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

export const CONTROL_PORT = 8799;

/** 状态日志路径（插件把关键节点写在这里，见 index.js 的 recordStatus） */
const STATUS_FILE = 'C:\\Users\\10454\\.dsh\\im-bridge-status.log';

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
 * @param {object} options
 * @param {(msg: string) => void} options.log
 * @returns {{ dispose: () => void, port: number }}
 */
export function startStatusServer({ log, getMessages, sendToAgent, listModels, setModel, getCredential }) {
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
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(readStatusSnapshot()));
      return;
    }

    // ── 设置页：凭据的只读状态（**绝不返回 secret**）──
    //
    // 为什么需要它：设置页原来的输入框初值只来自浏览器 localStorage，
    // 而真正的凭据在宿主这边 —— 两个真相来源，界面会骗人。
    // 这个端点让界面以宿主为准。
    if (url.pathname === '/im-bridge/credential' && req.method === 'GET') {
      void (async () => {
        try {
          const payload = await getCredential?.();
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
    if (url.pathname === '/im-bridge/messages' && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 80);
      void (async () => {
        try {
          const payload = await getMessages?.(Number.isFinite(limit) ? limit : 80);
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
            const result = await sendToAgent?.(text);
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
