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

    /** 设置页：连接 QQ */
    function QqBridgeSettings() {
      ensureStyle();
      const [form, setForm] = React.useState(() => loadConfig());
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);

      const update = (key) => (event) => setForm((prev) => ({ ...prev, [key]: event.target.value }));

      /**
       * 凭据在**宿主**里的真实状态。
       *
       * ⚠ 三种状态，不能混成两种（这是这次修 bug 的核心）：
       *   null       = 还没查到（探测中）
       *   {configured:true}  = 宿主里配好了 → 显示"已保存"，不显示输入框
       *   {configured:false} = 宿主里确实没有 → 显示输入框
       *
       *   曾经的做法是"输入框为空就当没配" —— 而输入框初值来自浏览器
       *   localStorage，清了就是空。于是**已配好的也会显示成空白**，
       *   界面在骗人（用户 2026-10-07 报的"设置页里凭据消失"）。
       */
      const [cred, setCred] = React.useState(null);
      const [editing, setEditing] = React.useState(false);

      const probeCredential = React.useCallback(async () => {
        try {
          const r = await fetch(`${CONTROL_BASE}/credential`);
          if (!r.ok) { setCred({ configured: false, reason: `http-${r.status}` }); return; }
          setCred(await r.json());
        } catch (error) {
          // 探测失败 ≠ 没配置。分开报，避免把"问不到"说成"没配"。
          setCred({ configured: false, reason: 'probe-failed', message: String(error?.message ?? error) });
        }
      }, []);

      React.useEffect(() => { void probeCredential(); }, [probeCredential]);

      /** 凭据区：宿主说配好了就展示状态，否则显示输入框 */
      const credentialSection = () => {
        const known = cred !== null;
        const configured = cred?.configured === true;
        const probeFailed = cred?.reason === 'probe-failed' || String(cred?.reason ?? '').startsWith('http-');

        // 已配置 且 没点"重新设置" → 只显示状态，不显示输入框
        if (known && configured && !editing) {
          return h('div', { className: 'qqb-saved' },
            h('div', { className: 'qqb-saved-head' },
              h('span', { className: 'qqb-saved-dot' }),
              h('strong', null, '凭据已保存'),
              cred.connected === true ? h('span', { className: 'qqb-saved-ok' }, '已连接') : null),
            h('div', { className: 'qqb-saved-line' },
              `AppID 尾号 ${cred.appIdTail ?? '????'}（共 ${cred.appIdLength ?? '?'} 位）· AppSecret 已保存`),
            h('div', { className: 'qqb-saved-hint' },
              '凭据存在本机，界面不回显 —— 这是有意的（它是能调 QQ 接口的密钥）。'),
            h('div', { className: 'qqb-actions' },
              h('button', {
                className: 'qqb-btn qqb-btn-ghost',
                onClick: () => { setEditing(true); setStatus(null); },
              }, '重新设置')));
        }

        return h('div', null,
          // 还没查到 → 说明在探测，不要急着显示空表单
          !known ? h('div', { className: 'qqb-note' }, '正在读取本机凭据状态…') : null,
          // 探测失败 → 说清是"问不到"，不是"没配"
          probeFailed ? h('div', { className: 'qqb-status err' },
            '读不到本机的凭据状态（Host 侧接口没响应）。下面的输入框只反映浏览器里记着的值，不代表宿主里有没有。') : null,
          h('div', { className: 'qqb-row' },
            h('label', null, 'AppID'),
            h('input', {
              value: form.appId ?? '',
              onChange: update('appId'),
              placeholder: '在 q.qq.com/qqbot/dashboard 的「开发设置」里',
              spellCheck: false,
            })),
          h('div', { className: 'qqb-row' },
            h('label', null, 'AppSecret'),
            h('input', {
              value: form.appSecret ?? '',
              onChange: update('appSecret'),
              placeholder: '同一页面，注意不要外传',
              type: 'password',
              spellCheck: false,
            })),
          h('div', { className: 'qqb-actions' },
            h('button', { className: 'qqb-btn', onClick: connect, disabled: busy || !known },
              busy ? '连接中…' : '连接 QQ'),
            // 从"已保存"点进来时给一条退路，否则用户被困在编辑态
            known && configured && editing
              ? h('button', {
                  className: 'qqb-btn qqb-btn-ghost',
                  onClick: () => { setEditing(false); setStatus(null); },
                }, '取消')
              : null));
      };

      const connect = async () => {
        setBusy(true);
        setStatus({ kind: 'note', text: '正在保存…' });
        try {
          const appId = String(form.appId ?? '').trim();
          const appSecret = String(form.appSecret ?? '').trim();
          const sandbox = form.sandbox !== false;
          if (appId === '' || appSecret === '') {
            setStatus({ kind: 'err', text: 'AppID 和 AppSecret 都要填。' });
            return;
          }

          // 写进 Host 的凭据存储：记录形如
          //   { kind: 'api-key', env: { QQ_BOT_APPID, QQ_BOT_SECRET } }
          // Host 侧插件监听 'credentials/record-updated'，收到就自动重连。
          let written = false;
          try {
            const remote = ctx?.remote?.credentials;
            if (remote !== undefined && typeof remote.set === 'function') {
              const payload = JSON.stringify({
                kind: 'api-key',
                env: { QQ_BOT_APPID: appId, QQ_BOT_SECRET: appSecret },
              });
              await remote.set('im-bridge/bot', payload);
              written = true;
            }
          } catch { written = false; }

          saveConfig({ appId, appSecret, sandbox });

          // 保存后重新探测宿主状态 —— 让界面立刻反映"真的存进去了"
          // （不是靠 saveConfig 成功就假定宿主也成功了，那正是原来骗人的根源）
          await probeCredential();

          if (written) {
            // 存进去了 → 退出编辑态，回到"已保存"展示
            setEditing(false);
            // 输入框里的 secret 也清掉：界面不该长期留着一份明文密钥
            setForm((prev) => ({ ...prev, appSecret: '' }));
            setStatus({ kind: 'ok', text: '已保存到本机。Host 侧正在连接 QQ，稍候在手机 QQ 里给机器人发一条消息试试。' });
          } else {
            setStatus({ kind: 'note', text: '已记在浏览器里，但**没写进 Host 凭据存储** —— 插件不会用它连接。请重启客户端后重试，或看 Host 日志。' });
          }
        } catch (error) {
          setStatus({ kind: 'err', text: `失败：${error?.message ?? error}` });
        } finally {
          setBusy(false);
        }
      };

      return h('div', { className: 'qqb-wrap' },
        // ① 状态放最上面 —— 打开设置第一眼就知道"能用了没有"
        h(StatusPanel, null),
        // ② 凭据区：**以宿主为准**（不再把空输入框当"没配"）
        credentialSection(),
        status === null ? null : h('div', {
          className: `qqb-status ${status.kind === 'ok' ? 'ok' : status.kind === 'err' ? 'err' : ''}`,
        }, status.text),
        h('div', { className: 'qqb-note' },
          '连接前请先在两处做好准备：',
          h('br'),
          '① 在 q.qq.com 控制台的「沙箱配置」里，把你的 QQ 号加入「消息列表单聊」——不加的话机器人收不到任何消息，而且不报错；',
          h('br'),
          '② 家用宽带没有固定公网 IP，正式环境的 IP 白名单过不去，所以连接默认走沙箱环境。'),
        h('div', { className: 'qqb-hint' },
          '说明：凭据保存在本机；与 QQ 的通信由 Host 侧插件负责（浏览器直连会被 CORS 拦）。'));
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

    /**
     * 侧边栏入口的"在线"广播通道。
     *
     * 为什么要有它：连通性由 QqPanel 轮询（它本来就在查 /status），
     * 而侧边栏图标是**另一个组件**。两者要共享这一个布尔值。
     *
     * 做法：一个极简的"模块级 pub/sub + window 上的 sidecar"。
     *   · 为什么不用 React context：这两个组件挂在不同的槽位（sidebar.panellist
     *     和 main），中间隔着 DSH 自己的树，我没法给它俩套一个 Provider。
     *   · 为什么 sidecar 放 window 上：图标可能**先于**面板挂载（用户还没点开面板），
     *     那时还没有任何轮询。window 上的值让图标一挂载就能读到最近一次已知结果。
     *
     * ⚠ 注意这里**不是**经验库 E15 说的那种"模块级可变中继" ——
     *   那一条讲的是"写进去没人读、读的人永远拿到默认值"（接线漏了却不报错）。
     *   这里两条线都在同一个文件里接上了：QqPanel 调 publishLink() 写，
     *   PenguinIcon 通过 useLinkUp() 读，而且**同一份值**在 window 上兜底。
     */
    const LINK_STATE_KEY = '__dshQqBridgeLink';
    const linkSubscribers = new Set();

    /** QqPanel 每次探到连通性就调它，广播给所有订阅者 */
    function publishLink(up) {
      try { globalThis[LINK_STATE_KEY] = up === true; } catch { /* ignore */ }
      for (const fn of [...linkSubscribers]) {
        try { fn(up); } catch { /* ignore */ }
      }
    }

    /** 订阅连通性；挂载时先用 window 上的已知值初始化 */
    function useLinkUp() {
      const [up, setUp] = React.useState(() => {
        try { return globalThis[LINK_STATE_KEY] === true; } catch { return false; }
      });
      React.useEffect(() => {
        linkSubscribers.add(setUp);
        // 订阅时同步一次 —— 订阅前可能已经有别的组件探到了
        try { setUp(globalThis[LINK_STATE_KEY] === true); } catch { /* ignore */ }
        return () => { linkSubscribers.delete(setUp); };
      }, []);
      return up;
    }

    /**
     * 「奇怪的企鹅」—— 侧边栏入口图标。
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
     */
    function PenguinIcon(props) {
      ensureStyle();
      const size = typeof props?.size === 'number' && props.size > 0 ? props.size : 28;
      const active = props?.active === true;
      const online = useLinkUp();

      return h('div', {
        className: active ? 'qqb-penguin qqb-penguin-active' : 'qqb-penguin',
        style: { width: size, height: size, position: 'relative' },
        title: online ? '奇怪的企鹅（在线）' : '奇怪的企鹅（未连通 QQ）',
        'aria-label': '奇怪的企鹅',
      },
      h(PenguinArt, { size: Math.round(size * 0.78) }),
      online ? h('span', { className: 'qqb-badge-dot', 'aria-hidden': 'true' }) : null);
    }

    /**
     * 「奇怪的企鹅」面板 —— 显示 QQ 那个专用会话的消息，并能从电脑上继续发消息。
     *
     * 数据来源：宿主半的 8799 接口（**客户端没有会话数据 API**，查证过）：
     *   GET  /im-bridge/messages?limit=N   → 那个会话的最近消息
     *   POST /im-bridge/send  {text}       → 投给 agent（和手机消息走同一条路）
     *
     * 轮询而不是推送：8799 是个极简的 http 服务，没有 WebSocket。
     * 2 秒一次的开销可以忽略（本机回环），换来的是实现简单、不需要处理重连。
     */
    function QqPanel() {
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
          const response = await fetch(CONTROL_BASE + '/messages?limit=80', { method: 'GET' });
          const json = await response.json();
          setData(json);
          setError(json?.ok === false ? String(json.error ?? '读取失败') : '');
        } catch (err) {
          setError('连不上插件（Host 侧没在跑？）');
        }
      }, []);

      React.useEffect(() => {
        void load();
        const timer = setInterval(() => { void load(); }, 2000);
        return () => clearInterval(timer);
      }, [load]);

      /**
       * 在线状态 —— 单独查一次 /status（/messages 不返回连通性）。
       *
       * 判据刻意用**严格的 `=== true`**：只要不是明确连通，就不显示绿灯。
       * 这样"没配 AppID"（没凭据）、"正在连"、"连上过又断了"都自然落到"不显示"，
       * 不需要在客户端猜原因 —— 根因看设置页的状态面板就够了。
       *
       * 6 秒一次：连通性变化没那么频繁，而且它比消息轮询轻。
       */
      React.useEffect(() => {
        let alive = true;
        const probe = async () => {
          try {
            const response = await fetch(CONTROL_BASE + '/status', { method: 'GET' });
            const json = await response.json();
            if (alive) { const up = json?.connected === true; setLinkUp(up); publishLink(up); }
          } catch (err) {
            // 连插件都问不到 = 肯定不在线
            if (alive) { setLinkUp(false); publishLink(false); }
          }
        };
        void probe();
        const timer = setInterval(() => { void probe(); }, 6000);
        return () => { alive = false; clearInterval(timer); };
      }, []);

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
            body: JSON.stringify({ text: value }),
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
        h('div', { className: 'qqb-head-avatar' }, h(PenguinArt, { size: 28 })),
        h('div', { className: 'qqb-head-text' },
          h('div', { className: 'qqb-panel-title-row' },
            h('div', { className: 'qqb-panel-title' }, '奇怪的企鹅'),
            // 绿灯只在**明确连通**时出现；不连通就完全不渲染（不是灰点）
            linkUp ? h('span', {
              className: 'qqb-online',
              title: '已连通 QQ',
              'aria-label': '已连通 QQ',
            }) : null),
          h('div', { className: 'qqb-panel-sub' },
            error !== '' ? '连接异常'
              : busy ? '正在处理你的消息…'
              : linkUp ? (messages.length === 0 ? '在线待命' : ('在线 · 最近 ' + messages.length + ' 条'))
              : '未连通 QQ（去「设置 → 连接 QQ」看看）')),
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
              h('div', { className: 'qqb-empty-art' }, h(PenguinArt, { size: 96 })),
              h('div', { className: 'qqb-empty-title' }, '这里是企鹅的窝'),
              h('div', { className: 'qqb-empty-desc' },
                '在手机 QQ 上给它发消息，它会在这台电脑上干活；',
                h('br'),
                '也可以直接在下面输入 —— 两条路走的是同一个大脑。'),
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
            placeholder: '让它干点什么…',
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
          h('span', null, '回答不推手机'))));

      return h('div', { className: 'qqb-panel' }, head, body, foot);
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
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: 'qq-panel',
          order: 20,
          label: () => '奇怪的企鹅',
        }, PenguinIcon));

        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: 'qq-panel',
        }, QqPanel));
      },
    };
  },
});
