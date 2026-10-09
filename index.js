/**
 * DSH × QQ 桥接插件 —— Host 侧
 *
 * 目标：把 QQ 变成 DSH 的对话入口。用户在客户端「设置 → 连接 QQ」里填 AppID/AppSecret，
 * 之后在手机 QQ 里发消息 = 直接对 DSH 说话，回答自动回到 QQ。
 *
 * 与早期"读盘转述"方案的本质区别：
 *   早期：读 session.v4.jsonl.zstd → 转述给用户（只读，只能看历史）
 *   现在：agent.inbox.append() 投消息 → agent 真正执行 → assistant-stream 取回答（可写，是真对话）
 *
 * 已查证的契约（来自 DSH 内部类型声明，非推测）：
 *   - ctx.agents.get(sessionId): Agent | undefined
 *   - ctx.agents.create({ sessionId, meta: { cwd } }): Promise<AgentHandle>   // 连带创建会话
 *   - agent.inbox.append(target: 'next-turn' | 'next-step', message: UserMessage): void
 *   - UserMessage = { id: MessageId, role: 'user', content: ContentBlock[], source: { kind: 'user' } }
 *   - ctx.on('agent/assistant-stream', ({ agent, frame }) => …)
 *       frame.chunk.type: 'text-delta' | 'reasoning-delta' | 'tool-call-delta' | 'usage' | 'finish'
 *   - ctx.on('agent/status', ({ agent, status }) => …)   // 'idle' ⇄ 'running'
 *   - credentials：readRecord / modifyRecord（唯一写路径）+ 'credentials/record-updated' 事件
 *
 * 插件契约（照抄 DSH 自带插件）：
 *   export const name / inject / Config
 *   export function apply(ctx, config) { … }
 *   ctx.effect(() => () => { … }, 'label')   // 释放钩子（不是 ctx.on('dispose')）
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { startStatusServer } from './control-server.js';
import { createBusyTracker } from './busy-tracker.js';
import {
  probeFeishu,
  probeDingtalk,
  weixinStartLogin,
  weixinPollLogin,
  startWeixinLoop,
  startWecomLoop,
  startDingtalkStream,
  startFeishuWs,
  describeError,
} from './transports.js';
import {
  applyPendingRemovals,
  DEPS_DIR,
  installComponent,
  isInstalled as isComponentInstalled,
  listComponents,
  removeComponent,
} from './components.js';

/**
 * 状态文件 —— 让插件的行为可被外部观测。
 *
 * 为什么需要：Host 插件的 console.log 写到 DSH 主进程的 stdout，
 * 而桌面应用不把它落盘，所以出问题时"看不到任何日志"，无法判断
 * 插件到底有没有跑、有没有连上 QQ。
 *
 * 有了这个文件，任何时候都能读它来定位：
 *   ~/.dsh/im-bridge-status.log   逐行追加的事件流
 *   ~/.dsh/im-bridge-status.json  当前状态快照
 */
const STATUS_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const STATUS_LOG = join(STATUS_DIR, 'im-bridge-status.log');
const STATUS_JSON = join(STATUS_DIR, 'im-bridge-status.json');


// ------------------------------------------------ 平台开关（哪些平台在界面上出现）
//
// 侧边栏的每个平台条目是**按开关动态注册 / 注销**的。依据（读源码确认，非推测）：
//   · dsh-client-ui-slots/lib/index.js:237-242 —— register() 返回 dispose 函数
//   · dsh-client-ui-sidebar/lib/client.js:469 —— sidebar 订阅 sidebar.panellist，
//     条目变化时自动重排图标列表
// 客户端读不到文件，所以这份状态必须落在宿主，再通过控制接口给界面。
//
// ⚠ QQ 通道**不允许关闭**：这个会话本身就跑在它上面，关掉等于把通信掐断。
//   setPlatformEnabled 会明确拒绝，而不是静默忽略。
const PLATFORM_IDS = ['qq', 'weixin', 'feishu', 'dingtalk', 'wecom'];

/**
 * 各平台凭据在 credentials 服务里的键。
 *
 * ⚠ **QQ 刻意保持旧键 `im-bridge/bot` 不动**：它是当前正在工作的通道，
 *   改名要连带迁移，而迁移期间一旦出错就等于把自己和外界的联系掐断。
 *   等新平台都稳了、有独立的重启窗口时再改（已写进待办）。
 *
 * ⚠ 键名通用化、值装各平台自己的字段（沿用既有分层约定，见原 CREDENTIAL_KEY 注释）：
 *   feishu   → FEISHU_APP_ID / FEISHU_APP_SECRET
 *   dingtalk → DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET / DINGTALK_ROBOT_CODE
 *   wecom    → WECOM_BOT_ID / WECOM_BOT_SECRET
 *   weixin   → 无静态凭据（扫码换 bot_token，存在 im-bridge-weixin.json）
 */
const PLATFORM_CREDENTIAL_KEYS = {
  qq: 'im-bridge/bot',
  weixin: 'im-bridge/weixin',
  feishu: 'im-bridge/feishu',
  dingtalk: 'im-bridge/dingtalk',
  wecom: 'im-bridge/wecom',
};

/**
 * 通道纪律 —— 注入给"经 IM 转达"的会话。
 *
 * 为什么必须有它（真实代价，2026-10-09）：用户是在**手机上**看回复，而 IM 客户端
 * **不渲染 Markdown**。于是 `**粗体**` 原样显示成两个星号、表格变成一堆竖线 ——
 * 可读性直接崩掉。用户的原话是「很多 * · 这种 markdown 格式」。
 *
 * 关键点：**agent 看不到自己在什么通道上**，所以它不会自己知道这件事。
 * 必须**在提示词源头约束**（照抄 dsh-wecom-plugin 的 conciseOutput 做法），
 * 而不是事后靠人提醒 —— 那是"靠记得"，迟早失效（见经验库 E19）。
 */
const CHANNEL_DISCIPLINE = [
  'Delivery channel: plain-text chat app.',
  '',
  'Your replies are relayed to the user through a chat app (QQ / WeChat / Feishu / DingTalk)',
  'and are read on a phone. Markdown is NOT rendered in that client.',
  '',
  'Therefore:',
  '- No tables, no headings, no horizontal rules, no block quotes.',
  '- No bold or italic markers. They show up literally as asterisks or underscores.',
  '- Keep paragraphs to 2-4 lines and separate them with a blank line.',
  '- Structure with plain numbered lists (1. 2. 3.) or Chinese ordinals, not with markup.',
  '- Use a fenced code block only when the user must copy something verbatim.',
  '- For long reports, finish with a short "what to do next" section.',
  '- Prefer short and concrete over exhaustive: the user is reading on a phone.',
].join('\n');

/**
 * 每个平台的凭据字段名，分"非密"与"密"两类。
 *
 * ⚠ 为什么要把这个列出来（2026-10-08 加）：`getCredentialInfo` 要判断
 *   "配全了没有"，而各平台的字段名完全不同。原来那段是**写死 QQ 的**
 *   （`QQ_BOT_APPID` / `QQ_BOT_SECRET`）——于是别的平台查自己的凭据时，
 *   拿到的永远是"没配"。
 *
 *   列成表之后，加一个平台只改**这一处**，不用再动查询逻辑
 *   （经验库 E19：把规则变成结构，而不是散在各处的 if）。
 *
 * 顺序有意义：`plain[0]` 用来做"尾 4 位"显示（各平台都拿第一个非密字段当身份）。
 */
const PLATFORM_CREDENTIAL_FIELDS = {
  qq: { plain: ['QQ_BOT_APPID'], secret: ['QQ_BOT_SECRET'] },
  // 微信走扫码换 bot_token，没有静态凭据
  weixin: { plain: [], secret: [] },
  feishu: { plain: ['FEISHU_APP_ID'], secret: ['FEISHU_APP_SECRET'] },
  dingtalk: { plain: ['DINGTALK_CLIENT_ID', 'DINGTALK_ROBOT_CODE'], secret: ['DINGTALK_CLIENT_SECRET'] },
  wecom: { plain: ['WECOM_BOT_ID'], secret: ['WECOM_BOT_SECRET'] },
};

const PLATFORMS_FILE = join(STATUS_DIR, 'im-bridge-platforms.json');

/** 默认：QQ 开（现状），其余关（传输层还没接）。 */
function defaultPlatforms() {
  const value = {};
  for (const id of PLATFORM_IDS) value[id] = id === 'qq';
  return value;
}

/** 读平台开关；文件缺失就回默认值，文件坏了要留痕（不静默）。 */
function loadPlatforms() {
  const fallback = defaultPlatforms();
  try {
    const parsed = JSON.parse(readFileSync(PLATFORMS_FILE, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return fallback;
    const merged = { ...fallback };
    for (const id of PLATFORM_IDS) {
      if (typeof parsed[id] === 'boolean') merged[id] = parsed[id];
    }
    merged.qq = true;   // 永不关闭（见上面的说明）
    return merged;
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      recordStatus('platforms-read-failed', { message: String(error?.message ?? error).slice(0, 160) });
    }
    return fallback;
  }
}

let platformState = defaultPlatforms();

function savePlatforms() {
  try {
    writeFileSync(PLATFORMS_FILE, JSON.stringify(platformState, null, 2) + '\n', 'utf8');
    return true;
  } catch (error) {
    recordStatus('platforms-write-failed', { message: String(error?.message ?? error).slice(0, 160) });
    return false;
  }
}


// ------------------------------------------------ 入站消息去重
//
// 五个平台都会重推消息：飞书要求 3 秒内处理完、超时重推；企微 / 公众号回调
// 超时"重试三次"；微信 iLink 的长轮询游标回退也可能重复投递。
// 而 agent 一轮要跑几十秒 —— 没有去重，同一条消息会被回答好几遍。
//
// 判据用**平台消息 id**（QQ 是从事件里取的 data.id）。带 TTL + 条数上限。
// ⚠ 拿不到 id 的一律放行：宁可不防，也不能把正常消息吃掉。
const SEEN_INBOUND_MAX = 500;
const SEEN_INBOUND_TTL_MS = 5 * 60 * 1000;
const seenInbound = new Map();

/** @returns {boolean} true = 第一次见到（放行）；false = 重复（丢掉） */
function rememberInbound(key) {
  if (typeof key !== 'string' || key === '') return true;
  const now = Date.now();
  const previous = seenInbound.get(key);
  if (previous !== undefined && now - previous < SEEN_INBOUND_TTL_MS) return false;

  seenInbound.set(key, now);
  if (seenInbound.size > SEEN_INBOUND_MAX) {
    for (const [k, ts] of [...seenInbound]) {
      if (now - ts >= SEEN_INBOUND_TTL_MS) seenInbound.delete(k);
    }
    while (seenInbound.size > SEEN_INBOUND_MAX) {
      const oldest = seenInbound.keys().next();
      if (oldest.done === true) break;
      seenInbound.delete(oldest.value);
    }
  }
  return true;
}


// ------------------------------------------------ 回复失败的有界重试
//
// 旧行为：发送失败只记一条 `reply-failed` 日志，**消息就永久丢了**。
// 而"连接刚好在断线重连的窗口里"是最常见的失败原因 —— 等一下就能成功。
//
// ⚠ 关键设计：重试**不占队列表忙位**。第一发失败就立刻解忙、把排队消息放出去，
//   重试在后台按 3 秒间隔继续，最长 30 秒（对照组：看门狗 45 秒解封）。
//   否则一次网络抖动会把整条队列按在这里 30 秒，手机那头看起来像卡死。
const REPLY_RETRY_INTERVAL_MS = 3000;
const REPLY_RETRY_TOTAL_MS = 30_000;
const replyRetryTimers = new Set();

/**
 * @param {() => Promise<unknown>} send 真正执行发送的闭包（每次重试都调用它）
 * @param {object} context 写进状态日志的上下文（bytes / platform 等）
 */
function scheduleReplyRetry(send, context) {
  const startedAt = Date.now();
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    void (async () => {
      try {
        await send();
        clearInterval(timer);
        replyRetryTimers.delete(timer);
        recordStatus('reply-retry-ok', { ...context, attempts, afterMs: Date.now() - startedAt });
      } catch (error) {
        if (Date.now() - startedAt >= REPLY_RETRY_TOTAL_MS) {
          clearInterval(timer);
          replyRetryTimers.delete(timer);
          recordStatus('reply-failed-final', {
            ...context,
            attempts,
            waitedMs: Date.now() - startedAt,
            message: String(error?.message ?? error).slice(0, 200),
          });
        }
      }
    })();
  }, REPLY_RETRY_INTERVAL_MS);
  replyRetryTimers.add(timer);
}

function recordStatus(event, detail = {}) {
  const entry = { time: new Date().toISOString(), event, ...detail };
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    appendFileSync(STATUS_LOG, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 状态记录失败不能影响主流程 */ }
  return entry;
}

function writeStatusSnapshot(snapshot) {
  try {
    mkdirSync(STATUS_DIR, { recursive: true });
    writeFileSync(STATUS_JSON, JSON.stringify({ time: new Date().toISOString(), ...snapshot }, null, 2), 'utf8');
  } catch { /* ignore */ }
}

/**
 * 返回第一个「非空字符串」候选值，全空则返回 undefined。
 *
 * ⚠ 为什么不能用 `a ?? b ?? c`：插件 Config schema 会把未配置的字符串字段
 * 默认成 `''`，而 `'' ?? x` 的结果是 `''`（?? 只跳过 null/undefined）。
 * 这个坑真实发生过：sessionId 变成空串，`ctx.agents.create()` 抛
 * "cannot encode an empty path segment"，消息全部投递失败且难以定位。
 */
function firstNonEmpty(candidates) {
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/**
 * 构造 `AgentOptions`（provider / model / reasoningEffort）。
 *
 * ⚠ 为什么必须给：不给模型的 agent 会渲染系统提示词失败 ——
 *   turn/end reason = "error"
 *   会话里显示：prompt variable "{{model}}" has no value for this assembly
 *               (section "deployment:persona-prefix")
 * preset 只决定"有哪些能力"，**模型路由要由创建方指定**。
 *
 * 取值优先级：
 *   ① 插件配置里显式指定的 agentProvider / agentModel
 *   ② `ctx.agentDefaultModel.currentSelection()` —— 用户设置的默认模型
 *      （服务签名：currentSelection(): ModelSelection）
 *   ③ 都拿不到 → 返回 undefined（调用方会记录日志，不静默失败）
 */
/**
 * 已知在**本机**可用的 provider/model 兜底。
 *
 * 为什么需要：`ctx.agentDefaultModel.currentSelection()` 返回的是**组合里的默认路由**
 * （实测为 `deepseek-official`），但本机凭据是 `deepseek-account-platform/default`
 * 那一条 —— 两者不是同一个 provider。用错 provider 的后果是：
 *   turn/end reason = { kind: 'error', error: {
 *     message: 'llm-deepseek: no API key for provider route "deepseek-official"' } }
 * 也就是说：agent 会跑，但一调模型就失败，手机上只看到"(这一轮没有产生回答)"。
 *
 * 兜底值取自**本机实际能跑通的会话**（其会话投影里的 modelSelection）：
 *   { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' }
 */
const FALLBACK_AGENT_OPTIONS = {
  provider: 'deepseek-account',
  model: 'deepseek-flash',
  reasoningEffort: 'max',
};

/**
 * 凭据探测表：**每个 provider 靠什么证明"本机真能用它"**。
 *
 * 2026-10-07 改写。原来这里是一个写死的白名单：
 *
 *     const KNOWN_GOOD_PROVIDERS = ['deepseek-account', 'deepseek-account-platform'];
 *
 * 它在本机（账号登录）是对的，但对**用 API key 登录的人就错了**：
 * 那种情况下 `deepseek-official` 才是唯一能用的路由，而白名单会把它丢掉、
 * 回退到 `deepseek-account`（他没有）→ 机器人整轮失败。
 *
 * 写死"哪些能用"本质上是在**替用户猜他的登录方式**。改成探测：
 *
 *   kind: 'record' → 用 credentials.readRecord(key) 查服务端凭据记录
 *   kind: 'ref'    → 用 credentials.describe(ref) 查"某个环境变量名背后有没有值"
 *
 * 两种都要，因为 DSH 的凭据存在**两个键空间**（credentials 服务的说明原文）：
 *   · record（CredentialKey）：插件持有的授权记录，例如 `…-platform/default`
 *   · ref（CredentialRef）：环境变量式的值，例如 `DEEPSEEK_API_KEY`
 *     —— **API key 走的是这一半**，用 listRecords() 看不到它，
 *        必须 describe('DEEPSEEK_API_KEY')。
 *
 * 探测全失败时退回 `FALLBACK_AGENT_OPTIONS`（账号登录那条路），
 * 并且**Config 的显式值始终优先于探测结果** —— 所以永远有逃生口。
 */
const PROVIDER_CREDENTIAL_HINTS = [
  {
    provider: 'deepseek-official',
    kind: 'ref',
    ref: 'DEEPSEEK_API_KEY',
    note: 'API-key 登录（适配器 dsh-llm-deepseek-api-key）',
  },
  {
    provider: 'deepseek-account',
    kind: 'record',
    key: 'deepseek-account-platform/default',
    note: '账号登录（适配器 dsh-llm-deepseek-account）',
  },
  {
    // 账号登录的另一条记录（设备码流程）；和上面那条通常同时存在
    provider: 'deepseek-account-platform',
    kind: 'record',
    key: 'deepseek-account-platform/device',
    note: '账号登录（设备记录）',
  },
];

/**
 * 探测本机**真正有凭据**的 provider。
 *
 * 返回探测到的 provider 列表（按 hints 顺序，先到先得）。
 * 任何一步失败都不抛 —— 探测不该让插件加载失败。
 */
async function detectUsableProviders(ctx) {
  const creds = ctx.get?.('credentials');
  if (creds === undefined || creds === null) return [];
  const found = [];
  for (const hint of PROVIDER_CREDENTIAL_HINTS) {
    try {
      if (hint.kind === 'record') {
        if (typeof creds.readRecord !== 'function') continue;
        const rec = await creds.readRecord(hint.key);
        if (rec !== undefined && rec !== null) found.push(hint.provider);
      } else {
        if (typeof creds.describe !== 'function') continue;
        const info = await creds.describe(hint.ref);
        if (info?.configured === true) found.push(hint.provider);
      }
    } catch { /* 单条探测失败不影响其它 */ }
  }
  return found;
}


/**
 * 解析 QQ 会话该用哪个 provider / model。
 *
 * ⚠ **这是 async**（2026-10-07 改）：provider 现在靠**探测凭据**决定，
 *   而探测要调异步的 credentials 服务。两个调用点都在 async 函数体内，
 *   所以改签名是安全的（但**别新增同步调用点** —— 会拿到 Promise）。
 *
 * 决策顺序（**顺序本身就是踩出来的教训**）：
 *   ① Config 显式指定           —— 用户的逃生口，永远最优先
 *   ② 探测到的可用 provider      —— 本机真有凭据的路由
 *   ③ 服务 currentSelection()    —— 补 model / reasoningEffort，也补 provider
 *   ④ FALLBACK_AGENT_OPTIONS     —— 账号登录兜底
 */
async function readDefaultModelOptions(ctx, config) {
  const explicitProvider = firstNonEmpty([config.agentProvider]);
  const explicitModel = firstNonEmpty([config.agentModel]);
  const explicitEffort = firstNonEmpty([config.agentReasoningEffort]);

  // ① 插件配置里显式指定 → 直接用（这是唯一的"逃生口"）
  if (explicitProvider !== undefined && explicitModel !== undefined) {
    return {
      provider: explicitProvider,
      model: explicitModel,
      ...(explicitEffort === undefined ? {} : { reasoningEffort: explicitEffort }),
    };
  }

  // ② 读默认模型服务 —— **仅用于补全缺失的字段**
  //
  // ⚠ 为什么不能直接采信它返回的 provider（实测教训）：
  //
  //   `ctx.agentDefaultModel.currentSelection()` 在本机返回
  //     { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
  //   但本机的凭据挂在 **deepseek-account-platform/default** 下
  //   （见 ~/.dsh/.credentials.yaml，issuer = platform.deepseek.com），
  //   根本没有 'deepseek-official' 的 API key。于是每一轮都失败：
  //     turn/end reason = { kind: 'error', error: {
  //       message: 'llm-deepseek: no API key for provider route "deepseek-official"' } }
  //
  //   我第一版把它放在兜底之前，结果"兜底永远轮不到"——
  //   服务返回了值，整条链就停在那里了。所以现在**插件的判定优先于服务**，
  //   服务只用来补 model / reasoningEffort 这类不致命的字段。
  let fromService;
  try {
    const service = ctx.get('agentDefaultModel');
    if (service !== undefined) {
      const selection = service.currentSelection();
      if (selection !== undefined && selection !== null) {
        fromService = {
          provider: firstNonEmpty([selection.provider]),
          model: firstNonEmpty([selection.model]),
          reasoningEffort: firstNonEmpty([selection.reasoningEffort]),
        };
      }
    }
  } catch { /* 忽略，用插件默认 */ }

  // ③ 探测本机真正有凭据的 provider（替代原来写死的白名单）
  const usable = await detectUsableProviders(ctx);

  // 指定了 provider 又指定了 model 的情况在 ① 已经返回，这里只看 provider：
  // 用户显式给的 provider 即便探测不到也尊重（可能是我们没列的登录方式）。
  const provider = firstNonEmpty([
    explicitProvider,
    usable[0],
    fromService?.provider,
    FALLBACK_AGENT_OPTIONS.provider,
  ]);

  const model = firstNonEmpty([explicitModel, fromService?.model, FALLBACK_AGENT_OPTIONS.model]);
  const effort = firstNonEmpty([explicitEffort, fromService?.reasoningEffort, FALLBACK_AGENT_OPTIONS.reasoningEffort]);

  if (provider === undefined || model === undefined) return undefined;
  return {
    provider,
    model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

/**
 * 决定 QQ 会话的工作目录。
 *
 * 解析顺序：`config.workspace` → `$DSH_WORKSPACE` → `process.cwd()`
 *
 * ⚠ **为什么要多加一层"目录存在才用它"**（2026-10-07 修的真问题）：
 *
 * 这份插件的 `cordis.patch.yml` 是**随包发布**的，而它曾经写着
 * `workspace: 'D:\EasyDSH'` —— **开发机的路径**。别人从 GitHub 装完，
 * 这个值会进他们的配置，把工作目录指向一个在他们机器上不存在的路径。
 *
 * 光删掉那个默认值还不够，还要挡住另外两种情况：
 *   · 用户改过 workspace，后来把那个目录删了或改名了
 *   · 多台机器共用一份配置（同步 dotfiles），路径只在一台上存在
 *
 * 两种情况原来的表现都是**静默**的：agent 在一个不存在的目录里干活，
 * 读文件报"找不到"、glob 结果为空 —— 而看配置一切正常，极难排查。
 *
 * 所以：**候选路径不存在就跳过它**，并记一条日志说清楚去了哪。
 */
function resolveWorkspace(config) {
  const candidates = [
    ['config.workspace', firstNonEmpty([config.workspace])],
    ['$DSH_WORKSPACE', firstNonEmpty([process.env.DSH_WORKSPACE])],
  ];
  for (const [source, value] of candidates) {
    if (value === undefined) continue;
    if (existsSync(value)) return value;
    // 明确记下"配置了但不存在"—— 这正是原来静默的地方
    recordStatus('workspace-missing-fallback', {
      source,
      configured: value,
      fallback: process.cwd(),
      note: '配置里的工作目录不存在 → 回退到进程 cwd',
    });
  }
  return process.cwd();
}

/**
 * 插件名（Cordis 用它标识这个插件，日志前缀也用它）。
 *
 * 2026-10-07 从 'qq-bridge' 改成 'im-bridge'，和 cordis.patch.yml 里的行 id 对齐。
 * 改名时这一处被漏掉了（我的映射表里有包名有目录名，唯独没有这个裸字符串 `'qq-bridge'`）——
 * 于是日志里一直自称 qq-bridge，而它在做的是"IM 桥接"。
 */
export const name = 'im-bridge';

// credentials：凭据服务。用户改凭据会触发 'credentials/record-updated'，据此重连。
//
// agentPresets 刻意**不写进 inject**：用可选查找（ctx.get('agentPresets')）。
// 理由：写成硬依赖时，只要该服务缺席，整个插件就不会激活 —— 那比"绑不上 preset"
// 严重得多。可选查找让插件始终能加载，绑不上时只是记录一条失败日志。
export const inject = ['agents', 'credentials'];

/**
 * 凭据记录的 key，按品牌约定用 "<owner>/<name>"。
 * 用 ApiKeyRecord，其 env 字段正好装下两个值：
 *   { kind: 'api-key', env: { QQ_BOT_APPID: '…', QQ_BOT_SECRET: '…' } }
 *
 * ⚠ 注意：**键名通用化，但里面装的值仍是 QQ 的平台契约**（QQ_BOT_APPID / QQ_BOT_SECRET）。
 *   这是有意的分层：键名是"这个插件持有哪份凭据"，值是"某个平台要求什么格式"。
 *   以后接飞书会新增 `im-bridge/feishu`（或飞书自己的键），装它自己的字段。
 */
const CREDENTIAL_KEY = 'im-bridge/bot';

/**
 * 改名前的旧凭据键（2026-09-26 从 `qq-bridge/bot` 改成 `im-bridge/bot`）。
 *
 * 留着它只为一件事：**自动迁移**，让用户不用重新填 AppID/Secret。
 * 迁移在启动时做一次，幂等 —— 见 migrateCredentialKey()。
 */
const LEGACY_CREDENTIAL_KEY = 'qq-bridge/bot';

/**
 * 配置 schema —— 必须导出，且必须是 Standard Schema。
 *
 * 踩过的坑（两次失败换来的）：
 *   1) 导出普通 JSON Schema（{ type:'object', properties:{…} }）会炸：
 *      Cordis 内部走的是 Standard Schema 的 `~standard.validate`，读到 undefined 就抛
 *      TypeError: Cannot read properties of undefined (reading 'validate')
 *   2) 干脆不导出 Config 也炸 —— Cordis 公开的 resolveConfig 有 `if (!Config) return config`
 *      守卫，但报错来自 Cordis 库内部未加守卫的版本，两条路径行为不一致。
 *      所以「必须导出 Config」。
 *   3) 不要为此去 import zod —— DSH 是打包安装的，zod 在 asar 里的路径不稳定。
 *
 * Standard Schema v1 的契约很小，手写即可（下面这个对象完全符合规范）：
 *   { '~standard': { version: 1, vendor: string, validate(value) => {value} | {issues} } }
 */
const ConfigSchema = {
  '~standard': {
    version: 1,
    vendor: 'im-bridge',
    validate(value) {
      const input = (value !== null && typeof value === 'object') ? value : {};
      const issues = [];
      if (input.workspace !== undefined && typeof input.workspace !== 'string') {
        issues.push({ message: 'workspace 必须是字符串（绝对路径）' });
      }
      if (input.sessionId !== undefined && typeof input.sessionId !== 'string') {
        issues.push({ message: 'sessionId 必须是字符串' });
      }
      if (issues.length > 0) return { issues };
      return {
        value: {
          // 沙箱默认开启：家用宽带没有固定公网 IP，正式环境的 IP 白名单过不去
          sandbox: input.sandbox !== false,
          // 承接 QQ 消息的工作区；留空则回退到 DSH 进程自身的工作目录
          workspace: typeof input.workspace === 'string' ? input.workspace : '',
          // 绑定到固定会话；留空则按 QQ 用户派生
          sessionId: typeof input.sessionId === 'string' ? input.sessionId : '',
          // QQ 会话用哪个角色预设。留空默认 'standard'。
          // 注意：这里不能省 —— 不绑 preset 的 agent 不会执行。
          agentPreset: typeof input.agentPreset === 'string' ? input.agentPreset : '',
          // 模型路由：留空则自动取「用户设置的默认模型」（ctx.agentDefaultModel）。
          // ⚠ 必须能解析出 provider + model，否则 agent 渲染系统提示词时会因
          //   缺少 {{model}} 而整轮失败（turn/end reason = "error"）。
          agentProvider: typeof input.agentProvider === 'string' ? input.agentProvider : '',
          agentModel: typeof input.agentModel === 'string' ? input.agentModel : '',
          agentReasoningEffort: typeof input.agentReasoningEffort === 'string' ? input.agentReasoningEffort : '',
          // 是否把思考过程也发到 QQ
          showReasoning: input.showReasoning === true,
          /**
           * 微信通道：收到消息时**立刻**回一条短确认（诊断用，默认**关**）。
           *
           * ── 为什么需要它（2026-10-08 的一次真故障）─────────────────────
           * 实测现象：agent 真的答了 624 字，iLink 返回 **HTTP 200**，
           * 请求体与"旧代码能送达"那版**逐字相同** —— 但用户什么都没收到。
           *
           * 剩下最可能的分歧是**时延**：
           *   · 旧代码（送达成功）：收到 → 立刻发（~0.4 秒）
           *   · 新代码（没送达）  ：收到 → agent 干活 → 发（10.8 秒 / 1.2 秒）
           * iLink 的 `context_token` 有可能只在短时间内有效。
           *
           * 打开它之后，同一个会话里应该先收到一条**短确认**、稍后才收到正式回答：
           *   ✓ 确认到了、正式回答没到 → 是**时延/令牌有效期**问题
           *   ✗ 两个都没到             → 是**发送通道本身**的问题（与 agent 无关）
           *   ✓ 两个都到了             → 通道没问题，是别的原因（且此时正式回答也送达了）
           *
           * 一句话就能分辨，不用再猜。诊断完请关掉 —— 否则用户会多收到一条消息。
           */
          weixinInstantAck: input.weixinInstantAck === true,
          /** 上面那条确认的文本。留空用默认。 */
          weixinAckText: typeof input.weixinAckText === 'string' ? input.weixinAckText : '',
          /**
           * QQ 会话的**权限预设** —— 决定它能干什么（2026-09-26 加）。
           *
           * 为什么要显式设：默认预设是 `workspace-write`，它的语义是
           *   "只能改工作目录 + 每次要人工批准"。
           * 而 QQ 会话是**无人值守**的：批准框弹在桌面上，手机那头什么都看不到
           *   → agent 卡在 approval/asked，一轮就废了（实测卡 53 秒后被看门狗解开，
           *     而且回复根本没发出去）。
           *
           * 另一个雪上加霜的事实：本机上 workspace-write 的沙箱**初始化就失败**
           *   （SetNamedSecurityInfoW failed (Win32 5): grantWrite(<工作区>)）
           *   → 那条路连"只改工作目录"都做不到，任何 shell 命令都跑不起来。
           *
           * 所以默认用 `danger-full-access`（approval 为 never），
           * 这也是 DSH 自己的无人值守场景（dsh-webhook）采用的值。
           *
           * ⚠ **安全含义**：这等于把一台电脑的 shell 交给"能给这个 QQ 机器人发消息的人"。
           *   仅在你接受这个前提下使用。想收紧就把它改成 read-only
           *   （能读不能改），或改回 workspace-write（但本机沙箱起不来，不可用）。
           */
          permissionPreset: typeof input.permissionPreset === 'string' ? input.permissionPreset : '',
        },
      };
    },
  },
};

export const Config = ConfigSchema;


// ---------------------------------------------------------------- QQ 协议层
// 协议部分是从已验证可跑的 qq-bridge.mjs 搬过来的，不需要重写。
const INTENTS = 1 << 25;   // GROUP_AND_C2C_EVENT：单聊 + 群@

class QqClient {
  constructor({ appId, appSecret, sandbox, log }) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.apiBase = sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.bot.qq.com';
    this.log = log;
    this.token = null;
    this.tokenExpireAt = 0;
    this.socket = null;
    this.heartbeat = null;
    this.refreshTimer = null;
    this.lastSeq = null;
    this.onMessage = () => {};
    this.closed = false;
  }

  async ensureToken() {
    if (this.token !== null && Date.now() < this.tokenExpireAt - 60_000) return this.token;
    const response = await fetch('https://bots.qq.com/app/getAppAccessToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.appSecret }),
    });
    const data = await response.json();
    if (data.access_token === undefined) {
      throw new Error(`取 access_token 失败：code=${data.code} message=${data.message}`);
    }
    this.token = data.access_token;
    this.tokenExpireAt = Date.now() + Number(data.expires_in ?? 7200) * 1000;
    this.log(`已获取 access_token（${data.expires_in ?? 7200} 秒后过期）`);
    return this.token;
  }

  /** QQ 的坑：业务失败时 HTTP 仍是 200，必须看响应体的 err_code */
  static assertOk(what, data) {
    if (data !== null && typeof data === 'object' && data.err_code !== undefined && data.err_code !== 0) {
      throw new Error(`${what} 失败：err_code=${data.err_code} message=${data.message ?? ''}`);
    }
  }

  async apiGet(path) {
    const token = await this.ensureToken();
    const response = await fetch(`${this.apiBase}${path}`, { headers: { authorization: `QQBot ${token}` } });
    const data = await response.json();
    if (response.status >= 300) throw new Error(`GET ${path} → HTTP ${response.status}`);
    QqClient.assertOk(`GET ${path}`, data);
    return data;
  }

  async apiPost(path, payload) {
    const token = await this.ensureToken();
    const response = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers: { authorization: `QQBot ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await response.json();
    if (response.status >= 300) throw new Error(`POST ${path} → HTTP ${response.status}`);
    QqClient.assertOk(`POST ${path}`, data);
    return data;
  }

  /**
   * 发单聊消息；长文本分片（QQ 单条约 1000 字符上限）。
   *
   * ⚠ 关于 `msg_id`（这里踩过一个"静默失败"的坑，是"发出去收不到"的元凶）：
   *
   *   QQ 有两种发消息方式，成功响应长得**一模一样**（都是 HTTP 200 +
   *   `{id:"ROBOT1.0_...", timestamp, ext_info}`），所以**光看响应分不出送达没有**：
   *
   *     · 带 `msg_id` = **被动回复**（回复某条用户消息）—— 不需要额外权限，
   *       但**必须是那条消息的有效回复**，否则 QQ 接受但不投递
   *     · 不带     = **主动推送** —— 需要机器人有主动消息权限
   *
   *   实测（同一个 bot、同一个用户、同样内容）：
   *     主动推送 → 用户稳定收到 ✓
   *     被动回复 → 用户**从来没收到过** ✗（但插件一直以为成功了）
   *
   *   所以这里改成：**首片先试被动回复，失败就退回主动推送**；
   *   后续分片一律用主动推送（被动回复只能对应用户那一条消息，只能回一次）。
   *
   *   为什么两个都留着而不是直接用主动推送：
   *   主动消息权限很多机器人没有，而被动回复是"万能"的 ——
   *   谁知道哪天 `msg_id` 那条路又对了呢。两条都试最稳。
   */
  async reply(openid, content, msgId, onEvent) {
    const LIMIT = 900;
    const chunks = [];
    for (let i = 0; i < content.length; i += LIMIT) chunks.push(content.slice(i, i + LIMIT));

    for (const [index, chunk] of chunks.entries()) {
      const base = { content: chunk, msg_type: 0 };

      // 只有第一片、且拿得到 msg_id 时，才有"被动回复"这个选项
      if (index === 0 && msgId !== undefined) {
        let ok = false;
        try {
          const data = await this.apiPost(`/v2/users/${openid}/messages`, { ...base, msg_id: msgId });
          onEvent?.('replied-passive', { chunk: index, id: data?.id ?? null, ts: data?.timestamp ?? null });
          // ⚠ 关键判据：**成功响应一定带消息 id**（实测主动推送返回 `{id:"ROBOT1.0_...", timestamp, ext_info}`）。
          //   所以"HTTP 200 但没有 id"要当成失败 —— QQ 对无效 msg_id 可能就是这样
          //   静默处理的，光看 HTTP 状态分辨不出来。
          ok = typeof data?.id === 'string' && data.id !== '';
          if (!ok) {
            onEvent?.('passive-reply-no-message-id', { chunk: index, response: JSON.stringify(data ?? null).slice(0, 200) });
          }
        } catch (error) {
          onEvent?.('passive-reply-failed-fallback', {
            chunk: index,
            message: String(error?.message ?? error).slice(0, 200),
          });
        }
        if (ok) continue;   // 被动回复成功，这一片不用再发
      }

      // 主动推送（不带 msg_id）
      const data = await this.apiPost(`/v2/users/${openid}/messages`, base);
      onEvent?.('replied-active', { chunk: index, id: data?.id ?? null, ts: data?.timestamp ?? null });
    }
  }

  async connect() {
    await this.ensureToken();
    const gateway = await this.apiGet('/gateway');
    this.log(`网关：${gateway.url}`);

    const open = () => {
      if (this.closed) return;
      const socket = new WebSocket(gateway.url);
      this.socket = socket;

      socket.addEventListener('open', () => this.log('WebSocket 已连接'));

      socket.addEventListener('message', (event) => {
        let payload;
        try { payload = JSON.parse(String(event.data)); } catch { return; }
        if (payload.s !== undefined && payload.s !== null) this.lastSeq = payload.s;

        switch (payload.op) {
          case 10: {   // Hello → 发 Identify
            const interval = payload.d?.heartbeat_interval ?? 45000;
            if (this.heartbeat !== null) clearInterval(this.heartbeat);
            this.heartbeat = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            }, interval);
            socket.send(JSON.stringify({
              op: 2,
              d: {
                token: `QQBot ${this.token}`,
                intents: INTENTS,
                shard: [0, 1],
                // ⚠ 这两个字段是**发给腾讯服务器**的握手标识（identify.properties）。
                //   改名时一起改了（qq-bridge → im-bridge）——
                //   它对 QQ 侧只是"这个客户端自称什么"，改掉是安全的，
                //   但要知道它确实是**线上可见**的标识，不是纯本地字符串。
                properties: { $os: 'windows', $browser: 'dsh-im-bridge', $device: 'dsh-im-bridge' },
              },
            }));
            break;
          }
          case 0:      // Dispatch
            this.onMessage(payload).catch((error) => this.log(`处理事件出错：${error.message}`));
            break;
          case 7:
            this.log('服务端要求重连');
            socket.close();
            break;
          case 9:
            this.log('鉴权失败（Invalid Session）——检查 intents 权限或 token');
            this.token = null;
            break;
          default:
            break;
        }
      });

      socket.addEventListener('close', () => {
        if (this.closed) return;
        if (this.heartbeat !== null) clearInterval(this.heartbeat);
        this.log('连接断开，5 秒后重连');
        setTimeout(open, 5000);
      });

      socket.addEventListener('error', (event) => this.log(`WebSocket 错误：${event?.message ?? '(无详情)'}`));
    };

    open();

    // 令牌 7200 秒过期，定期刷新
    this.refreshTimer = setInterval(() => {
      this.ensureToken().catch((error) => this.log(`刷新令牌失败：${error.message}`));
    }, 30 * 60 * 1000);
  }

  dispose() {
    this.closed = true;
    if (this.heartbeat !== null) clearInterval(this.heartbeat);
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
    try { this.socket?.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- 插件主体
export function apply(ctx, config = {}) {
  // 日志前缀 —— 改名时一起改了（qq-bridge → im-bridge）。
  // ⚠ Host 插件的 console.log **桌面应用不落盘**，所以这个前缀主要方便开发时看
  //   宿主进程 stdout；真正排障要看 im-bridge-status.log（recordStatus 写的那个）。
  const log = (...args) => console.log('[im-bridge]', ...args);

  // QQ openid → DSH 会话 id 的绑定
  const bindings = new Map();
  // 正在累积的回答：sessionId → { text, reasoning, openid, msgId }
  const pending = new Map();

  // ---- 平台开关：真相在宿主，界面通过控制接口读（见 control-server 的 /platforms）
  //
  // 启动读一次盘；之后由设置页的开关通过 POST /im-bridge/platform 改。
  // ⚠ 改完**不需要重启**：客户端每 5 秒拉一次，据此注册 / 注销侧边栏条目。
  platformState = loadPlatforms();
  recordStatus('platforms-loaded', { platforms: platformState });

  /** 给客户端读（控制接口用）；ids 一并给出去，界面不用自己维护平台清单 */
  function getPlatformsInfo() {
    const status = {};
    for (const [id, value] of platformRuntime) status[id] = value;
    return { ok: true, platforms: { ...platformState }, status, ids: [...PLATFORM_IDS] };
  }

  /**
   * 给设置页写。返回 { ok, platforms } 或 { ok:false, error }。
   *
   * ── 关于"能不能关掉某个平台"（2026-10-08 改）──────────────────────
   *
   * 原来这里是三条硬编码，把 QQ 做成"常开、不可关"：
   *   ① `if (id === 'qq' && enabled === false) return error`
   *   ② `platformState = { ..., qq: true }` ← **写任何平台都强制把 qq 设回开**
   *   ③（客户端那一半）`locked = meta.id === 'qq'` 画成禁用按钮
   *
   * 而当初给的理由是"当前会话就跑在它上面，关掉等于掐断通信" —— 那句**不成立**：
   * QQ 用的是自己的专用会话（`im-bridge-dedicated-v1`），微信是另一个
   * （`im-bridge-weixin-v1`），互相独立。关掉 QQ 只是不再监听 QQ、不再显示入口，
   * 不会动到别的平台的会话。
   *
   * ② 还顺带是个 bug：你关掉**微信**，QQ 会被莫名其妙地设回开。
   *
   * ── 现在保留的唯一守卫 ──────────────────────────────────────────
   * **不能把最后一个开着的平台关掉**。理由和平台无关、是通用的：
   * 全关掉之后侧边栏一个入口都不剩，用户就再也找不到这个插件了
   * （只能去设置页那个列表里找回来 —— 而列表本身也在插件里，自相矛盾）。
   * 这是"防止不可恢复的状态"，不是"某个平台特殊"。
   */
  async function setPlatformEnabled(id, enabled) {
    if (!PLATFORM_IDS.includes(id)) return { ok: false, error: `未知平台：${String(id)}` };
    if (enabled === false && platformState[id] === true) {
      const others = PLATFORM_IDS.filter((other) => other !== id && platformState[other] === true);
      if (others.length === 0) {
        return {
          ok: false,
          error: '至少要留一个平台开着 —— 全关掉之后侧边栏就没有入口了，得回到这里才能重新打开',
        };
      }
    }
    platformState = { ...platformState, [id]: enabled === true };
    const saved = savePlatforms();
    recordStatus('platform-set', { id, enabled: enabled === true, saved });
    return { ok: true, saved, platforms: { ...platformState } };
  }

  // ---- 各平台的连接状态 + 「测试连接」（实现在 transports.js）
  //
  // 为什么状态要放在宿主：客户端读不到文件、也拿不到凭据。
  // 界面每次轮询 /platforms 就能同时拿到"开关"和"连上没连上"。
  const platformRuntime = new Map();   // id -> { phase, message, detail, at }
  const WEIXIN_STATE_FILE = join(STATUS_DIR, 'im-bridge-weixin.json');

  function setRuntime(id, phase, message, detail) {
    platformRuntime.set(id, { phase, message: String(message ?? '').slice(0, 240), detail: detail ?? null, at: Date.now() });
    recordStatus('platform-runtime', { id, phase, message: String(message ?? '').slice(0, 160) });
  }
  /**
   * 读某个平台的连接状态 —— 给**每个平台的面板**判断"在线"绿灯用。
   *
   * ⚠ 为什么必须能按平台读（2026-10-08 加）：原来前端面板只拿得到 QQ 的连通性，
   *   于是微信面板会用 **QQ 的连通状态**去点亮自己的绿灯 —— 两个平台的状态串了。
   *   判据是宿主这边的 `phase === 'connected'`，不是"有没有配凭据"：
   *   配了不等于连上（微信要扫码、企微要握手）。
   */
  function getPlatformRuntime(id) {
    return platformRuntime.get(String(id ?? '')) ?? null;
  }
  for (const id of PLATFORM_IDS) setRuntime(id, 'idle', '');

  let weixinLoop = null;
  let wecomLoop = null;
  let dingtalkLoop = null;
  let feishuLoop = null;
  let weixinLogin = null;   // { qrcode, qrUrl, startedAt }

  /** 微信 bot_token 存在本机 —— 重启后不用重新扫码 */
  function readWeixinToken() {
    try {
      const parsed = JSON.parse(readFileSync(WEIXIN_STATE_FILE, 'utf8'));
      const token = String(parsed?.botToken ?? '').trim();
      return token === '' ? null : token;
    } catch { return null; }
  }
  function writeWeixinToken(botToken) {
    try {
      writeFileSync(WEIXIN_STATE_FILE, JSON.stringify({ botToken, savedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (error) {
      recordStatus('weixin-token-save-failed', { message: describeError(error) });
    }
  }

  /**
   * 读某个平台的凭据 env。
   *
   * ⚠ 键名各平台不同，**集中在这一处映射**，别散到各处去写 ——
   *   散开就会出现"加平台时漏改一处"（这个项目里已经发生过同类事故）。
   */
  async function readPlatformEnv(id) {
    const key = PLATFORM_CREDENTIAL_KEYS[id];
    if (key === undefined) return {};
    try {
      const record = await ctx.credentials.readRecord(key);
      if (record === undefined || record.kind !== 'api-key') return {};
      return record.env ?? {};
    } catch (error) {
      recordStatus('platform-credential-read-failed', { id, message: describeError(error) });
      return {};
    }
  }

  /**
   * 微信：起长轮询，把入站消息**接到 agent**（2026-10-08 改）。
   *
   * 改之前是"收到就回一条 [测试回显]"—— 那一步的使命是证明收发双向都通，
   * 已经达成。现在改成真正的闭环：
   *
   *     微信消息 → enqueueDelivery(微信会话, …) → agent 干活
   *              → finishTurn → slot.reply（带那条消息的 context_token）→ 微信
   *
   * ⚠ 两处与 QQ 不同，都要注意：
   *   ① **回复闭包必须逐条传**：微信的回复要带 inbound 的 context_token，
   *      所以它是消息级能力（见 transports.js 里 startWeixinLoop 的说明）。
   *   ② **微信有自己的专用会话**（`im-bridge-weixin-v1`），与 QQ 分开。
   *      这样两个平台的上下文互不干扰，面板也能按平台分开展示。
   */
  function startWeixinWithLoop(token) {
    if (weixinLoop !== null) { weixinLoop.dispose(); weixinLoop = null; }
    const weixinSessionId = dedicatedSessionId('weixin');
    weixinLoop = startWeixinLoop({
      token,
      onInbound: (text, reply) => {
        recordStatus('weixin-inbound-text', { text: text.slice(0, 80) });

        // 诊断开关：立刻回一条短确认，用来分辨"时延问题"还是"通道问题"。
        // 见 Config 里 weixinInstantAck 的说明。**不要 await** —— 它必须在
        // 收到消息的当下一瞬间发出去，等它就失去诊断意义了。
        if (config.weixinInstantAck === true) {
          const ack = firstNonEmpty([config.weixinAckText, '（收到，正在处理…）']);
          void Promise.resolve(reply(ack)).then(
            () => recordStatus('weixin-instant-ack-sent', { bytes: ack.length }),
            (error) => recordStatus('weixin-instant-ack-failed', { message: describeError(error) }),
          );
        }

        // peer 用不了 openid（微信是 from_user_id），从闭包里拿不到，
        // 所以队列键用会话 id —— 微信是单聊场景，不需要再按人分。
        //
        // ⚠ `reply` 返回的是 Promise，`finishTurn` 会拿它 `.then()` ——
        //   所以这里必须**把 Promise 原样 return 出去**，让它真的等到 API 结果。
        //   写 `reply: reply` 也行（它本身就是返回 Promise 的函数），
        //   但包一层 `Promise.resolve(...)` 能把"不是 Promise"的意外情况也吃掉，
        //   避免 `finishTurn` 里 `.then()` 抛 "不是一个函数"。
        enqueueDelivery(weixinSessionId, text, '', undefined, {
          platform: 'weixin',
          reply: (replyText) => Promise.resolve(reply(replyText)),
        });
      },
      onEvent: (event, detail) => {
        recordStatus(event, detail ?? {});
        if (event === 'weixin-replied') {
          setRuntime('weixin', 'connected', '已连接 —— 给「微信 ClawBot」发消息，它会用 agent 回答');
        }
        if (event === 'weixin-reply-failed') {
          setRuntime('weixin', 'error', `能收但回不出去：${detail?.message ?? ''}`);
        }
        if (event === 'weixin-poll-failed' && Number(detail?.failures ?? 0) >= 3) {
          setRuntime('weixin', 'error', `轮询连续失败 ${detail?.failures} 次：${detail?.message ?? ''}`);
        }
      },
    });
    setRuntime('weixin', 'connected', '长轮询已启动 —— 现在给「微信 ClawBot」发一条消息试试');
    return { ok: true, message: '已连接：去微信里给 ClawBot 发一条消息，它会让 agent 回答', phase: 'connected' };
  }

  /**
   * 「测试连接」—— 界面点一下就走这里。
   *
   * 四个平台的能力**刻意不同**，返回值里的 phase 要如实反映：
   *   weixin   → need-scan / connected（真连接 + 回显）
   *   wecom    → connecting → connected（真长连接；但不保证能回复）
   *   feishu   → verified（只验证凭据可用）
   *   dingtalk → verified（只验证凭据可用）
   */
  async function testPlatform(id) {
    if (!PLATFORM_IDS.includes(id)) return { ok: false, message: `未知平台：${String(id)}`, phase: 'error' };

    if (id === 'qq') {
      // ⚠ 原来这里无条件返回"QQ 通道是常驻的，不用测试"。
      //   现在 QQ 可关，所以要先看开关 —— 关着的时候回这句话是错的。
      if (platformState.qq !== true) {
        setRuntime('qq', 'idle', 'QQ 开关是关的 —— 打开上面那个开关即可');
        return { ok: false, phase: 'idle', message: 'QQ 开关是关的，先打开它' };
      }
      // 开着的时候：把当前真实连接状态如实说出来，并顺手重连一次
      //（用户点"测试"的意图就是"现在到底通不通"，那就真去连一次）。
      await restartConnection('用户点了测试');
      const connected = qq !== null;
      setRuntime('qq', connected ? 'connected' : 'error',
        connected ? 'QQ 连接正常' : 'QQ 没连上 —— 检查 AppID / Secret');
      return {
        ok: connected,
        phase: connected ? 'connected' : 'error',
        message: connected
          ? 'QQ 连接正常'
          : 'QQ 没连上 —— 检查「设置 → 连接 IM」里的 AppID / Secret',
      };
    }

    setRuntime(id, 'connecting', '正在测试…');

    if (id === 'feishu') {
      const env = await readPlatformEnv(id);
      const appId = String(env.FEISHU_APP_ID ?? '').trim();
      const appSecret = String(env.FEISHU_APP_SECRET ?? '').trim();
      if (appId === '' || appSecret === '') {
        const message = '请先填 App ID 和 App Secret（展开这一行有开通指引）';
        setRuntime(id, 'error', message);
        return { ok: false, phase: 'error', message };
      }

      // 装了长连接组件 → 起**真连接**；没装 → 退回"只验证凭据"并告诉用户去哪装
      if (isComponentInstalled('lark-sdk')) {
        // ⚠ 先做一次 REST 握手：它能给出**精确**的失败原因（App ID 错 / Secret 错 / 未开通），
        //   而长连接失败只能告诉你"没连上"。顺序反了用户就得猜。
        const probe = await probeFeishu({ appId, appSecret });
        if (probe.ok !== true) {
          setRuntime(id, 'error', `凭据不通：${probe.message}`);
          return { ok: false, phase: 'error', message: probe.message };
        }
        try { feishuLoop?.dispose(); } catch { /* ignore */ }
        feishuLoop = null;
        setRuntime(id, 'connecting', '正在建立长连接…');
        const started = await startFeishuWs({
          appId,
          appSecret,
          onInbound: (text) => recordStatus('feishu-inbound-text', { text: text.slice(0, 80) }),
          onEvent: (event, detail) => recordStatus(event, detail ?? {}),
        });
        if (started.ok !== true) {
          setRuntime(id, 'error', started.message);
          return { ok: false, phase: 'error', message: started.message };
        }
        feishuLoop = started;
        setRuntime(id, 'connected', started.message);
        return { ok: true, phase: 'connected', message: started.message };
      }

      const result = await probeFeishu({ appId, appSecret });
      if (result.ok === true) {
        result.message += '；⚠ 长连接组件未安装 —— 现在只能验证凭据，要在「可选组件」里装「飞书长连接」才能收消息';
      }
      setRuntime(id, result.ok ? 'verified' : 'error', result.message, result.detail);
      return { ...result, phase: result.ok ? 'verified' : 'error' };
    }

    if (id === 'dingtalk') {
      const env = await readPlatformEnv(id);
      const clientId = String(env.DINGTALK_CLIENT_ID ?? '').trim();
      const clientSecret = String(env.DINGTALK_CLIENT_SECRET ?? '').trim();
      const robotCode = String(env.DINGTALK_ROBOT_CODE ?? '').trim();
      if (clientId === '' || clientSecret === '') {
        const message = '请先填 Client ID（AppKey）和 Client Secret（AppSecret）';
        setRuntime(id, 'error', message);
        return { ok: false, phase: 'error', message };
      }

      if (isComponentInstalled('dingtalk-stream')) {
        // ⚠ 同飞书：先验凭据拿到精确原因，再起长连接
        const probe = await probeDingtalk({ clientId, clientSecret });
        if (probe.ok !== true) {
          setRuntime(id, 'error', `凭据不通：${probe.message}`);
          return { ok: false, phase: 'error', message: probe.message };
        }
        try { dingtalkLoop?.dispose(); } catch { /* ignore */ }
        dingtalkLoop = null;
        setRuntime(id, 'connecting', '正在建立 Stream 长连接…');
        const started = await startDingtalkStream({
          clientId,
          clientSecret,
          onInbound: (text) => recordStatus('dingtalk-inbound-text', { text: text.slice(0, 80) }),
          onEvent: (event, detail) => recordStatus(event, detail ?? {}),
        });
        if (started.ok !== true) {
          setRuntime(id, 'error', started.message);
          return { ok: false, phase: 'error', message: started.message };
        }
        dingtalkLoop = started;
        const extra = robotCode === '' ? '' : `；RobotCode 已保存（${robotCode.slice(0, 8)}…）`;
        setRuntime(id, 'connected', started.message + extra);
        return { ok: true, phase: 'connected', message: started.message + extra };
      }

      const result = await probeDingtalk({ clientId, clientSecret });
      // ⚠ RobotCode 在握手阶段用不上（发消息才要），但**必须读一下并反馈** ——
      //   否则界面上填了它却永远没回音，用户会以为填丢了。
      if (result.ok === true && robotCode !== '') {
        result.message += `；RobotCode 已保存（${robotCode.slice(0, 8)}…，发消息时用）`;
        result.detail = { ...(result.detail ?? {}), hasRobotCode: true };
      }
      if (result.ok === true) {
        result.message += '；⚠ 长连接组件未安装 —— 现在只能验证凭据，要在「可选组件」里装「钉钉长连接」才能收消息';
      }
      setRuntime(id, result.ok ? 'verified' : 'error', result.message, result.detail);
      return { ...result, phase: result.ok ? 'verified' : 'error' };
    }

    if (id === 'weixin') {
      // 已有 token（扫过码）→ 直接起长轮询，不用再扫
      const existing = readWeixinToken();
      if (existing !== null) return startWeixinWithLoop(existing);

      const login = await weixinStartLogin([]);
      if (login.ok !== true) {
        setRuntime(id, 'error', login.message);
        return { ...login, phase: 'error' };
      }
      weixinLogin = { qrcode: login.qrcode, qrUrl: login.qrUrl, startedAt: Date.now() };
      setRuntime(id, 'need-scan', '等你扫码');
      return { ok: true, phase: 'need-scan', needScan: true, qrcode: login.qrcode, qrUrl: login.qrUrl, message: login.message };
    }

    if (id === 'wecom') {
      const env = await readPlatformEnv(id);
      const botId = String(env.WECOM_BOT_ID ?? '').trim();
      const secret = String(env.WECOM_BOT_SECRET ?? '').trim();
      if (botId === '' || secret === '') {
        const message = '请先填机器人 ID 和 Secret（企业微信后台 → 应用管理 → 智能机器人）';
        setRuntime(id, 'error', message);
        return { ok: false, phase: 'error', message };
      }
      if (wecomLoop !== null) { wecomLoop.dispose(); wecomLoop = null; }
      wecomLoop = startWecomLoop({
        botId,
        secret,
        onInbound: (text) => { recordStatus('wecom-inbound-text', { text: text.slice(0, 80) }); },
        onEvent: (event, detail) => {
          recordStatus(event, detail ?? {});
          if (event === 'wecom-subscribed') setRuntime('wecom', 'connected', '长连接已就绪（能收消息；回复帧形状官方未公开，暂不回）');
          if (event === 'wecom-subscribe-rejected') setRuntime('wecom', 'error', `订阅被拒：errcode=${detail?.errcode ?? '?'} ${detail?.errmsg ?? ''}`);
          if (event === 'wecom-give-up') setRuntime('wecom', 'error', '反复连接失败，已停止重试 —— 检查网络或凭据');
        },
      });
      return { ok: true, phase: 'connecting', message: '正在建立长连接…几秒后看状态' };
    }

    return { ok: false, phase: 'error', message: `平台 ${String(id)} 还没有测试实现` };
  }

  /**
   * 从界面保存某个平台的凭据 —— **由宿主写**，不由浏览器写。
   *
   * ⚠ 为什么必须改成这样（这是一个已确认的真 bug）：
   *   客户端旧代码走 `ctx?.remote?.credentials`，而 `factory(require)` 里
   *   **根本没有绑定 `ctx`**（已核：全局搜 globalThis.ctx / window.ctx 均 0 命中）。
   *   对**未声明的标识符**，可选链 `ctx?.x` 照样抛 ReferenceError ——
   *   它被外层 `catch { written = false }` 吞掉，于是设置页点「连接」
   *   永远提示"没写进 Host 凭据存储"。静默失败，界面还以为自己试过了。
   *
   * 现在改成：浏览器 POST 到回环控制接口，宿主用 credentials 服务落盘，
   * 写完**回读确认**才算成功（别相信"写调用没抛错"就等于写进去了）。
   */
  async function savePlatformCredential(id, env) {
    const key = PLATFORM_CREDENTIAL_KEYS[id];
    if (key === undefined) return { ok: false, message: `未知平台：${String(id)}` };
    if (env === null || typeof env !== 'object') return { ok: false, message: '凭据内容不合法' };

    try {
      const credentials = ctx.credentials;
      if (typeof credentials?.modifyRecord !== 'function') {
        return {
          ok: false,
          message: '这台 DSH 的 credentials 服务缺少写方法（modifyRecord）—— 没法从界面保存，请用 dsh CLI 写',
        };
      }
      await credentials.modifyRecord(key, async () => ({ kind: 'api-key', env }));
      const written = await credentials.readRecord(key);
      if (written === undefined) {
        return { ok: false, message: '写入后回读为空 —— 凭据没保存成功' };
      }
      recordStatus('platform-credential-saved', { id, fields: Object.keys(env).length });
      return { ok: true, message: '凭据已保存到本机' };
    } catch (error) {
      recordStatus('platform-credential-save-failed', { id, message: describeError(error) });
      return { ok: false, message: `保存失败：${describeError(error)}` };
    }
  }

  /** 微信扫码轮询（界面每 1.5 秒调一次） */
  async function pollWeixinLoginOnce() {    if (weixinLogin === null) return { ok: false, message: '没有进行中的登录，请重新点「测试连接」', phase: 'error' };
    if (Date.now() - weixinLogin.startedAt > 5 * 60_000) {
      weixinLogin = null;
      setRuntime('weixin', 'error', '二维码已过期（5 分钟）');
      return { ok: false, message: '二维码已过期（5 分钟），请重新点「测试连接」', phase: 'error' };
    }
    const data = await weixinPollLogin(weixinLogin.qrcode);
    if (data?.status === 'confirmed' && typeof data?.bot_token === 'string' && data.bot_token !== '') {
      const token = data.bot_token;
      weixinLogin = null;
      writeWeixinToken(token);
      return startWeixinWithLoop(token);
    }
    if (data?.status === 'error') {
      const message = String(data?.message ?? '轮询出错');
      setRuntime('weixin', 'error', message);
      return { ok: false, message, phase: 'error' };
    }
    return { ok: true, pending: true, status: String(data?.status ?? 'wait'), message: '等扫码…', phase: 'need-scan' };
  }

  // ---- 可选组件（重 SDK）的安装 / 卸载 —— 见 components.js
  //
  // 为什么要有它：飞书/钉钉的长连接只能用官方 SDK（一个 35KB、一个 30MB），
  // 不能让所有用户被迫下载。所以做成"要这个能力就自己装"。
  //
  // ⚠ 启动时第一件事就是清理上次没删掉的组件 —— 必须赶在任何组件的
  //   动态 import 之前，否则文件被加载进内存就删不掉了（Windows 文件锁）。
  {
    const cleaned = applyPendingRemovals((line) => log(`[components] ${line}`));
    if (cleaned.length > 0) recordStatus('components-cleaned', { ids: cleaned });
  }

  /** pnpm 的输出缓冲 —— 界面要**流式**看到，否则"点了没反应"。 */
  const componentLog = [];
  const COMPONENT_LOG_MAX = 400;
  let componentBusy = '';

  function pushComponentLog(chunk) {
    for (const line of String(chunk ?? '').split(/\r?\n/)) {
      if (line.trim() === '') continue;
      componentLog.push(line.slice(0, 300));
    }
    while (componentLog.length > COMPONENT_LOG_MAX) componentLog.shift();
  }

  function getComponentsInfo() {
    return {
      ok: true,
      busy: componentBusy,
      components: listComponents(),
      log: [...componentLog],
      depsDir: DEPS_DIR,
    };
  }

  async function installComponentById(id) {
    if (componentBusy !== '') {
      return { ok: false, message: `正在忙（${componentBusy}），等它结束再试` };
    }
    componentBusy = id;
    componentLog.length = 0;
    pushComponentLog(`开始安装 ${String(id)} …`);
    recordStatus('component-install-start', { id });
    try {
      const result = await installComponent(id, pushComponentLog);
      recordStatus('component-install-done', { id, ok: result.ok === true, message: String(result.message).slice(0, 200) });
      return result;
    } catch (error) {
      const message = `安装出错：${describeError(error)}`;
      pushComponentLog(message);
      recordStatus('component-install-error', { id, message });
      return { ok: false, message };
    } finally {
      componentBusy = '';
    }
  }

  function removeComponentById(id) {
    componentLog.length = 0;
    pushComponentLog(`开始卸载 ${String(id)} …`);
    try {
      const result = removeComponent(id);
      if (result.pending === true) pushComponentLog('文件被占用 —— 已安排重启后清理');
      recordStatus('component-remove-done', { id, ok: result.ok === true, pending: result.pending === true });
      return result;
    } catch (error) {
      const message = `卸载出错：${describeError(error)}`;
      pushComponentLog(message);
      recordStatus('component-remove-error', { id, message });
      return { ok: false, message };
    }
  }

  // ---- 驱动问题（踩过的大坑）：
  // DSH 里"驱动 agent 跑 turn"的是 GUI 会话那条链路。插件自己用
  // ctx.agents.resume()/create() 弄出来的 agent 没有驱动 —— 消息能进收件箱
  // （会话日志里有 agent/inbox/spliced），但永远不出现 turn/start，
  // 也就永远等不到回答。
  //
  // 所以：优先把 QQ 消息投进**活动的 GUI 会话**（它天然有驱动）。
  // liveSessions 按创建顺序记录活动会话，取最近的一个作为目标。
  const liveSessions = [];
  // 每个会话一条队列：会话忙时排队，空闲时投递
  const queues = new Map();   // sessionId → [{ text, openid, msgId }]
  /**
   * 正在等回答的会话：sessionId → 置忙的时刻（ms）。
   *
   * ⚠ 为什么是 Map 而不是 Set（这里踩过一个致命 bug）：
   *
   *   原来用 `new Set()`，而 `busy` 只在两处清除 —— 投递失败时、以及
   *   `finishTurn()` 的 `.finally()` 里。但 `finishTurn` 是**由 `turn/end` 事件驱动**的：
   *   那个事件只要漏掉一次（或者 `finishTurn` 提前 return），`busy` 就永远不清，
   *   于是 `pumpQueue` 每次都在第一行 `if (busy.has(...)) return` 就回去了 ——
   *   **整条对话永久卡死，后续所有消息都堆在队列里再也不被处理。**
   *
   *   实测症状：第二条 QQ 消息 `queued` 之后，`pump-delivering` 那条日志
   *   **从未出现**，用户等几分钟也收不到任何回复。
   *
   *   改成 Map 存时间戳 + 看门狗（见 BUSY_TIMEOUT_MS），超时强制解封并记日志。
   *   宁可偶尔重复投递一条，也不要让会话永久卡死。
   */
  /**
   * 「忙」状态 —— 用可测试的 busy-tracker 模块，不再内联实现。
   *
   * ⚠ 为什么必须抽出去：这里踩过一个**造成真实故障**的 bug（2026-09-26）——
   *   同一个"正在处理中"有**两个键**：
   *     · **队列键** `qq-8B099DA5A8D0`（按 QQ 用户分组），`pumpQueue` 设在它上面
   *     · **会话键** `im-bridge-dedicated-v1`（agent.id），`finishTurn` 清的是它
   *   结果队列键永远占着 → 第二条消息卡死 → 用户在手机上什么都收不到。
   *   连看门狗都犯同一个错，所以自愈也失效。
   *
   *   这个 bug 读代码很难发现：两边单独看都是对的，**错在它们不是同一个键**
   *   （和经验库 E16 同类）。所以做成模块 + 单元测试
   *   （tools/verify/verify-busy-tracker.mjs，21 项，含该场景的复现）。
   */
  const busy = createBusyTracker();
  const markBusy = (...keys) => busy.mark(...keys);
  const clearBusy = (key) => busy.clear(key);
  const isBusy = (key) => busy.isBusy(key);
  const busyHeldMs = (key) => busy.heldMs(key);

  /**
   * 该键（或它的任一别名）名下**待处理消息总数**。
   *
   * 为什么要按别名累加：队列是按**队列键**存的（`qq-${openid.slice(0,12)}`），
   * 而调用方常常拿**会话键**来问。原来直接 `queues.get(会话键)` ——
   * 那个键下从来没有队列，于是面板上"排队 N"**永远显示 0**
   * （另一个被同一个"两个键"问题掩盖的 bug）。
   */
  function queueDepth(key) {
    const keys = new Set([key, ...busyAliasKeys(key)]);
    let total = 0;
    for (const k of keys) total += (queues.get(k) ?? []).length;
    return total;
  }

  /** 取某个键的所有别名（含它自己）—— 供 queueDepth 和日志用 */
  function busyAliasKeys(key) {
    const group = busy.aliasesOf(key);
    return group.length > 0 ? group : [key];
  }

  /**
   * 看门狗 timeout（毫秒）。
   *
   * 为什么是 45 秒：一轮正常回复大约 2~30 秒（实测最长 22 秒的流式回复）。
   * 超过 45 秒还没等到 turn/end，几乎肯定是事件漏了而不是模型在慢慢想。
   *
   * ⚠ 原来是 180 秒 —— 实测发现用户在 10 秒内就等不下去了
   *   （那条 pump-give-up 之后他在手机上什么也看不到）。
   *   宁可偶发一次重复投递，也不要让用户对着"石沉大海"干等 3 分钟。
   */
  const BUSY_TIMEOUT_MS = 45_000;
  /** 看门狗检查间隔 */
  const WATCHDOG_INTERVAL_MS = 15_000;
  let watchdog = null;

  let qq = null;          // 当前活动的 QQ 连接
  let credential = null;  // { appId, appSecret }

  /**
   * 把旧键的凭据迁移到新键（一次，幂等）。
   *
   * 背景：2026-09-26 把凭据键从 `qq-bridge/bot` 改成 `im-bridge/bot`。
   * 如果不迁移，用户升级后表现为"连不上 QQ"，而设置页是空的 ——
   * 他会以为凭据丢了，其实只是键名变了。
   *
   * 契约（`credentials` 服务，已查证）：
   *   readRecord(key) → CredentialRecord | undefined
   *   modifyRecord(key, mutate) → 唯一的写路径（串行读-改-写）
   *   deleteRecord(key) → 删（删不存在的键是 no-op）
   *   ApiKeyRecord = { kind: 'api-key', key?, env?: Record<string,string> }
   *
   * 幂等性靠三点保证：
   *   ① 新键已有记录 → 直接返回，什么都不做
   *   ② 旧键没有记录 → 直接返回
   *   ③ **先写新键成功、再删旧键** —— 顺序反了的话，写失败就永久丢凭据
   */
  async function migrateCredentialKey() {
    const credentials = ctx.get?.('credentials');
    if (credentials?.readRecord === undefined) return;

    /**
     * ⚠ 必须先确认**每个**要用的方法都在（2026-10-07 实测踩到）。
     *
     * 第一次跑迁移时报的是：
     *   credential-migrate-error  "credentials.modifyRecord is not a function"
     * 而原因是我只检查了 `readRecord` 存在，就直接调了 `modifyRecord` ——
     * **注释里抄对了契约，代码里只守了一半**。
     *
     * 教训的通用形式：**从接口声明里抄来的方法列表，不等于运行时每个都已实现。**
     * 抽象服务尤其如此（`credentials` 的说明里就写着这几个方法是 `abstract`）。
     * 所以要用哪个方法，就在用之前确认哪个存在 ——
     * 这样缺方法时得到的是一条**说得清的诊断**，而不是一句
     * "xxx is not a function" 让你去猜是谁的问题。
     */
    const missing = ['readRecord', 'modifyRecord', 'deleteRecord']
      .filter((m) => typeof credentials[m] !== 'function');
    if (missing.length > 0) {
      recordStatus('credential-migrate-unavailable', {
        missing,
        note: 'credentials 服务缺写方法 —— 迁移跳过（不影响已配好的新键）',
      });
      return;
    }

    try {
      // ① 新键已有 → 无事可做（这是"跑过多次也安全"的关键一步）
      const existing = await credentials.readRecord(CREDENTIAL_KEY);
      if (existing !== undefined) return;

      // ② 旧键没有 → 无事可做
      const legacy = await credentials.readRecord(LEGACY_CREDENTIAL_KEY);
      if (legacy === undefined) return;

      recordStatus('credential-migrate-start', {
        from: LEGACY_CREDENTIAL_KEY,
        to: CREDENTIAL_KEY,
        kind: legacy.kind ?? null,
        hasEnv: legacy.env !== undefined,
      });

      // ③ 写新键（modifyRecord 是唯一写路径；返回 undefined 表示不改）
      await credentials.modifyRecord(CREDENTIAL_KEY, async () => legacy);

      // ④ 回读确认写成功了，**再**删旧键
      const written = await credentials.readRecord(CREDENTIAL_KEY);
      if (written === undefined) {
        recordStatus('credential-migrate-failed', {
          reason: '写新键后回读为空 —— 保留旧键不动',
          from: LEGACY_CREDENTIAL_KEY,
        });
        return;
      }

      await credentials.deleteRecord(LEGACY_CREDENTIAL_KEY);
      recordStatus('credential-migrated', {
        from: LEGACY_CREDENTIAL_KEY,
        to: CREDENTIAL_KEY,
        // 只报"有没有值"，不把 secret 写进日志
        hasAppId: String(written.env?.QQ_BOT_APPID ?? '').length > 0,
        hasSecret: String(written.env?.QQ_BOT_SECRET ?? '').length > 0,
      });
      log(`凭据已从 ${LEGACY_CREDENTIAL_KEY} 迁移到 ${CREDENTIAL_KEY}`);
    } catch (error) {
      // 迁移失败不能影响主流程：旧键还在，用户最多是"要重填一次"
      recordStatus('credential-migrate-error', {
        from: LEGACY_CREDENTIAL_KEY,
        to: CREDENTIAL_KEY,
        message: String(error?.message ?? error),
      });
    }
  }

  // ---- 凭据：从 credentials 服务读取记录
  /**
   * 读 QQ 的连接凭据（`{ appId, appSecret }`）。
   *
   * ⚠ **这个函数有意是 QQ 专用的**（2026-10-08 核对过）：
   *   · 只有 QQ 的 `restartConnection` 用它，返回值就是 QQ 客户端的两个入参
   *   · 其它平台的凭据由各自的 `testPlatform` 分支通过 `readPlatformEnv(id)` 读
   *   · 而"设置页要看的凭据状态"走 `getCredentialInfo(id)` —— 那个是**通用**的
   *
   *   所以这里出现 `QQ_BOT_*` 字段名不是漏改，是它的职责本来就是"给 QQ 客户端备料"。
   *   （判断依据：一个函数里出现平台专属字段名**没错**，错的是"本该通用却写死"。
   *     `getCredentialInfo` 原来就是后者，已改成按平台。）
   */
  async function readCredential() {
    try {
      const record = await ctx.credentials.readRecord(CREDENTIAL_KEY);
      if (record === undefined || record.kind !== 'api-key') return null;
      const env = record.env ?? {};
      const appId = String(env.QQ_BOT_APPID ?? record.key ?? '').trim();
      const appSecret = String(env.QQ_BOT_SECRET ?? '').trim();
      if (appId === '' || appSecret === '') return null;
      return { appId, appSecret };
    } catch (error) {
      log(`读取凭据失败：${error.message}`);
      return null;
    }
  }

  /**
   * 凭据的**只读状态**，供设置页显示"到底配好了没有"。
   *
   * 为什么需要它（2026-10-07 用户反馈"设置页里凭据消失"）：
   *   设置页原来的输入框初值只来自**浏览器的 localStorage**
   *   （`loadConfig()` 读 `dsh-plugin-qq-bridge.config`），
   *   而真正的凭据在**宿主的 credentials 存储**里 —— 两个真相来源。
   *   于是 localStorage 一被清（换包名/清缓存/换机器），界面就显示空白，
   *   但插件其实工作正常 —— **界面在骗人**。
   *
   * 修法：界面以**宿主为准**。这个函数就是那个"宿主的事实"。
   *
   * ⚠ `id` 参数（2026-10-08 加）：原来只支持 QQ。现在每个平台那一行
   *   都要显示自己的"已保存 / 还没填"，所以必须能按平台查。
   *   不传时默认 qq，向后兼容。
   *
   * ⚠ **绝不返回 secret** —— 凭据不是配置，能拿它去调平台 API。
   *   只报：配没配、每个非密字段的长度与尾 4 位、以及从哪读到的。
   */
  async function getCredentialInfo(id = 'qq') {
    try {
      if (!PLATFORM_IDS.includes(id)) {
        return { configured: false, reason: `unknown-platform:${String(id)}` };
      }
      const env = await readPlatformEnv(id);
      const fields = PLATFORM_CREDENTIAL_FIELDS[id] ?? { plain: [], secret: [] };

      // 缺失判据：**所有**非密字段 + **所有**密字段都得有值。
      //   不逐个平台写 if —— 那样每加一个平台就要改这个函数（E19：把规则变成结构）。
      const missing = [
        ...fields.plain.filter((key) => String(env[key] ?? '').trim() === ''),
        ...fields.secret.filter((key) => String(env[key] ?? '').trim() === ''),
      ];
      if (missing.length > 0) {
        return {
          configured: false,
          reason: Object.keys(env).length === 0 ? 'no-record' : 'incomplete',
          missing,
        };
      }

      const first = String(env[fields.plain[0]] ?? '').trim();
      return {
        configured: true,
        hasSecret: true,
        // 只给尾 4 位 + 长度：够确认"是哪一份"，但不足以拼出完整凭据
        appIdTail: first.length > 4 ? first.slice(-4) : first,
        appIdLength: first.length,
        // 当前连接状态也一起给它 —— 界面能在一处说清"配好了"和"连上了"
        connected: getPlatformRuntime(id)?.phase === 'connected',
      };
    } catch (error) {
      return { configured: false, reason: 'read-failed', message: String(error?.message ?? error).slice(0, 120) };
    }
  }

  /** 断开旧连接、按当前凭据建立新连接 —— 用户改完凭据后调用 */
  async function restartConnection(reason) {
    if (qq !== null) {
      qq.dispose();
      qq = null;
    }
    recordStatus('restart-connection', { reason });
    // ⚠ QQ 的状态也要进 platformRuntime（2026-10-08 修）。
    //   原来这条路径**只**调 writeStatusSnapshot（那是另一个快照对象），
    //   而设置页读的是 `setRuntime` 写的那份 `platformRuntime` ——
    //   于是 QQ 明明连着、能收发，界面上却一直显示初始值 "idle"，
    //   对应词就是「未测试」。用户的原话："理论上来说，QQ 应该也是已连接才对"
    //   —— 他是对的，是我们没有把状态报上去。
    setRuntime('qq', 'connecting', `正在连接（${reason}）…`);
    credential = await readCredential();
    if (credential === null) {
      log(`没有可用凭据（${reason}）——请在「设置 → 连接 QQ」里填写`);
      recordStatus('no-credential', { reason });
      writeStatusSnapshot({ phase: 'no-credential', reason });
      // 没有凭据 = 需要人动手，既不是"错误"也不是"未测试"。
      // 界面照实说清缺什么，比一个灰扑扑的"未测试"有用得多。
      setRuntime('qq', 'no-credential', '还没填 AppID / Secret（展开这一行填写）');
      return;
    }
    recordStatus('credential-loaded', { appId: credential.appId, reason });

    qq = new QqClient({
      appId: credential.appId,
      appSecret: credential.appSecret,
      sandbox: config.sandbox !== false,
      log,
    });

    qq.onMessage = async (payload) => {
      const type = payload?.t;
      const data = payload?.d ?? {};
      recordStatus('qq-event', { type });

      if (type === 'READY') {
        const bot = data.user?.username ?? '?';
        log(`已就绪：${bot}`);
        recordStatus('ready', { bot: data.user?.username ?? null });
        writeStatusSnapshot({ phase: 'connected', bot: data.user?.username ?? null, sandbox: config.sandbox !== false });
        // ★ 这一行原来漏了 —— 设置页读的是 platformRuntime，不是上面那个快照。
        //   不写它，QQ 就会永远停在 "idle"（界面显示「未测试」），
        //   而它其实已经能收发了。用户正是看出了这个矛盾。
        setRuntime('qq', 'connected', `已连接 —— 机器人 ${bot}，可以收发消息`);
        return;
      }

      if (type === 'C2C_MESSAGE_CREATE') {
        const text = String(data.content ?? '').trim();
        const openid = data.author?.user_openid;
        recordStatus('c2c-message', { openid: openid ?? null, text: text.slice(0, 80) });
        if (openid === undefined || text === '') return;

        // 去重：同一条消息被平台重推时只处理一次（判据是平台消息 id）
        if (!rememberInbound(typeof data.id === 'string' ? `qq:${data.id}` : '')) {
          recordStatus('dedup-dropped', { platform: 'qq', messageId: String(data.id ?? '').slice(0, 48) });
          return;
        }

        // ⚠ 必须用「非空字符串才算数」的判断，不能用 ?? ——
        // Config schema 把 sessionId 默认成 ''，而 '' 不是 null/undefined，
        // `config.sessionId ?? …` 会直接选中空串，导致 create() 报
        // "cannot encode an empty path segment"。
        const sessionId = firstNonEmpty([
          config.sessionId,
          bindings.get(openid),
          `qq-${openid.slice(0, 12)}`,
        ]);
        bindings.set(openid, sessionId);
        // 队列按"QQ 用户"分组即可 —— 真正的投递目标由 resolveTargetAgent 决定
        enqueueDelivery(sessionId, text, openid, data.id);
        return;
      }

      if (type === 'GROUP_AT_MESSAGE_CREATE') {
        // 群里 @机器人：剥掉 <@!xxx> 前缀
        const text = String(data.content ?? '').replace(/<@!?\d+>/g, '').trim();
        log(`群消息（本版暂不回复）：${text.slice(0, 40)}`);
        recordStatus('group-message', { text: text.slice(0, 80) });
        return;
      }
    };

    qq.connect().catch((error) => {
      log(`连接失败：${error.message}`);
      recordStatus('connect-error', { message: error.message });
      writeStatusSnapshot({ phase: 'error', error: error.message });
    });
    log(`正在连接 QQ（${reason}）`);
    recordStatus('connecting', { reason, sandbox: config.sandbox !== false });
  }

  /** QQ 会话用哪个角色预设。留空默认 standard。 */
  const presetId = firstNonEmpty([config.agentPreset, 'standard']);

  /**
   * QQ 会话的权限预设。留空默认 `danger-full-access`。
   *
   * 为什么默认不是 workspace-write：见 Config 里那段说明 ——
   * QQ 会话是**无人值守**的，任何需要人工批准的预设都会卡死
   * （批准框在桌面上，手机看不到）。而且本机的 workspace-write 沙箱起不来。
   */
  const permissionPresetId = firstNonEmpty([config.permissionPreset, 'danger-full-access']);

  /**
   * 给会话设权限预设。
   *
   * 契约（`permissionPresets` 服务）：
   *   set(session: Session, name: string): void
   *   current(session): string     // 读回生效值，用于核对
   *   resolve(name): { sandbox, approval }
   *
   * ⚠ 参数是 **Session 对象**，不是 sessionId 字符串 ——
   *   （正确用法照抄 dsh-webhook：`ctx.permissionPresets.set(handle.agent.session, name)`）
   *
   * ⚠ **不要用 `agent.session`**（这里踩过，2026-09-26）：
   *   `agent.session` 是个**惰性代理属性** —— 直接访问会抛
   *     Error: cannot get property "session" without inject
   *   它要求先把 `agents` 服务注入到**那个上下文**。`dsh-webhook` 能用是因为
   *   它自己的模块声明了 inject；本插件的作用域不同，照抄就炸。
   *
   *   而且这个炸法很隐蔽：它在 setup 回调里抛 → 整个 create/resume 失败
   *   → 日志里只看到 "dedicated-create-failed"，很容易以为是别的原因。
   *
   *   现在改用 `ctx.sessions.get(id)` —— 这条路是已验证的
   *   （getPanelMessages 一直用它读会话历史，一直正常）。
   *
   * 为什么必须在**第一轮之前**设好：权限决定 shell 工具怎么起沙箱。
   * 设晚了，第一轮已经用旧预设跑过了 —— 而"第一轮"通常就是用户真正要干的事。
   */
  function applyPermissionPreset(sessionId) {
    const presets = ctx.get?.('permissionPresets');
    if (presets?.set === undefined) {
      recordStatus('permission-preset-missing', { sessionId, wanted: permissionPresetId });
      return;
    }
    try {
      // ⚠ 用 sessions 服务取 Session 对象（不要碰 agent.session —— 见上面的说明）
      const session = ctx.get?.('sessions')?.get?.(sessionId);
      if (session === undefined || session === null) {
        recordStatus('permission-preset-no-session', { sessionId, wanted: permissionPresetId });
        return;
      }
      presets.set(session, permissionPresetId);
      // 读回核对 —— 设错了要当场知道，而不是等第一轮失败
      const effective = presets.current?.(session) ?? null;
      const spec = (() => { try { return presets.resolve?.(effective) ?? null; } catch { return null; } })();
      recordStatus('permission-preset-set', {
        sessionId,
        wanted: permissionPresetId,
        effective,
        sandbox: spec?.sandbox ?? null,
        approval: spec?.approval ?? null,
        ok: effective === permissionPresetId,
      });
    } catch (error) {
      recordStatus('permission-preset-failed', {
        sessionId,
        wanted: permissionPresetId,
        message: String(error?.message ?? error),
      });
    }
  }

  /**
   * 把 agent 绑到 preset —— **这是"机器人办不了公"的根因所在**（2026-09-26 定位）。
   *
   * ── 症状 ──────────────────────────────────────────────────────────
   * 手机发「请查看我 D 盘有哪些文件」，机器人回答：
   *   "本会话没有文件/命令工具（只有 load_workspace_dependencies 和 record_experience）"
   *
   * ── 证据（从会话日志的 request/header 里逐次读出来的）──────────────
   *   seq=13  reason=initial  工具 **28** 个（pwsh/read/write/edit/glob/grep 都在）
   *   seq=30  reason=resume   工具 **2** 个  ← 全丢了
   *   之后每次 resume 都是 2 个
   *   而主会话（不经 resume）始终 30 个 → **不是 preset 定义的问题，是绑定没生效**
   *
   * ── 根因 ──────────────────────────────────────────────────────────
   * 原来这里调的是 `agentPresets.select(agent, id)`，而它的契约是：
   *   "Select a preset **before a session starts its first turn**"
   * 所以只有"刚创建、还是 blank"的会话能选中；**一旦 resume 过就报
   * "This session has already started"** → preset 没绑上 → 只剩全局层注册的工具
   * （`load_workspace_dependencies` 是全局的、`record_experience` 是 dev-tools
   *   在全局注册的 —— 正好就是残留的那两个）。
   *
   * 也就是说：日志里那条一直被当成"无害噪音"的 `preset-select-failed`
   * **就是"机器人没有工具"的真正原因**。
   *
   * ── 正确写法（照抄 dsh-webhook 的官方用法）────────────────────────
   *   const preset = await ctx.agentPresets.resolve(id);
   *   ctx.agentPresets.mount(agentCtx, preset.id)     // mount 的契约是
   *     "Bind an **unpublished** Agent to the current preset revision"
   *   —— setup 回调正好是在发布之前跑的，所以 create / resume **两条路都能绑上**。
   */
  /**
   * 给"经 IM 转达"的会话注入通道纪律（见 CHANNEL_DISCIPLINE）。
   *
   * 契约（照抄 dsh-wecom-plugin/src/bridge.js:1051 —— 那是已验证的写法）：
   *   agentCtx.systemPrompt.section({ name, order, text })
   *   order 取 `getSectionOrder('DEPLOYMENT_PERSONA_PREFIX')`：DSH 0.1.5+ 把
   *   `DEPLOYMENT_PERSONA` 拆成了 PREFIX/SUFFIX，前缀键是权威的（order 0）。
   *   `?? 0` 只是"order 必须是有限数"的兜底 —— section() 遇到非有限数会抛。
   *
   * ⚠ 注入失败**不能让 create/resume 失败**（和 bindPreset 同一原则）：
   *   setup 里抛错会导致整个会话建不起来。所以整体 try/catch + 记状态日志。
   */
  function applyChannelPrompt(agentCtx) {
    const systemPrompt = agentCtx?.systemPrompt;
    if (typeof systemPrompt?.section !== 'function') {
      recordStatus('channel-prompt-skipped', { reason: 'systemPrompt.section 不可用' });
      return;
    }
    try {
      const order = systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_PREFIX') ?? 0;
      systemPrompt.section({ name: 'im-bridge-channel-discipline', order, text: CHANNEL_DISCIPLINE });
      recordStatus('channel-prompt-applied', { order });
    } catch (error) {
      recordStatus('channel-prompt-failed', { message: String(error?.message ?? error).slice(0, 200) });
    }
  }

  async function bindPreset(agentCtx, agent) {
    const presets = ctx.get('agentPresets');
    if (presets === undefined) {
      recordStatus('preset-service-missing', { presetId });
      return;
    }

    // ① 先解析出 preset 本体（resolve 不启动 agent，很轻）
    let variant = null;
    try {
      variant = await presets.resolve(presetId);
    } catch (error) {
      recordStatus('preset-resolve-failed', { presetId, message: String(error?.message ?? error) });
      return;
    }

    // ② mount —— 这是唯一的正确绑定入口（select 只对 blank 会话有效）
    try {
      const bound = await presets.mount(agentCtx ?? agent?.ctx, variant?.id ?? presetId);
      recordStatus('preset-mounted', {
        presetId,
        resolved: variant?.id ?? null,
        bound: bound?.id ?? bound ?? null,
      });
    } catch (error) {
      recordStatus('preset-mount-failed', {
        presetId,
        message: String(error?.message ?? error),
        // 挂不上就等于没有工具 —— 这条日志要足够醒目
        impact: 'agent 会只剩全局工具，办不了公',
      });
      return;
    }

    // ③ 核对：绑上之后 composedPreset 应该能读出 id
    try {
      const composed = presets.composedPreset?.(agentCtx ?? agent?.ctx);
      recordStatus('preset-verify', { presetId, composed: composed ?? null, ok: composed !== undefined });
    } catch { /* 核对失败不影响主流程 */ }
  }

  /**
   * 把一条 QQ 消息排队投递。
   *
   * 为什么要排队：DSH 的 agent 收件箱里的消息会在**同一个 turn 里被一起处理**，
   * 也就是说两条 QQ 消息先后到达时，会合并成一个回合、只产生一个回答 ——
   * 那样两条消息只能收到一个回复。串行化可以保证"一条消息一个回答"。
   */
  function enqueueDelivery(sessionId, text, openid, msgId, opts = {}) {
    const list = queues.get(sessionId) ?? [];
    // `opts` 承载"这条消息从哪来、怎么回"——多平台引入的（2026-10-08）。
    //    platform  —— 'qq' / 'weixin' / …（决定回复走哪个传输）
    //    reply     —— **这条消息专属**的回复闭包。
    //                 ⚠ 微信的回复必须带上那条消息的 context_token，
    //                 所以它是消息级能力，不能用一个全局 send 代替。
    //                 为 undefined 时退回旧的"按平台查表"路径。
    list.push({ text, openid, msgId, platform: opts.platform ?? 'qq', reply: opts.reply });
    queues.set(sessionId, list);
    recordStatus('queued', { sessionId, platform: opts.platform ?? 'qq', pending: list.length });
    pumpQueue(sessionId).catch((error) => {
      recordStatus('pump-failed', { sessionId, message: String(error?.message ?? error) });
    });
  }

  /**
   * 串行泵：会话空闲时取一条投递，投递后置忙，等 turn/end 再继续。
   *
   * 为什么必须串行：DSH 会把**同一个 turn 内的多条收件箱消息合并处理**，
   * 两条 QQ 消息会只产生一个回答。串行化保证"一条消息一个回答"。
   *
   * ⚠ 忙的时候**不能就这样丢下不管**（这里也踩过）：
   *   原来第一行是 `if (busy.has(sessionId)) return;` —— 直接返回，什么都不做。
   *   于是"消息在忙碌期间到达"就完全依赖"忙碌结束时有人再调一次 pumpQueue"。
   *   而忙碌结束只发生在 `finishTurn` 里；那条路一旦没走到，队列就永远不动了。
   *
   *   实测症状：第二条消息 `queued` 之后 `pump-delivering` **从未出现**，
   *   队列里的消息永久滞留。
   *
   *   现在：忙的时候**短暂重试**（有上限），而不是直接放弃。
   */
  async function pumpQueue(sessionId, attempt = 0) {
    // ── 0. 自愈：置忙已超时 → 当场解封，不等看门狗 ──────────────────────
    //
    // 为什么放在这里而不是只靠看门狗：看门狗最长要等一个完整周期，
    // 而这条路径是**用户正在等回复**的关键路径。发现超时就立刻接管，
    // 让恢复时间从"最多 timeout + 周期"降到"最多 timeout"。
    const held = busyHeldMs(sessionId);
    if (held >= BUSY_TIMEOUT_MS) {
      recordStatus('busy-timeout-inline-unlock', { sessionId, heldMs: held, keys: clearBusy(sessionId) });
    }

    if (isBusy(sessionId)) {
      // 忙 → 等一下再试。
      //
      // ⚠ 实测踩到的坑（2026-09-26）：第二条 QQ 消息进来时 busy 仍被占着，
      //   重试 40 次全部失败 → `pump-give-up`，用户在手机上等了 10 秒什么都没有。
      //   而日志里明明有 `busy-released`。
      //
      //   **根因已定位**：`busy` 有**两个别名键** ——
      //     队列键 `qq-8B099DA5A8D0`（按 QQ 用户分组）和
      //     会话键 `im-bridge-dedicated-v1`（专用会话/agent 的 id）。
      //   `pumpQueue` 设在**队列键**上，而 `finishTurn` 清的是**会话键** ——
      //   于是队列键永远占着。看门狗也犯同一个错，所以自愈同样失效。
      //   现在用 markBusy / clearBusy / isBusy 统一处理两个别名（见它们的注释）。
      //
      //   另外：重试上限放宽到覆盖整个 BUSY_TIMEOUT_MS
      //   （45 秒 / 250 毫秒 = 180 次），期间一旦置忙超时会在上面被自愈解封。
      //   换句话说：**卡住最多 45 秒必然恢复**，而不是靠调用方碰运气。
      const MAX_ATTEMPT = Math.ceil(BUSY_TIMEOUT_MS / 250) + 4;

      if (attempt === 0) {
        // 只在第一次进入时记一条（否则几百次重试会把日志刷爆）
        recordStatus('pump-blocked', {
          sessionId,
          keys: busyAliasKeys(sessionId),
          busyForMs: held,
          timeoutMs: BUSY_TIMEOUT_MS,
          queued: queueDepth(sessionId),
        });
      }
      if (attempt >= MAX_ATTEMPT) {
        recordStatus('pump-give-up', {
          sessionId,
          attempt,
          queued: queueDepth(sessionId),
          keys: busyAliasKeys(sessionId),
          busyForMs: busyHeldMs(sessionId),
        });
        // 放弃之前**先告诉用户** —— 否则手机那头是"石沉大海"。
        // 这条走主动推送（没有 msg_id 可用），失败也无所谓。
        //
        // ⚠ 按平台选通道（2026-10-08 改）：原来写死 `qq?.reply`，
        //   微信场景下它会是 undefined → **提示静默不发**。
        const stuck = queues.get(sessionId) ?? [];
        const notice = '（上一条还在处理，请稍后再发一次）';
        if (stuck.length > 0) {
          const job = stuck[0];
          const send = typeof job.reply === 'function'
            // 消息级回复闭包优先（微信必需，它要带 context_token）
            ? () => job.reply(notice)
            : (job.platform ?? 'qq') === 'qq' && qq !== null
              ? () => qq.reply(job.openid, notice, undefined, (ev, d) => recordStatus(ev, d))
              : null;
          if (send === null) {
            recordStatus('pump-give-up-notice-skipped', {
              sessionId,
              platform: job.platform ?? 'qq',
              note: '这个平台没有可用的发送通道，提示发不出去',
            });
          } else {
            Promise.resolve(send()).catch((error) => {
              recordStatus('pump-give-up-notice-failed', { message: String(error?.message ?? error) });
            });
          }
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 250));
      return pumpQueue(sessionId, attempt + 1);
    }

    const list = queues.get(sessionId);
    if (list === undefined || list.length === 0) return;

    const job = list.shift();
    // 先用队列键登记；`deliverToAgent` 解析出 agent 后会补上会话键
    //（见它里面的 markBusy 调用）—— 这样两侧的检查都能看到"忙"。
    markBusy(sessionId);
    recordStatus('pump-delivering', { sessionId, remaining: list.length });
    try {
      await deliverToAgent(sessionId, job.text, job.openid, job.msgId, {
        platform: job.platform,
        reply: job.reply,
      });
    } catch (error) {
      clearBusy(sessionId);
      recordStatus('deliver-failed-in-pump', { sessionId, message: String(error?.message ?? error) });
      throw error;
    }
  }

  /**
   * 看门狗：清理"置忙超时"的会话，并把它的队列接着泵下去。
   *
   * 为什么必须有它：`busy` 的清除依赖 `turn/end` 事件。
   * 那个事件只要漏掉一次，会话就**永久卡死**，而且没有任何自愈路径。
   * 宁可偶尔重复投递一条，也不要让用户等一辈子。
   */
  function startWatchdog() {
    if (watchdog !== null) return;
    watchdog = setInterval(() => {
      // ⚠ 用 busy.groups() 而不是逐个键遍历 —— 一个"忙"登记了多个别名，
      //   逐键遍历会把同一次卡住当成多个会话，重复解封并重复泵送。
      //   groups() 已经按分组去重（见 busy-tracker.js）。
      for (const group of busy.groups()) {
        if (group.heldMs < BUSY_TIMEOUT_MS) continue;

        // 记下**全部别名**：日志里能同时看到队列键和会话键，
        // 下次再有"清了但没清干净"一眼就能看出来。
        const released = clearBusy(group.key);
        recordStatus('busy-timeout-unlock', {
          key: group.key,
          keys: released,
          heldMs: group.heldMs,
          queued: queueDepth(group.key),
        });
        // 队列是按**队列键**存的，所以对每个别名都试一次泵送
        for (const k of released) {
          pumpQueue(k).catch((error) => {
            recordStatus('pump-failed-after-unlock', { key: k, message: String(error?.message ?? error) });
          });
        }
      }
    }, WATCHDOG_INTERVAL_MS);
  }

  /**
   * 专用 QQ 会话的 id（固定，不随用户开哪个会话而变）。
   *
   * **v2 的原因**：v1（'im-bridge-dedicated'）在"没绑 preset + 没给模型"的状态下
   * 已经开跑过一轮，导致：
   *   · preset-select-failed: "This session has already started"（绑不上了）
   *   · 缺 {{model}} → turn/end reason = "error"
   * 换句话说那个会话是**污染状态**，改 id 让它以干净状态重建。
   *
   * **v3 的原因**：v2 建的时候**还没有** `meta.origin = 'subagent'`
   * （见下面 create 调用处的说明），所以它以普通会话身份出现在侧边栏列表里。
   * 而"换个 id"是唯一能**强制重建**的手段 —— 因为 v2 的持久化记录里
   * 没有 subagent 标记，`resume` 会成功、会话继续留在内存里，
   * 那样无论怎么删磁盘文件都会被 flush 写回。
   *
   * 所以 v3 = 第一个以 `origin:'subagent'` 创建、因而**不进会话列表**的世代。
   * 换 id 的副作用是丢掉 v2 那段测试历史 —— 那本来就是测试数据，不要了。
   *
   * **v4 的原因**（2026-09-26）：v3 的**历史被污染了**。
   *
   * 经过：v3 用 `select()` 绑 preset（错的，见 bindPreset 的说明），
   * 所以每次 resume 后工具从 28 个掉到 2 个。模型于是在对话里反复写下
   * "本会话只有 load_workspace_dependencies 和 record_experience"、
   * "read/glob/grep 全部 unknown tool"，并把这些断言**留在会话历史里**。
   *
   * 修好绑定之后（改用 `mount()`）工具确实回来了 —— 实测 seq=128 那次请求
   * 带了完整的 28 个工具、schema 齐全。但模型**一个都没试**，
   * 因为它读的是自己历史里那句"我没有工具"，然后照着继续编。
   *
   * 也就是说：**工具已经修好，但脏历史不会自己消失** ——
   * 只要还 resume 同一个会话，模型就会继续相信自己"没有工具"。
   * 换 id 开新会话，是让"已修好的能力"真正生效的最直接手段。
   *
   * ⚠ 这条经验的通用形式：**"能力修好了"和"对方相信自己有能力"是两件事。**
   *   当一个 agent 在对话里形成了关于自身能力的错误结论，那个结论会被
   *   后续每一轮继承下去 —— 改代码解决不了，得换上下文。
   */
  const DEDICATED_SESSION_ID = 'im-bridge-dedicated-v1';

  /**
   * 按平台派生"专用会话 id"（2026-10-08 加，多平台引入）。
   *
   * 为什么要按平台分：
   *   · 各平台的上下文互不干扰（微信里的对话不会串到 QQ 的会话里）
   *   · 面板能按平台分开（client.js 里每个平台已注册独立 panelId）
   *   · 每个平台可以有不同的模型 / 权限设置
   *
   * ⚠ **QQ 必须保持原 id**（`im-bridge-dedicated-v1`，注意没有平台中缀）：
   *   那个会话有历史，改了前缀等于**丢历史** —— 上次从 qq-bridge 改名到 im-bridge
   *   已经丢过一次（v3/v4 三代），不该再丢一次。
   *   所以这里对 qq 做特例，其余平台用 `im-bridge-<平台>-v1`。
   */
  function dedicatedSessionId(platform) {
    return platform === 'qq' ? DEDICATED_SESSION_ID : `im-bridge-${platform}-v1`;
  }

  /**
   * 取得"专用 QQ 会话"的 agent。
   *
   * 为什么不复用用户正在用的会话（这是上一版的错误）：
   *   投进用户正在聊的会话 = 投进用户和模型正在进行的那轮对话，
   *   结果是模型的回复被当成 QQ 的回答发出去（内容完全不对），
   *   而且用户聊天时 QQ 消息只能排在后面等 —— 两边互相干扰。
   *
   * 专用会话则有独立上下文，QQ 消息不影响也不占用用户正在用的会话。
   * 用 parentAgent 把生命周期挂到一个活动 root agent 上，
   * 这样它由 DSH 的工厂创建并驱动，apply 返回时 loop 已在运行。
   */
  async function resolveTargetAgent(platform = 'qq') {
    const sessionId = dedicatedSessionId(platform);

    // ① 已存在就直接用
    const existing = ctx.agents.get(sessionId);
    if (existing !== undefined) return { agent: existing, kind: 'dedicated' };

    // ② 复用已持久化的会话 → resume
    //
    // ⚠ 这里必须也传 agentOptions（provider/model/reasoningEffort）。
    //   之前只在 create 路径传了，resume 没传 —— 结果恢复出来的 agent
    //   没有模型路由，渲染系统提示词时 `{{model}}` 无值，整轮直接失败：
    //     turn/end reason = "error"
    //     prompt variable "{{model}}" has no value for this assembly
    //     (section "deployment:persona-prefix")
    //   ResumeAgentOptions 里确实有 agentOptions 字段，别漏。
    //
    // ⚠ 另外：已经开跑过的会话不能再 select preset
    //   （实测报 "This session has already started"）——
    //   所以 preset 只在 setup 里"尽力而为"，失败不算致命。
    const resumeOwner = ctx.agents.roots()[0];
    const resumeAgentOptions = await readDefaultModelOptions(ctx, config);
    recordStatus('resume-agent-options', { agentOptions: resumeAgentOptions ?? null });
    try {
      const handle = await ctx.agents.resume({
        resumeSessionId: sessionId,
        ...(resumeOwner === undefined ? {} : { parentAgent: resumeOwner }),
        ...(resumeAgentOptions === undefined ? {} : { agentOptions: resumeAgentOptions }),
        setup: async (agentCtx, agent) => {
          await bindPreset(agentCtx, agent);
          applyChannelPrompt(agentCtx);
        },
      });
      recordStatus('dedicated-resumed', {
        sessionId,
        platform,
        owner: resumeOwner === undefined ? null : String(resumeOwner.id),
        hasAgentOptions: resumeAgentOptions !== undefined,
      });
      return { agent: handle.agent, kind: 'dedicated' };
    } catch (resumeError) {
      recordStatus('dedicated-resume-failed', { message: String(resumeError?.message ?? resumeError) });
    }

    // ③ 全新创建。用 parentAgent 拿到被驱动的生命周期。
    const owner = ctx.agents.roots()[0];
    // 工作目录：config → $DSH_WORKSPACE → process.cwd()。
    //
    // ⚠ **为什么要有 existsSync 这一层**（2026-10-07 修的真问题）：
    //
    // 这份插件的 `cordis.patch.yml` 是**随包发布**的，而它曾经写着
    // `workspace: 'D:\EasyDSH'` —— **开发机的路径**。别人从 GitHub 装完，
    // 这个值会进他们的配置，把工作目录指向一个**他们机器上不存在的路径**。
    //
    // 光删掉那个默认值不够，还要挡住另外两种情况：
    //   · 用户改过 workspace，后来把那个目录删了或改名了
    //   · 多台机器共用一份配置（同步 dotfiles），路径只在一台上存在
    //
    // 两种情况原来的表现都是**静默**的：agent 在一个不存在的目录里干活，
    // 读文件报"找不到"、glob 结果为空 —— 而看配置一切正常，极难排查。
    //
    // 所以：**路径不存在就不用它**，退到下一个候选，并记一条日志说清楚。
    const workspace = resolveWorkspace(config);

    // ⚠ 必须显式给模型：`CreateAgentOptions.agentOptions = { provider, model, reasoningEffort }`。
    //
    // 不给的后果（实测）：
    //   turn/end reason = "error"
    //   会话里显示：prompt variable "{{model}}" has no value for this assembly
    //               (section "deployment:persona-prefix")
    // 也就是系统提示词的装配阶段拿不到模型名，整轮直接失败。
    // preset 只负责"有哪些能力"，模型路由仍要由创建方指定。
    //
    // 具体的 create 调用（含 meta.origin='subagent' 的理由、以及
    // "id 已在磁盘上"的兜底）都在 createDedicatedAgent 里，见它的注释。
    return createDedicatedAgent(owner, workspace, presetId, 0, platform);
  }

  /**
   * 兜底：建会话时如果撞上"这个 id 已经在磁盘上"，就换一个唯一 id 重试。
   *
   * **为什么需要**（查证过的失败模式）：
   *
   * `dsh-session-persistence-jsonl` 的 create() 第一件事就是查磁盘：
   *   if (this.tracker.hasPending(snapshot.id) ||
   *       await this.findLog(snapshot.id, options?.signal) !== void 0)
   *     throw new SessionAlreadyExistsError(snapshot.id);   // 行 2439
   *
   * 正常路径不会撞上它 —— 因为 `resolveTargetAgent` 会先 resume，成功就不 create。
   * 而宿主路径的 resume **不检查 origin**（`dsh-agent-loop` 里 "subagent" 零命中；
   * 那条 "session is not resumable" 的守卫在 `dsh-acp`，管的是 ACP 客户端），
   * 所以带 `origin:'subagent'` 的会话照样能 resume。
   *
   * 但**万一 resume 因为别的原因失败**（文件损坏 / 格式升级 / 权限），
   * 代码就会掉到 create，而磁盘上那个文件还在 → SessionAlreadyExistsError
   * → 整个 QQ 桥接卡死（症状：连上了但永远收不到回复）。
   *
   * 后果太重（QQ 完全不可用），所以这里加一层兜底：换唯一 id 重建。
   * 代价是**多留一个孤儿会话文件** —— 而它是内部会话，不进列表，可以接受。
   */
  async function createDedicatedAgent(owner, workspace, presetId, attempt, platform = 'qq') {
    const agentOptions = await readDefaultModelOptions(ctx, config);
    recordStatus('agent-options-resolved', { agentOptions: agentOptions ?? null, attempt, platform });
    if (agentOptions === undefined) {
      log('⚠ 没能解析出模型（provider/model）—— agent 可能因缺少 {{model}} 而整轮失败');
    }

    const baseId = dedicatedSessionId(platform);
    const sessionId = attempt === 0
      ? baseId
      : `${baseId}-${Date.now().toString(36)}`;   // 唯一化，绕开冲突

    try {
      const handle = await ctx.agents.create({
        sessionId,
        ...(owner === undefined ? {} : { parentAgent: owner }),
        // ── meta.origin = 'subagent' ────────────────────────────────────────
        //
        // **为什么必须有**：不加的话这个专用会话会出现在侧边栏的会话列表里
        // （实测：它落在「未分组」组下，标题是手机发来的那句话）。
        // 那是机器人的对话，不是用户自己的会话 —— 混在列表里既干扰又容易误删。
        //
        // 机制（从 dsh-client-ui-workspace 源码查证）：
        //   function sessionVisible(session, current, archived, archivedFilter) {
        //       if (session.origin === "subagent") return false;   // ← 就是这里
        //       ...
        //   }
        // 另外 asar 里共有 35 处按 `origin === 'subagent'` 分叉，都把它当"内部会话"。
        //
        // ⚠ 一个查证记录（免得后人再踩）：**宿主路径的 resume 不检查 origin**。
        //   我一度以为"标了 subagent 就不能 resume"，于是担心 create 会撞
        //   SessionAlreadyExistsError —— 但那是 `dsh-acp` 的守卫（管 ACP 客户端），
        //   `dsh-agent-loop` 里搜 "subagent" **零命中**，resumeWith 全程不看这个字段。
        //   所以正常路径是 resume 成功、根本不 create，撞不上。
        //   本函数上面的 attempt 兜底是给"resume 因别的原因失败"这种意外准备的。
        meta: { cwd: workspace, agentPreset: presetId, origin: 'subagent' },
        ...(agentOptions === undefined ? {} : { agentOptions }),
        setup: async (agentCtx, agent) => {
          await bindPreset(agentCtx, agent);
          applyChannelPrompt(agentCtx);
        },
      });
      recordStatus('dedicated-created', {
        sessionId,
        owner: owner === undefined ? null : String(owner.id),
        attempt,
      });
      return { agent: handle.agent, kind: 'dedicated' };
    } catch (error) {
      const message = String(error?.message ?? error);
      recordStatus('dedicated-create-failed', { sessionId, attempt, message: message.slice(0, 200) });
      if (attempt >= 2) throw error;
      log(`建会话失败（${message.slice(0, 120)}）—— 换一个唯一 id 重试`);
      return createDedicatedAgent(owner, workspace, presetId, attempt + 1);
    }
  }

  /**
   * 把手机 QQ 的一条消息投进**专用 QQ 会话** —— 这就是"写"。
   * 参数 fallbackSessionId 仅用于日志归类，不再是投递目标。
   *
   * ⚠ 关键修正：用 `agent.followup(message)`，不要用 `agent.inbox.append(...)`
   *
   * 官方 Agent 接口（app.asar 里的类型声明）：
   *   send(message, target, wakeup): void
   *   followup(message) = send(message, 'next-turn', true)    ← 会唤醒 agent
   *   steer(message)    = send(message, 'next-step', true)
   *   inject(message)   = send(message, 'next-step', false)   ← 不唤醒
   *
   * 而 `inbox.append` 是我早先从内部类型里"考古"出来的底层写法：它只入队、
   * **不会唤醒 agent**。官方 practices 文档写得很清楚：
   *   "A timer that starts work calls `agent.followup()`, which wakes the agent;
   *    `agent.inject()` does not wake it, so injected context can wait in the
   *    inbox until other input arrives."
   *
   * 这正是"消息进了收件箱、会话日志里有 agent/inbox/spliced，但永远没有
   * turn/start"的根因 —— 从来没有东西去唤醒它。
   *
   * 用文档里的公开 API，而不是猜底层结构。
   */
  async function deliverToAgent(fallbackSessionId, text, openid, msgId, opts = {}) {
    const platform = opts.platform ?? 'qq';
    const { agent, kind } = await resolveTargetAgent(platform);

    /**
     * 权限预设必须在**这里**设，不能在 `setup` 回调里（2026-09-26 实测踩到）。
     *
     * 踩到的现象：在 setup 里调它，日志报
     *   permission-preset-no-session  sessionId=im-bridge-dedicated-v1
     * 而**紧接着下一行**就是同一个 id 的 `agent-created-seen` ——
     * 也就是"调它的时候会话还没进 store"。
     *
     * 时序原因：agent 的生命周期是
     *   prepare（构造，**未入 store**）→ setup（**回调在这里**）→ publish（enter+announce，才入 store）
     * 所以 setup 阶段 `ctx.sessions.get(id)` 必然拿不到。
     *
     * 而 `resolveTargetAgent()` 返回时 create/resume 都已走完 publish，
     * 会话一定在 store 里 —— 这是能保证拿到 Session 的最早时机。
     *
     * 为什么还赶得上"第一轮之前"：投递发生在下面几行的 `agent.followup()`，
     * 而权限决定的是 shell 工具**怎么起沙箱** —— 只要在 followup 之前设好就够。
     *
     * ⚠ 传 `agent.id` 而不是 `DEDICATED_SESSION_ID`（2026-10-08 改）：
     *   `DEDICATED_SESSION_ID` 是 QQ 的会话 id，多平台引入后会**设错会话**
     *   （微信的权限被设到 QQ 会话上）。而 `agent.id === agent.session.id`
     *   （DSH 有这条不变量，见 dsh-agent 的 enter()），所以用 agent.id 一定对。
     *   它还顺带覆盖了"会话 id 撞车后换了唯一 id"那条路。
     */
    applyPermissionPreset(agent.id);

    const message = {
      id: randomUUID(),                 // MessageId 是品牌化字符串，运行时用 uuid
      role: 'user',
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    };

    recordStatus('deliver-target', { sessionId: agent.id, kind });
    // pending 里多存 platform / reply —— finishTurn 靠它们决定"往哪里回、用什么回"。
    // 之前只存 openid / msgId，而 finishTurn 里写死了 `qq.reply(...)`，
    // 于是"非 QQ 平台接 agent"这件事根本无处落地（2026-10-08 改）。
    pending.set(agent.id, {
      text: '',
      reasoning: '',
      messages: [],
      openid,
      msgId,
      platform: opts.platform ?? 'qq',
      // 消息级回复闭包（微信必需）；为 undefined 时 finishTurn 退回按平台查表
      reply: opts.reply,
    });

    // ⚠ 把**会话键也登记进 busy**（关键修复，2026-09-26）：
    //   到目前为止 busy 只认了队列键（pumpQueue 里 markBusy(sessionId)），
    //   而 finishTurn 收到的是**会话键**（agent.id）—— 它 clearBusy 时
    //   在 busyAliases 里查不到，于是只清了会话键、留下队列键永远占着。
    //   这里把两个键合并成一组，之后任何一侧的 isBusy/clearBusy 都能对上。
    markBusy(fallbackSessionId, agent.id);

    try {
      if (typeof agent.followup !== 'function') {
        // ⚠ **不要退回 `agent.inbox.append()`**（这里原本有个兜底，已删除）。
        //
        // 为什么删：`inbox.append` 只入队、**不唤醒 agent** —— 那正是本插件
        // 最早那个 bug 的根因（"消息进了收件箱，但永远没有 turn/start"）。
        // 留着这个兜底等于：一旦 followup 不存在，症状会**退化成那个最难查的形态**
        // —— 消息看起来投递成功了（日志有 delivered-to-agent），但 agent 永远不动，
        // 用户只看到"机器人不理我"。
        //
        // 而且它是**不会被执行到的死分支**：当前 DSH 的 Agent 一定有 followup。
        // 所以它唯一的实际作用就是**掩盖将来的接口不兼容**。
        //
        // 正确做法：明确报错。这样 `deliver-failed-detail` 会记下 agentKeys，
        // 一眼就能看出"DSH 的 Agent 接口变了"，而不是去猜为什么没人回话。
        // （对应经验库 E4：加了兜底 ≠ 兜底可用；宁可响亮地失败，也不要安静地错。）
        recordStatus('deliver-no-followup', {
          sessionId: agent.id,
          agentKeys: Object.keys(agent),
          hint: 'DSH 的 Agent 接口可能变了：现在必须有 followup()',
        });
        throw new Error(
          `agent 没有 followup() —— 无法唤醒它（agentKeys: ${Object.keys(agent).join(', ')}）`,
        );
      }
      agent.followup(message);        // 入队 + 唤醒（唯一正确做法）
      recordStatus('deliver-via-followup', { sessionId: agent.id });
    } catch (error) {
      recordStatus('deliver-failed-detail', {
        sessionId: agent.id,
        message: String(error?.message ?? error),
        stack: String(error?.stack ?? '').split('\n').slice(0, 6).join(' | '),
        hasFollowup: typeof agent?.followup === 'function',
        hasInbox: agent?.inbox !== undefined,
      });
      pending.delete(agent.id);
      throw error;
    }

    log(`已投递到 ${agent.id}（${kind}）：${text.slice(0, 40)}`);
    recordStatus('delivered-to-agent', { sessionId: agent.id, kind, text: text.slice(0, 80) });
    writeStatusSnapshot({ phase: 'busy', sessionId: agent.id, lastMessage: text.slice(0, 80) });
  }

  /**
   * ── QQ 面板：读消息（**优先内存，回退磁盘**）───────────────────────
   *
   * 用户反馈过的问题：**重启后要发一条消息才看得到历史**，否则面板是空的。
   *
   * 根因：原来只查 `ctx.sessions.get(id)` —— 那是**内存里**的会话。
   *   客户端重启后专用会话还没被建起来，所以查不到 → 面板空。
   *   发一条消息会触发 resolveTargetAgent → resume/create → 会话进内存 → 历史才出现。
   *
   * 修法：内存里没有就**从磁盘读**，用
   *   `sessionQuery.readSession(id): Promise<SessionLogSnapshot>`
   * 官方描述原文："Read and replay-validate one complete logical session log
   * **without making it live**." —— 正好是我们要的：只读历史，不启动 agent。
   *
   * （为什么不用 `ctx.agents.resume()`：它会把 agent loop 也拉起来 ——
   *   每开一次面板就起一个 agent，太重。readSession 没有这个副作用。）
   *
   * ⚠ 两种来源的**事件形状不同**（都从真实日志核对过）：
   *   活会话：`session.deriveMessages()` → 直接是消息对象
   *   磁盘：原始事件流 → 要自己从 `type` + `data` 里抽文本，注意
   *        `assistant/message` 的 message 是**嵌套**在 data.message 里的，
   *        而 `user/message` 的字段直接在 data 上。
   */
  async function readPanelMessages(sessionId, limit) {
    const sessions = ctx.get?.('sessions');
    const live = sessions?.get?.(sessionId);

    // ── A. 活会话：deriveMessages 是权威来源 ──
    if (live !== undefined && live !== null) {
      let derived = [];
      try {
        derived = live.deriveMessages?.() ?? [];
      } catch (error) {
        recordStatus('panel-derive-failed', { message: String(error?.message ?? error) });
        return { ok: false, messages: [], error: String(error?.message ?? error) };
      }
      return { ok: true, source: 'live', messages: messagesFromDerived(derived, limit) };
    }

    // ── B. 内存里没有：从磁盘只读回放 ──
    const query = ctx.get?.('sessionQuery');
    if (query?.readSession === undefined) {
      return { ok: true, source: 'none', messages: [], note: '没有 sessionQuery 服务，读不到历史' };
    }
    try {
      const snapshot = await query.readSession(sessionId);
      const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
      return { ok: true, source: 'disk', messages: messagesFromEvents(events, limit) };
    } catch (error) {
      const message = String(error?.message ?? error);
      // 会话根本不存在（从没收到过消息）是正常情况，不要报成错误
      const missing = /not found|absent|no such|ENOENT|不存在/i.test(message);
      return {
        ok: true,
        source: 'none',
        messages: [],
        note: missing ? '还没有任何对话 —— 在手机 QQ 上给它发一条试试' : message.slice(0, 160),
      };
    }
  }

  /** 从活会话的派生消息里抽出可显示的（role + 文本）—— 见 getPanelMessages 的说明 */
  function messagesFromDerived(derived, limit) {
    const rows = [];
    for (const message of derived ?? []) {
      const role = String(message?.role ?? '?');
      if (role === 'system' || role === 'developer') continue;   // 提示词不进面板
      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content
        .map((part) => (part?.type === 'text' ? String(part.text ?? '') : ''))
        .join('')
        .trim();
      if (text === '') continue;
      rows.push({ role, text: text.slice(0, 4000) });
    }
    return tailOf(rows, limit);
  }

  /**
   * 从**原始事件流**里抽出可显示的消息。
   *
   * ⚠ 两种事件的字段位置不一样（这是从真实日志里核对出来的，别想当然）：
   *   user/message      → data.role / data.content[]           （字段直接在 data 上）
   *   assistant/message → data.message.role / data.message.content[]（**嵌套一层**）
   *   tool/result       → data.message.content[]
   *
   * 只取 text 块；reasoning 块是思考过程，不进面板（要看得把 showReasoning 打开）。
   */
  function messagesFromEvents(events, limit) {
    const rows = [];
    for (const event of events ?? []) {
      const type = event?.type;
      const data = event?.data ?? {};
      let message = null;
      let role = '';

      if (type === 'user/message') {
        message = data;
        role = 'user';
      } else if (type === 'assistant/message' || type === 'tool/result') {
        message = data.message;          // ← 嵌套
        role = type === 'assistant/message' ? 'assistant' : 'tool';
      } else {
        continue;
      }

      const content = Array.isArray(message?.content) ? message.content : [];
      const text = content
        .map((part) => (part?.type === 'text' ? String(part.text ?? '') : ''))
        .join('')
        .trim();
      if (text === '') continue;
      rows.push({ role, text: text.slice(0, 4000), seq: event?.seq ?? null });
    }
    return tailOf(rows, limit);
  }

  /** 取末尾 N 条（N 上下都有界，防止面板被超大 limit 拖垮） */
  function tailOf(rows, limit) {
    const n = Math.max(1, Math.min(400, Number.isFinite(limit) ? limit : 80));
    return rows.slice(-n);
  }

  /**
   * ── QQ 面板：读那个专用会话的消息 ──────────────────────────────────
   *
   * **为什么由宿主半读、而不是客户端直接查**（查证过的）：
   *   客户端服务目录里**没有任何会话数据 API** ——
   *   只有 clientModules / slots / uiSession（那个只有 bindingSource/provide）等，
   *   没有"给我某个会话的消息"这种东西。所以数据必须由宿主半提供。
   */
  async function getPanelMessages(limit, platform = 'qq') {
    // ⚠ 必须按平台取**各自的专用会话**（2026-10-08 修）。
    //   原来写死 `DEDICATED_SESSION_ID`（那是 QQ 的），于是：
    //   点开微信面板看到的是 **QQ 的对话**，而自己在微信里聊的内容不在里面 ——
    //   用户报的"聊天框里没有消息记录"就是这个。
    //   备注：客户端 fila 时也从不带平台参数，两边都要改（见 control-server）。
    const sessionId = dedicatedSessionId(platform);
    const read = await readPanelMessages(sessionId, limit);
    return {
      ok: read.ok !== false,
      platform,
      sessionId,
      source: read.source ?? null,
      total: (read.messages ?? []).length,
      messages: read.messages ?? [],
      ...(read.note === undefined ? {} : { note: read.note }),
      ...(read.error === undefined ? {} : { error: read.error }),
      // ⚠ 这两个值必须走别名集合：
      //   · busy 用 isBusy —— "忙"可能登记在队列键上（见 busyAliases 的说明）
      //   · queued 要把**所有别名**的队列长度加起来 ——
      //     队列键是 `<platform>-<peer前12位>`，不是会话 id，
      //     所以原来 `queues.get(sessionId)` **永远是 0**（一个隐藏 bug）。
      busy: isBusy(sessionId),
      queued: queueDepth(sessionId),
      info: await panelInfo(ctx.get?.('sessions')?.get?.(sessionId)),
    };
  }

  /**
   * ── QQ 面板：模型 + 上下文用量 ──────────────────────────────────────
   *
   * 用户会问"它用的是哪个模型、上下文还剩多少" —— 这两个都得让宿主半读，
   * 因为客户端没有这些 API（见 getPanelMessages 的说明）。
   *
   * ① 模型：`agentDefaultModel.currentSelection()`
   *      签名：currentSelection(): ModelSelection → { provider, model, reasoningEffort? }
   * ② 上下文窗口：`llm.resolveModelInfo(provider, model)` → { context?: { contextWindow } }
   * ③ 已用：`tokenMeter.measure(session)` → TokenMeasurement
   *      totalTokens 是"当前请求压力"，baseline.kind === 'usage' 时是**真实**用量
   *      （否则是估算 —— 面板上要区分开，不能把估算说成实测）
   *
   * ⚠ 每一步都用可选链 + try：这些服务在别人的组合里可能没装，
   *   面板不能因为读不到模型信息就整个塌掉。
   */
  async function panelInfo(session) {
    const info = {};

    // ① 模型
    try {
      const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
      if (selection !== undefined && selection !== null) {
        info.provider = selection.provider ?? null;
        info.model = selection.model ?? null;
        info.reasoningEffort = selection.reasoningEffort ?? null;
      }
    } catch (error) {
      info.modelError = String(error?.message ?? error).slice(0, 120);
    }

    // ② 上下文窗口（拿不到就算了 —— 有些 provider 不声明）
    if (info.provider !== undefined && info.model !== undefined) {
      try {
        const resolved = await ctx.get?.('llm')?.resolveModelInfo?.(info.provider, info.model);
        const window = resolved?.context?.contextWindow;
        if (typeof window === 'number' && window > 0) info.contextWindow = window;
      } catch (error) {
        // 不记 info.modelError —— 窗口拿不到不影响模型名显示
      }
    }

    // ③ 已用 token
    if (session !== undefined && session !== null) {
      try {
        const measured = ctx.get?.('tokenMeter')?.measure?.(session);
        if (measured !== undefined && measured !== null) {
          info.usedTokens = typeof measured.totalTokens === 'number' ? measured.totalTokens : null;
          const baseline = measured.baseline;
          if (baseline?.kind === 'usage' && typeof baseline.tokens === 'number') {
            info.usedTokens = baseline.tokens;
            info.usedTokensExact = true;
          } else if (baseline?.kind === 'estimated' && typeof baseline.tokens === 'number') {
            info.usedTokens = baseline.tokens + (measured.surfaceDeltaTokens ?? 0);
            info.usedTokensExact = false;
          } else {
            info.usedTokensExact = false;
          }
        }
      } catch (error) {
        info.tokensError = String(error?.message ?? error).slice(0, 120);
      }
    }

    return info;
  }

  /**
   * ── QQ 面板：改模型 ────────────────────────────────────────────────
   *
   * `agentDefaultModel.saveSelection(next)` 保存的是**完整选择**
   * （签名：saveSelection(next: ModelSelection): Promise<void>）。
   * 注意它保存的是"默认模型"这个全局设置 —— 所以面板里改模型，
   * 和用户在 DSH 设置里改默认模型是同一件事。这一点要在界面上说清楚。
   *
   * ⚠ 改完必须让**下一个 agent** 用上新模型：已经在跑的 agent 不会自动换路由。
   *   所以这里顺手清掉内存里的那个专用 agent，让它下次按新模型重建。
   */
  async function setPanelModel(provider, model) {
    const service = ctx.get?.('agentDefaultModel');
    if (service?.saveSelection === undefined) {
      return { ok: false, error: '这个组合里没有 agentDefaultModel 服务' };
    }
    if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
      return { ok: false, error: 'provider / model 不能为空' };
    }

    // 保留原有的 reasoningEffort（除非调用方显式给了）
    let reasoningEffort;
    try {
      reasoningEffort = service.currentSelection?.()?.reasoningEffort;
    } catch { /* ignore */ }

    const next = reasoningEffort === undefined || reasoningEffort === null
      ? { provider, model }
      : { provider, model, reasoningEffort };

    try {
      await service.saveSelection(next);
      recordStatus('panel-model-changed', { provider, model, reasoningEffort: reasoningEffort ?? null });

      // 让下一个 agent 用新模型：把当前这个从内存里撤掉。
      // 用 dispose 而不是"删掉引用" —— 否则会话文件不会被正常收尾。
      const existing = ctx.agents.get?.(DEDICATED_SESSION_ID);
      if (existing !== undefined && existing !== null) {
        recordStatus('panel-model-dispose-agent', { sessionId: DEDICATED_SESSION_ID });
        // handle 没保存在这里，走 agent 自己的 dispose（如果暴露了的话）
        try { await existing.dispose?.(); } catch { /* ignore */ }
      }
      return { ok: true, saved: next, note: '下一个回合生效' };
    } catch (error) {
      recordStatus('panel-model-change-failed', { provider, model, message: String(error?.message ?? error) });
      return { ok: false, error: String(error?.message ?? error) };
    }
  }

  /**
   * ── QQ 面板：可选的模型列表 ────────────────────────────────────────
   *
   * `llm.listProviders()` → [{ id, name }]
   * `llm.listModels(provider)` → [{ provider, id, name, description? }]
   *
   * ⚠ 只列**已注册路由**的模型。用户在 DSH 设置里加过凭据的 provider 才会出现，
   *   所以这个列表是"现在真能用的"，不是"理论上支持的"。
   */
  async function listPanelModels() {
    const llm = ctx.get?.('llm');
    if (llm?.listProviders === undefined) {
      return { ok: false, error: '这个组合里没有 llm 服务', providers: [] };
    }
    try {
      const providers = llm.listProviders() ?? [];
      const out = [];
      for (const provider of providers) {
        let models = [];
        try {
          models = (await llm.listModels?.(provider.id)) ?? [];
        } catch (error) {
          out.push({
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            models: [],
            error: String(error?.message ?? error).slice(0, 120),
          });
          continue;
        }
        out.push({
          provider: provider.id,
          providerName: provider.name ?? provider.id,
          models: models.map((m) => ({ id: m.id, name: m.name ?? m.id })),
        });
      }
      return { ok: true, providers: out };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error), providers: [] };
    }
  }

  /**
   * ── QQ 面板：把输入框的内容投给 agent ──────────────────────────────
   *
   * 和手机发来的消息**走同一条路**（enqueueDelivery → resolveTargetAgent →
   * agent.followup），所以能力完全一致：面板里也可以让它去操作桌面文件。
   *
   * ⚠ 一个刻意的差别：**面板来的消息不回报给 QQ**。
   *   因为它是你本人在电脑上打的字，QQ 那边没有对应的提问，
   *   把回答推到手机上是骚扰。做法是 `openid` 传空 —— finishTurn 里会判断。
   */
  async function sendPanelMessage(text, platform = 'qq') {
    const clean = String(text ?? '').trim();
    if (clean === '') return { ok: false, error: 'text 为空' };

    recordStatus('panel-send', { platform, text: clean.slice(0, 80) });
    // ⚠ 队列分组键**要按平台**（2026-10-08 修）：原来写死 `qq-panel:`，
    //   于是微信面板里打的消息会和 QQ 面板的排在同一条队列上，
    //   而且投递目标也会被 resolveTargetAgent 解析成 QQ 的会话。
    const sessionId = `${platform}-panel:${dedicatedSessionId(platform)}`;
    // 面板消息：openid 传空（不回发到平台）—— 但**平台名要带上**，
    // 否则 finishTurn 无法区分"这是面板输入"还是"某个平台的入站消息"。
    enqueueDelivery(sessionId, clean, '', undefined, { platform });
    return { ok: true, queued: true, platform };
  }

  // ---- 跟踪活动会话（GUI 会话有驱动，是我们优先的投递目标）
  ctx.on('agent/created', ({ agent, source }) => {
    const id = String(agent.id);
    const at = liveSessions.indexOf(id);
    if (at >= 0) liveSessions.splice(at, 1);
    liveSessions.push(id);
    recordStatus('agent-created-seen', { sessionId: id, source, total: liveSessions.length });
  });
  ctx.on('agent/disposed', ({ agent }) => {
    const id = String(agent.id);
    const at = liveSessions.indexOf(id);
    if (at >= 0) liveSessions.splice(at, 1);
    recordStatus('agent-disposed-seen', { sessionId: id, total: liveSessions.length });
  });

  // ---- 会话级事件：捕获回答文本 + 判断轮次结束（跨作用域可靠）
  //
  // 为什么不用 agent/assistant-stream + agent/status：
  // 那两个事件是 scope-filtered 的 —— 只有 agent 经由**本插件**的上下文进入时
  // 才收得到。而我们的投递目标是 GUI 自己创建的会话（另一个作用域），
  // 所以那两个监听器收不到任何东西：文本不累积、idle 判不到、回复永远不发。
  //
  // session/event 的定义是：
  //   'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void
  // 非作用域限定的监听器能收到所有会话的追加事件。
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session?.id ?? '');
    const slot = pending.get(sessionId);
    if (slot === undefined) return;

    const type = event?.type;

    // ① 最终回答文本（权威来源，比流式 deltas 更可靠）
    if (type === 'assistant/message') {
      const content = event?.data?.message?.content;
      const body = Array.isArray(content)
        ? content.map((part) => (part?.type === 'text' ? part.text ?? '' : '')).join('')
        : '';
      if (body.trim() !== '') {
        // 覆盖式累积：assistant/message 是一条完整消息，不是增量
        slot.messages = slot.messages ?? [];
        slot.messages.push(body.trim());
        recordStatus('assistant-message-seen', { sessionId, chars: body.length });
      }
      return;
    }

    // ② 一轮结束 → 回发 QQ
    if (type === 'turn/end') {
      const reason = event?.data?.reason?.kind ?? '(未知)';
      recordStatus('turn-end-seen', { sessionId, reason });
      finishTurn(sessionId, reason);
    }
  });

  // ---- 观察回答流：只取 text-delta，原生区分思考与正文
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const slot = pending.get(agent.id);
    if (slot === undefined) return;

    if (frame.type === 'chunk' && frame.chunk !== undefined) {
      const chunk = frame.chunk;
      if (chunk.type === 'text-delta') slot.text += chunk.text;
      else if (chunk.type === 'reasoning-delta' && config.showReasoning === true) slot.reasoning += chunk.text;
      return;
    }
    // frame.type === 'end'：本轮结束，但助手可能还要调工具，先不急着发
  });

  /**
   * 一轮结束 → 把回答发回 QQ，然后解除忙状态、继续排队中的消息。
   * 由 session/event 的 turn/end 触发（比 agent/status 跨作用域可靠）。
   * 幂等：同一会话同一轮只会发一次。
   */
  function finishTurn(sessionId, reason) {
    const slot = pending.get(sessionId);
    if (slot === undefined) return;
    pending.delete(sessionId);

    // 优先用 assistant/message 收集到的完整文本；没有就用流式累积的
    const collected = Array.isArray(slot.messages) ? slot.messages.join('\n\n') : '';
    const streamed = typeof slot.text === 'string' ? slot.text.trim() : '';
    const body = collected.trim() !== '' ? collected.trim() : streamed;

    const parts = [];
    if (slot.reasoning !== '') parts.push(`【思考】\n${slot.reasoning}`);
    parts.push(body === '' ? `(这一轮没有产生回答；结束原因：${reason})` : body);
    const reply = parts.join('\n\n———\n\n');

    recordStatus('finish-turn', { sessionId, reason, bytes: reply.length, source: collected.trim() !== '' ? 'assistant-message' : 'streamed' });

    // ── 面板来的消息：**不回报出去** ──────────────────────────────────────
    //
    // 判据**不能只看 `slot.openid === ''`**（2026-10-08 修）。
    //
    // 原来只判 openid 为空 —— 那时只有 sendPanelMessage 会传空，所以成立。
    // 但多平台引入后**微信也传空 openid**（它没有 openid 这个概念，只有
    // from_user_id，而回复靠消息级的 reply 闭包）。于是微信的回答会被
    // 当成"面板输入"，直接走这一支**静默不回复** —— 一个只有真机才暴露的 bug。
    //
    // 正确判据：既没有 openid，**也没有可用的回复闭包**。
    //   · 面板：openid='' + reply=undefined → 不回复 ✓
    //   · 微信：openid='' + reply=函数     → 要回复 ✓
    //   · QQ  ：openid 非空                → 要回复 ✓
    //
    // 为什么必须区分：面板里是**用户本人在电脑上打的字**，手机上没有对应的提问。
    // 如果把回答推过去，用户会收到一条莫名其妙的、自己没问过的消息。
    //
    // 但仍然要走 `.finally()` 的解忙 + 泵队列，否则队列会卡住。
    const hasReplyChannel = typeof slot.reply === 'function';
    if (slot.openid === '' && !hasReplyChannel) {
      log(`面板输入已回答（${reply.length} 字符）—— 不回发`);
      recordStatus('panel-answered', { sessionId, bytes: reply.length });
      // clearBusy 会把这一"忙"的**全部别名**（队列键 + 会话键）一起清掉 ——
      // 只清 sessionId 正是之前那个 bug（见 busyAliases 的说明）。
      const released = clearBusy(sessionId);
      recordStatus('busy-released', {
        sessionId,
        keys: released,
        queued: released.reduce((n, k) => n + (queues.get(k) ?? []).length, 0),
      });
      // 队列键可能和 sessionId 不同，所以对**每一个别名**都试一次泵送
      for (const k of released) {
        pumpQueue(k).catch((error) => {
          recordStatus('pump-failed', { sessionId: k, message: String(error?.message ?? error) });
        });
      }
      return;
    }

    // 发送闭包 —— 首次尝试与后台重试走**同一个**它，保证两条路完全一致
    //
    // ⚠ 这里原来是写死的 `qq.reply(slot.openid, reply, slot.msgId, …)`，
    //   于是"非 QQ 平台接 agent"无处落地（2026-10-08 改）。
    //   现在分两条路：
    //     ① `slot.reply` 存在 → 用它。**微信必需**：它的回复要带那条消息的
    //        context_token，是消息级能力，不能用一个全局 send 替代。
    //     ② 否则 → 按 `slot.platform` 查表（QQ 走这条，行为与原来完全一致）
    const sendReply = () => {
      const platform = slot.platform ?? 'qq';

      if (typeof slot.reply === 'function') {
        return slot.reply(reply).then((ok) => {
          // 传输层自己报的成功/失败已经写进事件了；这里只在明确失败时抛，
          // 让上面的 catch 走后台重试（编造成功比报错更糟）。
          if (ok === false) throw new Error(`${platform} 传输层报告发送失败`);
        });
      }

      if (platform === 'qq') {
        if (qq === null) throw new Error('连接已释放（qq 为 null）');
        return qq.reply(slot.openid, reply, slot.msgId, (event, detail) => {
          // 记下 QQ 返回的 message id / 时间戳 —— 出问题时能拿它们去 QQ 侧查，
          // 只记字节数是不够的（"发出去了但收不到"就是这么漏掉的）
          recordStatus(event, detail);
        });
      }

      // 走到这里说明：这个平台还没实现出站，却有人把消息投进来了 —— 那是接线错误
      throw new Error(
        `平台「${platform}」没有可用的发送通道（未实现出站，或回复闭包没传下来）。`
        + '见 transports.js 顶部的能力表：目前只有 QQ 与微信能发消息。',
      );
    };

    sendReply()
      .then(() => {
        log(`已回复（${reply.length} 字符）`);
        recordStatus('replied', { bytes: reply.length });
        writeStatusSnapshot({ phase: 'connected', lastReplyBytes: reply.length });
      })
      .catch((error) => {
        log(`回复失败：${error.message} —— 转入后台重试（最长 ${REPLY_RETRY_TOTAL_MS / 1000} 秒）`);
        recordStatus('reply-failed', { message: error.message });
        // ⚠ 这里**不 await**：重试在后台跑，下面 finally 里的解忙 / 泵队列
        //   照常立刻执行。否则一次网络抖动会把整条队列按死 30 秒。
        scheduleReplyRetry(sendReply, {
          bytes: reply.length,
          platform: slot.platform ?? 'qq',
          // openid 在微信上是空串（它没有 openid），记平台名才有排查价值
          peer: String(slot.openid ?? '').slice(0, 12) || `(${slot.platform ?? 'qq'})`,
        });
      })
      .finally(() => {
        // ⚠ 先解忙、再泵队列 —— 顺序不能反。
        //   反了的话 pumpQueue 会在第一行看到 still busy 就返回（旧代码那样），
        //   队列就此停工。
        //
        // ⚠ 这里收到的 `sessionId` 是**会话键**（agent.id），而 busy 一开始是
        //   用**队列键**登记的。clearBusy 会把两个别名一起清掉 —— 这正是修复点。
        const released = clearBusy(sessionId);
        recordStatus('busy-released', {
          sessionId,
          keys: released,
          queued: released.reduce((n, k) => n + (queues.get(k) ?? []).length, 0),
        });
        // 队列是按**队列键**存的，所以要对每一个别名都试一次泵送
        for (const k of released) {
          pumpQueue(k).catch((error) => {
            recordStatus('pump-failed', { sessionId: k, message: String(error?.message ?? error) });
          });
        }
      });
  }

  // ---- agent 回到 idle 也作为兜底触发（同作用域时可用；跨作用域收不到）
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle') return;
    if (pending.has(String(agent.id))) {
      recordStatus('agent-idle-fallback', { sessionId: String(agent.id) });
      finishTurn(String(agent.id), 'idle');
    }
  });

  // ---- 凭据变化 → 自动重连（"点一下即通"的关键）
  // 用户在界面上保存凭据、或外部改了 ~/.dsh/.credentials.yaml，都会触发这个事件。
  ctx.on('credentials/record-updated', (key) => {
    if (String(key) === CREDENTIAL_KEY) {
      restartConnection('凭据已更新').catch((error) => log(`重连失败：${error.message}`));
    }
  });

  /**
   * 启动时把**已启用**的平台恢复起来（2026-10-08 加）。
   *
   * ── 为什么必须有它（这是一次实测的真故障）──────────────────────────
   * 原来启动路径**只连 QQ**（`restartConnection('启动')`），其它平台要用户
   * 手动去设置页点「测试连接」才会起来。于是出现这个极难自查的现象：
   *
   *     用户重启客户端 → 在微信里发消息 → 「没反应」
   *     日志里：qq-event READY（QQ 连上了），**之后一行 weixin 都没有**
   *
   * 消息根本没进插件。而用户会以为"接 agent 又坏了"。
   *
   * ── 为什么只自动恢复微信 ────────────────────────────────────────
   *   · 微信用 bot_token，**存在本机**（`im-bridge-weixin.json`）→
   *     可以直接起长轮询，**不用再扫码**，所以恢复是无副作用的
   *   · 企微/钉钉/飞书虽然有凭据，但**出站没实现**（发不回去）。
   *     自动连上只会让界面显示"已连接"却依然不能用 —— 那比不连更误导。
   *     所以这里**只自动恢复"能双向收发"的平台**，其余留给用户手动点
   *     （设置页里已经如实标注了各平台的完成度）。
   *
   * 失败只记日志、不抛 —— 自动恢复失败不该影响插件加载（QQ 已经在正常跑了）。
   */
  function autoResumePlatforms() {
    const resumed = [];
    if (platformState.weixin === true) {
      const token = readWeixinToken();
      if (token !== null) {
        try {
          startWeixinWithLoop(token);
          resumed.push('weixin');
        } catch (error) {
          recordStatus('platform-autoresume-failed', { id: 'weixin', message: describeError(error) });
        }
      } else {
        // 启用了但没凭据 —— 记一条，否则用户只会看到"微信没反应"
        recordStatus('platform-autoresume-skipped', {
          id: 'weixin',
          reason: '本机没有存盘的 bot_token —— 需要在设置页扫码一次',
        });
      }
    }
    const notResumed = PLATFORM_IDS.filter(
      (id) => id !== 'qq' && id !== 'weixin' && platformState[id] === true,
    );
    if (notResumed.length > 0) {
      recordStatus('platform-autoresume-skipped', {
        ids: notResumed,
        reason: '这些平台的出站还没实现（发不回去），自动连接会误导 —— 请手动点「测试连接」',
      });
    }
    return resumed;
  }

  // ---- 启动：先按已有凭据尝试连接
  recordStatus('plugin-applied', {
    version: '1.0.0',
    workspace: config.workspace ?? '(未配置，将回退到进程 cwd)',
    sandbox: config.sandbox !== false,
    cwd: process.cwd(),
  });
  writeStatusSnapshot({ phase: 'starting', pid: process.pid, cwd: process.cwd() });

  // ---- 凭据迁移（改名遗留）→ 再连接
  //
  // ⚠ 顺序不能反：`migrateCredentialKey()` 必须**先跑完**再 `restartConnection()`，
  //   否则第一次连接读的是新键（还没写）→ 表现为"升级后连不上 QQ"。
  //   所以这里用 await 链起来，而不是各跑各的。
  void (async () => {
    await migrateCredentialKey();
    // ⚠ QQ 也要看开关（2026-10-08 改）。原来这里**无条件**连 QQ ——
    //   那时 QQ 被做成"常开"，所以无条件是对的。现在 QQ 可以关，
    //   若不看开关，会出现"界面上关掉了、后台还在监听 QQ"的假象。
    if (platformState.qq === true) {
      await restartConnection('启动');
    } else {
      recordStatus('platform-startup-skipped', { id: 'qq', reason: 'QQ 开关是关的' });
    }
    // 再恢复其它**已启用且能双向收发**的平台（目前是微信）。
    //   放在 QQ 之后：QQ 是主通道，先让它起来；恢复别的失败也不影响它。
    //   没有这一步的话，用户重启客户端后微信通道是**死的** ——
    //   表现是"发了消息没反应"，而日志里连一条 weixin 事件都没有（实测踩过）。
    const resumed = autoResumePlatforms();
    recordStatus('platforms-autoresumed', { resumed });
  })().catch((error) => {
    log(`启动连接失败：${error.message}`);
    recordStatus('startup-error', { message: error.message });
  });

  // ---- 看门狗：解开会话卡死（见 startWatchdog 的说明）
  startWatchdog();

  // ---- 启动自检：那个"读历史"的回退路径通不通 ──────────────────────
  //
  // 为什么要在启动时探一次：面板历史读取有两条路（内存 / 磁盘），
  // 而**磁盘那条只在重启后才走**（重启后内存里没有会话）。
  // 如果它坏了，用户看到的现象是"面板空的、发一条消息才出现历史" ——
  // 那正是这次要修的问题。所以启动时主动探一次，把结论写进日志，
  // 免得下次又靠猜。探测本身很轻（只读日志、不启 agent）。
  void (async () => {
    try {
      const sessions = ctx.get?.('sessions');
      const live = sessions?.get?.(DEDICATED_SESSION_ID);
      if (live !== undefined && live !== null) {
        recordStatus('panel-history-probe', { path: 'live', note: '会话已在内存，不需要读磁盘' });
        return;
      }
      const query = ctx.get?.('sessionQuery');
      if (query?.readSession === undefined) {
        recordStatus('panel-history-probe', { path: 'none', note: '没有 sessionQuery 服务' });
        return;
      }
      const snapshot = await query.readSession(DEDICATED_SESSION_ID);
      const rows = messagesFromEvents(snapshot?.events ?? [], 80);
      recordStatus('panel-history-probe', {
        path: 'disk',
        ok: true,
        events: (snapshot?.events ?? []).length,
        messages: rows.length,
        newest: rows.length > 0 ? rows[rows.length - 1].text.slice(0, 40) : null,
      });
    } catch (error) {
      recordStatus('panel-history-probe', {
        path: 'disk',
        ok: false,
        message: String(error?.message ?? error).slice(0, 200),
      });
    }
  })();

  // ---- 状态接口：给客户端设置页的状态面板用（**只读**）
  //
  // 为什么需要它：客户端半没法读文件（浏览器没有文件权限），而插件的运行状态
  // 原本只写进日志 —— 用户想知道"连上没有"就得去翻文件。这个接口把日志摘要成
  // JSON 给界面用。见 control-server.js 的说明。
  //
  // ⚠ 这里**没有任何能结束进程的代码**。曾经的"重启 / 关闭"执行端已移到
  //   开发工具箱（dev-tools/app-control.js）—— 产品里不该有"能杀掉自己"的路径。
  let control = null;
  try {
    control = startStatusServer({
      log,
      // QQ 面板的数据接口（见上面的 getPanelMessages / sendPanelMessage / panelInfo 等）
      getMessages: getPanelMessages,
      sendToAgent: sendPanelMessage,
      listModels: listPanelModels,
      setModel: setPanelModel,
      // 设置页用：凭据的只读状态（不含 secret）
      getCredential: getCredentialInfo,
      // 侧边栏用：哪些平台启用 —— 界面据此**动态注册 / 注销**图标条目
      getPlatforms: getPlatformsInfo,
      setPlatform: setPlatformEnabled,
      // 面板用：按平台读连接状态（每个平台的面板各自点亮自己的绿灯）
      getRuntime: getPlatformRuntime,
      // 设置页用：「测试连接」按平台分发（微信还有扫码轮询）
      testPlatform,
      pollWeixinLogin: pollWeixinLoginOnce,
      // 设置页用：保存某个平台的凭据（宿主侧写，绕开客户端那条坏路）
      savePlatformCredential,
      // 设置页用：可选组件（重 SDK）的安装 / 卸载 / 状态
      getComponents: getComponentsInfo,
      installComponent: installComponentById,
      removeComponent: removeComponentById,
    });
  } catch (error) {
    recordStatus('status-server-start-failed', { message: String(error?.message ?? error) });
  }

  // ---- 随插件（即随客户端进程）释放。
  // 正确写法是 ctx.effect(() => teardown)；ctx.on('dispose') 在 DSH 里不存在。
  ctx.effect(() => () => {
    qq?.dispose();
    control?.dispose();
    // 各平台的长连接也要断 —— 尤其是企业微信：**每个机器人只允许一条连接**，
    // 留着旧连接会让下次连接把新连接顶掉（表现为"刚连上就断"）。
    try { weixinLoop?.dispose(); } catch { /* ignore */ }
    try { wecomLoop?.dispose(); } catch { /* ignore */ }
    // 钉钉/飞书的长连接也要断 —— 尤其钉钉：它的 Stream 网关同样可能踢掉重复连接
    try { dingtalkLoop?.dispose(); } catch { /* ignore */ }
    try { feishuLoop?.dispose(); } catch { /* ignore */ }
    weixinLoop = null;
    wecomLoop = null;
    dingtalkLoop = null;
    feishuLoop = null;
    weixinLogin = null;
    if (watchdog !== null) {
      clearInterval(watchdog);
      watchdog = null;
    }
    pending.clear();
    bindings.clear();
    queues.clear();
    // 入站去重表 + 回复重试定时器也要清 —— 否则插件重载后会留着旧定时器，
    // 它们拿着**上一代**的 qq 引用去发消息（那个连接已经 dispose 了）。
    seenInbound.clear();
    for (const timer of replyRetryTimers) clearInterval(timer);
    replyRetryTimers.clear();
    // ⚠ 不要在这里 busy.clear() —— busy 现在是个 busy-tracker 实例，
    //   它没有 clear() 方法（旧的内联 Map 才有）。写错会在这里抛错，
    //   而且抛错的位置是"卸载路径"，最难被发现。
    //   也不需要清：模块实例随插件实例一起被丢弃，重载会拿到全新的一个。
    log('已停止');
  }, 'im-bridge: 关闭 QQ 长连接、状态接口、看门狗并清理状态');
}
