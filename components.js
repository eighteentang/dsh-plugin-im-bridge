/**
 * im-bridge · 可选组件（重 SDK）的安装 / 卸载 / 体积统计
 *
 * ── 为什么要单独一个模块 ────────────────────────────────────────────
 *
 * 飞书 / 钉钉的**长连接**走各自的私有协议（飞书 SDK 里带 protobufjs），
 * 手写要逆向帧格式 → 只能用官方 SDK。而这两个 SDK 一个 35KB、一个 30MB，
 * **不能让所有用户都被迫下载**。
 *
 * ── 为什么不装进插件自己的目录 ──────────────────────────────────────
 *
 * 插件是 `link:` / `file:` 装进 profile 的：
 *   · 装进插件目录 → `pnpm add` 会改插件的 package.json（git 变脏），
 *     而且生产环境里插件是被复制进 profile 缓存副本的，**升级就被覆盖、依赖丢失**。
 *   · 装到 `$DSH_HOME/im-bridge-deps/`（用户数据目录）→ 自包含、可整体删除、
 *     与插件源码和版本升级完全解耦。
 *
 * 运行时用 `createRequire` 从那个目录**解析**包入口（不硬编码 dist 路径，
 * 随包版本变化也能跟），再 `import()` —— 所以是**可失败的动态加载**：
 * 没装就优雅降级，不是崩。
 *
 * ── 卸载为什么是"标记 + 重启后清理" ────────────────────────────────
 *
 * Windows 上文件被进程加载后不能删。用户在界面上点卸载时，
 * 该 SDK 很可能已经被 import 进内存 → 直接删会 EBUSY/EPERM，
 * 删一半留下半损坏状态最难查。
 * 所以：先尝试立刻删；失败就写一个 pending 标记，
 * **下次插件启动时**（那时还没 import 任何 SDK）再删。
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';

/** 可选组件表 —— 界面、体积预估、包名映射都来自这里，别在别处再写一份。 */
export const COMPONENTS = [
  {
    id: 'dingtalk-stream',
    label: '钉钉长连接',
    packages: ['dingtalk-stream'],
    approxBytes: 35 * 1024,
    approxNote: '约 35 KB',
    purpose: '让钉钉能真正收消息（Stream 模式）',
    // 官方包在 npm 上的 latest 标签指向 beta —— 这本身是要告诉用户的风险
    caveat: '上游 SDK 的 npm latest 目前是 beta 版（2.1.6-beta.1）',
  },
  {
    id: 'lark-sdk',
    label: '飞书长连接',
    packages: ['@larksuiteoapi/node-sdk'],
    approxBytes: 30 * 1024 * 1024,
    approxNote: '约 30 MB（含 7 个依赖会更大）',
    purpose: '让飞书能真正收事件（长连接模式）',
    caveat: '装完还要在飞书后台把「事件配置」切成「使用长连接」—— 那一步保存时要求已有客户端在线',
  },
];

const COMPONENT_BY_ID = new Map(COMPONENTS.map((c) => [c.id, c]));

const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh');
export const DEPS_DIR = join(DSH_HOME, 'im-bridge-deps');
const PENDING_FILE = join(DEPS_DIR, '.pending-removal.json');
const NODE_MODULES = join(DEPS_DIR, 'node_modules');

// ---------------------------------------------------------------- 体积

/** 递归统计目录字节数（读不到就按 0 算，别让统计把功能搞崩） */
function dirBytes(path) {
  let total = 0;
  let entries;
  try { entries = readdirSync(path, { withFileTypes: true }); } catch { return 0; }
  for (const entry of entries) {
    const child = join(path, entry.name);
    try {
      if (entry.isDirectory()) total += dirBytes(child);
      else if (entry.isFile()) total += statSync(child).size;
    } catch { /* 单个文件读不到就跳过 */ }
  }
  return total;
}

// ---------------------------------------------------------------- 安装状态

/** 顶层包目录名（scope 要拼起来，例如 @larksuiteoapi/node-sdk） */
function topDirOf(packageName) {
  return join(NODE_MODULES, ...packageName.split('/'));
}

export function isInstalled(id) {
  const component = COMPONENT_BY_ID.get(id);
  if (component === undefined) return false;
  return component.packages.every((name) => existsSync(topDirOf(name)));
}

/**
 * 实际占用体积。
 *
 * 策略：优先量"这个组件自己的顶层目录 + .pnpm 里与它同名的目录"；
 * 量不到就退回整个 node_modules 的总量（单组件场景下这最准）。
 */
export function componentBytes(id) {
  const component = COMPONENT_BY_ID.get(id);
  if (component === undefined || !isInstalled(id)) return 0;

  let own = 0;
  for (const name of component.packages) own += dirBytes(topDirOf(name));

  let pnpmStored = 0;
  const pnpmDir = join(NODE_MODULES, '.pnpm');
  try {
    for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bare = component.packages.some((name) => entry.name.startsWith(name.replace('/', '+') + '@')
        || entry.name.startsWith(name + '@'));
      if (bare) pnpmStored += dirBytes(join(pnpmDir, entry.name));
    }
  } catch { /* 没有 .pnpm 就当 0 */ }

  return own + pnpmStored;
}

/** 界面用的一份清单 */
export function listComponents() {
  return COMPONENTS.map((component) => ({
    id: component.id,
    label: component.label,
    purpose: component.purpose,
    caveat: component.caveat,
    installed: isInstalled(component.id),
    approxBytes: component.approxBytes,
    approxNote: component.approxNote,
    actualBytes: componentBytes(component.id),
    pendingRemoval: pendingRemovals().includes(component.id),
  }));
}

// ---------------------------------------------------------------- pnpm 定位

/**
 * 找 pnpm。
 *
 * ⚠ 绝**不写死路径** —— 这个项目刚因为"写死开发机路径"出过一次产品级 bug
 *   （control-server.js 里的状态日志路径）。所以这里按顺序探测：
 *   ① DSH 运行时自带的 pnpm（相对 `process.execPath` 推，跨机器成立）
 *   ② PATH 上的 pnpm
 *   找不到就明确报错，让界面能说清"为什么点不动"。
 */
export function findPnpm() {
  const candidates = [
    // .../dependencies/node/bin/node.exe → ../../pnpm/bin/pnpm.mjs
    resolve(dirname(process.execPath), '..', '..', 'pnpm', 'bin', 'pnpm.mjs'),
    resolve(dirname(process.execPath), '..', 'pnpm', 'bin', 'pnpm.mjs'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'script', path: candidate };
  }
  const onPath = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  return { kind: 'path', path: onPath };
}

function ensureDepsDir() {
  mkdirSync(NODE_MODULES, { recursive: true });
  const manifest = join(DEPS_DIR, 'package.json');
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({
      name: 'im-bridge-deps',
      private: true,
      description: 'im-bridge 的可选组件（重 SDK）—— 由设置页的「安装组件」生成，可以整个删掉',
    }, null, 2) + '\n', 'utf8');
  }
  return DEPS_DIR;
}

// ---------------------------------------------------------------- 安装

/**
 * 装一个组件。
 *
 * @param {string} id
 * @param {(chunk: string) => void} onOutput  pnpm 的实时输出（界面要流式显示）
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
export async function installComponent(id, onOutput) {
  const component = COMPONENT_BY_ID.get(id);
  if (component === undefined) return { ok: false, message: `未知组件：${String(id)}` };
  if (isInstalled(id)) return { ok: true, message: '已经装好了' };

  const pnpm = findPnpm();
  ensureDepsDir();

  const args = pnpm.kind === 'script'
    ? [pnpm.path, 'add', ...component.packages]
    : ['add', ...component.packages];
  const command = pnpm.kind === 'script' ? process.execPath : pnpm.path;

  onOutput?.(`$ ${command} ${args.join(' ')}\n（在 ${DEPS_DIR} 里执行）\n`);

  return await new Promise((resolvePromise) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd: DEPS_DIR,
        // pnpm 走自己的代理/registry 配置；这里不额外注入
        env: { ...process.env, npm_config_yes: 'true' },
        windowsHide: true,
      });
    } catch (error) {
      resolvePromise({ ok: false, message: `起不了 pnpm：${String(error?.message ?? error)}` });
      return;
    }

    const fail = (message) => resolvePromise({ ok: false, message });

    // 超时保护：30MB 在慢网下可能几分钟，给到 10 分钟
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      fail('安装超时（10 分钟）—— 检查网络或代理后重试');
    }, 10 * 60_000);

    child.stdout?.on('data', (chunk) => onOutput?.(String(chunk)));
    child.stderr?.on('data', (chunk) => onOutput?.(String(chunk)));

    child.on('error', (error) => {
      clearTimeout(timer);
      fail(`pnpm 起不来：${String(error?.message ?? error)}（找不到 pnpm？` +
        `可以把 pnpm 加到 PATH，或用 DSH 自带的运行时）`);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        fail(`pnpm 退出码 ${code} —— 看上面的输出。常见原因：网络/代理不通、磁盘空间不足、registry 不可达`);
        return;
      }
      if (!isInstalled(id)) {
        fail('pnpm 成功了，但没找到包目录 —— 装到别处去了？看上面的输出');
        return;
      }
      resolvePromise({ ok: true, message: `已安装（实测占用 ${formatBytes(componentBytes(id))}），重启客户端后生效` });
    });
  });
}

// ---------------------------------------------------------------- 卸载

function pendingRemovals() {
  try {
    const parsed = JSON.parse(readFileSync(PENDING_FILE, 'utf8'));
    return Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [];
  } catch { return []; }
}

function writePendingRemovals(ids) {
  try {
    mkdirSync(DEPS_DIR, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify({ ids: [...new Set(ids)] }, null, 2) + '\n', 'utf8');
  } catch { /* 写不进去就只能靠立即删 */ }
}

/**
 * 卸一个组件。
 *
 * 先尝试立即删；失败（Windows 文件锁是最常见原因）就写 pending 标记，
 * 由 applyPendingRemovals() 在**下次启动**时清理。
 */
export function removeComponent(id) {
  const component = COMPONENT_BY_ID.get(id);
  if (component === undefined) return { ok: false, message: `未知组件：${String(id)}` };
  if (!isInstalled(id)) return { ok: true, message: '本来就没装' };

  try {
    for (const name of component.packages) {
      rmSync(topDirOf(name), { recursive: true, force: true });
    }
    // .pnpm 里的实体也顺手清（清不掉不算失败，它在 node_modules 里，迟早一起删）
    const pnpmDir = join(NODE_MODULES, '.pnpm');
    try {
      for (const entry of readdirSync(pnpmDir, { withFileTypes: true })) {
        const hit = component.packages.some((name) => entry.name.startsWith(name.replace('/', '+') + '@')
          || entry.name.startsWith(name + '@'));
        if (hit) rmSync(join(pnpmDir, entry.name), { recursive: true, force: true });
      }
    } catch { /* ignore */ }

    if (!isInstalled(id)) return { ok: true, message: '已删除（实测目录已清空）' };
  } catch (error) {
    // 落到"标记待清理"
  }

  writePendingRemovals([...pendingRemovals(), id]);
  return {
    ok: true,
    message: '文件被占用（进程正在用这个组件），已安排**重启后自动清理** —— 别担心，它不会拖坏别的东西',
    pending: true,
  };
}

/**
 * 启动时调用：把上次没删掉的清掉。
 *
 * ⚠ 必须在**任何组件的动态 import 之前**调用 —— 那时文件还没被加载，才删得掉。
 * @returns {string[]} 这次真删掉的组件 id
 */
export function applyPendingRemovals(onOutput) {
  const ids = pendingRemovals();
  if (ids.length === 0) return [];
  const done = [];
  for (const id of ids) {
    try {
      const result = removeComponent(id);
      if (result.pending === true) continue;   // 还是删不掉，留着下次
      done.push(id);
      onOutput?.(`已清理组件：${id}`);
    } catch { /* 留着下次 */ }
  }
  writePendingRemovals(ids.filter((id) => !done.includes(id)));
  return done;
}

// ---------------------------------------------------------------- 运行时加载

/**
 * 从组件目录里解析并加载一个包。
 *
 * 用 `createRequire` 以 deps 目录为基准解析（不是硬编码 dist 路径），
 * 所以包升级换了入口也能跟得上。
 *
 * @returns {Promise<any|null>} 没装或加载失败 → null（**可失败的动态加载**，不抛）
 */
export async function loadComponentPackage(packageName) {
  if (!existsSync(NODE_MODULES)) return null;
  try {
    const require = createRequire(join(DEPS_DIR, 'package.json'));
    const entry = require.resolve(packageName);
    const mod = await import(pathToFileURL(entry).href);
    return mod;
  } catch {
    return null;
  }
}

export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}
