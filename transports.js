/**
 * im-bridge · 各平台的「连接测试」实现
 *
 * 目标：**你点一下按钮，就能知道这个平台的凭据到底通不通。**
 *
 * ⚠ 全部**零依赖**：只用 Node 内置能力（`fetch` / `WebSocket` / `Buffer`）。
 *   这不是洁癖 —— 插件是 `link:` 装进 profile 的，一旦 import 第三方包
 *   （尤其 `@deepseek-ai/*`）就会 ERR_MODULE_NOT_FOUND（见经验库 E35）；
 *   而且飞书官方 SDK 解包 **30MB**，会把 ~200KB 的插件变成 30MB。
 *
 * 各平台的能力边界（**刻意不同，不要以为都一样**）：
 *   weixin  —— 官方 iLink / ClawBot 协议，HTTP + 长轮询。
 *              **收 + 回都实现了**（协议细节从官方包源码核对过，非二手文章）。
 *              连接测试 = 扫码换 token → 起长轮询；你发消息它会**回显**。
 *   wecom   —— 官方智能机器人长连接（JSON cmd over WebSocket）。
 *              订阅 + 心跳 + 收消息已实现；**回复帧的形状官方未公开**，
 *              所以只报"订阅成功 + 收到过几条"，不假装能回。
 *   feishu  —— 官方长连接要走它的私有协议（SDK 里带 protobufjs），
 *              手写风险高。这里做 **REST 握手测试**：拿 tenant_access_token。
 *   dingtalk—— 同上。Stream 模式官方给了 SDK；这里做 **REST 握手测试**：
 *              拿 access_token。
 *
 * 所以：微信/企业微信是**真连接**，飞书/钉钉是**凭据可用性验证**。
 * 界面上会如实这么写，不把"token 拿到了"说成"已经能收消息了"。
 */

// ---------------------------------------------------------------- 通用

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 给一个 Promise 套超时。
 *
 * ⚠ 为什么必须有：SDK 的 `connect()` / `start()` **可能在内部自己重试而不 reject**。
 *   那样 `await` 会永远挂着，界面就停在"连接中…" —— 正是"点了没反应"那类问题。
 *   所以每个可能长时间不返回的调用都要有上界。
 */
function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 轮询等待某个条件成立。
 *
 * ⚠ 为什么两个长连接都需要它：**两个 SDK 的 start/connect resolve 都不代表"连上了"**。
 *   · 钉钉 `DWClient.connect()` 会把失败吞进重连循环后照常 resolve；
 *     `connected` 才是在 `socket.on('open')` 里被置 true 的（读 client.cjs 确认）。
 *   · 飞书 `WSClient.start()` 立即 resolve，真正的状态在
 *     `getConnectionStatus().state`（idle/connecting/connected/reconnecting/failed）。
 *   只按"调用没抛错"就报"已连接"，就是在骗用户。
 */
async function waitFor(predicate, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (predicate() === true) return true;
    } catch { /* 谓词自己抛错就当没就绪 */ }
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

// ⚠ 只有"长连接"才需要可选组件；下面的 REST 握手测试不用，所以这条 import
//   不会让插件在未安装组件时加载失败（loadComponentPackage 是**可失败的**）。
import { loadComponentPackage } from './components.js';

/** 带超时的 fetch —— 所有网络调用都必须有超时，否则界面会一直转圈。 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把未知错误变成一句人话（网络类错误 pnpm/Node 的原文对用户没意义）。 */
function describeError(error) {  const message = String(error?.message ?? error);
  if (error?.name === 'AbortError') return '请求超时';
  if (/ENOTFOUND|EAI_AGAIN/.test(message)) return '域名解析失败（检查网络/DNS）';
  if (/ECONNREFUSED|ECONNRESET|socket hang up/i.test(message)) return '连接被拒绝或中断';
  if (/ETIMEDOUT/.test(message)) return '连接超时';
  if (/certificate|TLS|SSL/i.test(message)) return 'TLS 证书校验失败（可能被代理拦截）';
  return message.slice(0, 200);
}

// ---------------------------------------------------------------- 飞书

/**
 * 飞书：REST 握手测试。
 *
 * 拿到 `tenant_access_token` 就说明 **App ID / App Secret 是对的**，
 * 这是"凭据可用性"的判据，**不等于**"长连接已就绪"。
 * 长连接还要在开发者后台把「事件配置」切成"使用长连接接收事件"
 * —— 而那个操作**要求保存时已有客户端在线**，是后面接传输层的事。
 */
export async function probeFeishu({ appId, appSecret }) {
  if (appId === '' || appSecret === '') return { ok: false, message: '请先填 App ID 和 App Secret' };
  try {
    const response = await fetchWithTimeout(
      'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );
    const data = await response.json();
    if (data.code !== 0) {
      return { ok: false, message: `鉴权被拒：code=${data.code} ${data.msg ?? ''}`.trim() };
    }
    return {
      ok: true,
      message: `鉴权通过，tenant_access_token 已获取（${data.expire ?? '?'} 秒有效）`,
      detail: { expire: data.expire ?? null, note: '仅验证凭据可用；长连接需在飞书后台另行开启' },
    };
  } catch (error) {
    return { ok: false, message: `连不上飞书：${describeError(error)}` };
  }
}

// ---------------------------------------------------------------- 钉钉

/**
 * 钉钉：REST 握手测试。
 *
 * ⚠ 官方文档说：有效期内重复获取会返回**同一个** token 并自动续期，
 *   所以这个接口可以放心点（不会把 token 刷坏）。
 *   但**不能高频轮询** —— 组织内所有应用合计 10000 次/自然月（标准版）。
 */
export async function probeDingtalk({ clientId, clientSecret }) {
  if (clientId === '' || clientSecret === '') return { ok: false, message: '请先填 Client ID（AppKey）和 Client Secret（AppSecret）' };
  try {
    const url = 'https://oapi.dingtalk.com/gettoken'
      + `?appkey=${encodeURIComponent(clientId)}`
      + `&appsecret=${encodeURIComponent(clientSecret)}`;
    const response = await fetchWithTimeout(url, { method: 'GET' });
    const data = await response.json();
    if (data.errcode !== 0) {
      return { ok: false, message: `鉴权被拒：errcode=${data.errcode} ${data.errmsg ?? ''}`.trim() };
    }
    return {
      ok: true,
      message: `鉴权通过，access_token 已获取（${data.expires_in ?? '?'} 秒有效）`,
      detail: { expiresIn: data.expires_in ?? null, note: '仅验证凭据可用；Stream 模式需另接 SDK' },
    };
  } catch (error) {
    return { ok: false, message: `连不上钉钉：${describeError(error)}` };
  }
}

// ---------------------------------------------------------------- 微信 iLink / ClawBot

const ILINK_BASE = 'https://ilinkai.weixin.qq.com';

/**
 * `X-WECHAT-UIN`：随机 uint32 → 十进制字符串 → base64。
 * 官方源码里每个请求都会重新生成，作用是防重放。
 */
function randomWechatUin() {
  const value = Math.floor(Math.random() * 0xFFFFFFFF);
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function ilinkHeaders(token) {
  return {
    'content-type': 'application/json',
    // ⚠ 这两个头名是协议规定的（注意 AuthorizationType 不是 Authorization）
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(typeof token === 'string' && token !== '' ? { authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * 第一步：拿登录二维码。
 *
 * ⚠ **是 POST，不是 GET**，而且要带 body `{ local_token_list }`。
 *   网上流传很广的那篇《微信 Bot API 技术解析》写成了 GET —— 那是错的，
 *   这里依据的是官方包 `@tencent-weixin/openclaw-weixin` 的源码
 *   （`auth/login-qr.js` 用的就是 apiPostFetch）。
 *
 * `local_token_list` 只是"本机以前登录过的 bot token"，**不含任何
 * OpenClaw 账号凭据** —— 所以这个登录不依赖 OpenClaw（这点我核过源码）。
 */
export async function weixinStartLogin(localTokens = []) {
  try {
    const response = await fetchWithTimeout(
      `${ILINK_BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
      { method: 'POST', headers: ilinkHeaders(), body: JSON.stringify({ local_token_list: localTokens }) },
      15_000,
    );
    const data = await response.json();
    if (typeof data?.qrcode !== 'string' || data.qrcode === '') {
      return { ok: false, message: `拿二维码失败：${JSON.stringify(data).slice(0, 200)}` };
    }
    return {
      ok: true,
      qrcode: data.qrcode,
      // qrcode_img_content 就是二维码里编码的那个链接 —— 手机上直接打开它也能完成绑定
      qrUrl: typeof data.qrcode_img_content === 'string' ? data.qrcode_img_content : '',
      message: '二维码已生成，请用手机微信扫码（二维码 5 分钟内有效）',
    };
  } catch (error) {
    return { ok: false, message: `连不上微信 iLink：${describeError(error)}` };
  }
}

/** 第二步：轮询扫码状态。`confirmed` 时会带上 bot_token。 */
export async function weixinPollLogin(qrcode) {
  try {
    const response = await fetchWithTimeout(
      `${ILINK_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`,
      { method: 'GET', headers: ilinkHeaders() },
      40_000,   // 服务端会 hold 约 35 秒（长轮询）
    );
    return await response.json();
  } catch (error) {
    // 客户端超时属正常（服务端 hold 到 35 秒）；当成"继续等"
    if (error?.name === 'AbortError') return { status: 'wait' };
    return { status: 'error', message: describeError(error) };
  }
}

/**
 * 第三步：起长轮询收消息，并把它交给上层（`onInbound`）。
 *
 * ⚠ **不再自己回显**（2026-10-08 改）。
 *
 * 原来是"收到就回一条 [测试回显]"，用来证明收发两个方向都通 —— 那一步已经达成。
 * 现在改成把**回复能力随消息一起交上去**：
 *
 *     onInbound(text, reply)
 *                        ↑ 一个只对**这条消息**有效的回复函数
 *
 * 为什么回复函数必须逐条给，而不是给一个全局 send：
 * 微信的回复**必须原样带上那条消息的 `context_token`**，否则关联不到会话。
 * 也就是说"能不能回这条消息"是**消息级别的属性**，不是连接级别的。
 * 硬做一个全局 send 就得自己维护 token 映射，反而更容易错。
 *
 * @param {object} options
 * @param {string} options.token   bot_token
 * @param {(text: string, reply: (replyText: string) => Promise<void>) => void} options.onInbound
 *        收到用户消息。`reply` 只对本次调用收到的这条消息有效。
 * @param {(event: string, detail?: object) => void} options.onEvent
 * @returns {{ dispose: () => void, sendTo: (peer: string, text: string) => Promise<void> | undefined }}
 *        `sendTo` 只在**最近一条**消息的 context 上可用（逃生口，正常路径请用 onInbound 给的 reply）
 */
export function startWeixinLoop({ token, onInbound, onEvent }) {
  let stopped = false;
  let cursor = '';
  let failures = 0;
  /** 最近一条入站消息 —— 只为 sendTo 这个逃生口保留 */
  let lastMessage = null;

  /**
   * 发一条 POST 并把返回体交回调用方。
   *
   * ⚠ 为什么要把返回体**往上带**（2026-10-08 修的真问题）：
   *   原来这里只 `return await response.json()`，而调用方**完全不看**它 ——
   *   于是"HTTP 200 但体内带错误码"会被当成成功。
   *   实测症状：日志报 `weixin-replied bytes=2`（成功），而用户**什么都没收到**。
   *   这和当初 QQ 那个 `msg_id` 的坑**同型**：把"请求发出去了"当成"对方收到了"。
   *   微信/iLink 这类接口的惯例是 HTTP 200 + 体内 errcode/ret 字段，
   *   所以必须以**返回体**为准。
   */
  const post = async (path, body) => {
    const response = await fetchWithTimeout(
      `${ILINK_BASE}/${path}`,
      { method: 'POST', headers: ilinkHeaders(token), body: JSON.stringify(body) },
      45_000,
    );
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: response.status, ok: response.ok, body: json, raw: text };
  };

  /**
   * 判断一个返回体算不算"成功"。
   *
   * 判据要**宽松而明确**：只在能确定失败时判失败，其它情况判成功。
   * 因为不确定时判失败会导致误报（把成功的当失败，触发无谓重试）；
   * 而"能确定失败"的信号是明确的：HTTP 非 2xx，或体内出现非 0 的错误码字段。
   *
   * 支持的错误码字段：`errcode` / `ret` / `code` / `errCode`（跨腾讯系接口的常见命名）。
   * 值为 0 或缺失 → 视为成功。
   */
  const bodyLooksFailed = (r) => {
    if (r.ok !== true) return `http-${r.status}`;
    const b = r.body;
    if (b === undefined || b === null || typeof b !== 'object') return null;
    for (const field of ['errcode', 'ret', 'code', 'errCode']) {
      const v = b[field];
      if (typeof v === 'number' && v !== 0) return `${field}=${v}`;
      if (typeof v === 'string' && v !== '' && v !== '0') return `${field}=${v}`;
    }
    return null;
  };

  /**
   * 回一条文本。必须原样带上 `message.context_token`，否则关联不到会话。
   *
   * 返回 boolean 让调用方能据此决定要不要重试；失败时把**返回体**记进事件里，
   * 这样"发失败了"能看到服务端到底说了什么（而不是只知道"抛了异常"）。
   */
  /**
   * 回一条文本。必须原样带上 `message.context_token`，否则关联不到会话。
   *
   * 返回 boolean 让调用方能据此决定要不要重试。
   *
   * ⚠ **成功路径也要把返回体记进日志**（2026-10-08 补）：
   *   原来只有失败时记 `body`，成功时只记 `bytes`。
   *   结果遇到"HTTP 200、日志报成功、用户什么都没收到"时**完全无从下手** ——
   *   因为唯一能证明服务端是否真的接受了那条消息的，就是**返回体**。
   *   接受成功通常会带一个 message id，那正是能和用户侧对上的东西。
   */
  const sendTo = async (message, text) => {
    const body = {
      msg: {
        to_user_id: message.from_user_id,
        message_type: 2,
        message_state: 2,
        context_token: message.context_token,
        item_list: [{ type: 1, text_item: { text } }],
      },
    };
    try {
      const r = await post('ilink/bot/sendmessage', body);
      const failure = bodyLooksFailed(r);
      // 成功/失败的返回体都记（截断）—— "报成功但没收到"这类问题只能靠它查
      const raw = String(r.raw ?? '').slice(0, 300);
      if (failure !== null) {
        onEvent?.('weixin-reply-failed', {
          reason: failure,
          bytes: text.length,
          body: raw,
        });
        return false;
      }
      onEvent?.('weixin-replied', {
        bytes: text.length,
        status: r.status,
        // 记请求的关键字段 —— 排查"服务端收了但没送到"时要看它们
        toUserId: String(message.from_user_id ?? '').slice(0, 24),
        hasContextToken: typeof message.context_token === 'string' && message.context_token !== '',
        contextTokenLen: String(message.context_token ?? '').length,
        /**
         * 从**收到用户消息**到**发出这条回复**的毫秒数。
         *
         * ⚠ 这个数字是排查"服务端受理了但用户没收到"的关键变量：
         *   唯一已知的成功案例是"收到后立刻发"（~0.4 秒），
         *   而失败的那些都是等 agent 干完活（1~11 秒）才发。
         *   如果 iLink 的 context_token 只在短时间内有效，时延就会是根因。
         *   用户报"收到/没收到"时，拿这个数字一对就能判断。
         */
        sinceInboundMs: typeof message.__receivedAt === 'number' ? Date.now() - message.__receivedAt : null,
        body: raw,
      });
      return true;
    } catch (error) {
      onEvent?.('weixin-reply-failed', { message: describeError(error) });
      return false;
    }
  };

  const loop = async () => {
    while (!stopped) {
      try {
        const upd = await post('ilink/bot/getupdates', {
          get_updates_buf: cursor,
          base_info: { channel_version: '2.4.9' },
        });
        // ⚠ `post` 返回的是包装对象（{status, ok, body, raw}）—— 要取 `.body`。
        //   轮询失败也要记下来：原来只在抛异常时才记，而"200 + 体内错误码"会被漏掉。
        const updFailure = bodyLooksFailed(upd);
        if (updFailure !== null) {
          throw new Error(`getupdates 返回失败：${updFailure} ${String(upd.raw ?? '').slice(0, 160)}`);
        }
        const data = upd.body;
        failures = 0;
        if (typeof data?.get_updates_buf === 'string' && data.get_updates_buf !== '') {
          cursor = data.get_updates_buf;   // 游标必须更新，否则会重复收到消息
        }
        for (const message of (Array.isArray(data?.msgs) ? data.msgs : [])) {
          // message_type 1 = 用户发来的；2 = 机器人自己发的（要跳过，否则自问自答）
          if (message?.message_type !== 1) continue;
          const text = String(message?.item_list?.[0]?.text_item?.text ?? '').trim();
          if (text === '') continue;
          // 记下"收到这条消息的时刻"，发出时算时延。
          //
          // ⚠ 为什么要算它（2026-10-08 排查用）：实测现象是"服务端受理了
          //   （返回了 message_id）但用户没收到"，而唯一的已知成功案例是
          //   **收到后 0.4 秒内立刻发**的那次。所以时延是个关键变量 ——
          //   iLink 的 `context_token` 有可能只在短时间内有效。
          //   把时延记下来，就能和"用户到底收没收到"对上号。
          message.__receivedAt = Date.now();
          onEvent?.('weixin-inbound', { chars: text.length });
          lastMessage = message;
          // 把这条消息专属的回复闭包交上去
          onInbound?.(text, (replyText) => sendTo(message, replyText));
        }
      } catch (error) {
        if (stopped) return;
        failures += 1;
        onEvent?.('weixin-poll-failed', { failures, message: describeError(error) });
        // 退避：连续失败就多等一会儿，但别放弃（token 通常还是好的）
        await sleep(Math.min(30_000, 2000 * failures));
      }
    }
  };

  void loop();

  return {
    dispose() {
      stopped = true;
    },
    /** 逃生口：往"最近一条消息的发送者"回一条。正常路径请用 onInbound 给的 reply。 */
    sendTo(peer, text) {
      if (lastMessage === null) return undefined;
      return sendTo(lastMessage, text);
    },
  };
}

// ---------------------------------------------------------------- 企业微信（智能机器人长连接）

const WECOM_WS = 'wss://openws.work.weixin.qq.com';

/**
 * 企业微信：连官方长连接 + 订阅 + 心跳。
 *
 * 协议（JSON cmd over WebSocket，与 QQ 的 op 码风格不同但同样简单）：
 *   发 `{ cmd: 'aibot_subscribe', body: { bot_id, secret } }` 订阅
 *   收 `aibot_msg_callback` / `aibot_event_callback`
 *   发 `{ cmd: 'ping' }` 心跳（建议 30 秒）
 *
 * ⚠ 两个已知限制，界面上要如实说：
 *   ① **每个机器人同时只能有一条有效连接**，新连接会把旧的踢下线。
 *   ② **回复帧（aibot_respond_msg）的字段形状官方未公开** —— 所以这里
 *      只保证"订阅成功 + 能收到消息"，**不假装能回复**。
 *
 * @returns {{ dispose: () => void }}
 */
export function startWecomLoop({ botId, secret, onInbound, onEvent }) {
  let stopped = false;
  let socket = null;
  let pingTimer = null;
  let retryTimer = null;
  let attempts = 0;

  const connect = () => {
    if (stopped) return;
    let ws;
    try {
      ws = new WebSocket(WECOM_WS);
    } catch (error) {
      onEvent?.('wecom-open-failed', { message: describeError(error) });
      scheduleRetry();
      return;
    }
    socket = ws;

    ws.addEventListener('open', () => {
      onEvent?.('wecom-ws-open', {});
      ws.send(JSON.stringify({ cmd: 'aibot_subscribe', body: { bot_id: botId, secret } }));
      if (pingTimer !== null) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        try { ws.send(JSON.stringify({ cmd: 'ping' })); } catch { /* ignore */ }
      }, 30_000);
    });

    ws.addEventListener('message', (event) => {
      let payload;
      try { payload = JSON.parse(String(event.data)); } catch { return; }
      const cmd = String(payload?.cmd ?? '');
      const body = payload?.body ?? payload;

      if (cmd === 'aibot_subscribe' || cmd === 'subscribe') {
        const code = body?.errcode ?? payload?.errcode ?? 0;
        if (code === 0) {
          attempts = 0;
          onEvent?.('wecom-subscribed', {});
        } else {
          onEvent?.('wecom-subscribe-rejected', {
            errcode: code,
            errmsg: String(body?.errmsg ?? payload?.errmsg ?? ''),
          });
        }
        return;
      }

      if (cmd === 'aibot_msg_callback' || cmd === 'aibot_event_callback') {
        const text = String(
          body?.text?.content ?? body?.msg?.text?.content ?? body?.content ?? '',
        ).trim();
        const chatType = String(body?.chattype ?? body?.chat_type ?? '');
        onEvent?.('wecom-inbound', { chatType, chars: text.length });
        if (text !== '') onInbound?.(text);
      }
    });

    ws.addEventListener('close', () => {
      if (pingTimer !== null) { clearInterval(pingTimer); pingTimer = null; }
      if (stopped) return;
      onEvent?.('wecom-ws-closed', {});
      scheduleRetry();
    });

    ws.addEventListener('error', () => {
      onEvent?.('wecom-ws-error', {});
    });
  };

  const scheduleRetry = () => {
    if (stopped || retryTimer !== null) return;
    attempts += 1;
    // 被踢/断线后逐步退避；连续太多次就放弃（说明凭据或网络有问题，别无限重连）
    if (attempts > 8) {
      onEvent?.('wecom-give-up', { attempts });
      return;
    }
    const delay = Math.min(30_000, 2000 * attempts);
    retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
  };

  connect();

  return {
    dispose() {
      stopped = true;
      if (pingTimer !== null) clearInterval(pingTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
      try { socket?.close(); } catch { /* ignore */ }
    },
  };
}

export { describeError };

// ---------------------------------------------------------------- 长连接（需要可选组件）

/**
 * 钉钉 Stream 长连接。
 *
 * ⚠ 必须走官方 SDK：Stream 是私有 WebSocket 帧协议，手写要逆向。
 *   所以先检查"可选组件"装没装，没装就**明确告诉用户去哪装**（约 35KB）。
 *
 * API 依据（读 SDK 的 .d.ts + 实测构造，不是凭记忆）：
 *   `DWClientConfig = { clientId, clientSecret, keepAlive?, debug?, autoReconnect? }`
 *   `DWClientDownStream = { type, headers: { messageId, topic }, data: string }`
 *   `TOPIC_ROBOT = '/v1.0/im/bot/messages/get'`
 * 方法：`registerCallbackListener(eventId, cb)` / `connect()` / `disconnect()`
 */
export async function startDingtalkStream({ clientId, clientSecret, onInbound, onEvent }) {
  const mod = await loadComponentPackage('dingtalk-stream');
  if (mod === null) {
    return {
      ok: false,
      message: '长连接组件没装 —— 先在设置页的「可选组件」里装「钉钉长连接」（约 35 KB）',
    };
  }
  const bag = { ...(mod.default ?? {}), ...mod };
  const DWClient = bag.DWClient;
  const TOPIC_ROBOT = bag.TOPIC_ROBOT ?? '/v1.0/im/bot/messages/get';
  if (typeof DWClient !== 'function') {
    return { ok: false, message: '组件里没有 DWClient —— 版本对不上？重装一次试试' };
  }

  const client = new DWClient({ clientId, clientSecret, autoReconnect: true, debug: false });
  client.registerCallbackListener(TOPIC_ROBOT, (down) => {
    try {
      // data 是**字符串**（SDK 的类型声明如此），要自己 JSON.parse
      const message = JSON.parse(String(down?.data ?? '{}'));
      const text = String(message?.text?.content ?? '').trim();
      onEvent?.('dingtalk-inbound', {
        conversationType: String(message?.conversationType ?? ''),
        chars: text.length,
      });
      if (text !== '') onInbound?.(text);
    } catch (error) {
      onEvent?.('dingtalk-parse-failed', { message: describeError(error) });
    }
  });

  try {
    // 15 秒上界：SDK 可能内部重试而不 reject，没有上界界面就会一直"连接中…"
    await withTimeout(client.connect(), 15_000, '连接钉钉网关超时（15 秒）—— 检查网络或凭据');
  } catch (error) {
    try { client.disconnect(); } catch { /* ignore */ }
    return { ok: false, message: `连不上钉钉网关：${describeError(error)}` };
  }

  // ⚠ connect() resolve **不等于**连上了（看上面的说明）—— 必须等 connected 真的为 true
  const ready = await waitFor(() => client.connected === true, 10_000, 250);
  if (ready !== true) {
    try { client.disconnect(); } catch { /* ignore */ }
    return {
      ok: false,
      message: 'Stream 长连接没能建立（网关一直没回 open）—— 凭据可能不对，或网络/防火墙挡了 WebSocket',
    };
  }
  onEvent?.('dingtalk-connected', {});
  return {
    ok: true,
    message: 'Stream 长连接已建立（能收消息；钉钉的 Stream 通道本身不能回复）',
    dispose() {
      try { client.disconnect(); } catch { /* ignore */ }
    },
  };
}

/**
 * 飞书长连接。
 *
 * API 依据（读 SDK 导出 + 实测构造，不是凭记忆）：
 *   导出 `Client` / `WSClient` / `EventDispatcher` / `LoggerLevel`
 *   `WSClient` 方法：`start({ eventDispatcher })` / `close()` / `getConnectionStatus()`
 *   `EventDispatcher` 方法：`register({ 事件名: handler })`
 *
 * ⚠ 装完 SDK **还没完**：飞书后台的「事件与回调 → 事件配置」必须切成
 *   「使用长连接接收事件」，**而且那一步保存时要求已有客户端在线**。
 *   所以正确顺序是：先装组件 → 点连接（这里会开始收）→ 再回后台点保存。
 */
export async function startFeishuWs({ appId, appSecret, onInbound, onEvent }) {
  const mod = await loadComponentPackage('@larksuiteoapi/node-sdk');
  if (mod === null) {
    return {
      ok: false,
      message: '长连接组件没装 —— 先在设置页的「可选组件」里装「飞书长连接」（约 30 MB）',
    };
  }
  const bag = { ...(mod.default ?? {}), ...mod };
  const WSClient = bag.WSClient;
  const EventDispatcher = bag.EventDispatcher;
  if (typeof WSClient !== 'function' || typeof EventDispatcher !== 'function') {
    return { ok: false, message: '组件里没有 WSClient / EventDispatcher —— 版本对不上？重装一次试试' };
  }

  const dispatcher = new EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        const message = data?.message ?? {};
        const raw = String(message?.content ?? '');
        // content 是 JSON 字符串（例如 {"text":"你好"}），解析失败就按纯文本用
        let text = raw;
        try { text = String(JSON.parse(raw)?.text ?? raw); } catch { /* 保持 raw */ }
        text = text.trim();
        onEvent?.('feishu-inbound', { chatType: String(message?.chat_type ?? ''), chars: text.length });
        if (text !== '') onInbound?.(text);
      } catch (error) {
        onEvent?.('feishu-parse-failed', { message: describeError(error) });
      }
    },
  });

  let ws;
  try {
    ws = new WSClient({ appId, appSecret });
    await withTimeout(ws.start({ eventDispatcher: dispatcher }), 20_000, '建立飞书长连接超时（20 秒）');
  } catch (error) {
    try { ws?.close?.(); } catch { /* ignore */ }
    return { ok: false, message: `连不上飞书长连接：${describeError(error)}` };
  }

  // ⚠ start() 会**立即 resolve**，真正连上没有要问 getConnectionStatus()
  const stateOf = () => {
    try { return ws.getConnectionStatus()?.state; } catch { return undefined; }
  };
  const ready = await waitFor(() => stateOf() === 'connected', 12_000, 300);
  if (ready !== true) {
    const state = stateOf();
    try { ws.close(); } catch { /* ignore */ }
    return {
      ok: false,
      message: state === 'failed'
        ? '飞书返回 failed —— 通常是应用没有开启长连接能力，或 App ID/Secret 不对'
        : `长连接没能建立（状态停在 ${String(state ?? '未知')}）—— 检查网络，或应用是否已开启长连接`,
    };
  }
  onEvent?.('feishu-connected', {});
  return {
    ok: true,
    message: '长连接已建立（记得去飞书后台把「事件配置」切成「使用长连接接收事件」）',
    dispose() {
      try { ws.close(); } catch { /* ignore */ }
    },
  };
}

