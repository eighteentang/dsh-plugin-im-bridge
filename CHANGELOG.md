# 变更记录

本文件记录每个**打过标签**的版本。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

**怎么钉版本**（避免"装到一半上游改了"）：

```sh
dsh plugin --profile web add github:eighteentang/dsh-plugin-im-bridge#v1.1.0
```

---

## [1.1.0] - 2026-10-07

第一个**打过标签**的版本。

> 之前 `package.json` 里写着 `1.0.0`，但那个号**从未被标记过** ——
> 于是"1.0.0"同时指代了两个不同的代码状态。这个版本把它显式定下来，
> 并把那一堆修复归到 `1.1.0`。

### 修复

- **`workspace` 默认值泄漏给所有用户**（影响最大）
  随包发布的 `cordis.patch.yml` 里写着 `workspace: 'D:\EasyDSH'` —— 开发机的路径。
  别人从 GitHub 装完，这个值会进他们的配置，把 agent 的工作目录指向一个
  **他们机器上不存在的路径**。现在：
  - 从随包 patch 里删掉了 `workspace`（留空 = 用 DSH 自己的工作目录）
  - 新增 `resolveWorkspace()`：候选路径**不存在就跳过**，并记一条
    `workspace-missing-fallback` 日志。这同时修掉了"用户删了工作目录后静默失效"
    这类极难排查的情况。

- **provider 写死白名单，对 API-key 登录的用户是错的**
  原来写死 `['deepseek-account', 'deepseek-account-platform']`。
  用 API key 登录的机器上 `deepseek-official` 才是唯一能用的路由，
  白名单会把它丢掉、回退到一个不存在的 provider → 机器人整轮失败。
  现在改成**按凭据探测推导**：

  | provider | 探测方式 |
  |---|---|
  | `deepseek-official` | `credentials.describe('DEEPSEEK_API_KEY')` |
  | `deepseek-account` | `credentials.readRecord('deepseek-account-platform/default')` |

  两种键空间都要查：API key 存在 `refs` 里（`listRecords()` 看不到它），
  账号凭据存在 `records` 里。

- **`/im-bridge/credential` 端点缺失**，设置页读不到宿主的凭据状态，
  于是在"凭据其实已配好"的情况下显示空白输入框 —— **界面在骗人**。
  现在设置页**以宿主为准**，并且区分三种状态（探测中 / 已配置 / 真未配置），
  而不是把"问不到"当成"没有"。

- **客户端 `CONTROL_BASE` 与服务器路由不一致**（改名时只改了一边）
  服务器改成了 `/im-bridge/*`，客户端还停在 `/qq-bridge` →
  **六个端点全部 404**（面板、消息列表、发消息、模型列表、模型切换、凭据状态），
  而 35 项 bundle 校验全绿（它不比对两端路径）。

### 变更

- **包名 `dsh-plugin-qq-bridge-v4` → `dsh-plugin-im-bridge`**，
  目录 `qq-plugin-fresh/` → `im-bridge/`。
  内核与平台无关（队列 / 会话 / 面板 / 权限），只有传输层是 QQ 专属的 ——
  所以以后接飞书等平台只需新增一个传输层。

  **平台专属的东西保持 QQ 命名**（这是有意的，不是漏改）：
  凭据键里存的仍是 `QQ_BOT_APPID` / `QQ_BOT_SECRET`；
  面板标题「奇怪的企鹅」、`qqb-*` CSS 类名。

  ⚠ 换包名的代价：要卸载重装 + **丢掉整个会话历史**（会话 id 跟着前缀走）。
  正常改代码只需**重启客户端**，不需要换名。

- **设置页父菜单「连接 QQ」→「连接 IM」**。
  以后加平台不该拆成多个父菜单 —— 父菜单没有说明文字，
  并排两个入口说不清"现在生效的是哪个"。

- **凭据键 `qq-bridge/bot` → `im-bridge/bot`**，含**自动迁移**：
  启动时若新键为空、旧键有值 → 复制过去 → 回读确认 → 再删旧键。
  用户不用重填。

### 新增

- **README.md** —— 从"创建 QQ 机器人"到"第一条消息"的完整流程，
  含几个会**静默失败**的关键步骤说明。
- **LICENSE**（MIT）、**CHANGELOG.md**、**`.gitattributes`**（统一 LF）。

### 已知问题

- 卸载后 `~/.dsh/profiles/<名字>/node_modules/` 下可能残留一个死链接（junction）。
  不影响使用（加载清单已清干净），可手动删。
- 需要人工审批的权限预设会让 QQ 会话**卡死**（审批框在电脑上，手机看不到）。
  插件默认用 `danger-full-access` 避开，但这意味着**能私聊机器人的人
  就能在本机执行命令** —— 请自行确认机器人的可见范围。

---

## [1.0.0] - 2026-09-26（未打标签）

首个版本：QQ 机器人 ↔ DSH 双向消息桥接。

- WebSocket 长连接、被动回复 + 主动推送回退
- 消息排队（避免 agent 把两条消息合并成一个回合）
- 看门狗（会话卡死 45 秒后自动解封并放出排队消息）
- 侧边栏面板「奇怪的企鹅」+ 设置页

> ⚠ 这个版本**没有 git 标签**，所以无法用 `#v1.0.0` 钉住它。
> 它的代码等于 commit `6ec4d18`。
