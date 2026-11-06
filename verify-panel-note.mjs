/**
 * 校验：面板空状态提示语要按平台说渠道名。
 *
 * 守用户报的错（2026-11-06）：打开「微信绿泡泡」面板，空状态写着
 *   "还没有任何对话 —— 在手机 QQ 上给它发一条试试"
 * 真因：宿主 readPanelMessages() 生成 note 时把渠道写死成 QQ。
 *
 * 跑法（不需要启动 DSH）：
 *   node verify-panel-note.mjs
 */
import { readFileSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const { chatAppName, panelEmptyNote } = await import(
  new URL('./index.js', import.meta.url).href
);

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}${detail ? ` —— ${detail}` : ''}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`); }
};

/** 先剥注释再断言（经验库 E37：说明里会引用旧写法，用原文判会假红） */
const strip = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').map((line) => line.replace(/(^|\s)\/\/.*$/, '$1')).join('\n');

console.log('=== 1. 渠道名映射（真调用导出的函数）===');
const expected = {
  qq: 'QQ',
  weixin: '微信',
  feishu: '飞书',
  dingtalk: '钉钉',
  wecom: '企业微信',
};
for (const [id, name] of Object.entries(expected)) {
  check(`${id} → ${name}`, chatAppName(id) === name, chatAppName(id));
}
check('未知平台回落到 IM（不崩、不再编一个渠道名）', chatAppName('mystery') === 'IM', chatAppName('mystery'));
check('缺失 platform 回落到 IM', chatAppName(undefined) === 'IM', chatAppName(undefined));

console.log('\n=== 2. 空状态整句（真调用导出的函数）===');
for (const [id, name] of Object.entries(expected)) {
  const note = panelEmptyNote(id);
  // 拉丁字母（QQ）两侧留空格，和空状态描述里的写法一致；中文平台名不留
  const phrase = /[A-Za-z]/.test(name) ? `在手机 ${name} 上` : `在手机${name}上`;
  check(`${id} 的提示语含「${phrase}」`, note.includes(`${phrase}给它发一条试试`), note);
  if (id !== 'qq') check(`${id} 的提示语不再出现 QQ`, !note.includes('QQ'), note);
}

console.log('\n=== 3. 接线：宿主确实把 platform 传下去了 ===');
const host = readFileSync(join(HERE, 'index.js'), 'utf8');
const hostCode = strip(host);
check('readPanelMessages 收 platform 参数',
  /async function readPanelMessages\(sessionId, limit, platform = 'qq'\)/.test(hostCode));
check('getPanelMessages 把 platform 传给它',
  /readPanelMessages\(sessionId, limit, platform\)/.test(hostCode));
check('note 走 panelEmptyNote(platform)',
  /note: missing\s*\n\s*\? panelEmptyNote\(platform\)/.test(hostCode));
check('代码里不再有写死渠道的旧句子',
  !/在手机 QQ 上给它发一条试试/.test(hostCode));

console.log('\n=== 3.5 平台开关要能持久化（QQ 关掉后重载不能自己开回来）===');
check('loadPlatforms 不再强制 merged.qq = true',
  !/merged\.qq\s*=\s*true/.test(hostCode));
check('setPlatformEnabled 保留通用守卫（最后一个开着的不能关）',
  /others\.length === 0/.test(hostCode));

console.log('\n=== 4. 客户端：QQ 面板的指引不再指向不存在的菜单 ===');
const client = readFileSync(join(HERE, 'client.js'), 'utf8');
const clientCode = strip(client);
check('设置页菜单真实名字是「连接 IM」',
  /label: '连接 IM'/.test(clientCode));
check('QQ 离线指引写的是「连接 IM」（原来是「连接 QQ」）',
  !/去「设置 → 连接 QQ」看看/.test(clientCode)
  && /去「设置 → 连接 IM」里点 QQ 的「测试连接」/.test(clientCode));
check('微信离线指引仍然是「连接 IM」',
  /去「设置 → 连接 IM」里点微信的「测试连接」/.test(clientCode));

console.log('\n=== 5. 每个平台都有自己的面板文案块 ===');
check('QQ 的 emptyDesc 说 QQ', /id: 'qq'[\s\S]{0,700}emptyDesc: '在手机 QQ 上给它发消息/.test(clientCode));
check('微信的 emptyDesc 说微信', /id: 'weixin'[\s\S]{0,900}emptyDesc: '微信走官方/.test(clientCode));
check('飞书/钉钉/企微走静态占位面板（各自文案）',
  /emptyTitle: '飞书还没接上出站'/.test(clientCode)
  && /emptyTitle: '钉钉还没接上出站'/.test(clientCode)
  && /emptyTitle: '企业微信只能收，不能回'/.test(clientCode));

console.log('\n=== 6. 设置页状态面板按平台显示 ===');
check('StatusPanel 同时拉 /platforms 与 /status',
  /CONTROL_BASE\}\/platforms/.test(clientCode) && /CONTROL_BASE\}\/status/.test(clientCode));
check('只列**开着的**平台',
  /PLATFORMS\.filter\(\(meta\) => platforms\?\.platforms\?\.\[meta\.id\] === true\)/.test(clientCode));
check('不再写死 QQ 的未连接提示',
  !/未连接 QQ —— 请填写下方 AppID 与 AppSecret/.test(clientCode));
check('最近收到/回复会标出平台',
  /titleOf\(snapshot\.lastInbound\.platform\)/.test(clientCode)
  && /titleOf\(snapshot\.lastReply\.platform\)/.test(clientCode));

const server = readFileSync(join(HERE, 'control-server.js'), 'utf8');
const serverCode = strip(server);
check('宿主摘要认识微信的入站事件',
  /case 'weixin-inbound-text'/.test(serverCode)
  && /case 'weixin-replied'/.test(serverCode));
check('回复事件由宿主统一带上 platform',
  /recordStatus\('replied', \{ bytes: reply\.length, platform: slot\.platform \?\? 'qq' \}\)/.test(hostCode));
check('lastInbound / lastReply 带 platform 标记',
  /lastInbound = \{ time: entry\.time, text: entry\.text \?\? '', platform: 'qq' \}/.test(serverCode)
  && /platform: entry\.platform \?\? \(legacyWeixin \? 'weixin' : 'qq'\)/.test(serverCode));

console.log('\n=== 7. 宿主摘要真的认微信事件（跑 readStatusSnapshot）===');
// 复制一份 control-server.js 到临时目录、用临时的 DSH_HOME 跑 —— 只测纯函数，
// 不碰本机真实状态日志。副本和真文件逐字节相同，且这个模块没有相对 import，
// 所以复制不会引入 E40 那种路径失真。
const tmp = join(tmpdir(), `im-bridge-verify-${process.pid}`);
mkdirSync(tmp, { recursive: true });
const logPath = join(tmp, 'im-bridge-status.log');
const at = (s) => `2026-11-07T00:00:0${s}Z`;
// 补一行占位：让"首行是否被丢"这件事不影响下面这些场景的判定
// （场景 D 单独测首行不被误丢）
const noop = JSON.stringify({ time: at(0), event: 'noop' });
const inbound = JSON.stringify({ time: at(1), event: 'weixin-inbound-text', text: '微信消息' });
const run = (lines) => {
  writeFileSync(logPath, [noop, ...lines].join('\n') + '\n', 'utf8');
  return readStatusSnapshot();
};
writeFileSync(join(tmp, 'control-server-verify.mjs'), readFileSync(join(HERE, 'control-server.js'), 'utf8'), 'utf8');
process.env.DSH_HOME = tmp;
const { readStatusSnapshot, isAllowedOrigin } = await import(pathToFileURL(join(tmp, 'control-server-verify.mjs')).href);

// 来源白名单的**真函数**测试 —— 桌面端 origin 漏掉过一次（v1.2.8 的线上事故）
if (typeof isAllowedOrigin === 'function') {
  for (const ok of ['dsh-app://app', 'dsh-app://app/', 'http://127.0.0.1:63077', 'http://localhost:1234', 'https://[::1]:9000']) {
    check(`放行来源 ${ok}`, isAllowedOrigin(ok) === true);
  }
  for (const bad of ['https://evil.example', 'http://evil.example', 'dsh-app://other', 'null', 'file://', '']) {
    check(`拒绝来源 ${bad === '' ? '(空)' : bad}`, isAllowedOrigin(bad) === false);
  }
}

// 场景 A：旧日志（replied 没有 platform，紧跟一条同字节数的 weixin-replied）
const snapA = run([
  inbound,
  JSON.stringify({ time: at(2), event: 'weixin-replied', bytes: 7 }),
  JSON.stringify({ time: at(3), event: 'replied', bytes: 7 }),
]);
check('微信入站被计入', snapA.counts.inbound === 1, String(snapA.counts.inbound));
check('lastInbound 标 weixin', snapA.lastInbound?.platform === 'weixin', JSON.stringify(snapA.lastInbound));
check('一次微信回复只计 1 条（weixin-replied 不重复计数）', snapA.counts.replied === 1, String(snapA.counts.replied));
check('旧日志：微信回复不再被错标成 QQ', snapA.lastReply?.platform === 'weixin', JSON.stringify(snapA.lastReply));

// 场景 B：新日志（replied 自带 platform）
const snapB = run([
  inbound,
  JSON.stringify({ time: at(2), event: 'weixin-replied', bytes: 9 }),
  JSON.stringify({ time: at(3), event: 'replied', bytes: 5, platform: 'qq' }),
]);
check('新日志：replied 自带的 platform 生效', snapB.lastReply?.platform === 'qq', JSON.stringify(snapB.lastReply));

// 场景 C：更旧的 QQ 日志（没有 platform，也没有微信线索）
const snapC = run([
  JSON.stringify({ time: at(4), event: 'replied', bytes: 3 }),
]);
check('旧 QQ 日志：无 platform 无线索 → 按 QQ 处理', snapC.lastReply?.platform === 'qq', JSON.stringify(snapC.lastReply));

// 场景 D：小日志（没到 64KB）的首行是完整事件，不能被当成"被截断的残行"丢掉
writeFileSync(logPath, JSON.stringify({ time: at(5), event: 'ready', bot: '测试机器人' }) + '\n', 'utf8');
const snapD = readStatusSnapshot();
check('小日志的首行不被误丢（ready 生效）', snapD.connected === true && snapD.bot === '测试机器人');

// 场景 E：第一次发送失败、后台重试成功 —— 也要算进"回复"，否则面板会停在更早一次
const snapE = run([
  JSON.stringify({ time: at(6), event: 'reply-retry-ok', bytes: 11, platform: 'weixin' }),
]);
check('重试成功的回复也算一次回复',
  snapE.counts.replied === 1 && snapE.lastReply?.platform === 'weixin', JSON.stringify(snapE.lastReply));

console.log('\n=== 8. 控制接口只放行本机来源（防任意网页驱动 agent）===');
check('有来源白名单，且包含 DSH 桌面端 origin',
  /const ALLOWED_ORIGIN_PATTERNS/.test(serverCode) && /dsh-app:/.test(serverCode));
check('非白名单来源直接 403（不是只缺 CORS 头）',
  /!isAllowedOrigin\(origin\)/.test(serverCode) && /forbidden \(origin\)/.test(serverCode));
check('来源检查在 OPTIONS 之前（preflight 也拦）',
  serverCode.indexOf('!isAllowedOrigin(origin)') !== -1
  && serverCode.indexOf('!isAllowedOrigin(origin)') < serverCode.indexOf("req.method === 'OPTIONS'"));

rmSync(tmp, { recursive: true, force: true });

console.log('\n=== 9. 队列上限 / 日志轮转 / 轮询保护 ===');
check('单会话队列有上限', /MAX_QUEUED_PER_SESSION = 50/.test(hostCode));
check('队列满会记事件并回提示', /queue-overflow/.test(hostCode) && /notifyQueueOverflow/.test(hostCode));
check('面板发送能收到队列满错误', /这个会话积压了太多消息/.test(hostCode));
check('状态日志有轮转',
  /STATUS_LOG_MAX_BYTES/.test(hostCode)
  && /rotateStatusLogIfNeeded\(\)/.test(hostCode)
  && /status-log-rotated/.test(hostCode));
check('长消息读取从末尾取（不再全量扫描）',
  /for \(let i = list\.length - 1; i >= 0 && rows\.length < n; i -= 1\)/.test(hostCode));
check('系统注入的 role:user 消息不进面板（按 source.kind 过滤）',
  /function isHumanUserMessage/.test(hostCode)
  && /role === 'user' && !isHumanUserMessage/.test(hostCode));
check('im_send_media 文案改成只支持 QQ', /目前只支持 QQ 渠道/.test(hostCode));
check('面板轮询有防叠加', /loadingRef\.current/.test(clientCode) && /probing/.test(clientCode));
check('页面在后台不轮询', /document\.hidden/.test(clientCode));
check('设置页有媒体清理入口（两步确认）',
  /media\/clean/.test(clientCode) && /确认清理 30 天前的文件/.test(clientCode));

console.log('\n=== 10. 媒体清理只删旧文件（跑 cleanOldMedia）===');
// 用临时 USERPROFILE 指一个假桌面 —— 绝不碰真实桌面。
// desktopDir() 是**调用时**读 env 的，所以 import 之后再改也有效。
const fakeProfile = join(tmpdir(), `im-bridge-media-verify-${process.pid}`);
const mediaRoot = join(fakeProfile, 'Desktop', 'im-bridge-media', 'qq', '2026-01-01');
mkdirSync(mediaRoot, { recursive: true });
const oldFile = join(mediaRoot, 'old.jpg');
const newFile = join(mediaRoot, 'new.jpg');
writeFileSync(oldFile, 'old', 'utf8');
writeFileSync(newFile, 'new', 'utf8');
const sixtyDaysAgo = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
utimesSync(oldFile, sixtyDaysAgo, sixtyDaysAgo);
const savedProfile = process.env.USERPROFILE;
process.env.USERPROFILE = fakeProfile;
const { cleanOldMedia } = await import(new URL('./media.js', import.meta.url).href);
const cleaned = cleanOldMedia({ days: 30 });
if (savedProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedProfile;
check('旧文件被删', existsSync(oldFile) === false);
check('新文件保留', existsSync(newFile) === true);
check('清理结果计数正确', cleaned.files === 1 && cleaned.bytes === 3, JSON.stringify(cleaned));
rmSync(fakeProfile, { recursive: true, force: true });

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
