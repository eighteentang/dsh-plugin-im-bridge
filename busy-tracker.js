/**
 * 「忙」状态跟踪器 —— 解决**一个状态、两个键**的清理问题。
 *
 * ── 为什么单独抽出来 ────────────────────────────────────────────
 *
 * 这是一个**真实踩到并造成故障**的 bug（2026-09-26）：
 *
 * 全过程涉及两个不同的 id，但指的是同一个"正在处理中"：
 *
 *   · **队列键** `qq-8B099DA5A8D0`
 *       `enqueueDelivery` 按 QQ 用户分组用的（`qq-${openid.slice(0,12)}`），
 *       `pumpQueue` 拿它做 `busy.set()`。
 *   · **会话键** `im-bridge-dedicated-v1`
 *       专用会话 / agent 的 id，`finishTurn` 收到的是它，于是 `busy.delete()` 清的是它。
 *
 * 结果：**忙被设在队列键上，却只在会话键上清除** → 队列键永远占着 →
 * 第二条消息一进来就卡在「忙」检查上 → 重试耗尽 → 用户在手机上什么都收不到。
 *
 * 更糟的是**看门狗犯同一个错**（它也只清 sessionId），所以"自愈"也失效。
 *
 * 这个 bug 靠读代码很难发现，因为两边单独看都是对的：
 * 一边 set 一个合理的键、另一边 delete 一个合理的键 ——
 * **错在它们不是同一个键**（和经验库 E16 同类：各自测过 ≠ 接在同一条线上）。
 *
 * ── 抽出来的目的 ────────────────────────────────────────────────
 *
 * 让它**可以被单元测试**：把"两个别名一起清"这件事做成有测试覆盖的行为，
 * 而不是留在 1600 行的 index.js 里靠人眼检查。
 */

/**
 * @param {{ now?: () => number }} [deps] 注入时钟（测试用）
 */
export function createBusyTracker(deps = {}) {
  const now = deps.now ?? (() => Date.now());

  /** 任一别名 → 该"忙"的全部键 */
  const aliases = new Map();
  /** 任一键 → 置忙时刻（ms） */
  const since = new Map();

  /**
   * 登记"忙"：一次认下**全部**别名。
   *
   * 传多个键的场景是：pumpQueue 先知道队列键，deliverToAgent 解析出 agent 后
   * 才知道会话键 —— 两次调用会**合并**成同一组别名，而不是互相覆盖。
   */
  function mark(...keys) {
    const real = keys.filter((k) => typeof k === 'string' && k !== '');
    if (real.length === 0) return [];
    const t = now();
    for (const k of real) {
      since.set(k, t);
    }
    // 合并已有分组：新键可能已经属于某一组（例如先 mark(队列键) 再 mark(队列键, 会话键)）
    const merged = new Set(real);
    for (const k of real) {
      for (const member of aliases.get(k) ?? []) merged.add(member);
    }
    for (const k of merged) aliases.set(k, [...merged]);
    return [...merged];
  }

  /**
   * 清除"忙"：把同一组别名**全部**清掉。
   *
   * 这是本模块存在的理由 —— 调用方只知道一个键（可能是队列键、也可能是会话键），
   * 但必须把**两个都清**，否则留下一个永远占着的键。
   * 幂等：清一个本来就不忙的键不会出错。
   */
  function clear(key) {
    const group = aliases.get(key);
    if (group === undefined) {
      const had = since.delete(key);
      return had ? [key] : [];
    }
    for (const k of group) {
      since.delete(k);
      aliases.delete(k);
    }
    return [...group];
  }

  /** 该键（或它的任一别名）是否忙 */
  function isBusy(key) {
    const group = aliases.get(key);
    if (group === undefined) return since.has(key);
    return group.some((k) => since.has(k));
  }

  /** 忙了多久（ms）；不忙返回 -1。同组取**最久**的那个 */
  function heldMs(key) {
    const group = aliases.get(key) ?? [key];
    let oldest = -1;
    for (const k of group) {
      const t = since.get(k);
      if (t === undefined) continue;
      const held = now() - t;
      if (oldest < 0 || held > oldest) oldest = held;
    }
    return oldest;
  }

  /** 当前所有"忙"的分组（看门狗遍历用；同一组只出现一次） */
  function groups() {
    const seen = new Set();
    const out = [];
    for (const [key, members] of aliases) {
      const id = members.join('|');
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ key, keys: [...members], heldMs: heldMs(key) });
    }
    // 没有别名的孤立键
    for (const k of since.keys()) {
      if (!aliases.has(k)) out.push({ key: k, keys: [k], heldMs: heldMs(k) });
    }
    return out;
  }

  /** 便于诊断：把内部状态导出来 */
  function snapshot() {
    return {
      aliases: [...aliases.entries()].map(([k, v]) => [k, [...v]]),
      since: [...since.entries()],
    };
  }

  /**
   * 取某个键的全部别名（**不含**它自己 —— 调用方通常自己会带上）。
   * 没有别名时返回空数组。
   */
  function aliasesOf(key) {
    const group = aliases.get(key);
    return group === undefined ? [] : [...group];
  }

  return { mark, clear, isBusy, heldMs, groups, snapshot, aliasesOf };
}
