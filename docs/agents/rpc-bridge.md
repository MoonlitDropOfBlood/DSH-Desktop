# Electron ↔ DSH 通信协议（AGENTS.md §3 详版）

> 主索引与红线清单在 [AGENTS.md](../../AGENTS.md)；本文承接其完整细节，两处需同步维护。

## 三条通道

| 通道 | 方向 | 用途 |
|---|---|---|
| `preload` 的 `dshDesktop.*` IPC | 渲染进程(DSH 页面)→主进程 | 窗口控制、设置读写、更新、重启 |
| `dsh:update-state` 事件 | 主进程→渲染进程 | 推送版本/设置状态给插件 UI |
| **RPC 桥** `http://127.0.0.1:<随机端口>` | DSH Host 进程→Electron 主进程 | **插件 RPC 扩展面（一期）**：`bridge.register` / `notify.show`（任务通知）/ `tray.setMenu`（托盘菜单贡献） |
| **反向事件通道** `http://127.0.0.1:<插件eventPort>` | Electron 主进程→DSH Host 进程 | 壳→插件事件回投（托盘菜单点击 `tray.click`）；插件在 DSH 进程内自起 Tiny HTTP server 并经 `bridge.register` 上报端口 |

任务通知：插件 **Host 半部**（index.js，运行在 DSH 进程里）监听 `agent/status`(running→idle=完成)、`agent/error`(失败)、`approval/request`(waterfall，需调 next)，经 `notify.show` RPC 发到主进程，主进程弹 `Notification`。
**只有主会话（主 agent）才能通知**——三个事件通道全部经 `isSubagent()` 过滤：subagent 的 session header 带
`parentSession`/`origin:'subagent'`/`delegationDepth≥1`（核心 `dsh-subagent` 创建子会话时写入），据此过滤；subagent 频繁完成、错误由父 agent 收容、审批被宿主自动拒绝，逐个弹窗全是噪音。三个事件都是 scope 路由事件、必然携带主体 agent（`agent/status`/`agent/error` 在 payload 上，`approval/request` 在 `req.agent` 上），过滤可靠。只有**主 agent** 完成、失败、需要确认才弹。
**待确认状态同样只由主 agent 的流转解除**（2026-09-16 修）：`approvalPending` 的清零必须在 `isSubagent` 过滤之后——subagent 的 status 事件曾把托盘「有操作待确认」误清成运行中/空闲。

## RPC 桥协议（一期扩展点，2026-09 落地）

- 请求体 `{ method, params }` → 响应 `{ ok: true, ... }` / `{ ok: false, error }`（400）。**旧形态 `{ kind, summary }`（无 method）仍路由到 `notify.show`**，旧版插件拷贝对新壳继续可用（反向：新插件对旧壳通知会静默丢失——壳与插件同包发布、`prepareDesktopPlugin` 每次 spawn 重拷，偏斜只是瞬态）。
- `bridge.register { plugin, eventPort }`：先注册才能 `tray.setMenu`（点击事件要回投到 eventPort）。插件名只是**组织键**（整个 DSH 进程共享同一 token，不是插件间安全边界）。插件侧网络失败按 1.5s~20s 退避重试 5 次；收到 `ok:false` 则不重试（= 旧壳无 RPC 桥）。
- `notify.show { kind?, title?, body?, force? }`：通用通知。`kind=done/error/approval` 有默认标题/文案；显式 method 形态下未知 kind 兜底标题为应用名；**legacy 形态的未知 kind 仍然丢弃**（行为不回归）。`force:true` **只绕过焦点抑制**（保留给"用户显式动作的回执"，如点击托盘贡献项——托盘菜单关闭时焦点可能已回到窗口，不 bypass 会被吞）；`taskNotify` 总开关永远生效。被抑制也会写主日志（`notify suppressed (任务通知 off|window focused)`）——排查"没弹通知"先看主日志。
- `tray.setMenu { plugin, items: [{ id, label, enabled? }] }`：替换该插件的托盘菜单分区（空数组=清除）。`rebuildTrayMenu()` 组装：内置「打开」「重启核心」→ 各插件分区（按注册序，前置 separator）→ 内置「退出」。校验：id ≤64 字符、label ≤80、每插件 ≤10 项。
- `settings.get { plugin, key? }` / `settings.set { plugin, key, value }`：**插件设置 KV**（二期）。持久化在 `update-settings.json` 的 `plugins` 桶（`{ plugins: { "<plugin>": { key: scalar } } }`）；value 限 string/number/boolean（string ≤500 字符，number 须有限），`null` 删除该 key；key 格式 `PLUGIN_KEY_RE`，每插件 ≤50 key。不强制先 register（KV 只是存储）。**`writeSettings` 必须合并 raw 对象（`readRawSettings()`，BOM 剥离在 `settings-json.js`）而非 `readSettings()` 的定形视图**——否则任何 `dsh:set*` 写入都会擦掉整个 plugins 桶（readSettings 只认识固定字段）。写盘失败经 IPC 返回值带 `writeError` 回给设置页（2026-09-16 起，`dsh:setAutoUpdate`/`dsh:setCoreChannel` 返回态可携带）。
- `window.<action>`（二期）：`progress {value}`（Electron 语义：-1 清除 / 0..1 确定 / >1 不确定）、`flash {flag}`（true 时挂一次性 focus 监听自动停止，防遗忘常闪）、`badge {text}`（macOS dock / Linux launcher count，Windows 空操作）、`overlay {dataUrl, description}`（Windows 任务栏角标，base64 png/jpeg ≤32KB，空串清除）、`alwaysOnTop {flag}`、`show` / `hide`（无托盘时降级为 minimize——没有托盘图标的隐藏窗口不可达）、`minimize`。窗口已销毁时干净报错（badge 除外，它不依赖窗口）。
- **壳事件总线（二期）**：`bridge.register` 可带 `events: ["window.visibility", "core.lifecycle"]` 订阅（未知名静默丢弃，向前兼容）；壳经反向通道回投 `{ event, data }`（与 tray.click 同一信封）。渲染进程侧走 `dsh:shell-event` 通道（preload `dshDesktop.onShellEvent`）。事件源：`window.visibility`（show/hide/focus/blur/minimize/restore 的快照 `{visible, focused, minimized}`；注意 Windows 最小化时 `isVisible()=false`）、`core.lifecycle`（`starting`@doSpawn / `ready`@openDSH / `restarting`@restartDSH 入口 / `exited`@核心死透的 report()）。**顺序注意**：`starting` 在 `resetBridgeContributions()` 之后发出——重启链上旧注册已清，只有 `restarting` 能送到上一代订阅者。**渲染进程投递在页面导航期间会丢**（splash→DSH 是一次导航，期间 `webContents.send` 的事件没有接收者；重启链的 `ready` 常因此到不了刚刷新的页面）——关键状态由 Host 侧反向通道兜底，客户端插件别依赖导航窗口期的事件。
- **浮窗（`float.window.*`，桌面宠物等二级窗口；设计全文 `designs/float-window.md`）**：插件可创建小型悬浮窗（透明/无边框/置顶 `floating` 级/不进任务栏/`focusable:false` 永不抢焦点，经 `showInactive` 显示）。`create {plugin, html|url, width, height, x?, y?, transparent?=true, clickThrough?=false}`（html 内联 ≤256KB data: 加载，或 `url` 仅允许 `http://127.0.0.1:<port>/`——插件自己的本地服务器，富内容走这条自建双向通道）；`state {plugin,id,state}` 下行推 JSON ≤2.5KB、**替换最新值**语义（壳缓存、did-finish-load 补发）；`move`/`close`/`closeAll`。页面交互上行：浮窗页面 `__dshFloat.send(data)`（专用迷你 preload `float-preload.js`，**只暴露这一个对象**，绝不能给它主窗口的桥面）→ 反向通道 `float.window.input {id, data}`；崩溃/系统关闭回投 `float.window.closed {id, reason}`。**拖动零协议**：页面自己写 `-webkit-app-region: drag`。**窗口是壳的资产、随核心代际走**：`resetBridgeContributions()` 关全部浮窗（核心重启/死透不留孤儿宠物）；主窗口真关闭（非托盘路径）也必须关——否则 `window-all-closed` 因浮窗存在永不触发、应用退不出去（易踩！）。限额每插件 3 / 全局 6；用户总开关 `allowFloatWindows`（默认开，桌面版设置页即时生效：关闭时现存浮窗全部关闭）。`bridge.register` 响应带 `capabilities: ["float.window", ...]` 供插件特性探测。e2e：`node scripts/e2e-float-window.js <port> <token> <userData>`（15 项断言，`npm run test:e2e:float`）。
- **客户端插件的对应 IPC**（preload `dshDesktop.*`）：`windowAction(action, params)`（与 `window.*` RPC 同一实现）、`pluginSettingsGet/Set`（同一 KV 校验）、`onShellEvent(cb)`。**插件设置 UI 的唯一扩展点是核心的 `settings.section` 槽**（`ctx.slots.register({name:"settings.section", id, order, label}, Component)`，桌面版区自身就是这么挂的），持久化用插件设置 KV（host 插件 `settings.get/set` RPC，客户端插件 `dshDesktop.pluginSettingsGet/Set`）。**刻意不做行级声明式 schema 层**——2026-09 实现过一版（全局队列注册 + toggle/select/text/password/number/custom 六种行级控件）后移除：整页 settings.section 能覆盖全部场景且少一套要维护的注册协议。
- **生命周期**：`doSpawn()` 抬代际时 `resetBridgeContributions()` 清空全部注册/贡献（新核心的插件启动后会重注册）；exit 处理器 `report()`（核心死透、无重启在途）里也清一次——托盘不残留指向死端口的菜单项。`closeToTray` 关闭时贡献照样存着，`ensureTray()` 建图标时一次装配。
- **桥始终监听**（`whenReady` 无条件 `startNotifyServer()`）——它是通用 RPC 载体，不再只是通知传输；`taskNotify` 开关只决定通知**弹不弹**（`notifyTaskEvent` 内判定），不决定桥监听与否。**勿改回"按 taskNotify 门控监听"**——那样托盘贡献等其他 RPC 在开关关闭时全灭。**桥 5 次绑定重试全部失败 → `pushUpdateState()` 带出 `notifyBridgeOk:false`**，设置页显示降级提示（2026-09-16 起，此前只有一行日志）。

## RPC 桥安全（重要）

- **焦点抑制**：桌面窗口**有焦点且可见时不弹通知**（用户正在看 DSH，任务状态已内联显示；弹原生通知只是噪音），只在后台/最小化/藏托盘时才通知。判断：`mainWindow.isVisible() && isFocused() && !isMinimized()`。
- 桥只绑定 `127.0.0.1`（不暴露局域网），且**端口是每次启动随机**（`40000–50000`，`generateNotifyCredentials()`），避免固定端口被本地进程抢占。
- 带**每次启动随机的 bearer token**（`crypto.randomBytes(24)`），通过 `DSH_DESKTOP_NOTIFY_PORT`/`DSH_DESKTOP_NOTIFY_TOKEN` 环境变量只传给被 spawn 的 DSH 进程，插件 POST 时带 `x-dsh-notify-token` 头；桥校验不符直接 401。**反向通道同一 token**：壳 POST 插件 eventPort 时带同一头，插件事件服务器验不符 401。
- 带**外部 Web Origin 的请求直接 403**（浏览器页面拿不到 token 也到不了这层；配合 Chrome/Firefox 的 Private Network Access 双重防护）；只收 POST（其余 405）；body 上限 4KB，超限断开。
- 因此网页/无关本地进程无法伪造或刷屏通知。真机上可用 `curl -X POST -H "x-dsh-notify-token: <token>" -d '{"kind":"done"}' http://127.0.0.1:<port>/` 手工验证（token 在 DSH 子进程环境里，app 本身不落盘）。

## 主窗口导航防护（2026-09-16 起）

`createWindow()` 在 `setWindowOpenHandler` 之外新增 `will-navigate` 守卫：只放行 `file:` 与 `http(s)://127.0.0.1|localhost:<effectivePort()>/`（**任意 path** 都放行——必须兼容核心 ≥0.1.2-rc.1 认证后带 `?token=…` 的同源跳转），其余一律 `preventDefault()` + 记日志。`loadURL`/`loadFile` 不触发 `will-navigate`，splash 与初始加载不受影响。背景：preload 桥（restartCore / 设置写 / 更新触发）暴露给窗口加载的**任何**页面，被注入的 DSH 页面不能把桥带到外部源。

## 任务通知编码坑（重要）

插件 Host 半部 POST 到通知桥时，**中文 summary 会被破坏成 `??`**，如果直接用 `body: JSON.stringify(...)` 字符串发送（某些 DSH host 环境的 fetch 对 string 编码处理异常）。修复：用 `TextEncoder` 转成 **Uint8Array** 字节发送。
