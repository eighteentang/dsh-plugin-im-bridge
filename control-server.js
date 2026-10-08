/**
 * QQ 桥接 —— 宿主侧状态接口
 *
 * 只做一件事：把插件的运行状态**摘要**成 JSON，给客户端的设置页状态面板用。
 *
 * ── 为什么这个接口只读 ────────────────────────────────────────
 *
 * 这个文件原本还带着「重启 / 关闭客户端」的执行端（spawn 独立助手、taskkill 外壳
 * 那一整套）。那些能力**已经移到开发工具箱**（`dev-tools/app-control.js`）——
 * 它们是开发期用具，不该出现在用户拿到的产品里。
 *
 * 现在产品侧只剩只读查询，不再有任何能结束进程的代码。这是有意的收敛：
 * **产品里不该有"能杀掉自己"的代码路径。**
 *
 * ── 安全模型 ──────────────────────────────────────────────────
 *
 * **只绑定 127.0.0.1**，并在请求时二次校验来源是回环地址 —— 这是唯一的准入条件。
 * Origin 一律回显、不参与准入判断，因为客户端页面跑在 `dsh-app://` 自定义协议下，
 * 它请求 http://127.0.0.1 在浏览器看来本来就是跨站（实测见经验 9）。
 */

import { createServer } from 'node:http';
import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONTROL_PORT = 8799;

/**
 * 状态日志路径（插件把关键节点写在这里，见 index.js 的 recordStatus）
 *
 * ⚠ 2026-10-08 修：这里曾经**写死开发机的绝对路径**
 *   （`C:\Users\<开发机用户名>\.dsh\im-bridge-status.log`）。这份文件是随包发布的 ——
 *   别人装上以后，状态面板读的是一个**他们机器上根本不存在的文件**，
 *   界面永远显示空/异常，而日志本身其实是正常的。
 *
 *   同类问题 v1.1.0 修过 cordis.patch.yml 里那个 `workspace: 'D:\EasyDSH'`，
 *   但漏了这一处。现在与 index.js 的 STATUS_DIR 用**同一套解析**：
 *   `$DSH_HOME` → `~/.dsh`。别再各写一份。
 */
const STATUS_DIR = process.env.DSH_HOME ?? join(homedir(), '.dsh');
const STATUS_FILE = join(STATUS_DIR, 'im-bridge-status.log');

/**
 * 把状态日志**摘要**成界面能直接显示的结构。
 *
 * 设计原则：界面要的是"结论"，不是"事件流"。所以只回答用户真正会问的：
 *   · QQ 连上了吗？（connected / bot）
 *   · 最近收到什么消息？（lastInbound）
 *   · 最近回了什么、成功了吗？（lastReply / lastTurn.ok）
 *   · 出过错吗？（recentErrors，已过滤掉"预期内"的噪声）
 *
 * 只读日志尾部 64KB：日志会持续增长，取最近一段足够覆盖近期活动。
 */
export function readStatusSnapshot() {
  const snapshot = {
    ok: true,
    connected: false,
    bot: null,
    lastInbound: null,
    lastReply: null,
    lastTurn: null,
    recentErrors: [],
    counts: { inbound: 0, replied: 0, errors: 0 },
    logPath: STATUS_FILE,
  };

  try {
    const fd = openSync(STATUS_FILE, 'r');
    const size = fstatSync(fd).size;
    const windowBytes = Math.min(size, 64 * 1024);
    const buffer = Buffer.alloc(windowBytes);
    readSync(fd, buffer, 0, windowBytes, size - windowBytes);
    closeSync(fd);

    // 首行可能被截断，丢掉
    for (const line of buffer.toString('utf8').split('\n').slice(1)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let entry;
      try { entry = JSON.parse(trimmed); } catch { continue; }

      switch (entry.event) {
        case 'ready':
          snapshot.connected = true;
          snapshot.bot = entry.bot ?? null;
          break;
        case 'connecting':
        case 'restart-connection':
          snapshot.connected = false;
          break;
        case 'c2c-message':
          snapshot.counts.inbound += 1;
          snapshot.lastInbound = { time: entry.time, text: entry.text ?? '' };
          break;
        case 'replied':
          snapshot.counts.replied += 1;
          snapshot.lastReply = { time: entry.time, bytes: entry.bytes ?? 0 };
          break;
        case 'turn-end-seen':
          snapshot.lastTurn = { time: entry.time, reason: entry.reason ?? null };
          break;
        default:
          break;
      }

      // 异常事件计入错误，但**排除"预期内的正常情况"**，否则界面会一直显示假警报：
      //   · dedicated-resume-failed —— 首次运行没有可恢复的会话，必然出现
      //   · control-server-failed (EADDRINUSE) —— 已有实例在跑，属正常竞争
      const benign = entry.event === 'dedicated-resume-failed'
        || entry.event === 'control-server-failed';
      if (!benign && /error|failed|rejected/.test(entry.event)) {
        snapshot.counts.errors += 1;
        snapshot.recentErrors.push({
          time: entry.time,
          event: entry.event,
          detail: entry.message ?? entry.detail ?? null,
        });
      }
    }

    if (snapshot.recentErrors.length > 5) {
      snapshot.recentErrors = snapshot.recentErrors.slice(-5);
    }
    if (snapshot.lastTurn !== null && typeof snapshot.lastTurn.reason === 'string') {
      snapshot.lastTurn.ok = snapshot.lastTurn.reason === 'completed';
    }
  } catch (error) {
    snapshot.ok = false;
    snapshot.error = String(error?.message ?? error);
  }

  return snapshot;
}

/**
 * 归一化平台 id。
 *
 * ⚠ 为什么要有它：`platform` 是从**查询串**来的，而那可能缺失或乱填。
 *   缺失时必须回落到 `'qq'` —— 那是这个插件最初的唯一平台，
 *   所以"没传平台"的历史请求行为不变（向后兼容）。
 *   乱填则当作 qq 处理（宁可给错平台的旧数据，也不要 500）。
 */
function normalizePlatform(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (value === '') return 'qq';
  return /^[a-z][a-z0-9-]{0,31}$/.test(value) ? value : 'qq';
}

/**
 * @param {object} options
 * @param {(msg: string) => void} options.log
 * @returns {{ dispose: () => void, port: number }}
 */
export function startStatusServer({ log, getMessages, sendToAgent, listModels, setModel, getCredential, getPlatforms, setPlatform, testPlatform, pollWeixinLogin, savePlatformCredential, getComponents, installComponent, removeComponent, getRuntime }) {
  const server = createServer((req, res) => {
    const remote = req.socket.remoteAddress ?? '';
    const origin = String(req.headers.origin ?? '');
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

    if (origin !== '') {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    // POST 是给 QQ 面板的输入框用的（把文字投给 agent）。
    res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (!isLoopback) {
      log(`状态接口拒绝非本机请求：remote=${remote}`);
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(`forbidden (remote=${remote})`);
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${CONTROL_PORT}`);
    if (url.pathname === '/im-bridge/status') {
      // ⚠ 按平台返回连通性（2026-10-08 加）：原来这里只有 QQ 的 `connected`，
      //   而各平台面板都要用它让"在线"绿灯亮起来 —— 微信面板拿 QQ 的连通性判断自己，
      //   就会在 QQ 连着、微信没连时亮绿灯（反向也一样）。
      //
      //   `platform` 缺失时保持原样（只返回 QQ 那套快照），向后兼容。
      const platform = String(url.searchParams.get('platform') ?? '').trim().toLowerCase();
      const snapshot = readStatusSnapshot();
      if (platform === '') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(snapshot));
        return;
      }
      let runtime = null;
      try { runtime = getRuntime?.(platform) ?? null; } catch { runtime = null; }
      const phase = String(runtime?.phase ?? 'idle');
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ...snapshot,
        platform,
        // 判据**只有一个**：宿主那边这个平台确实是 connected。
        // 刻意不用"有没有配凭据"来推断 —— 配了不等于连上（微信要扫码，企微要握手）。
        connected: phase === 'connected',
        phase,
        runtimeMessage: String(runtime?.message ?? ''),
      }));
      return;
    }

    // ── 设置页：凭据的只读状态（**绝不返回 secret**）──
    //
    // 为什么需要它：设置页原来的输入框初值只来自浏览器 localStorage，
    // 而真正的凭据在宿主这边 —— 两个真相来源，界面会骗人。
    // 这个端点让界面以宿主为准。
    //
    // ⚠ `id` 参数（2026-10-08 加）：原来只查 QQ。现在每个平台那一行都要
    //   显示自己的"已保存 / 还没填"，所以必须能按平台查。
    //   不传 `id` 时保持原行为（查 QQ），向后兼容。
    if (url.pathname === '/im-bridge/credential' && req.method === 'GET') {
      const credentialId = String(url.searchParams.get('id') ?? 'qq').trim() || 'qq';
      void (async () => {
        try {
          const payload = await getCredential?.(credentialId);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload ?? { configured: false, reason: 'no-handler' }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ configured: false, reason: 'error', message: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    // ── 面板：读那个专用会话的消息 ──
    //
    // ⚠ `platform` 参数必须有（2026-10-08 修）：原来这个端点**不区分平台**，
    //   宿主半又写死读 QQ 会话 —— 于是点开"微信绿泡泡"面板看到的是 **QQ 的对话**，
    //   用户自己在微信里聊的内容不在里面（用户报的"聊天框没有消息记录"）。
    if (url.pathname === '/im-bridge/messages' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 80);
      const platform = normalizePlatform(url.searchParams.get('platform'));
      void (async () => {
        try {
          const payload = await getMessages?.(Number.isFinite(limit) ? limit : 80, platform);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload ?? { ok: false, messages: [] }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, messages: [], error: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    // ── 面板：把输入框的内容投给 agent（和手机发的消息走同一条路）──
    if (url.pathname === '/im-bridge/send' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 64 * 1024) req.destroy();     // 防御：面板输入不该这么大
        });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const text = String(parsed.text ?? '').trim();
            if (text === '') {
              res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, error: 'text 为空' }));
              return;
            }
            const result = await sendToAgent?.(text, normalizePlatform(parsed.platform));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: true }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    // ── 面板：可选模型列表 ──
    if (url.pathname === '/im-bridge/models' && req.method === 'GET') {
      void (async () => {
        try {
          const payload = await listModels?.();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload ?? { ok: false, providers: [] }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, providers: [], error: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    // ── 面板：改模型 ──
    if (url.pathname === '/im-bridge/model' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const result = await setModel?.(String(parsed.provider ?? ''), String(parsed.model ?? ''));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: false, error: '没有 setModel 处理函数' }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    // ── 侧边栏：平台开关状态（哪些平台在界面上出现）──
    //
    // 为什么真相在宿主：客户端读不到文件，而"哪些平台启用"是要持久化的状态。
    // 客户端每 5 秒拉一次，据此**动态注册 / 注销**侧边栏条目 ——
    // sidebar.panellist 的 register() 返回 dispose，sidebar 会跟着重排（已核源码）。
    if (url.pathname === '/im-bridge/platforms' && req.method === 'GET') {
      void (async () => {
        try {
          const payload = await getPlatforms?.();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload ?? { ok: false, platforms: {} }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, platforms: {}, error: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    // ── 设置页：开 / 关某个平台 ──
    if (url.pathname === '/im-bridge/platform' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const result = await setPlatform?.(String(parsed.id ?? ''), parsed.enabled === true);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: false, error: '没有 setPlatform 处理函数' }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, error: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    // ── 设置页：「测试连接」──
    //
    // 四个平台的能力**刻意不同**，返回值用 phase 如实区分，界面照它显示：
    //   weixin → need-scan（要扫码）/ connected（已连上，回显工作中）
    //   wecom  → connecting → connected（真长连接；不保证能回复）
    //   feishu / dingtalk → verified（**只验证凭据可用**，不等于能收消息）
    if (url.pathname === '/im-bridge/test' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const result = await testPlatform?.(String(parsed.id ?? ''));
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: false, phase: 'error', message: '没有 testPlatform 处理函数' }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, phase: 'error', message: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    // ── 设置页：微信扫码状态轮询（界面每 1.5 秒调一次）──
    if (url.pathname === '/im-bridge/weixin/poll' && req.method === 'POST') {
      void (async () => {
        try {
          const result = await pollWeixinLogin?.();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(result ?? { ok: false, pending: false, message: '没有轮询处理函数' }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, phase: 'error', message: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    // ── 设置页：保存某个平台的凭据 ──
    //
    // ⚠ 走宿主写，而不是浏览器直接写 credentials —— 客户端侧那条路是坏的
    //   （`factory(require)` 里没有 `ctx`，`ctx?.remote` 会抛 ReferenceError
    //    然后被 catch 吞掉）。详见 index.js 里 savePlatformCredential 的说明。
    //
    // 安全：这个服务只监听 127.0.0.1，且每个请求都二次校验来源是回环地址。
    //       密钥只在"浏览器 → 本机回环接口"之间传，不出机器。
    if (url.pathname === '/im-bridge/credential' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 32 * 1024) req.destroy(); });
        req.on('end', async () => {
          try {
            const parsed = JSON.parse(body === '' ? '{}' : body);
            const result = await savePlatformCredential?.(String(parsed.id ?? ''), parsed.env ?? {});
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: false, message: '没有 savePlatformCredential 处理函数' }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, message: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    // ── 设置页：可选组件（重 SDK）的状态 / 安装 / 卸载 ──
    //
    // ⚠ 安装**不等待**：一个 30MB 的 SDK 在慢网下要几分钟，同步回包会让
    //   浏览器请求一直挂着（还可能被网关掐掉）。所以立即回"已开始"，
    //   真正的进度由界面轮询 GET /components（那里带 pnpm 的流式输出）。
    if (url.pathname === '/im-bridge/components' && req.method === 'GET') {
      void (async () => {
        try {
          const payload = await getComponents?.();
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(payload ?? { ok: false, components: [], log: [] }));
        } catch (error) {
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, components: [], log: [], error: String(error?.message ?? error) }));
        }
      })();
      return;
    }

    if (url.pathname === '/im-bridge/components/install' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
        req.on('end', () => {
          let id = '';
          try { id = String(JSON.parse(body === '' ? '{}' : body).id ?? ''); } catch { /* ignore */ }
          if (id === '') {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, message: '缺少 id' }));
            return;
          }
          // 故意不 await —— 见上面的说明
          void installComponent?.(id);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, started: true, message: '已开始安装，下面的输出会实时刷新' }));
        });
      })();
      return;
    }

    if (url.pathname === '/im-bridge/components/remove' && req.method === 'POST') {
      void (async () => {
        let body = '';
        req.on('data', (chunk) => { body += chunk; if (body.length > 16 * 1024) req.destroy(); });
        req.on('end', () => {
          let id = '';
          try { id = String(JSON.parse(body === '' ? '{}' : body).id ?? ''); } catch { /* ignore */ }
          try {
            const result = removeComponent?.(id);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(result ?? { ok: false, message: '没有 removeComponent 处理函数' }));
          } catch (error) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, message: String(error?.message ?? error) }));
          }
        });
      })();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.on('error', (error) => {
    log(`状态接口启动失败：${error.message}`);
  });

  server.listen(CONTROL_PORT, '127.0.0.1', () => {
    log(`状态接口就绪：http://127.0.0.1:${CONTROL_PORT}/im-bridge/status（仅本机）`);
  });

  return {
    port: CONTROL_PORT,
    dispose() {
      try { server.close(); } catch { /* ignore */ }
    },
  };
}
