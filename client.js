/**
 * QQ 桥接插件 —— 客户端（浏览器侧）半
 *
 * ⚠ 重要：客户端 bundle 不是 ESM！
 *
 * 踩过的坑（会让整个应用起不来）：
 *   最初这个文件用了 `export default { … }`，启动时报
 *     Uncaught SyntaxError: Unexpected token 'export'
 *   然后应用弹「无法启动」——因为 web boot 有一项没激活就整体失败。
 *
 * 原因：DSH 的客户端插件走 **lazy-CJS** 模型。bundle 被当普通脚本执行，
 * 它唯一的职责是调用 `window.__ModuleLoader__.load({ id, factory })`
 * 注册一个工厂；所有模块副作用（包括 CSS 注入）都放在 factory 闭包里。
 *
 * 正确格式（来自 DSH 自带模板 templates/decoration/client.js）：
 *   window.__ModuleLoader__.load({
 *     id: '<包名>',
 *     factory(require) { … return { inject, apply } },
 *   })
 *
 * 另外两个要点：
 *   · React 要 `require('react')` 拿 —— 它在外壳预置的冻结模块表里。
 *   · 不要 import 任何 DSH 客户端 UI 包：纯 JS 插件没有类型检查，
 *     组件一抛错整个 slot 条目就变空白（控制台只留 "slot entry crashed"）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-plugin-im-bridge',

  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 宿主侧控制接口（见 control-server.js）：插件自己开的、只监听回环的小服务。
    //
    // ⚠ 这个路径必须和 control-server.js 里的路由**完全一致**。
    //   两端各写一份字符串 —— 之前改名时就漏了这里：
    //   服务器改成了 /im-bridge/*，客户端还停在 /qq-bridge
    //   → 所有端点 404（面板、设置页、模型切换全部失效），
    //   而 35 项 bundle 校验全绿（它不比对两端路径）。
    //   现在有 verify-two-sided-paths.mjs 专门比对这件事。
    const CONTROL_BASE = 'http://127.0.0.1:8799/im-bridge';

    const CSS = `
.qqb-wrap{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.qqb-row{display:flex;flex-direction:column;gap:6px}
.qqb-row label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.qqb-row input{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:8px;
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);
  color:inherit;font:inherit;outline:none}
.qqb-row input:focus{border-color:var(--dsw-alias-brand-primary)}
.qqb-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
/* 设置页的主按钮 —— 和发送按钮用同一套按钮 token（不再用 brand-primary 当底） */
.qqb-btn{padding:8px 16px;border-radius:var(--dsw-radius-sm);border:0;cursor:pointer;font:inherit;
  background:var(--dsw-alias-button-info-fill);color:#fff;
  transition:background-color .1s ease}
.qqb-btn:hover:not([disabled]){background:var(--dsw-alias-button-info-hover)}
.qqb-btn[disabled]{opacity:.4;cursor:default}
/* 次要按钮（"重新设置"/"取消"）—— 用幽灵样式，不和主按钮抢注意力 */
.qqb-btn-ghost{background:transparent;color:var(--dsw-alias-label-primary);
  border:1px solid var(--dsw-alias-border-l2)}
.qqb-btn-ghost:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover)}
/* 「凭据已保存」卡片 —— 已配置时用它替代输入框（避免"空输入框 = 没配"的误读） */
.qqb-saved{padding:10px 12px;border-radius:var(--dsw-radius-md);
  border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-menu)}
.qqb-saved-head{display:flex;align-items:center;gap:8px;font-size:13px}
.qqb-saved-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;
  background:var(--dsw-alias-state-success-primary)}
.qqb-saved-ok{margin-left:auto;font-size:12px;color:var(--dsw-alias-state-success-primary)}
.qqb-saved-line{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.qqb-saved-hint{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.8}
.qqb-saved .qqb-actions{margin-top:10px}
.qqb-note{font-size:12px;line-height:1.7;color:var(--dsw-alias-label-secondary)}
.qqb-status{font-size:12px;padding:8px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1)}
.qqb-status.ok{color:#7ee0a8;border-color:#2c5b3f}
.qqb-status.err{color:#ff9d9d;border-color:#5b2c2c}
.qqb-hint{font-size:12px;color:var(--dsw-alias-label-secondary)}
.qqb-status-panel{display:flex;flex-direction:column;gap:7px;padding:12px 14px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l1);
  background:var(--dsw-alias-bg-layer-1);font-size:13px}
.qqb-stat-row{display:flex;align-items:flex-start;gap:8px;line-height:1.5}
.qqb-stat-label{color:var(--dsw-alias-label-secondary);font-size:12px;
  flex:0 0 auto;min-width:52px;padding-top:1px}
.qqb-stat-value{color:var(--dsw-alias-label-primary);word-break:break-word}
.qqb-stat-value.bad{color:#ff9d9d}
.qqb-dot{flex:0 0 auto;width:8px;height:8px;border-radius:50%;margin-top:6px}
.qqb-dot.on{background:#4ec97e;box-shadow:0 0 6px rgba(78,201,126,.6)}
.qqb-dot.off{background:#8b93a7}
.qqb-stat-errors{display:flex;flex-direction:column;gap:3px;border-top:1px solid var(--dsw-alias-border-l1);
  padding-top:8px;margin-top:2px}
.qqb-stat-error{font-size:12px;color:#ff9d9d;line-height:1.5;word-break:break-word}
.qqb-stat-counts{font-size:12px;color:var(--dsw-alias-label-secondary);padding-top:6px;
  border-top:1px solid var(--dsw-alias-border-l1)}
.qqb-toast{position:fixed;right:18px;bottom:18px;z-index:9999;padding:10px 14px;
  border-radius:var(--dsw-radius-md);
  font-size:13px;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);
  backdrop-filter:var(--dsw-menu-backdrop-filter);
  border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-panel)}

/* ── 「奇怪的企鹅」：侧边栏入口图标 ─────────────────────────────────
   柔和浅蓝底 + 纯内联 SVG 简笔企鹅。
   为什么画 SVG 而不是引图标包：客户端 bundle 必须单文件零 import，
   引任何 UI 包都可能在别人的环境里加载失败（整个槽位条目会变空白）。
   颜色刻意写死而非用主题 token —— 这是"品牌色"，深浅主题下都要一样醒目。 */
.qqb-penguin{display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,#E4F0FC,#CFE3F8);
  border-radius:10px;cursor:pointer;user-select:none;box-sizing:border-box;
  transition:background .15s ease,box-shadow .15s ease}
.qqb-penguin:hover{background:linear-gradient(160deg,#D8EAFB,#BCD8F3);
  box-shadow:0 1px 6px rgba(90,150,210,.28)}
.qqb-penguin.qqb-penguin-active{background:linear-gradient(160deg,#C9E2FA,#A8CDF0);
  box-shadow:inset 0 0 0 1.5px rgba(70,130,195,.45)}
.qqb-penguin svg{display:block}
/* 在线角标 —— 图标的右上角。
   尺寸调过一轮：第一版 9px + 1.5px 描边，用户反馈"太大了、太丑了"。
   现在 6px + 1.5px 描边 —— 描边相对更粗，视觉上读作"嵌在角上的一点"，
   而不是"浮在上面的一个球"。位置也往里收（top/right 各 0，不用负偏移）。 */
.qqb-badge-dot{position:absolute;top:0;right:0;
  width:6px;height:6px;border-radius:50%;box-sizing:border-box;
  background:var(--dsw-alias-state-success-primary);
  box-shadow:0 0 0 1.5px var(--dsw-alias-bg-base)}

/* ── 面板 ─────────────────────────────────────────────────────────── */
.qqb-panel{display:flex;flex-direction:column;height:100%;min-height:0;
  font-size:13.5px;color:var(--dsw-alias-label-primary);
  background:var(--dsw-alias-bg-base)}

/* 头部：企鹅头像 + 标题 + 状态点 */
.qqb-panel-head{display:flex;align-items:center;gap:12px;
  padding:16px 22px;border-bottom:1px solid var(--dsw-alias-border-l1);flex:0 0 auto}
.qqb-head-avatar{flex:0 0 auto;width:38px;height:38px;border-radius:var(--dsw-radius-md);
  display:flex;align-items:center;justify-content:center;
  background:linear-gradient(160deg,#E4F0FC,#CFE3F8)}
.qqb-head-text{display:flex;flex-direction:column;gap:1px;min-width:0}
.qqb-panel-title{font-size:16px;font-weight:600;letter-spacing:.2px}
/* 在线指示灯 —— 只在**真正连通**时才渲染（见 QqPanel 的 connected 判断）。
   不连通时整个元素不出现，而不是变成灰点 —— 灰点会让人以为"有个占位的灯坏了"。 */
.qqb-panel-title-row{display:flex;align-items:center;gap:7px}
.qqb-online{flex:0 0 auto;width:6px;height:6px;border-radius:50%;
  background:var(--dsw-alias-state-success-primary)}
.qqb-panel-sub{font-size:12px;color:var(--dsw-alias-label-secondary)}
.qqb-panel-spacer{flex:1}
.qqb-badge{padding:3px 10px;border-radius:999px;font-size:11.5px;white-space:nowrap;
  background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.qqb-badge.busy{background:rgba(255,196,0,.16);color:#e8b84b}
.qqb-badge.err{background:rgba(255,120,120,.16);color:#ff9d9d}

/* 消息区 */
.qqb-panel-body{flex:1;min-height:0;overflow-y:auto;padding:20px 22px;
  display:flex;flex-direction:column;gap:12px;align-items:center}
.qqb-body-inner{width:100%;max-width:var(--dsh-composer-card-max-width,760px);
  display:flex;flex-direction:column;gap:12px}
/* ── 消息气泡：照抄 DSH 原生 .bubble ──────────────────────────────
   原生规则（dsh-client-ui-chat 的 .LdtX1G_bubble）：
     background:var(--dsw-specific-bubble)   border-radius:var(--dsw-radius-xl)
     color:var(--dsw-alias-label-primary)    padding:10px 16px
     font-size:var(--dsh-content-font-size,14px)
     line-height:calc(22px + var(--dsh-content-font-delta,0px))
     white-space:pre-wrap  word-break:break-word
   ⚠ **用户和助手是同一个底色** —— DSH 靠"位置 + 宽度"区分角色，不靠颜色。
     原生 .LdtX1G_userRow 是 align-items:flex-end，
          .LdtX1G_userStack 是 max-width:min(calc(--dsh-chat-content-width * .702), 82%)。
     （我之前给用户气泡上品牌色 —— 而 brand-primary 在两个主题下都很深，
       配上深色文字就是用户看到的"黑块"。） */
.qqb-msg{padding:10px 16px;border-radius:var(--dsw-radius-xl);
  background:var(--dsw-specific-bubble);color:var(--dsw-alias-label-primary);
  font-size:var(--dsh-content-font-size,14px);
  line-height:calc(22px + var(--dsh-content-font-delta,0px));
  max-width:100%;white-space:pre-wrap;word-break:break-word;
  animation:qqb-in .18s ease}
@keyframes qqb-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
/* 角色区分：用户靠右、助手靠左（和原生 userRow / 助手行一致） */
.qqb-msg-user{align-self:flex-end;
  max-width:min(calc(var(--dsh-chat-content-width,748px) * .702), 82%)}
.qqb-msg-assistant{align-self:flex-start}
.qqb-msg-tool{align-self:flex-start;background:var(--dsw-specific-tip);
  color:var(--dsw-alias-label-secondary);
  font-size:var(--dsh-content-font-size-secondary,13px);
  max-width:88%;padding:8px 14px}
/* 角色标签只给"工具"留着 —— 用户和企鹅靠左右位置就能分辨，
   再顶一行"我（手机）"是冗余，而且让每条消息都变高。 */
.qqb-msg-role{font-size:var(--dsh-content-font-size-secondary,13px);opacity:.8;
  margin-bottom:3px;font-weight:600;letter-spacing:.3px}

/* 空状态：不是"什么都没有"，是"准备好了在等你" */
.qqb-panel-empty{margin:auto;display:flex;flex-direction:column;align-items:center;
  gap:16px;text-align:center;padding:24px;max-width:420px}
.qqb-empty-art{width:132px;height:132px;border-radius:34px;
  display:flex;align-items:center;justify-content:center;
  background:var(--dsw-specific-bubble);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-stroke)}
.qqb-empty-title{font-size:17px;font-weight:600;letter-spacing:.2px}
.qqb-empty-desc{font-size:13px;line-height:1.9;color:var(--dsw-alias-label-secondary)}
.qqb-empty-hint{font-size:11.5px;line-height:1.8;color:var(--dsw-alias-label-secondary);
  opacity:.72;padding:7px 13px;border-radius:9px;background:var(--dsw-alias-bg-layer-2)}

/* 底部输入区 */
.qqb-panel-foot{flex:0 0 auto;border-top:1px solid var(--dsw-alias-border-l1);
  padding:14px 22px 15px;display:flex;flex-direction:column;gap:9px;
  align-items:center}
.qqb-foot-inner{width:100%;max-width:var(--dsh-composer-card-max-width,760px);
  display:flex;flex-direction:column;gap:9px}
.qqb-send-row{display:flex;gap:11px;align-items:flex-end}
.qqb-send-box{flex:1 1 auto;min-height:40px;max-height:150px;resize:none;box-sizing:border-box;
  padding:9px 14px;border-radius:var(--dsw-radius-lg);border:0;font:inherit;
  font-size:var(--dsh-content-font-size,14px);line-height:22px;
  background:var(--dsw-specific-input-major);color:inherit;outline:none;
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l2);
  box-shadow:var(--dsw-elevation-soft);
  transition:box-shadow .15s ease}
.qqb-send-box::placeholder{color:var(--dsw-alias-label-secondary);opacity:.8}
.qqb-send-box:focus{--dsw-elevation-stroke-color:var(--dsw-alias-brand-primary);
  box-shadow:var(--dsw-elevation-soft),0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary) 18%,transparent)}
.qqb-send-btn{width:34px;height:34px;flex:none;padding:0;border:0;cursor:pointer;
  border-radius:999px;display:grid;place-items:center;
  background:var(--dsw-alias-button-info-fill);color:#fff;
  transition:background-color .1s ease}
.qqb-send-btn:hover:not([disabled]){background:var(--dsw-alias-button-info-hover)}
.qqb-send-btn[disabled]{opacity:.4;cursor:default}
.qqb-panel-note{font-size:11px;color:var(--dsw-alias-label-secondary);
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;opacity:.85}

/* 模型选择器 + 上下文用量（底栏那一行） */
.qqb-model{position:relative;display:inline-block}
.qqb-model-chip{display:inline-flex;align-items:center;gap:6px;cursor:pointer;
  padding:4px 10px;border-radius:999px;font-size:11.5px;
  border:0;
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-stroke);
  background:var(--dsw-alias-bg-layer-2);
  color:var(--dsw-alias-label-secondary);
  transition:color .15s ease}
.qqb-model-chip:hover{color:var(--dsw-alias-label-primary)}
.qqb-model-chip .qqb-caret{opacity:.6;font-size:9px}
.qqb-model-pop{position:absolute;left:0;bottom:calc(100% + 7px);z-index:40;
  min-width:250px;max-height:290px;overflow-y:auto;
  background:var(--dsw-specific-menu);
  backdrop-filter:var(--dsw-menu-backdrop-filter);
  border:0;border-radius:var(--dsw-radius-md);padding:6px;
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);
  box-shadow:var(--dsw-elevation-panel)}
.qqb-model-group{padding:7px 9px 3px;font-size:10.5px;font-weight:600;letter-spacing:.5px;
  color:var(--dsw-alias-label-secondary);text-transform:uppercase;opacity:.75}
.qqb-model-item{display:block;width:100%;text-align:left;cursor:pointer;
  padding:7px 10px;border-radius:7px;border:none;font:inherit;font-size:12.5px;
  background:transparent;color:var(--dsw-alias-label-primary)}
.qqb-model-item:hover{background:var(--dsw-alias-bg-layer-2)}
.qqb-model-item.qqb-model-current{color:var(--dsw-alias-brand-primary);font-weight:600}
.qqb-ctx{display:inline-flex;align-items:center;gap:7px;font-size:11.5px;
  color:var(--dsw-alias-label-secondary)}
.qqb-ctx-bar{width:62px;height:5px;border-radius:3px;overflow:hidden;
  background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1)}
.qqb-ctx-fill{height:100%;background:var(--dsw-alias-brand-primary);transition:width .3s ease}
.qqb-ctx-fill.qqb-ctx-warn{background:var(--dsw-alias-state-warn-primary)}
.qqb-ctx-fill.qqb-ctx-danger{background:var(--dsw-alias-state-error-primary)}
`;

    /**
     * 浏览器本地缓存的键 —— **只用来预填表单**，不是真相来源。
     *
     * ⚠ 真相在宿主侧：`~/.dsh/.credentials.yaml` 的 `im-bridge/bot`。
     *   这份缓存丢了不影响功能（插件照常工作），只是输入框要重填。
     *   界面显示"配没配"必须走宿主（见 /im-bridge/credential）。
     */
    const STORAGE_KEY = 'dsh-plugin-im-bridge.config';

    /**
     * 改名前的旧键（2026-10-07 插件从 qq-bridge 改成 im-bridge）。
     * 留着只为**一次性迁移**：老用户浏览器里预填的值不该因为改名丢掉。
     */
    const LEGACY_STORAGE_KEY = 'dsh-plugin-qq-bridge.config';

    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.getElementById('im-bridge-style') !== null) return;
      const style = document.createElement('style');
      style.id = 'im-bridge-style';
      style.textContent = CSS;
      document.head.appendChild(style);
    }

    /**
     * 读本地缓存的预填值。**顺带把旧键的值迁过来**（幂等）。
     *
     * 迁移在"读"里做，而不是单独一个启动钩子 —— 因为这是它唯一被用到的地方，
     * 放在这里就保证了"用到之前一定已经迁过"，不会漏。
     * 迁移成功后删旧键，避免下次又迁一遍（虽然迁多遍也无害）。
     */
    function loadConfig() {
      try {
        const ls = globalThis.localStorage;
        if (ls === undefined || ls === null) return {};

        const raw = ls.getItem(STORAGE_KEY);
        if (raw !== null && raw !== undefined) return JSON.parse(raw);

        // 新键没有 → 看旧键有没有值可迁
        const legacy = ls.getItem(LEGACY_STORAGE_KEY);
        if (legacy === null || legacy === undefined) return {};
        const parsed = JSON.parse(legacy);
        try {
          ls.setItem(STORAGE_KEY, legacy);   // 先写新键
          ls.removeItem(LEGACY_STORAGE_KEY); // 成功后再删旧键
        } catch { /* 写失败就只当次用，不删旧键 */ }
        return parsed;
      } catch { return {}; }
    }

    function saveConfig(value) {
      try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* ignore */ }
    }

    /** 右下角一次性提示 */
    function toast(message, ms = 2600) {
      if (typeof document === 'undefined') return;
      const existing = document.getElementById('im-bridge-toast');
      if (existing !== null) existing.remove();
      const node = document.createElement('div');
      node.id = 'im-bridge-toast';
      node.className = 'qqb-toast';
      node.textContent = message;
      document.body.appendChild(node);
      setTimeout(() => { try { node.remove(); } catch { /* ignore */ } }, ms);
    }

    // ---------------------------------------------------------------- 侧边栏按钮
    //
    // ⚠ 「⟳ 重启 / ⏻ 关闭」两个按钮**已从这里移走**，现在由开发工具箱
    //   （dsh-plugin-dev-tools）的「应用控制按钮」小工具提供。
    //
    // 为什么移动：它们是**开发期用具**（改完插件代码要重启验证），
    // 不属于"手机 QQ 与 DSH 对话"这个产品能力。放在产品里会让用户
    // 看到一个他不需要、也不该点的按钮。开发工具箱里它们还能被开关控制。

    /**
     * 实时状态面板 —— 放在设置页最上方。
     *
     * ⚠ 这是"易用"的关键改动。
     *
     * 在此之前，插件的运行状态**只写进日志文件**，用户想知道
     * "连上没有 / 刚才那条消息回了什么 / 有没有出错"，
     * 就得去翻 `~/.dsh/im-bridge-status.log` 或跑诊断命令 ——
     * 那是最不"易用"的地方，也是这个工作区被打差评的主因。
     *
     * 现在改为：宿主侧把日志**摘要**成 JSON（/im-bridge/status），
     * 这里每 3 秒拉一次并直接在界面上显示结论。
     *
     * 设计原则：**显示结论，不显示事件流。**
     * 用户要的是"能用了没有"，不是"第 06:34:07.716 行发生了什么"。
     */
    function StatusPanel() {
      ensureStyle();
      const [snapshot, setSnapshot] = React.useState(null);
      const [unreachable, setUnreachable] = React.useState(false);

      const refresh = React.useCallback(async () => {
        try {
          const response = await fetch(`${CONTROL_BASE}/status`, { method: 'GET' });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          setSnapshot(await response.json());
          setUnreachable(false);
        } catch {
          // 拉不到状态本身也是有用信息：说明宿主侧插件没在跑
          setUnreachable(true);
        }
      }, []);

      React.useEffect(() => {
        refresh();
        const timer = setInterval(refresh, 3000);
        return () => clearInterval(timer);
      }, [refresh]);

      if (unreachable) {
        return h('div', { className: 'qqb-status err' },
          '宿主侧插件没有响应 —— 插件可能未启用，或需要重启客户端一次。');
      }
      if (snapshot === null) {
        return h('div', { className: 'qqb-status' }, '正在读取状态…');
      }

      const fmtTime = (iso) => {
        if (typeof iso !== 'string') return '';
        const d = new Date(iso);
        if (Number.isNaN(d.getTime())) return '';
        return d.toLocaleTimeString('zh-CN', { hour12: false });
      };

      const rows = [];

      // ① 连接状态 —— 用户最关心的一件事，放最上面
      rows.push(h('div', { className: 'qqb-stat-row', key: 'conn' },
        h('span', { className: `qqb-dot ${snapshot.connected ? 'on' : 'off'}` }),
        h('span', null, snapshot.connected
          ? `已连接 QQ${snapshot.bot === null ? '' : `（机器人：${snapshot.bot}）`}`
          : '未连接 QQ —— 请填写下方 AppID 与 AppSecret')));

      // ② 最近一条收到的消息
      if (snapshot.lastInbound !== null) {
        rows.push(h('div', { className: 'qqb-stat-row', key: 'in' },
          h('span', { className: 'qqb-stat-label' }, '最近收到'),
          h('span', { className: 'qqb-stat-value' },
            `${fmtTime(snapshot.lastInbound.time)}　${snapshot.lastInbound.text}`)));
      }

      // ③ 最近一次回复 + 是否成功 —— "能不能用"的直接判据
      if (snapshot.lastReply !== null) {
        const turnOk = snapshot.lastTurn?.ok;
        rows.push(h('div', { className: 'qqb-stat-row', key: 'out' },
          h('span', { className: 'qqb-stat-label' }, '最近回复'),
          h('span', { className: `qqb-stat-value ${turnOk === false ? 'bad' : ''}` },
            `${fmtTime(snapshot.lastReply.time)}　${snapshot.lastReply.bytes} 字`,
            turnOk === false ? '（这一轮失败了，见下方错误）' : '')));
      }

      // ④ 错误（已过滤掉"预期内"的噪声事件）
      if (snapshot.recentErrors.length > 0) {
        rows.push(h('div', { className: 'qqb-stat-errors', key: 'err' },
          h('div', { className: 'qqb-stat-label' }, '最近的错误'),
          ...snapshot.recentErrors.map((e, i) => h('div', { className: 'qqb-stat-error', key: i },
            `${fmtTime(e.time)}　${e.event}${e.detail === null ? '' : `：${e.detail}`}`))));
      }

      // ⑤ 累计计数：一眼看出"到底通过没有"
      rows.push(h('div', { className: 'qqb-stat-counts', key: 'counts' },
        `累计：收到 ${snapshot.counts.inbound} 条 · 回复 ${snapshot.counts.replied} 条`,
        snapshot.counts.errors > 0 ? ` · 错误 ${snapshot.counts.errors} 次` : ''));

      return h('div', { className: 'qqb-status-panel' }, ...rows);
    }

    // ---------------------------------------------------------------- 平台开关
    //
    // "哪些平台在侧边栏出现"的真相在**宿主**：`$DSH_HOME/im-bridge-platforms.json`。
    // 客户端读不到文件，所以走控制接口：
    //   GET  /im-bridge/platforms  → { platforms: { qq:true, weixin:false, … } }
    //   POST /im-bridge/platform   { id, enabled }
    //
    // ⚠ 切开关**不需要重启**：apply() 那边的注入回调每 5 秒拉一次，据此
    //   注册 / 注销 sidebar.panellist 与 main 的条目。
    //
    // ⚠ QQ 不给关：这个会话本身就跑在它上面。宿主侧也会再拒一次 ——
    //   界面拦是为了不让用户白点，宿主拦是因为界面只是客户端代码。
    function PlatformToggles() {
      ensureStyle();
      const [state, setState] = React.useState(null);
      const [note, setNote] = React.useState('');
      // ---- 「测试连接」用的状态（2026-10-08 加）----
      const [openId, setOpenId] = React.useState('');      // 展开的是哪个平台的凭据表单
      const [forms, setForms] = React.useState({});        // id -> { 字段名: 值 }
      const [busyId, setBusyId] = React.useState('');      // 正在保存/测试哪个平台
      const [results, setResults] = React.useState({});    // id -> { kind, text }
      const [qrUrl, setQrUrl] = React.useState('');        // 微信扫码链接
      /**
       * id -> 宿主侧凭据状态（2026-10-08 加）。
       *
       * ⚠ 三态，不能混成两态（这是原来那个"凭据消失"bug 的根因）：
       *   undefined = 还没查（探测中）
       *   {configured:true}  = 宿主里真的配好了
       *   {configured:false} = 宿主里确实没有
       * 曾经的做法是"输入框为空就当没配" —— 而输入框初值来自浏览器
       * localStorage，清了就是空，于是**已配好的也显示成空白**。
       */
      const [creds, setCreds] = React.useState({});

      /** 查某个平台在**宿主**里的凭据状态（只有需要静态凭据的平台才查） */
      const probeCred = React.useCallback(async (id) => {
        try {
          const r = await fetch(`${CONTROL_BASE}/credential?id=` + encodeURIComponent(id));
          if (!r.ok) { setCreds((prev) => ({ ...prev, [id]: { configured: false, reason: `http-${r.status}` } })); return; }
          const json = await r.json();
          setCreds((prev) => ({ ...prev, [id]: json }));
        } catch (error) {
          // 探测失败 ≠ 没配置。分开报，避免把"问不到"说成"没配"。
          setCreds((prev) => ({ ...prev, [id]: { configured: false, reason: 'probe-failed', message: String(error?.message ?? error) } }));
        }
      }, []);

      /**
       * ⚠ 这里**必须主动查一次**，不能等用户点开某一行才查（2026-10-08 修）。
       *
       * 我第一版写的是"点开展开按钮时才 probe"，结果：
       *   折叠状态下 `creds[id]` 永远是 undefined → 标记渲染成空字符串 →
       *   **用户什么都看不到**。而 QQ 那行用户根本不用点开（它已经连上了），
       *   于是"折叠时就看得见凭据状态"这个设计目标完全没达成。
       *
       * 现在：加载时把所有**需要静态凭据**的平台一次性查掉。
       * 只有 4 个（qq/feishu/dingtalk/wecom），本机回环、一次几个请求，
       * 远比"让用户点开才知道"划算。
       */
      React.useEffect(() => {
        for (const meta of PLATFORMS) {
          if ((PLATFORM_FIELDS[meta.id] ?? []).length > 0) void probeCred(meta.id);
        }
      }, [probeCred]);

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(`${CONTROL_BASE}/platforms`);
          setState(await r.json());
        } catch (error) {
          setState({ ok: false, platforms: {}, error: String(error?.message ?? error) });
        }
      }, []);

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 5000);
        return () => clearInterval(timer);
      }, [load]);

      const toggle = async (id, enabled) => {
        setNote('');
        try {
          const r = await fetch(`${CONTROL_BASE}/platform`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id, enabled }),
          });
          const json = await r.json();
          if (json?.ok === false) setNote(String(json.error ?? '切换失败'));
          else setState((prev) => ({ ...(prev ?? {}), platforms: json.platforms ?? {} }));
        } catch (error) {
          setNote('切不了：连不上插件');
        }
      };

      // ---- 扫码轮询：只在"拿到二维码链接"时启动，拿到结果就停 ----
      React.useEffect(() => {
        if (qrUrl === '') return undefined;
        const timer = setInterval(async () => {
          try {
            const r = await fetch(`${CONTROL_BASE}/weixin/poll`, { method: 'POST' });
            const json = await r.json();
            if (json?.pending === true) return;
            setQrUrl('');
            setResults((prev) => ({ ...prev, weixin: { kind: json?.ok === false ? 'err' : 'ok', text: String(json?.message ?? '') } }));
            void load();
          } catch { /* 网络抖动就等下一轮 */ }
        }, 1500);
        return () => clearInterval(timer);
      }, [qrUrl, load]);

      const setField = (id, key) => (event) => setForms((prev) => ({
        ...prev,
        [id]: { ...(prev[id] ?? {}), [key]: event.target.value },
      }));

      /** 保存凭据（若确实填了）+ 测试连接 —— 合成一个动作，用户只点一次 */
      const saveAndTest = async (meta) => {
        setBusyId(meta.id);
        setResults((prev) => ({ ...prev, [meta.id]: { kind: 'note', text: '正在保存并测试…' } }));
        try {
          const fields = PLATFORM_FIELDS[meta.id] ?? [];
          const env = {};
          let filled = 0;
          for (const field of fields) {
            const value = String(forms[meta.id]?.[field.key] ?? '').trim();
            if (value !== '') { env[field.key] = value; filled += 1; }
          }
          // ⚠ 只有用户**确实填了东西**才写凭据 —— 否则"只点测试"会把他存好的凭据覆盖成空
          if (fields.length > 0 && filled > 0) {
            const saved = await (await fetch(`${CONTROL_BASE}/credential`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ id: meta.id, env }),
            })).json();
            if (saved?.ok === false) {
              setResults((prev) => ({ ...prev, [meta.id]: { kind: 'err', text: String(saved.message ?? '保存失败') } }));
              return;
            }
          }
          const tested = await (await fetch(`${CONTROL_BASE}/test`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: meta.id }),
          })).json();
          if (tested?.needScan === true) {
            setQrUrl(String(tested.qrUrl ?? ''));
            setResults((prev) => ({ ...prev, [meta.id]: { kind: 'note', text: String(tested.message ?? '') } }));
          } else {
            setResults((prev) => ({
              ...prev,
              [meta.id]: { kind: tested?.ok === true ? 'ok' : 'err', text: String(tested?.message ?? '') },
            }));
          }
          // 保存过就重新查一次凭据状态 —— 让"凭据已存"那个标记立刻变真，
          // 而不是等用户下次展开才更新（那样会让人以为没保存成功）
          if (fields.length > 0) void probeCred(meta.id);
          void load();
        } catch (error) {
          setResults((prev) => ({ ...prev, [meta.id]: { kind: 'err', text: '连不上插件（Host 侧没在跑？）' } }));
        } finally {
          setBusyId('');
        }
      };

      const platforms = state?.platforms ?? null;

      /** 一行平台：开关 + 阶段 + 展开后的凭据与测试 */
      const rowFor = (meta) => {
        const on = platforms?.[meta.id] === true;
        // ⚠ 2026-10-08：原来这里写死 `locked = meta.id === 'qq'`，把 QQ 画成禁用按钮
        //   （文字"常开"）。那是一条**站不住**的策略 —— QQ 用的是自己的专用会话，
        //   关掉它不会影响别的平台（详见宿主 setPlatformEnabled 的说明）。
        //
        //   现在唯一的"不可关"判据是**通用的**：它是最后一个开着的平台。
        //   全关掉会让侧边栏一个入口都不剩，用户就找不回这个插件了。
        const isLastOne = on
          && PLATFORMS.filter((p) => p.id !== meta.id && platforms?.[p.id] === true).length === 0;
        const locked = isLastOne;
        const runtime = state?.status?.[meta.id] ?? null;
        const phase = String(runtime?.phase ?? 'idle');
        const result = results[meta.id] ?? null;
        const fields = PLATFORM_FIELDS[meta.id] ?? [];
        const expanded = openId === meta.id;

        // ⚠ 开关关着的平台不该显示"未连接" —— 那读起来像出错，
        //   而它其实是"你主动关的，没有任何问题"。所以先看开关。
        //   （这个 const 必须在下面的 h(...) **外面** —— 参数位置是表达式，不能声明变量）
        const phaseText = on === false ? '已关闭' : (PHASE_TEXT[phase] ?? phase);

        // 凭据状态（只有需要静态凭据的平台才有意义；微信是扫码，不需要）
        const needsCred = (PLATFORM_FIELDS[meta.id] ?? []).length > 0;
        const cred = creds[meta.id];

        const head = h('div', {
          key: 'head',
          style: { display: 'flex', alignItems: 'center', gap: 8, padding: '5px 0' },
        },
        h('span', { style: { width: 18, height: 18, flex: '0 0 auto', opacity: on ? 1 : 0.35 } },
          h(meta.art, { size: 18 })),
        h('span', { style: { flex: '1 1 auto' }, title: meta.maturityText ?? '' },
          meta.title,
          // 完成度标签 —— **给用户看的实话**（2026-10-08 加）。
          // 起因：提交信息与代码注释互相矛盾，连我自己都误判过"六个平台都能用"。
          // 不做这个标签的话，别人会照着界面以为钉钉/飞书也能干活。
          meta.maturityText === undefined ? null : h('span', {
            style: {
              marginLeft: 6,
              fontSize: 10,
              padding: '1px 5px',
              borderRadius: 999,
              border: '1px solid var(--dsw-alias-border-l1)',
              color: meta.maturity === 'full'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-warn-primary)',
              whiteSpace: 'nowrap',
            },
          }, meta.maturity === 'full' ? '可用' : '部分'),
          /**
           * 「凭据」标记 —— 折叠状态下就能看出"填过没有、是哪一份"。
           *
           * ⚠ 为什么要有它（2026-10-08）：原来凭据状态（"凭据已保存"）是
           *   一个**独立的区块**，跟平台开关平级 —— 于是同一个 QQ 被拆到页面两处。
           *   现在合进这一行：折叠时看标记，展开时看字段。
           *
           * 三态都用不同说法，不能混：
           *   undefined（还没查）→ 显示"…"（**不显示空串** ——
           *                        空串等于什么都没有，用户会以为这功能不存在）
           *   configured:false    → 「· 未填凭据」（这才是要人动手的）
           *   configured:true     → 「· 凭据尾号 XXXX」（能一眼认出是哪一份）
           */
          !needsCred ? null : h('span', {
            style: {
              marginLeft: 6,
              fontSize: 10,
              color: cred?.configured === true
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-label-secondary)',
            },
          }, cred === undefined
            ? '· 查凭据…'
            : (cred.configured === true
              ? `· 凭据尾号 ${cred.appIdTail ?? '????'}`
              : '· 未填凭据')),
        // ⚠ 开关关着的平台不该显示"未连接" —— 那读起来像出错，
        //   而它其实是"你主动关的，没有任何问题"。所以先看开关。
        h('span', {
          style: {
            fontSize: 11,
            marginRight: 6,
            color: on === false ? 'var(--dsw-alias-label-secondary)'
              : phase === 'error' ? 'var(--dsw-alias-state-error-primary)'
              : (phase === 'connected' || phase === 'verified') ? 'var(--dsw-alias-state-success-primary)'
              : 'var(--dsw-alias-label-secondary)',
          },
          title: on === false
            ? '这个平台被关掉了 —— 点左边那个按钮可以打开'
            : String(runtime?.message ?? ''),
        }, phaseText),
        h('button', {
          className: 'qqb-btn qqb-btn-ghost',
          type: 'button',
          disabled: locked,
          title: locked
            ? '它是最后一个开着的平台 —— 全关掉之后侧边栏就没有入口了'
            : (on ? '点击关闭，侧边栏入口会消失' : '点击开启，侧边栏会出现入口'),
          onClick: () => { void toggle(meta.id, !on); },
        }, locked ? '至少留一个' : (on ? '已开启' : '已关闭')),
        h('button', {
          className: 'qqb-btn qqb-btn-ghost',
          type: 'button',
          onClick: () => {
            const next = expanded ? '' : meta.id;
            setOpenId(next);
            // 展开时查一次这个平台的**宿主侧**凭据状态 ——
            // 判据必须来自宿主（输入框永远不回显，不能拿它当依据）
            if (next !== '' && needsCred) void probeCred(next);
          },
        }, expanded ? '收起' : '配置/测试')));

        if (!expanded) return h('div', { key: meta.id }, head);

        // 开通指引 —— 放在最上面：先把"去哪拿凭据"说清，再让人填
        const guide = PLATFORM_GUIDE[meta.id] ?? null;
        const guideNode = guide === null ? null : h('div', {
          key: 'guide',
          className: 'qqb-note',
          style: { display: 'flex', flexDirection: 'column', gap: 4, paddingBottom: 2 },
        },
        h('div', null, h('strong', null, guide.title)),
        ...guide.steps.map((step, index) => h('div', { key: `step-${index}` }, `${index + 1}. ${step}`)),
        guide.link === undefined ? null : h('div', null,
          h('a', { href: guide.link.href, target: '_blank', rel: 'noreferrer' }, guide.link.label)),
        guide.note === undefined ? null : h('div', { style: { opacity: 0.85, marginTop: 2 } }, guide.note));

        const detail = h('div', {
          key: 'body',
          style: { padding: '6px 0 10px 26px', display: 'flex', flexDirection: 'column', gap: 8 },
        },
        guideNode,
        /**
         * 凭据状态 —— 展开时先告诉用户"存过没有"，再给输入框。
         *
         * ⚠ 为什么必须有这一行（2026-10-08）：输入框**永远不回显**
         *   （凭据存宿主、界面不显示明文），所以已配好的用户展开后
         *   会看到一片空白，以为丢了 —— 这正是 2026-10-07 那个
         *   "设置页里凭据消失"的反馈。判据必须来自宿主，不是输入框空不空。
         */
        !needsCred ? null : (() => {
          if (cred === undefined) return h('div', { className: 'qqb-note' }, '正在读取本机凭据状态…');
          const probeFailed = cred?.reason === 'probe-failed' || String(cred?.reason ?? '').startsWith('http-');
          if (probeFailed) {
            return h('div', { className: 'qqb-status err' },
              '读不到本机的凭据状态（Host 侧接口没响应）。下面输入框里是浏览器记着的值，不代表宿主里有没有。');
          }
          if (cred.configured === true) {
            return h('div', { className: 'qqb-saved' },
              h('div', { className: 'qqb-saved-head' },
                h('span', { className: 'qqb-saved-dot' }),
                h('strong', null, '凭据已保存在本机'),
                cred.connected === true ? h('span', { className: 'qqb-saved-ok' }, '已连接') : null),
              h('div', { className: 'qqb-saved-line' },
                `识别码尾号 ${cred.appIdTail ?? '????'}（共 ${cred.appIdLength ?? '?'} 位）· 密钥已保存`),
              h('div', { className: 'qqb-saved-hint' },
                '界面不回显密钥 —— 这是有意的。想换一份就在下面重填，留空则保持原样。'));
          }
          return h('div', { className: 'qqb-note' },
            '本机还没有这个平台的凭据 —— 在下面填好，再点「保存并连接」。');
        })(),
        fields.length === 0
          ? h('div', { className: 'qqb-note' },
              meta.id === 'weixin'
                ? '微信不用填 AppID —— 点下面的按钮会出现一个二维码链接，用手机微信扫码即可。'
                : '这个平台不需要静态凭据。')
          : h('div', null, fields.map((field) => h('div', { className: 'qqb-row', key: field.key },
              h('label', null, field.label),
              h('input', {
                value: forms[meta.id]?.[field.key] ?? '',
                onChange: setField(meta.id, field.key),
                placeholder: field.placeholder ?? '',
                type: field.secret === true ? 'password' : 'text',
                spellCheck: false,
              })))),
        h('div', { className: 'qqb-actions' },
          h('button', {
            className: 'qqb-btn',
            type: 'button',
            disabled: busyId === meta.id,
            onClick: () => { void saveAndTest(meta); },
          }, busyId === meta.id ? '测试中…' : '保存并测试连接')),
        result === null ? null : h('div', {
          className: `qqb-status ${result.kind === 'ok' ? 'ok' : result.kind === 'err' ? 'err' : ''}`,
        }, result.text),
        String(runtime?.message ?? '') === '' ? null : h('div', { className: 'qqb-hint' },
          `宿主状态：${String(runtime.message)}`),
        qrUrl === '' ? null : h('div', { className: 'qqb-row' },
          h('label', null, '扫码'),
          h('a', { href: qrUrl, target: '_blank', rel: 'noreferrer' }, '点这里打开二维码链接'),
          h('div', { className: 'qqb-hint' },
            '用手机微信扫码；或者直接在手机上打开这个链接。扫完这页会自动继续（每 1.5 秒查一次）。')));

        return h('div', { key: meta.id }, head, detail);
      };

      return h('div', { className: 'qqb-row' },
        h('label', null, '平台（开关决定左侧边栏出现哪几个入口；凭据与测试都在这里）'),
        platforms === null
          ? h('div', { className: 'qqb-note' }, '正在读取平台状态…')
          : h('div', null, PLATFORMS.map((meta) => rowFor(meta))),
        note === '' ? null : h('div', { className: 'qqb-status err' }, note),
        h('div', { className: 'qqb-hint' },
          '⚠ 四个平台的能力不同：微信 / 企业微信是**真连接**；飞书 / 钉钉目前只验证**凭据可用**（长连接还需接传输层）。'));
    }

    /**
     * 「可选组件」—— 重 SDK（飞书 30MB / 钉钉 35KB）的安装与卸载。
     *
     * 三条设计原则，都来自"别让用户猜"：
     *   · **体积写在按钮旁边**，在下载**之前** —— 决策点在装之前，不是装之后能卸
     *   · 装的时候**流式显示 pnpm 输出**，否则就是"点了没反应"
     *   · 卸载失败不是错误：Windows 文件锁删不掉，宿主会安排"重启后清理"，
     *     界面要把这句如实说出来，而不是丢个红字吓人
     */
    function ComponentSection() {
      ensureStyle();
      const [snap, setSnap] = React.useState(null);
      const [busy, setBusy] = React.useState('');
      const [note, setNote] = React.useState('');

      const load = React.useCallback(async () => {
        try {
          const r = await fetch(`${CONTROL_BASE}/components`);
          setSnap(await r.json());
        } catch {
          setSnap({ ok: false, components: [], log: [] });
        }
      }, []);

      // 有安装任务在跑 → 1 秒刷一次（看输出）；空闲 → 5 秒
      const hostBusy = String(snap?.busy ?? '');
      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, hostBusy === '' ? 5000 : 1000);
        return () => clearInterval(timer);
      }, [load, hostBusy]);

      /**
       * @param {string} url 完整地址 —— **必须在调用处用字面量拼**。
       *
       * ⚠ 不要用「基址 + 动态路径段」的拼法（这里最早就是那样写的）：
       *   verify-two-sided-paths.mjs 靠**静态比对**两端路径字符串来防"只改一边"，
       *   动态拼接它看不见，等于把这道防线关掉。
       *   （那个写法就是被该校验器抓出来的；这里也刻意**不复述原样**，
       *     否则注释里的反例又会被它的文本搜索命中。）
       */
      const act = async (url, id) => {
        setBusy(id);
        setNote('');
        try {
          const response = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id }),
          });
          const json = await response.json();
          if (json?.ok === false) setNote(String(json.message ?? '操作失败'));
          else if (url.endsWith('/remove')) setNote(String(json?.message ?? '已删除'));
          await load();
        } catch {
          setNote('连不上插件（Host 侧没在跑？）');
        } finally {
          setBusy('');
        }
      };

      const fmt = (bytes) => {
        if (typeof bytes !== 'number' || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
        return (value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)) + ' ' + units[index];
      };

      const components = Array.isArray(snap?.components) ? snap.components : [];
      const logLines = Array.isArray(snap?.log) ? snap.log : [];
      const disabled = hostBusy !== '';

      const rowFor = (c) => h('div', {
        key: c.id,
        style: {
          display: 'flex', flexDirection: 'column', gap: 2,
          padding: '6px 0', borderTop: '1px solid var(--dsw-alias-border-l1)',
        },
      },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        h('span', { style: { flex: '1 1 auto' } }, c.label),
        h('span', {
          style: {
            fontSize: 11, marginRight: 6,
            color: c.installed ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-label-secondary)',
          },
        }, c.installed
          ? `已安装 · ${fmt(c.actualBytes)}`
          : (c.pendingRemoval === true ? '待重启清理' : `未安装 · ${c.approxNote}`)),
        c.installed
          ? h('button', {
              className: 'qqb-btn qqb-btn-ghost',
              type: 'button',
              disabled: busy === c.id || disabled,
              onClick: () => { void act(`${CONTROL_BASE}/components/remove`, c.id); },
            }, busy === c.id ? '处理中…' : '卸载')
          : h('button', {
              className: 'qqb-btn',
              type: 'button',
              disabled: busy === c.id || disabled,
              onClick: () => { void act(`${CONTROL_BASE}/components/install`, c.id); },
            }, busy === c.id ? '处理中…' : '安装')),
      h('div', { className: 'qqb-hint' }, c.purpose),
      c.caveat ? h('div', { className: 'qqb-hint', style: { opacity: 0.8 } }, `⚠ ${c.caveat}`) : null);

      return h('div', { className: 'qqb-row' },
        h('label', null, '可选组件（重 SDK —— 需要才装，装了能回收空间）'),
        components.length === 0
          ? h('div', { className: 'qqb-note' }, '正在读取组件状态…')
          : h('div', null, components.map((c) => rowFor(c))),
        note === '' ? null : h('div', { className: 'qqb-hint' }, note),
        h('div', { className: 'qqb-hint' },
          '装完 / 卸完都**需要重启客户端**才生效。依赖装在 ',
          h('code', null, String(snap?.depsDir ?? '（未知）')),
          ' —— 整个目录可以随时删掉。'),
        logLines.length === 0 ? null : h('pre', {
          style: {
            maxHeight: 180, overflow: 'auto', margin: '6px 0 0', padding: '8px 10px',
            fontSize: 11, lineHeight: 1.5, borderRadius: 8,
            background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)',
            whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          },
        }, logLines.slice(-60).join('\n')));
    }

    /**
     * 设置页：连接 IM
     *
     * ⚠ 2026-10-08 大改：这个组件**不再自己管 QQ 凭据**了。
     *
     *   原来这里是"状态 + 平台开关 + 可选组件 + **独立的 QQ 凭据区** + 脚注"，
     *   而 QQ 凭据区又和平台列表里 QQ 那一行的展开表单**是同一件事** ——
     *   更糟的是两边键名还不一样：
     *     旧的独立区：`appId` / `appSecret`（走浏览器 localStorage）
     *     平台行内  ：`QQ_BOT_APPID` / `QQ_BOT_SECRET`（走宿主凭据存储）
     *   于是用户看到同一个 QQ 被拆到页面两处，而且两处不联动 —— 这就是"乱"。
     *
     *   现在凭据只在**平台那一行**里管（和飞书/钉钉/企微完全一致的形态），
     *   这个组件只负责摆好四件事：状态、平台列表、可选组件、脚注。
     *   所以它自己没有任何 state —— 每个区块自己取数据、自己刷新。
     */
    function QqBridgeSettings() {
      ensureStyle();

      return h('div', { className: 'qqb-wrap' },
        // ① 状态放最上面 —— 打开设置第一眼就知道"能用了没有"
        h(StatusPanel, null),
        // ② 平台列表 —— **这一页的主干**：每个平台一行，
        //    行内有开关、完成度、连接状态、凭据状态；展开后填凭据 / 测连接。
        //
        //    ⚠ 这里原来后面还跟着一个独立的 QQ 凭据区（credentialSection）——
        //    2026-10-08 去掉了。它和行内表单是**同一件事的两处界面**，
        //    而且键名还不一样（那边 `appId/appSecret` 走 localStorage，
        //    这边 `QQ_BOT_APPID/SECRET` 走宿主凭据存储）——
        //    用户看到同一个 QQ 被拆到页面两处，这就是"乱"的来源。
        h(PlatformToggles, null),
        // ③ 可选组件 —— 重 SDK 的安装 / 卸载（体积写在按钮旁，装了能回收空间）
        h(ComponentSection, null),
        // ④ 脚注：**只放对所有平台都成立的话**。
        //
        //    ⚠ 原来这里挂的是 QQ 专属的两条说明（q.qq.com 沙箱要把 QQ 号加进
        //    「消息列表单聊」、以及家用宽带过不了 IP 白名单所以走沙箱）——
        //    它躺在**整页最底部**，跟着"连接 IM"这个多平台页面，
        //    于是一打开页面最显眼的长文案是企鹅的事，别的平台用户看着莫名其妙。
        //    那两条现在归到 QQ 那一行的开通指引里（`PLATFORM_GUIDE.qq.note`），
        //    只有真要连 QQ 的人才在那行展开时看到。
        h('div', { className: 'qqb-hint' },
          '凭据保存在本机，界面不回显密钥；与各平台的通信由 Host 侧插件负责（浏览器直连会被 CORS 拦）。'));
    }

    /**
     * 企鹅图形 —— 抽成一处，侧边栏图标 / 面板头部 / 空状态三处共用。
     *
     * 画法：白肚子 + 黑身 + 橙喙 + 两只眼 + 橙脚，共 10 个基本形状。
     * viewBox 固定 32x32，靠 width/height 缩放 —— 所以同一个图形
     * 在 20px 的侧边栏图标和 96px 的空状态插画里都不会走样。
     */
    function PenguinArt(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      return h('svg', {
        viewBox: '0 0 32 32',
        width: size,
        height: size,
        'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('ellipse', { cx: 16, cy: 18, rx: 9.5, ry: 11, fill: '#2B2F38' }),
      h('ellipse', { cx: 16, cy: 20.5, rx: 6.4, ry: 7.6, fill: '#F4F7FB' }),
      h('circle', { cx: 16, cy: 9.5, r: 6.4, fill: '#2B2F38' }),
      h('ellipse', { cx: 13.6, cy: 9.7, rx: 2.0, ry: 2.4, fill: '#FFFFFF' }),
      h('ellipse', { cx: 18.4, cy: 9.7, rx: 2.0, ry: 2.4, fill: '#FFFFFF' }),
      h('circle', { cx: 13.9, cy: 10.1, r: 1.0, fill: '#1A1D24' }),
      h('circle', { cx: 18.1, cy: 10.1, r: 1.0, fill: '#1A1D24' }),
      h('path', { d: 'M16 12.1 L18.7 14.2 L13.3 14.2 Z', fill: '#F2A03D' }),
      h('ellipse', { cx: 8.6, cy: 24.5, rx: 2.4, ry: 3.4, fill: '#F2A03D' }),
      h('ellipse', { cx: 23.4, cy: 24.5, rx: 2.4, ry: 3.4, fill: '#F2A03D' }));
    }

    // ---------------------------------------------------------------- 各平台图形
    //
    // 和 PenguinArt 同一套做法：内联 SVG、viewBox 固定 32x32、靠 width/height 缩放。
    // **不用图片文件、不引依赖、不 import 任何 DSH 包** —— 纯 JS 画，
    // 这样在 16px 的侧边栏图标和 96px 的空状态插画里都不会走样。
    //
    // ⚠ 刻意**不追求和官方 logo 一模一样**（用户原话："也不要很准，和奇怪的企鹅类似即可"）。
    //   用平台主色 + 可辨认的几何形状即可，同时也避开了品牌素材的授权问题。

    /** 微信「绿泡泡」：一大一小两个气泡 + 两点眼睛。 */
    function WeixinArt(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      return h('svg', {
        viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('ellipse', { cx: 12.6, cy: 13.4, rx: 10.6, ry: 8.8, fill: '#07C160' }),
      h('circle', { cx: 9.2, cy: 11.8, r: 1.5, fill: '#FFFFFF' }),
      h('circle', { cx: 15.8, cy: 11.8, r: 1.5, fill: '#FFFFFF' }),
      // 小白边把两个气泡分开 —— 否则同色叠在一起会糊成一团
      h('ellipse', { cx: 20.6, cy: 21.4, rx: 8.6, ry: 7.4, fill: '#FFFFFF' }),
      h('ellipse', { cx: 20.6, cy: 21.4, rx: 7.4, ry: 6.3, fill: '#07C160' }),
      h('circle', { cx: 18.2, cy: 20.2, r: 1.2, fill: '#FFFFFF' }),
      h('circle', { cx: 23.0, cy: 20.2, r: 1.2, fill: '#FFFFFF' }));
    }

    /** 飞书 Bot：折纸风的鸟 —— 一片圆弧主体 + 一道白色折线。 */
    function FeishuArt(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      return h('svg', {
        viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('path', { d: 'M6.5 25.5 C6.5 14 14 6.5 25.5 6.5 C25.5 18 18 25.5 6.5 25.5 Z', fill: '#3370FF' }),
      h('path', { d: 'M10.5 21.5 L21.5 10.5', stroke: '#FFFFFF', strokeWidth: 2.2, strokeLinecap: 'round', fill: 'none' }),
      h('path', { d: 'M21.5 10.5 L21.5 16.5', stroke: '#FFFFFF', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }),
      h('path', { d: 'M10.5 21.5 L16.5 21.5', stroke: '#FFFFFF', strokeWidth: 1.6, strokeLinecap: 'round', fill: 'none' }));
    }

    /** 钉钉 Bot：一只翅膀 + 白色闪电折线。 */
    function DingtalkArt(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      return h('svg', {
        viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('path', { d: 'M5.5 19.5 C11 7.5 22.5 4.5 27 6.5 C22 9.5 18.5 13.5 16.5 20.5 L11.5 15.5 Z', fill: '#3296FA' }),
      h('path', { d: 'M11 27 L17 17.5 L14.5 16.5 L21 9.5 L16 19 L18.5 20 Z', fill: '#FFFFFF' }),
      h('path', { d: 'M16.5 20.5 L11.5 15.5', stroke: '#FFFFFF', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none' }));
    }

    /** 企业微信：蓝色圆角气泡 + 两点 + 一条小尾巴。 */
    function WecomArt(props) {
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      return h('svg', {
        viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true',
        style: { display: 'block' },
      },
      h('rect', { x: 4, y: 6.5, width: 24, height: 18.5, rx: 5.5, fill: '#2F7DFF' }),
      h('path', { d: 'M12 25 L12 30 L18.5 25 Z', fill: '#2F7DFF' }),
      h('circle', { cx: 11.8, cy: 15.8, r: 2.0, fill: '#FFFFFF' }),
      h('circle', { cx: 20.2, cy: 15.8, r: 2.0, fill: '#FFFFFF' }));
    }

    /**
     * 平台表 —— 侧边栏条目、面板、设置页开关**共用这一份**，别各写一份。
     *
     *   id        —— 平台标识（与宿主 PLATFORM_IDS 对应）
     *   panelId   —— sidebar.panellist 的 id，同时是 main 的 key（两者必须一致）
     *   title     —— 侧边栏与面板标题
     *   order     —— 侧边栏顺序（企鹅 20，其余依次往后）
     *   art       —— 上面那些图形组件
     *   live      —— **传输层是否已实现**。只有 QQ 是 true。
     *                其余为 false：面板照常显示（格式一致），但会明确写"传输层未接入"，
     *                并且**不轮询 QQ 的会话数据**（那会把企鹅的消息错显示到别的平台下）。
     *   empty     —— 空状态与未接入状态的文案
     *   accent    —— 头部小圆点的品牌色
     */
    /**
     * 平台清单。
     *
     * ⚠ `maturity` 字段是**给用户看的实话**（2026-10-08 加）——
     *   起因：提交信息说"钉钉/飞书真接上"，而传输层注释说"只做握手测试"，
     *   两边不一致，我自己都差点以为六个平台都能用。
     *
     *   所以每个平台显式声明它能做到哪一步，设置页如实显示：
     *     'full'     收发双向 + 已接 agent
     *     'inbound'  能收，但**发不回去**（缺出站实现或官方未公开回复格式）
     *     'probe'    只验证凭据可用，还没接长连接
     *
     *   判据来自 transports.js 的代码本体（不是注释、不是提交信息）：
     *     qq       ✅ 收发 + 接 agent（startQqClient 那套）
     *     weixin   ✅ 收发 + 接 agent（HTTP 长轮询，回复带 context_token）
     *     wecom    ⚠️ 只有 startWecomLoop（收）；**回复帧形状官方未公开**
     *     dingtalk ⚠️ 有 startDingtalkStream（收）；出站未实现，且要装 SDK 组件
     *     feishu   ⚠️ 有 startFeishuWs（收）；出站未实现，且要装 SDK 组件
     */
    /**
     * ⚠ `order` 为什么从 20..24 挪到 100..104（2026-10-08）：
     *
     * 侧边栏是**一条全局列表**，按 `order` 升序排 —— 而**没有分组/嵌套能力**
     * （`sidebar.panellist` 的注册契约只有 `id` / `order` / `label`）。
     * 所以只要别的插件用了和我们**相同或相邻**的 order，它就会插到我们中间。
     *
     * 实测就撞上了：装了一个新插件（`dsh-context`），它用 `order: 20` ——
     * 和企鹅**同分**，于是它夹在企鹅和微信之间：
     *
     *     plugins(0)  schedules(10)  qq-panel(20)  dsh-context(20)  weixin-panel(21)
     *
     * 现在的取值策略：
     *   · **整体排到最后**（100 起）—— DSH 自带的是 0 / 10，第三方插件的面板
     *     跟在它们后面更符合这个侧边栏的设计意图
     *   · **彼此紧凑**（100..104 连续）—— 我们自己的面板不该被自己拆开
     *   · **和常见区间拉开**（别人多取 0/10/20/30 那几档）—— 降低再次撞车的概率
     *
     * ⚠ 这只是"降低概率"，**不是保证**：另一个插件完全可以也取 100。
     *   要彻底解决得让侧边栏支持分组，那是 DSH 侧的能力，不是插件能给的。
     *   （同一份说明也写在两条静态注册注释里，免得只看注册处的人不知道缘由。）
     */
    const PLATFORMS = [
      {
        id: 'qq', panelId: 'qq-panel', title: '奇怪的企鹅', order: 100, art: PenguinArt, live: true,
        maturity: 'full', maturityText: '完整可用 —— 收发 + agent',
        accent: '#2B2F38',
        emptyTitle: '这里是企鹅的窝',
        emptyDesc: '在手机 QQ 上给它发消息，它会在这台电脑上干活；也可以直接在下面输入 —— 两条路走的是同一个大脑。',
        // ⚠ 面板文案块（2026-10-08 加）：面板已抽成**共用实现**，
        //   每个平台的空状态/提示语由这里给，不再写死在面板里。
        ui: {
          offlineHint: '去「设置 → 连接 QQ」看看',
          emptyTitle: '这里是企鹅的窝',
          emptyDesc: '在手机 QQ 上给它发消息，它会在这台电脑上干活；也可以直接在下面输入 —— 两条路走的是同一个大脑。',
          placeholder: '让它干点什么…',
          note: '回答不推手机',
        },
      },
      {
        // ⚠ 微信的 `live` 是 **true**（2026-10-08 修）：它的传输层确实已实现
        //   （扫码换 token + 长轮询收 + sendmessage 发 + 已接 agent），
        //   只是**面板**当初没跟着接上，才一直被渲染成"占位壳"。
        //   现在面板是共用的，所以这里如实标 true —— 点进去能看到真实对话、也能发。
        id: 'weixin', panelId: 'weixin-panel', title: '微信绿泡泡', order: 101, art: WeixinArt, live: true,
        maturity: 'full', maturityText: '完整可用 —— 收发 + agent',
        accent: '#07C160',
        emptyTitle: '绿泡泡还没接上',
        emptyDesc: '微信（个人号）走官方 iLink / ClawBot 通道：扫码换 bot_token，再用长轮询收消息 —— 免公网、不需要 SDK。'
          + '已接 agent：在微信里给 ClawBot 发消息，它会用这台电脑上的 agent 回答。',
        ui: {
          offlineHint: '去「设置 → 连接 IM」里点微信的「测试连接」',
          emptyTitle: '绿泡泡还没接上',
          emptyDesc: '微信走官方 iLink / ClawBot 通道：扫码换 bot_token，再用长轮询收消息。'
            + '在微信里给 ClawBot 发消息，它会用这台电脑上的 agent 回答；也可以直接在下面输入。',
          placeholder: '让它干点什么…',
          note: '回答不推微信',
        },
      },
      {
        id: 'wecom', panelId: 'wecom-panel', title: '企业微信', order: 102, art: WecomArt, live: false,
        maturity: 'inbound', maturityText: '只能收 —— 发不回去',
        accent: '#2F7DFF',
        emptyTitle: '企业微信只能收，不能回',
        emptyDesc: '官方长连接（wss://openws.work.weixin.qq.com）免公网，订阅 + 心跳 + 收消息都已实现；'
          + '**但回复帧的形状官方未公开**，所以它只报"订阅成功 + 收到过几条"，不假装能回。'
          + '只能服务企业内部成员。',
      },
      {
        id: 'feishu', panelId: 'feishu-panel', title: '飞书Bot', order: 103, art: FeishuArt, live: false,
        maturity: 'inbound', maturityText: '能收，但发不回去',
        accent: '#3370FF',
        emptyTitle: '飞书还没接上出站',
        emptyDesc: '长连接走官方 SDK（`@larksuiteoapi/node-sdk` 的 WSClient，带 protobufjs 私有协议）。'
          + '入站已实现；**出站还没做**，所以现在接不了 agent。'
          + '要先在设置页安装可选组件，且这一家的实现成本最高。',
      },
      {
        id: 'dingtalk', panelId: 'dingtalk-panel', title: '钉钉Bot', order: 104, art: DingtalkArt, live: false,
        maturity: 'inbound', maturityText: '能收，但发不回去',
        accent: '#3296FA',
        emptyTitle: '钉钉还没接上出站',
        emptyDesc: 'Stream 模式走官方 SDK（`dingtalk-stream` 的 DWClient）。'
          + '入站已实现；**出站还没做**（Stream 通道本身不能回复，发送要另走 REST），所以现在接不了 agent。'
          + '要先在设置页安装可选组件。',
      },
    ];

    const PLATFORM_BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

    /**
     * 每个平台要在设置页填哪几个字段。
     *
     * ⚠ 字段名必须和宿主 `PLATFORM_CREDENTIAL_KEYS` 那套 env 键**逐字对应** ——
     *   两端各写一份字符串是本项目踩过的坑（改名时漏了一边 → 六个端点全 404）。
     *   这里由 verify 脚本交叉比对。
     *
     * 微信是空的：它没有静态凭据，靠**扫码**换 bot_token（存在宿主侧）。
     */
    const PLATFORM_FIELDS = {
      qq: [
        { key: 'QQ_BOT_APPID', label: 'AppID', placeholder: 'q.qq.com 机器人后台 → 开发设置' },
        { key: 'QQ_BOT_SECRET', label: 'AppSecret', secret: true },
      ],
      weixin: [],
      feishu: [
        { key: 'FEISHU_APP_ID', label: 'App ID', placeholder: 'open.feishu.cn → 开发者后台 → 凭证与基础信息' },
        { key: 'FEISHU_APP_SECRET', label: 'App Secret', secret: true },
      ],
      dingtalk: [
        { key: 'DINGTALK_CLIENT_ID', label: 'Client ID（AppKey）', placeholder: 'open.dingtalk.com → 应用信息' },
        { key: 'DINGTALK_CLIENT_SECRET', label: 'Client Secret（AppSecret）', secret: true },
        { key: 'DINGTALK_ROBOT_CODE', label: 'RobotCode（可留空）', placeholder: '机器人的 robotCode，发消息时要用' },
      ],
      wecom: [
        { key: 'WECOM_BOT_ID', label: '机器人 ID（bot_id）', placeholder: '企业微信后台 → 应用管理 → 智能机器人' },
        { key: 'WECOM_BOT_SECRET', label: 'Secret', secret: true },
      ],
    };

    /**
     * 每个平台的**开通指引** —— 直接写在设置页里。
     *
     * 为什么必须有：这些凭据分散在四家后台，入口各不相同，而且每家的
     * **坑**都不一样（QQ 要加沙箱白名单、飞书要企业、钉钉要组织授权、
     * 企微只能内部成员）。让用户去别处查文档，等于把"点了没反应"
     * 变成他自己要排查的问题。
     *
     * 写法约定：
     *   · steps —— 可照做的编号步骤，每条一句话，**带具体路径**
     *   · link  —— 该去哪（可点击）
     *   · note  —— 最容易踩的坑，以及这一步**做不到什么**（别让人误以为连上就万事大吉）
     */
    const PLATFORM_GUIDE = {
      qq: {
        title: '凭据从哪来',
        steps: [
          '打开 q.qq.com，用 QQ 登录，创建机器人应用（需要实名认证）',
          '进机器人后台 →「开发设置」，复制 AppID 和 AppSecret',
          '⚠ 再到「沙箱配置」→「消息列表单聊」，**把你自己的 QQ 号加进去** —— 不加的话机器人收不到任何消息，而且不报错',
        ],
        link: { href: 'https://q.qq.com', label: 'q.qq.com（QQ 机器人后台）' },
        note: '家用宽带没有固定公网 IP，正式环境的 IP 白名单过不去，所以默认走沙箱环境 —— 自己用完全够。',
      },
      weixin: {
        title: '怎么连（不用申请任何凭据）',
        steps: [
          '手机微信升到 8.0.70 或更高',
          '微信 →「我」→「设置」→「插件」，确认能看到「微信 ClawBot」',
          '回到这里点「保存并测试连接」，会出现一个二维码链接 —— 用手机微信扫码',
        ],
        note: '二维码 5 分钟内有效。扫过之后 bot_token 存在本机，重启客户端不用重扫。若扫码没反应，先回手机那个插件页确认它已启用。',
      },
      feishu: {
        title: '凭据从哪来',
        steps: [
          '打开 open.feishu.cn，进入「开发者后台」',
          '创建「**企业自建应用**」（个人可以先自建一个飞书企业来测试）',
          '进应用 →「凭证与基础信息」，复制 App ID 和 App Secret',
        ],
        link: { href: 'https://open.feishu.cn/app', label: 'open.feishu.cn（飞书开发者后台）' },
        note: '⚠ 想让飞书**真的收消息**要两步：① 在下面「可选组件」里装「飞书长连接」（约 30 MB）；② 回飞书后台把「事件与回调 → 事件配置」切成「使用长连接接收事件」—— 注意第 ② 步保存时**要求客户端已经在线**，所以先做 ①、在这里点一次「保存并测试连接」，再回去点保存。没装组件时，这里只验证凭据是否可用。',
      },
      dingtalk: {
        title: '凭据从哪来',
        steps: [
          '打开 open.dingtalk.com，进入「开发者后台」',
          '创建「**企业内部应用**」—— 需要钉钉组织；开发者权限由组织管理员在 OA 管理后台授予',
          '进应用 →「应用信息」，复制 Client ID（AppKey）和 Client Secret（AppSecret）',
          'RobotCode 在机器人配置里，**发消息时才用得上**，现在可以先留空',
        ],
        link: { href: 'https://open-dev.dingtalk.com', label: 'open.dingtalk.com（钉钉开发者后台）' },
        note: '⚠ 想让钉钉**真的收消息**，先在下面「可选组件」里装「钉钉长连接」（约 35 KB）—— 不装的话这里只验证凭据是否可用。另外标准版有配额：单应用 20 QPS，且组织内所有企业内部应用**合计 10000 次/自然月**，别把「测试连接」当心跳反复点。',
      },
      wecom: {
        title: '凭据从哪来',
        steps: [
          '打开 work.weixin.qq.com 管理后台（个人可以免费注册一个企业）',
          '「应用管理」→ 创建「**智能机器人**」',
          '在机器人详情页复制 机器人 ID（bot_id）和 Secret',
        ],
        link: { href: 'https://work.weixin.qq.com', label: 'work.weixin.qq.com（企业微信管理后台）' },
        note: '⚠ 智能机器人**只能服务企业内部成员** —— 外部群、上下游群加不了它，单聊也只覆盖"机器人可见范围内"的成员。另外每个机器人同时只允许一条连接，新连接会把旧的踢下线。',
      },
    };

    /** 阶段 → 界面上那句话 + 颜色。宿主返回的 phase 是唯一真相。 */
    /**
     * 状态列的用词 —— 每个词都要回答"**现在能不能用**"，而不是"做没做过某个动作"。
     *
     * ⚠ `idle` 原来叫「未测试」（2026-10-08 改）。那个词有歧义：
     *   字面上它是"没跑过测试这个动作"，但用户会读成
     *   "不能用 / 没弄好 / 我是不是漏了一步"。而且它**没说清是哪一种情况** ——
     *   开关关着、没填凭据、还没开始连，全被归进同一个词。
     *
     *   现在叫「未连接」，真正的信息由**运行时说明**那一行给
     *   （宿主会写清"缺凭据"还是"正在连"还是"连接出错"），
     *   界面这一列只管"连上没连上"这一件事实。
     *
     * ⚠ `no-credential` 也补了：它是"缺凭据"（要人动手），原来落到默认分支
     *   会显示成裸的 `no-credential` 英文字符串。
     *
     * 判据保持唯一：宿主说 `phase === 'connected'` 才算连上。
     */
    const PHASE_TEXT = {
      idle: '未连接',
      connecting: '连接中…',
      'need-scan': '等你扫码',
      'no-credential': '缺凭据',
      verified: '已连接',
      connected: '已连接',
      error: '连接出错',
    };

    /**
     * 侧边栏入口的"在线"广播通道。
     *
     * 为什么要有它：连通性由面板轮询（它本来就在查 /status），
     * 而侧边栏图标是**另一个组件**。两者要共享这个布尔值。
     *
     * 做法：一个极简的"模块级 pub/sub + window 上的 sidecar"。
     *   · 为什么不用 React context：这两个组件挂在不同的槽位（sidebar.panellist
     *     和 main），中间隔着 DSH 自己的树，我没法给它俩套一个 Provider。
     *   · 为什么 sidecar 放 window 上：图标可能**先于**面板挂载（用户还没点开面板），
     *     那时还没有任何轮询。window 上的值让图标一挂载就能读到最近一次已知结果。
     *
     * ⚠ 必须**按平台**存（2026-10-08 修）：原来只有一个全局布尔值，
     *   于是微信面板的轮询会覆盖 QQ 图标的绿灯状态、反之亦然 ——
     *   表现为"两个平台的在线灯一起亮/一起灭"，而真相是它们各自独立。
     *
     * ⚠ 注意这里**不是**经验库 E15 说的那种"模块级可变中继" ——
     *   那一条讲的是"写进去没人读、读的人永远拿到默认值"（接线漏了却不报错）。
     *   这里两条线都在同一个文件里接上了：面板调 publishLink() 写，
     *   图标通过 useLinkUp(platformId) 读，而且**同一份值**在 window 上兜底。
     */
    const LINK_STATE_KEY = '__dshImBridgeLink';
    const linkSubscribers = new Map();   // platformId -> Set<setter>

    /** 面板每次探到连通性就调它，广播给**该平台**的所有订阅者 */
    function publishLink(platformId, up) {
      const id = String(platformId ?? 'qq');
      try {
        const all = globalThis[LINK_STATE_KEY] ?? {};
        all[id] = up === true;
        globalThis[LINK_STATE_KEY] = all;
      } catch { /* ignore */ }
      for (const fn of [...(linkSubscribers.get(id) ?? [])]) {
        try { fn(up === true); } catch { /* ignore */ }
      }
    }

    /** 订阅**某个平台**的连通性；挂载时先用 window 上的已知值初始化 */
    function useLinkUp(platformId) {
      const id = String(platformId ?? 'qq');
      const [up, setUp] = React.useState(() => {
        try { return globalThis[LINK_STATE_KEY]?.[id] === true; } catch { return false; }
      });
      React.useEffect(() => {
        const set = linkSubscribers.get(id) ?? new Set();
        linkSubscribers.set(id, set);
        set.add(setUp);
        // 订阅时同步一次 —— 订阅前可能已经有别的组件探到了
        try { setUp(globalThis[LINK_STATE_KEY]?.[id] === true); } catch { /* ignore */ }
        return () => { set.delete(setUp); };
      }, [id]);
      return up;
    }

    /**
     * 通用平台图标 —— 每个平台一个实例：`makePlatformIcon(meta)`。
     *
     * ownerProps: { size: number, active: boolean }（由 sidebar.panellist 提供）
     *   · size   —— 方块边长，直接用它，别写死（不同布局下 DSH 会给不同值）
     *   · active —— 这个面板当前是否被选中，用来加深背景
     *
     * ⚠ 图形按 size 的 **78%** 缩放 —— 留出内边距，视觉上才不会"顶格"。
     *
     * ⚠ 在线角标为什么是"图标右上角"而不是"名字右边的小灯泡"：
     *   侧边栏那一行是 **DSH 自己渲染的**，结构是
     *     button.panelRow > [ span.panelGlyph（放我的图标）, span.panelTitle（DSH 的文字） ]
     *   **panelTitle 是 DSH 的 DOM，插件插不进去** —— 除非去操作别人的 DOM
     *   （不可靠、也不该做：那是越界，DSH 一改结构就崩）。
     *   所以把状态放在**我能控制的那块**：图标右上角。
     *   这也是通用做法（和 App 图标上的状态点一样），一眼可见。
     *
     * 刻意复用同一套 class（`qqb-penguin` / `qqb-badge-dot`），所以尺寸、
     * 悬停、选中加深、在线角标的行为**完全一致**，只是图形和提示文字换成各自的。
     *
     * ⚠ 在线角标只在 `meta.live` 为真时才可能亮 —— 没接传输层的平台画一个
     *   "在线"点等于骗人（界面上任何"结论"都必须是真的）。
     *
     * ⚠ 这里**没有**单独的「QQ 图标」函数（2026-10-08 删）：
     *   它曾经是 QQ 专用的，后来这个通用版把它完全覆盖了，于是它变成死代码。
     *   留着它会让人以为"QQ 走特殊路径" —— 实际上 QQ 现在也走这个通用版
     *   （注册处 `makePlatformIcon(meta)`，meta 来自 PLATFORMS 表）。
     */
    function makePlatformIcon(meta) {
      const Art = meta.art;
      return function PlatformIcon(props) {
        ensureStyle();
        const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
        const active = props?.active === true;
        // ⚠ useLinkUp(平台) 必须**无条件调用**（hooks 规则）——
        //   不能写成 `meta.live === true && useLinkUp(meta.id)`：`&&` 短路会让这个
        //   hook 有时执行有时不执行。这里 meta.live 是常量所以目前不会炸，
        //   但等哪天它变成动态值（比如"接入后立刻亮灯"），那就是真 bug。
        //
        //   ⚠ 要传平台 id（2026-10-08 修）：原来读的是**全局**那一个布尔值，
        //     于是微信的绿灯会跟着 QQ 的连通状态亮/灭。
        const linked = useLinkUp(meta.id);
        const online = meta.live === true && linked;

        return h('div', {
          className: active ? 'qqb-penguin qqb-penguin-active' : 'qqb-penguin',
          style: { width: size, height: size, position: 'relative' },
          title: meta.live === true
            ? (online ? `${meta.title}（在线）` : `${meta.title}（未连通）`)
            : `${meta.title}（传输层未接入）`,
          'aria-label': meta.title,
        },
        h(Art, { size: Math.round(size * 0.78) }),
        online ? h('span', { className: 'qqb-badge-dot', 'aria-hidden': 'true' }) : null);
      };
    }

    /**
     * **共用**的「真实会话」面板 —— QQ 和微信都用它，只是传进来的 `meta` 不同
     * （调用方用 `QqPanel.bind(null, meta)` 传，见下方注册处）。
     *
     * 数据来源：宿主半的 8799 接口（**客户端没有会话数据 API**，查证过）：
     *   GET  /im-bridge/messages?limit=N&platform=<id>  → **那个平台**专用会话的消息
     *   POST /im-bridge/send  {text, platform}          → 投给该平台的 agent
     *   GET  /im-bridge/status?platform=<id>            → **那个平台**的连通性
     *
     * ⚠ 三个接口都必须带 platform（2026-10-08 修）。原来它们都是 QQ 专用
     *   （写死会话 id + 不带平台参数），于是点开微信面板：
     *   · 显示的是 **QQ 的对话**（用户报的"没有消息记录"）
     *   · 在线绿灯用的是 **QQ 的连通状态**（两个平台的状态串了）
     *   而 `platform` 缺失时后端回落到 QQ，所以"只有一个平台"的历史行为不变。
     *
     * 轮询而不是推送：8799 是个极简的 http 服务，没有 WebSocket。
     * 2 秒一次的开销可以忽略（本机回环），换来的是实现简单、不需要处理重连。
     */
    function QqPanel(meta) {
      // 调用方一定传 meta；但这个默认值让"漏传"表现为一个能看懂的界面，
      // 而不是 `meta.art is not a function` 之类的崩溃（客户端插件崩溃 = 整块空白）
      const m = meta ?? {};
      const Art = m.art ?? PenguinArt;
      const platformId = m.id ?? 'qq';
      const platformTitle = m.title ?? '奇怪的企鹅';
      const ui = m.ui ?? {
        offlineHint: '去「设置 → 连接 QQ」看看',
        emptyTitle: '这里是企鹅的窝',
        emptyDesc: '在手机 QQ 上给它发消息，它会在这台电脑上干活；'
          + '也可以直接在下面输入 —— 两条路走的是同一个大脑。',
        placeholder: '让它干点什么…',
        note: '回答不推手机',
      };

      ensureStyle();
      const [data, setData] = React.useState(null);
      const [linkUp, setLinkUp] = React.useState(false);
      const [text, setText] = React.useState('');
      const [sending, setSending] = React.useState(false);
      const [error, setError] = React.useState('');
      const bodyRef = React.useRef(null);
      const stickBottom = React.useRef(true);

      const load = React.useCallback(async () => {
        try {
          const response = await fetch(
            CONTROL_BASE + '/messages?limit=80&platform=' + encodeURIComponent(platformId),
            { method: 'GET' },
          );
          const json = await response.json();
          setData(json);
          setError(json?.ok === false ? String(json.error ?? '读取失败') : '');
        } catch (err) {
          setError('连不上插件（Host 侧没在跑？）');
        }
      }, [platformId]);

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 2000);
        return () => clearInterval(timer);
      }, [load]);

      /**
       * 在线状态 —— 单独查一次 /status（/messages 不返回连通性）。
       *
       * ⚠ 必须带 platform（2026-10-08 修）：不带的话后端返回的是 **QQ 的**
       *   连通状态，于是微信面板会用 QQ 的状态点亮自己的绿灯。
       *
       * 判据刻意用**严格的 `=== true`**：只要不是明确连通，就不显示绿灯。
       * 这样"没配凭据"、"正在连"、"连上过又断了"都自然落到"不显示"，
       * 不需要在客户端猜原因 —— 根因看设置页的状态面板就够了。
       *
       * 6 秒一次：连通性变化没那么频繁，而且它比消息轮询轻。
       */
      React.useEffect(() => {
        let alive = true;
        const probe = async () => {
          try {
            const response = await fetch(
              CONTROL_BASE + '/status?platform=' + encodeURIComponent(platformId),
              { method: 'GET' },
            );
            const json = await response.json();
            if (alive) { const up = json?.connected === true; setLinkUp(up); publishLink(platformId, up); }
          } catch (err) {
            // 连插件都问不到 = 肯定不在线
            if (alive) { setLinkUp(false); publishLink(platformId, false); }
          }
        };
        void probe();
        const timer = setInterval(() => { void probe(); }, 6000);
        return () => { alive = false; clearInterval(timer); };
      }, [platformId]);

      // 贴底逻辑：只有用户本来就在底部时才自动滚 —— 否则他正在往上翻，
      // 每次轮询都把他拽回底部会很难用。
      React.useEffect(() => {
        const node = bodyRef.current;
        if (node === null || !stickBottom.current) return;
        node.scrollTop = node.scrollHeight;
      }, [data]);

      const onScroll = () => {
        const node = bodyRef.current;
        if (node === null) return;
        stickBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      };

      const send = async () => {
        const value = text.trim();
        if (value === '' || sending) return;
        setSending(true);
        setError('');
        try {
          const response = await fetch(CONTROL_BASE + '/send', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: value, platform: platformId }),
          });
          const json = await response.json();
          if (json?.ok === false) setError(String(json.error ?? '发送失败'));
          else {
            setText('');
            stickBottom.current = true;
            await load();
          }
        } catch (err) {
          setError('发送失败：连不上插件');
        } finally {
          setSending(false);
        }
      };

      const onKeyDown = (event) => {
        // Ctrl/Cmd + Enter 发送；单独的 Enter 换行（和聊天框的习惯一致）
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void send();
        }
      };

      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const busy = data?.busy === true;
      const queued = Number(data?.queued ?? 0);

      // ── 头部：头像 + 标题（连通时带绿灯）+ 状态 ──
      const head = h('div', { className: 'qqb-panel-head' },
        h('div', { className: 'qqb-head-avatar' }, h(Art, { size: 28 })),
        h('div', { className: 'qqb-head-text' },
          h('div', { className: 'qqb-panel-title-row' },
            h('div', { className: 'qqb-panel-title' }, platformTitle),
            // 绿灯只在**明确连通**时出现；不连通就完全不渲染（不是灰点）
            linkUp ? h('span', {
              className: 'qqb-online',
              title: '已连通 ' + platformTitle,
              'aria-label': '已连通 ' + platformTitle,
            }) : null),
          h('div', { className: 'qqb-panel-sub' },
            error !== '' ? '连接异常'
              : busy ? '正在处理你的消息…'
              : linkUp ? (messages.length === 0 ? '在线待命' : ('在线 · 最近 ' + messages.length + ' 条'))
              : ('未连通 ' + platformTitle + '（' + ui.offlineHint + '）'))),
        h('div', { className: 'qqb-panel-spacer' }),
        error !== '' ? h('span', { className: 'qqb-badge err' }, error) : null,
        busy ? h('span', { className: 'qqb-badge busy' }, '处理中') : null,
        queued > 0 ? h('span', { className: 'qqb-badge' }, '排队 ' + queued) : null);

      // ── 消息区（空的时候给一个像样的空状态）──
      // 外面 .qqb-panel-body 负责滚动+居中，里面 .qqb-body-inner 限宽 ——
      // 这样消息和输入框**左右对齐在同一列**，不会一个顶满、一个窄。
      const body = h('div', { className: 'qqb-panel-body', ref: bodyRef, onScroll },
        h('div', { className: 'qqb-body-inner' },
        messages.length === 0
          ? h('div', { className: 'qqb-panel-empty' },
              h('div', { className: 'qqb-empty-art' }, h(Art, { size: 96 })),
              h('div', { className: 'qqb-empty-title' }, ui.emptyTitle),
              h('div', { className: 'qqb-empty-desc' }, ui.emptyDesc),
              h('div', { className: 'qqb-empty-hint' },
                data?.note !== undefined ? String(data.note) : ''))
          : messages.map((message, index) => {
              const role = String(message?.role ?? 'assistant');
              const cls = role === 'user'
                ? 'qqb-msg qqb-msg-user'
                : role === 'tool' ? 'qqb-msg qqb-msg-tool' : 'qqb-msg qqb-msg-assistant';
              // 只有"工具"需要标签 —— 用户和企鹅靠位置+颜色就能分辨
              const who = role === 'tool' ? '工具调用' : null;
              return h('div', { className: cls, key: index },
                who === null ? null : h('div', { className: 'qqb-msg-role' }, who),
                h('div', null, String(message?.text ?? '')));
            })));

      // ── 底部：模型 + 上下文用量 + 输入区 ──
      const info = data?.info ?? {};

      // 上下文用量：窗口拿不到时只报"已用"，别假装百分比
      const used = typeof info.usedTokens === 'number' ? info.usedTokens : null;
      const window_ = typeof info.contextWindow === 'number' ? info.contextWindow : null;
      const pct = (used !== null && window_ !== null && window_ > 0)
        ? Math.min(100, Math.round((used / window_) * 100)) : null;
      const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

      const ctxNode = used === null ? null : h('span', { className: 'qqb-ctx' },
        h('span', null, '上下文'),
        pct === null ? null : h('span', { className: 'qqb-ctx-bar' },
          h('span', {
            className: 'qqb-ctx-fill'
              + (pct >= 85 ? ' qqb-ctx-danger' : pct >= 65 ? ' qqb-ctx-warn' : ''),
            style: { width: pct + '%' },
          })),
        h('span', null, pct === null
          ? (fmtK(used) + ' tokens')
          : (fmtK(used) + ' / ' + fmtK(window_) + '  ' + pct + '%')),
        // 估算 vs 实测要区分 —— 不能把估算说成真实用量
        info.usedTokensExact === true ? null : h('span', { style: { opacity: .6 } }, '（估算）'));

      const foot = h('div', { className: 'qqb-panel-foot' },
        h('div', { className: 'qqb-foot-inner' },
        h('div', { className: 'qqb-send-row' },
          h('textarea', {
            className: 'qqb-send-box',
            value: text,
            placeholder: ui.placeholder,
            onChange: (event) => setText(event.target.value),
            onKeyDown,
            rows: 1,
          }),
          h('button', {
            className: 'qqb-send-btn',
            type: 'button',
            title: sending ? '发送中…' : '发送（Ctrl + Enter）',
            'aria-label': '发送',
            disabled: sending || text.trim() === '',
            onClick: () => { void send(); },
          }, sending ? h('span', { style: { fontSize: 11 } }, '…') : h(SendIcon, { size: 16 }))),
        h('div', { className: 'qqb-panel-note' },
          h(ModelChip, { info, onChanged: () => { void load(); } }),
          ctxNode,
          h('div', { className: 'qqb-panel-spacer' }),
          h('span', null, 'Ctrl + Enter 发送'),
          h('span', null, '·'),
          h('span', null, ui.note))));

      return h('div', { className: 'qqb-panel' }, head, body, foot);
    }

    /**
     * 通用平台面板 —— 给「传输层还没接」的平台用。
     *
     * 刻意和企鹅面板**同一套 DOM 结构与 class**（qqb-panel / qqb-panel-head /
     * qqb-panel-body / qqb-body-inner / qqb-panel-foot …），所以点进去看起来
     * 是同一个产品，只有图形和文案换成各自平台。
     *
     * ⚠ 它**不轮询 `/messages`** —— 那个接口返回的是 **QQ 专用会话**的数据，
     *   显示到这里就等于把企鹅的消息挂到别的平台名下。等各平台传输层接好，
     *   再把 `meta.live` 打开、接上真实的会话路由。
     */
    function makePlatformPanel(meta) {
      const Art = meta.art;
      return function PlatformPanel() {
        ensureStyle();

        const head = h('div', { className: 'qqb-panel-head' },
          h('div', { className: 'qqb-head-avatar' }, h(Art, { size: 28 })),
          h('div', { className: 'qqb-head-text' },
            h('div', { className: 'qqb-panel-title-row' },
              h('div', { className: 'qqb-panel-title' }, meta.title)),
            h('div', { className: 'qqb-panel-sub' }, '传输层未接入 —— 界面已就绪')),
          h('div', { className: 'qqb-panel-spacer' }),
          h('span', { className: 'qqb-badge' }, '未接入'));

        const body = h('div', { className: 'qqb-panel-body' },
          h('div', { className: 'qqb-body-inner' },
          h('div', { className: 'qqb-panel-empty' },
            h('div', { className: 'qqb-empty-art' }, h(Art, { size: 96 })),
            h('div', { className: 'qqb-empty-title' }, meta.emptyTitle),
            h('div', { className: 'qqb-empty-desc' }, meta.emptyDesc),
            h('div', { className: 'qqb-empty-hint' },
              '在「设置 → 连接 IM」里可以开关这个平台；传输层接好之后，这块就是它的会话界面。'))));

        const foot = h('div', { className: 'qqb-panel-foot' },
          h('div', { className: 'qqb-foot-inner' },
          h('div', { className: 'qqb-send-row' },
            h('textarea', {
              className: 'qqb-send-box',
              value: '',
              placeholder: '传输层未接入，暂时发不出去',
              disabled: true,
              readOnly: true,
              rows: 1,
            }),
            h('button', {
              className: 'qqb-send-btn',
              type: 'button',
              disabled: true,
              title: '传输层未接入',
              'aria-label': '发送',
            }, h(SendIcon, { size: 16 }))),
          h('div', { className: 'qqb-panel-note' },
            h('span', null, meta.title),
            h('span', null, '·'),
            h('span', null, '仅界面占位'))));

        return h('div', { className: 'qqb-panel' }, head, body, foot);
      };
    }

    /**
     * 发送图标 —— 一个简笔纸飞机，和 DSH 原生发送按钮一样是"圆形图标按钮"。
     *
     * 为什么不写"发送"两个字：DSH 原生的提交按钮是个 34x34 的圆形图标按钮
     * （`.BuPN2G_primary{width:34px;height:34px;border-radius:999px;display:grid}`），
     * 照它的形制做才像"一家的"。文字按钮会和整个输入条格格不入。
     */
    function SendIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 16;
      return h('svg', {
        viewBox: '0 0 16 16', width: size, height: size,
        'aria-hidden': 'true', style: { display: 'block' },
      }, h('path', {
        d: 'M1.6 7.2 L14 1.6 L8.4 14 L6.9 9.1 Z',
        fill: 'currentColor',
      }));
    }

    /**
     * 模型选择器 —— 一个胶囊形的当前模型 + 点开的列表。
     *
     * 为什么要它：用户会问"它到底用的哪个模型"。面板显示不了"当前会话"的模型选择器
     * （那个槽位是 session 作用域的，而面板不是 conversation 主面板、拿不到会话绑定），
     * 所以这里自己做一个小号的。
     *
     * ⚠ 它改的是 **agentDefaultModel（全局默认模型）**，不是"只给 QQ 用" ——
     *   和用户在 DSH 设置里改默认模型是同一件事。界面上必须说清楚，
     *   否则用户会以为"改这里只影响 QQ"。
     *
     * 改动要等下一个回合生效（已经在跑的 agent 不会中途换路由），
     * 所以宿主半还会把当前 agent 撤掉让它按新模型重建。见 setPanelModel。
     */
    function ModelChip(props) {
      const [open, setOpen] = React.useState(false);
      const [catalog, setCatalog] = React.useState(null);
      const [applying, setApplying] = React.useState(false);
      const [err, setErr] = React.useState('');
      const boxRef = React.useRef(null);

      const info = props?.info ?? {};
      const current = info.model !== undefined && info.model !== null ? String(info.model) : '';
      const currentProvider = info.provider !== undefined && info.provider !== null ? String(info.provider) : '';

      // 点外面关掉 —— 不用超时（超时会在用户正要点击时把浮层收走）
      React.useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          const node = boxRef.current;
          if (node !== null && !node.contains(event.target)) setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        return () => document.removeEventListener('mousedown', onDown);
      }, [open]);

      const openList = async () => {
        setOpen(true);
        if (catalog !== null) return;
        try {
          const response = await fetch(CONTROL_BASE + '/models', { method: 'GET' });
          setCatalog(await response.json());
        } catch (err) {
          setErr('拿不到模型列表');
        }
      };

      const pick = async (provider, model) => {
        setApplying(true);
        setErr('');
        try {
          const response = await fetch(CONTROL_BASE + '/model', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider, model }),
          });
          const json = await response.json();
          if (json?.ok === false) setErr(String(json.error ?? '切换失败'));
          else { setOpen(false); props?.onChanged?.(); }
        } catch (err) {
          setErr('切换失败：连不上插件');
        } finally {
          setApplying(false);
        }
      };

      const providers = Array.isArray(catalog?.providers) ? catalog.providers : [];

      // ── 显示名解析 ──────────────────────────────────────────────────
      //
      // 宿主半的 /models 会给出官方显示名（DSH 的模型目录里写着：
      //   { id: 'deepseek-flash',  name: 'DeepSeek-V41-Flash' }
      //   { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' }）
      // 而 info.model 拿到的是 **id**。直接显示 id 就是用户说的"缩写"。
      //
      // 但显示名只有点开列表后才知道 —— 所以：**找到就用显示名，没找到先用 id**，
      // 用户打开过一次之后胶囊就一直是好读的名字了。
      let modelLabel = current === '' ? '模型未知' : current;
      let providerLabel = '';
      for (const group of providers) {
        const hit = (group.models ?? []).find((m) => m.id === current);
        if (hit === undefined) continue;
        modelLabel = hit.name ?? hit.id ?? current;
        providerLabel = group.providerName ?? group.provider ?? '';
        break;
      }

      const pop = open ? h('div', { className: 'qqb-model-pop' },
        h('div', { className: 'qqb-model-group' }, '选择模型（改的是全局默认模型）'),
        catalog === null
          ? h('div', { className: 'qqb-model-item' }, '加载中…')
          : providers.length === 0
            ? h('div', { className: 'qqb-model-item' }, '没有可用模型（先在设置里配好凭据）')
            : providers.map((group) => h('div', { key: group.provider },
                h('div', { className: 'qqb-model-group' }, group.providerName ?? group.provider),
                (group.models ?? []).map((m) => h('button', {
                  key: group.provider + '/' + m.id,
                  type: 'button',
                  className: (m.id === current && group.provider === currentProvider)
                    ? 'qqb-model-item qqb-model-current' : 'qqb-model-item',
                  disabled: applying,
                  onClick: () => { void pick(group.provider, m.id); },
                }, m.name ?? m.id))))) : null;

      return h('div', { className: 'qqb-model', ref: boxRef },
        h('button', {
          className: 'qqb-model-chip',
          type: 'button',
          // 悬停给出完整身份：provider + 模型 id（id 是排障时真正有用的东西）
          title: (providerLabel === '' ? '' : providerLabel + ' · ')
            + (current === '' ? '未知模型' : current),
          onClick: () => { if (open) setOpen(false); else void openList(); },
        },
        h('span', null, modelLabel),
        h('span', { className: 'qqb-caret' }, '▼')),
        pop,
        err !== '' ? h('span', { style: { fontSize: 11, marginLeft: 7, color: 'var(--dsw-alias-state-error-primary)' } }, err) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 设置页：连接 IM
        //
        // ⚠ 父菜单名是「连接 IM」而不是「连接 QQ」（2026-09-26 改）：
        //   以后加飞书等平台时，**不该拆成多个父菜单** ——
        //   父菜单没有说明文字，并排两个入口（"连接QQ"/"连接飞书"）
        //   会让人不知道该点哪个，也说不清"现在生效的是哪个"。
        //   一个「连接 IM」入口、进去按平台切换，才是加平台时不用再改菜单的形态。
        //   而下面平台专属的东西**保持 QQ 命名**：凭据键、面板标题"奇怪的企鹅"、
        //   以及本插件注册的 qqb-* CSS 类 —— 它们是"QQ 这个机器人"的身份。
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'im-bridge',
          order: 60,
          label: '连接 IM',
        }, QqBridgeSettings));

        // ── 「奇怪的企鹅」：侧边栏入口 + 主区域面板 ──────────────────────
        //
        // 这两个槽位是配对的（DSH 的原话）：
        //   "Global panel icons. Each list id addresses the matching main panel"
        // 所以 sidebar.panellist 的 id 必须和 main 的 key **一致** —— 都用 qq-panel。
        //
        // 为什么放在 QQ 插件里而不是单独一个插件：
        //   入口和功能应该同生共死 —— 禁用 QQ 插件时图标和面板一起消失，
        //   不会出现"插件没了但图标还在、点了是空白"。
        // ── 通用：把"宿主说启用了哪几个平台"变成动态的槽位条目 ──────────
        //
        // 依据（读源码确认，非推测）：
        //   · dsh-client-ui-slots/lib/index.js:237-242 —— register() **返回 dispose**
        //   · dsh-client-ui-sidebar/lib/client.js:469 —— sidebar 订阅 sidebar.panellist，
        //     条目变化时自动重排图标列表
        // ⚠ 不要用"图标组件 return null"来隐藏：那样**行还在**，
        //   会留下一个空图标 + 文字的按钮。必须真注册 / 真注销。
        //
        // `pickMetas` 决定"哪些平台走动态注册"（默认全部 —— 但 QQ/微信已被静态注册，
        // 所以调用方会传一个排除它们的清单，避免同一 key 注册两次）。
        const wireDynamicPlatforms = (makeOptions, makeComponent, pickMetas = () => PLATFORMS) => {
          const disposers = new Map();   // 平台 id → dispose
          let stopped = false;

          const sync = (enabled) => {
            for (const meta of pickMetas()) {
              const on = enabled[meta.id] === true;
              const has = disposers.has(meta.id);
              if (on && !has) {
                try {
                  disposers.set(meta.id, ctx.slots.register(makeOptions(meta), makeComponent(meta)));
                } catch (error) {
                  console.error('[im-bridge] 注册平台入口失败：' + String(meta.id), error);
                }
              } else if (!on && has) {
                try { disposers.get(meta.id)(); } catch { /* ignore */ }
                disposers.delete(meta.id);
              }
            }
          };

          const poll = async () => {
            if (stopped) return;
            try {
              const response = await fetch(`${CONTROL_BASE}/platforms`);
              const json = await response.json();
              if (!stopped) sync(json?.platforms ?? {});
            } catch {
              // 接口没响应（插件没起 / 正忙）时**不动已有条目** ——
              // 宁可维持现状，也不要因为一次探测失败把图标全清掉。
            }
          };

          void poll();
          const timer = setInterval(() => { void poll(); }, 5000);

          return () => {
            stopped = true;
            clearInterval(timer);
            for (const dispose of disposers.values()) {
              try { dispose(); } catch { /* ignore */ }
            }
            disposers.clear();
          };
        };

        // ── 侧边栏入口 + 主区域面板 ─────────────────────────────────────
        //
        // 这两个槽位是配对的（DSH 原话）：
        //   "Global panel icons. Each list id addresses the matching main panel"
        // 所以 sidebar.panellist 的 id 必须和 main 的 key **一致**（都用 <平台>-panel）。
        //
        // QQ 与微信的**面板**静态注册（`QqPanel` 是共用实现，bind 各自 meta）；
        // 但它们的**侧边栏入口**走动态注册 —— 因为现在两个平台都可以被关掉，
        // 而入口必须跟着开关走（关了还留着入口 = 点了是空白）。
        // 其余三个平台（企微/飞书/钉钉）面板仍是占位壳，也走动态注册。
        //
        //   ⚠ 为什么不像原来那样把 QQ 入口静态注册：那时 QQ 是"常开、不可关"，
        //     所以"一直在"是对的。现在它能关，静态注册就会在关掉后留下一个
        //     指向空面板的入口。
        const staticPanelIds = ['qq', 'weixin'];
        const staticMetas = () => PLATFORMS.filter((p) => staticPanelIds.includes(p.id));
        const dynamicMetas = () => PLATFORMS.filter((p) => !staticPanelIds.includes(p.id));

        ctx.slots.inject('sidebar.panellist', () => {
          // 所有平台的入口都动态注册（开关状态在宿主，这边每 5 秒对齐一次）
          const disposeOthers = wireDynamicPlatforms(
            (meta) => ({ name: 'sidebar.panellist', id: meta.panelId, order: meta.order, label: () => meta.title }),
            (meta) => makePlatformIcon(meta),
          );
          return () => { disposeOthers(); };
        });

        ctx.slots.inject('main', () => {
          // ⚠ 用 `.bind(null, meta)` 把平台元数据喂给**同一份**面板实现。
          //   为什么不用 `makeLivePanel(meta)` 工厂：那需要把整个函数体再缩进一层，
          //   而在这个近 2000 行的文件上做批量缩进风险明显更高（我因此毁过一次文件，
          //   靠 git checkout 才恢复）。bind 得到的效果一样、改动面小得多。
          const disposers = staticMetas().map((meta) => ctx.slots.register({
            name: 'main',
            key: meta.panelId,
          }, QqPanel.bind(null, meta)));
          const disposeOthers = wireDynamicPlatforms(
            (meta) => ({ name: 'main', key: meta.panelId }),
            (meta) => makePlatformPanel(meta),
            dynamicMetas,
          );
          return () => { disposeOthers(); for (const d of disposers) d(); };
        });
      },
    };
  },
});
