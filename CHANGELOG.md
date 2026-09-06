# Changelog

本项目所有重要变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布流程：改动记录在 `## [Unreleased]`；打 `v*` 标签发布时，把对应内容移到新的 `## [x.y.z] - <日期>` 小节。
> GitHub Actions 发布 Release 时会自动取 `## [<版本号>]` 这一节作为 Release 说明。

## [Unreleased]

## [1.8.0] - 2026-09-07

### 新增

- **托盘右键菜单内置「重启核心」**：点击先唤起主窗口（可见 splash 进度）再走 `restartDSH()` 重启链，与菜单 Ctrl+Alt+R 同一链路；菜单项展示 `Ctrl+Alt+R` 快捷键（托盘菜单 accelerator 仅展示不注册，真正的注册仍在 app 菜单）。背景：Windows 的 frameless 窗口没有可见菜单栏，用户此前无从得知重启快捷键的存在。
- **设置页「核心」新增「重启核心」按钮 + 快捷键说明**：按钮经 `hasBridge("restartCore")` 守卫（纯浏览器不渲染），点击禁用防双击；下方整行提示说明行为（窗口短暂回到启动页、更新渠道等改动借此生效）与两个快捷键——Windows 显示 `Ctrl+R 刷新页面；Ctrl+Alt+R 重启核心`，macOS 显示 `⌘ R / ⌘ ⌥ R`（按 UA 区分）。
- **`dshDesktop.restartCore` IPC（`dsh:restartCore`）**：只重启 DSH 核心不重启壳，与 `restartApp`（整壳重启）并列；返回布尔值表示是否真正启动，供按钮反馈。

### 修复

- **`restartDSH()` 新增安装期守卫**：`installInProgress`（首次安装/更新下载进行中）时手动重启静默 no-op——此前此窗口期的 Ctrl+Alt+R 可能 spawn 到半成品安装树；并改为返回是否真正启动，托盘/按钮据此提示。原有 `restartRequested`/`isUpdating` 竞态守卫不变。
- **设置页行内长提示挤压按钮**：`.dsh-desktop-row > .dsh-desktop-hint` 改为占据剩余宽度、在自身内部折行，长提示不再把同行按钮挤到换行（重启核心行由此拆为「按钮行 + 整行提示」两行，与桌面版区既有排版一致）。

## [1.7.1] - 2026-09-05

### 变更

- **窗口控制条样式优化**：右上角最小化/最大化/关闭三个按钮从「36px 顶条内 22px 高 + 上边距 9px」改为**占满整条、紧贴窗口顶边**（hover 高亮铺满整条，与原生无边框标题栏一致），消除按钮距顶部的空隙；三个图标从不同字体的文本字符（`–` `□` `✕`，光学大小/线宽各不相同）替换为**统一尺寸与线宽的内联 SVG**（12×12，24 单位 viewBox + 2 单位圆头描边，Lucide 几何，颜色照常跟随主题与 hover）；左侧 Session log 胶囊改为在条内垂直居中，与整高按钮协调。插件故障兜底控制条（main.js 注入的 `.dsh-desktop-fallback`）同步同样式，两条路径外观一致。

## [1.7.0] - 2026-09-04

### 变更

- **显示品牌更名「鲸港 WhaleHarbor」**（GitHub 上 DSH-Desktop 重名过多）：启动页标题/标题条、窗口/托盘显示名（`APP_NAME`）、README、宣传页、生成 patch 注释全部换新品牌。**内部标识一律不变**——`package.json` 的 `productName`/`name`（决定 userData 路径与安装身份，动了会丢设置/并存安装）、npm 包名、`DSH_DESKTOP_*` 环境变量、`dsh:*` IPC 通道、`dsh-desktop-plugin` 插件包名，对现有用户零影响。

### 修复

- **手编 `update-settings.json` 带 UTF-8 BOM 导致全部设置静默失效**：`readSettings()` 的裸 `JSON.parse` 遇 BOM 直接抛异常、整份设置回落默认（`port`/`coreChannel` 等全部瞬间丢失）。现解析前剥 BOM。排查启示：PowerShell `Set-Content -Encoding utf8` 在部分宿主上会写出 BOM，改设置文件请用编辑器或 `utf8NoBOM`。

### 新增

- **插件 RPC 桥（壳扩展点一期）**：原单用途"通知桥"泛化为双向 JSON-RPC 通道，DSH 插件的 Host 半部现在可以调用壳能力。首批三个方法：① `bridge.register`——插件注册自己 + 上报反向事件端口（插件在 DSH 进程内自起 127.0.0.1 小服务器，壳→插件事件回投走同一 token 认证）；② `notify.show`——通用原生通知（`kind=done/error/approval` 保留默认文案，任意 title/body 亦可；`force:true` 只绕过焦点抑制，保留给用户显式动作的回执；`taskNotify` 总开关永远生效）；③ `tray.setMenu`——**托盘右键菜单贡献**：插件声明式提交菜单项（每插件一个分区、最多 10 项），点击经反向通道回投 `{ event: "tray.click", id }`。生命周期：新核心代际 spawn 时与核心死透时自动清空全部注册/贡献，插件随核心启动重注册。安全模型不变：127.0.0.1 绑定 + 每次启动随机端口/随机 bearer token + 外部 Origin 403 + 4KB 上限；旧形态 `{ kind, summary }` 通知 POST 完全兼容。可观测性：通知被抑制（开关关闭/窗口聚焦）、反向投递失败、未注册插件事件全部写主日志。
- **托盘新增「任务状态」实时项**：`dsh-desktop-plugin` 作为 RPC 桥首个消费者，在托盘菜单实时显示主 agent 状态（空闲 / 运行中(N) / 有操作待确认，subagent 照常过滤），点击该项弹一条带当前状态详情的通知。
- **窗口/任务栏能力（壳扩展点二期）**：RPC 桥新增 `window.progress`（任务栏进度：-1 清除 / 0..1 确定 / >1 不确定）、`window.flash`（任务栏闪烁，窗口获焦自动停止）、`window.badge`（macOS Dock / Linux 启动器角标，Windows 空操作）、`window.overlay`（Windows 任务栏角标图标）、`window.alwaysOnTop`、`window.show` / `window.hide` / `window.minimize`；客户端插件经 `dshDesktop.windowAction(action, params)` IPC 使用同一实现。
- **壳事件总线（二期）**：插件可订阅 `window.visibility`（窗口显示/聚焦/最小化快照）与 `core.lifecycle`（starting / ready / restarting / exited）。Host 插件在 `bridge.register` 里声明 `events` 列表、经反向通道接收；客户端插件用 `dshDesktop.onShellEvent(cb)`。
- **插件设置 KV（二期）**：壳提供按插件命名空间的键值存储（`settings.get`/`settings.set` RPC 与 `dshDesktop.pluginSettingsGet/Set` IPC 同一实现），持久化在 `update-settings.json` 的 `plugins` 桶。插件需要设置 UI 时直接用核心的 `settings.section` 槽挂整页（桌面版设置区自身就是这么挂的），持久化走该 KV；壳不另设行级声明式 schema 层。
- **任务栏实时反馈**：`dsh-desktop-plugin` 消费二期能力——主 agent 运行期间任务栏显示不确定进度条（全部完成后清除），主 agent 出错或等待审批时任务栏按钮闪烁直到窗口获焦。顺带修复一期重写引入的「任务完成通知从未发送」（`wasRunning` 引用未定义变量、被 catch 吞掉）。
- **e2e 钩子**：`DSH_DESKTOP_NOTIFY_TOKEN` 环境变量可钉住桥 token（仅供自动化测试直调桥方法，生产勿设）。
- **插件浮窗 `float.window.*`（桌面宠物等二级悬浮窗口）**：插件可创建小型透明置顶悬浮窗——无边框、不进任务栏、`focusable:false` 永不抢焦点（`showInactive` 显示）。`create {html|url, width, height, x?, y?, transparent?, clickThrough?}`：`html` 内联（data: 加载，≤256KB）或 `url` 仅允许插件自己的 `127.0.0.1` 服务器（富内容自建双向通道）；`state` 下行推 JSON（≤2.5KB，**替换最新值**，壳缓存并在页面加载完成后补发）；`move`（钳制进工作区）/`close`/`closeAll`。页面交互上行：浮窗专用迷你 preload（`float-preload.js`，仅暴露 `__dshFloat.onState/.send`，绝不给主窗口桥面）→ 反向通道 `float.window.input`；崩溃回投 `float.window.closed`。拖动零协议（页面自带 `-webkit-app-region: drag`）。**浮窗随核心代际走**：`resetBridgeContributions()`/主窗口真关闭/退出时统一销毁，核心死了绝不留孤儿宠物。限额每插件 3、全局 6；用户总开关「允许插件浮窗」（默认开，关闭立即清场）。`bridge.register` 响应新增 `capabilities` 数组供特性探测。e2e：`scripts/e2e-float-window.js`（15 项断言）；设计全文 `designs/float-window.md`。

## [1.6.1] - 2026-09-04

### 修复

- **核心更新到 0.1.2-rc.1 后无法启动（pnpm 跨版本线更新的 peer 版本错位）**：在存量目录上 `pnpm add` 跨版本线（0.1.1-rc.2 → 0.1.2-rc.1）时，pnpm 的 peer 解析会复用树上的旧实例——旧 lockfile 把 `dsh-subagent@0.1.2-rc.1` 的 peer `@deepseek-ai/dsh-attachment: ^0.1.2-rc.1` 解析成残存的 0.1.1-rc.2（实测冻在旧 lockfile 里），新代码 import 旧包没有的导出（`admitPromptContent`）→ ESM 链接期 SyntaxError，`llm-deepseek`/`session-controller`/`better-sidebar` 整批加载失败、核心秒崩。全新目录安装不复现（pnpm/npm 均正常）。修复：`prepareManagedDir()` 每次安装前删除 `pnpm-lock.yaml`——壳只跑 `pnpm add`（每次本就全树重解析），lockfile 零收益、纯事故载体。
- **核心 ≥0.1.2 时内置市场重复挂载，启动即崩（`duplicate loader entry id: dsh-market`）**：0.1.2 起核心会把 profile node_modules 里的包自动挂载为 loader 条目，壳暂存市场后再 `- insert:` 就成了第二条。修复：装到的核心 ≥0.1.2 时（`coreAutoMountsProfilePackages()`）patch 改发**覆盖行**（`- id:`，顺带把 `allowRestart: false` 附上）；0.1.1.x 不自动挂载，维持 `- insert:`（版本门禁，勿合并成无条件覆盖）。
- **更新冒烟探针误报超时**：核心 ≥0.1.2-rc.1 起裸 `GET /` 不再返回 <400，更新冒烟启动的探针改为轮询核心自己打印的带 token URL（`extractDshUrl`），并把冒烟子进程 env 里的 `DSH_DESKTOP_PORT` 剥掉（否则核心按 env 绑真实端口、探针却盯着 argv 端口，表现为 90s 假超时）。

### 新增

- **更新三重防线，「点了更新打不开」绝不再发生**：① **park**——安装前把现役树 rename 成 `dsh.prev`，新树装进全新目录（同时消除存量状态诱因），回滚 = 一次 rename，零网络；② **冒烟启动**——提交前在临时端口 + 一次性 home 上无头启动新核心验证（HTTP <400 即通过），树内版本错位这类故障 import 阶段几秒内暴露，失败输出自动落主日志；③ **失败自动回滚**——冒烟失败把旧版**换名**救回并通知用户，无感继续用旧版。注意 Windows delete-pending 陷阱：回滚绝不能"先 rmSync 目标再 rename"（实测 3/3 EPERM，之后核心被 spawn 到被掏空的树上），必须换名策略 + 退避重试。冒烟判定秒数可用 `DSH_DESKTOP_SMOKE_SECONDS` 覆盖。
- **安装器自动切换（npm / pnpm）**：更新目标 ≥0.1.2 → 自动用 **npm**（该版本线优化了发布包 peer 图，实测全新安装 23.7s，对比 0.1.1 时代 >10min 解析爆炸；npm 对 peer 按区间独立解析，结构上不会复现 pnpm 偏斜），其余场景仍 pnpm（内置、裸机可用）；`DSH_DESKTOP_INSTALLER=npm|pnpm` 可强制覆盖；npm 安装前自动清掉 pnpm 时代的符号农场目录。

## [1.6.0] - 2026-09-04

### 修复

- **核心 0.1.2-rc.1+ 启动链接 token 丢失，窗口一直卡在认证界面**：核心新版 `dsh web` 打印的启动链接会携带一次性认证 token（`http://127.0.0.1:3080/?token=…`，页面根路径交换 token 写 cookie 后跳回干净的 `/`）。壳的 `handleLine` 原来用 `line.match(/(https?:\/\/127\.0\.0\.1:\d+)/)` 只截取到端口号——query 里的 token 被直接丢弃，窗口加载无 token 的裸地址，页面以未认证状态启动、永远停在认证等待。修复：URL 提取抽成纯函数模块 `url-extract.js`（`extractDshUrl`），匹配端口后继续保留 `[/?#]` 起的 query/fragment（剥离 ANSI 转义、修剪行尾标点），老核心的裸 URL 行完全兼容；配套单测 `scripts/test-url-extract.js`（13 组断言）。**注意：以后改 URL 提取逻辑先跑 `node scripts/test-url-extract.js`，绝不要把提取改回"只到端口"。**
- **打包白名单漏掉 `url-extract.js`**：electron-builder 的 `build.files` 白名单未包含新增模块，导致安装包里 `main.js` 加载 `./url-extract.js` 失败；已补上（`main.js` 引用的两个本地模块 `plugin-recovery.js` 与 `url-extract.js` 均在白名单内）。

### 新增

- **核心更新渠道选择（稳定版 / 体验版 / 实验版）**：桌面版设置页「核心」新增「更新渠道」下拉——**稳定版=latest / 体验版=next / 实验版=alpha**（npm dist-tag，设置存 `update-settings.json` 的 `coreChannel`，默认 `latest`）。安装（`installPlan`）、版本检查（`queryLatest`）、启动自动更新（`checkForUpdatesOnStartup`）全部按所选渠道解析 tag；切换渠道经 `dsh:setCoreChannel` IPC 持久化并立即重查该渠道最新版本（`updateAvailable`/「最新」显示即时刷新）。dist-tag 是移动指针，某渠道暂无发布版本时静默显示"已是最新版本"，不报错。`DSH_DESKTOP_SPEC` 环境变量仍优先生效（调试/CI 覆盖）。

## [1.5.0] - 2026-08-29

### 修复

- **任务通知严格限定主会话**：此前只有 `agent/status`（完成）通道过滤了 subagent，`agent/error`（失败）与 `approval/request`（待确认）未过滤——subagent 的报错/审批也会弹原生通知。三个事件通道现在全部经 `isSubagent()`（session header 的 `parentSession`/`origin:"subagent"`/`delegationDepth≥1`）过滤，只有主会话的主 agent 完成、失败、需要确认才弹通知。
- **Ctrl+Alt+R 重启偶发「端口已被占用」（v1.4.5 残留竞态）**：v1.4.5 给 exit 处理器的面板/收养探测加了代际校验，但**漏掉了对 `dshProc = null` 与 `clearWatchdog()` 的守卫**——实测（e2e 自动重启 ×8 + 独立复现脚本）被杀核心的 `exit` 事件**经常晚于**新核心的 `doSpawn` 才送达（重启链的 loadFile/同步 IO 拥堵主事件循环，libuv 的 child-wait 回调排队），旧代码于是把 `dshProc` 误清——新核心变成簿记孤儿：**下一次重启无子进程可杀，端口被它一直占用 → 必现「端口已被占用」**。修复：exit 处理器的状态变更先校验身份（`dshProc === child`）与代际（`serial === spawnSerial`），迟到的 exit 完全无害化。
- **taskkill 静默失败无兜底**：`killDSH` 原来不看 taskkill 的退出码（"not found"/"access denied" 也照常走流程），旧核心没被杀死时 10s 端口等待只能干等。修复：① taskkill 非零退出码/启动失败时记日志并回退 `child.kill()` 直接终止；② 重启链端口等待期间，若占用者仍是**刚被杀的那个 pid**（壳持有其子进程句柄，pid 不会被复用，无误杀风险），每 2.5s 重新 taskkill 一次自愈；③ POSIX 侧改为 200ms 轮询进程组存活（死了立刻继续，不再盲等 2s），2s 未死升级 SIGKILL。
- **错误面板/日志可诊断化**：主进程日志现在持久化到 `<userData>/dsh-desktop-main.log`（>1MB 启动时轮转为 .old）——打包版没有控制台，此前每次重启 flake 过后无任何证据可查；「端口已被占用」面板现在附带占用进程的 PID。

### 新增

- **插件故障自动恢复（DSH 被玩坏时自愈）**：核心因插件加载失败而无法启动时（实测 rc.2：bundle 缺失 / 模块语法错误 / `apply()` 抛错全部快速 exit 1，日志形如 `failed to import/apply loader entry <name> (<name>): …`、`cannot resolve profile bundle "X"`），壳现在会：① 从**该代核心自己的输出**（`child.logStart` 起、末尾 80 行——运行期 HMR 补丁报错措辞相同但不会触发）解析出故障插件名；② 映射回 profile bundle（包名/子路径前缀 + 解析各 bundle 的 `dsh.bundle.patch` 挂载名），**DSH 自带的 `@deepseek-ai/*` 系统插件一律排查在外、绝不自动卸载**；③ 自动卸载——从 profile `package.json` 的 `dsh.profile.bundles` **和** `dependencies` 同时移除（只删 bundles 会被下次 `dsh plugin` 的 reconcile 重新挂载）；④ 自动重启核心；⑤ 启动成功后弹出蓝色信息面板，明确列出被卸载的插件及处置说明，确认后进入 UI。特例：罪魁是 `dshmarket` 时额外关闭「内置插件市场」开关（否则壳下次 spawn 会重新暂存挂载）；罪魁是壳自己的 `dsh-desktop-plugin` 时该代不带其挂载行启动（窗口控制由内置备用按钮条兜底）。预算：每壳会话最多 4 次自动恢复，系统插件/无法归因/超预算时落回错误面板。
- 开发/回归钩子：`DSH_DESKTOP_E2E_RESTARTS="N[,ms]"` 环境变量让应用在每次打开 DSH 页面后自动执行 N 次真实重启链（配合 `DSH_DESKTOP_USER_DATA`/`DSH_DESKTOP_HOME`/`DSH_DESKTOP_PORT` 隔离使用）；`scripts/repro-restart-race.js` 可独立实测核心被杀后的端口释放时序；`scripts/repro-plugin-failure.js`（抓取四类插件故障的真实日志格式）、`scripts/test-plugin-recovery.js`（解析器单测，含真实日志回归）、`scripts/e2e-plugin-recovery.js`（自动恢复全链路 e2e）。

## [1.4.5] - 2026-08-27

### 修复

- **手动 Ctrl+Alt+R 重启不稳定（v1.4.4 引入的回归）**：v1.4.4 的「收养探测」与既有的重启守卫之间存在三个竞态窗口，导致手动重启时好时坏——中途闪「进程已退出/启动失败」崩溃面板、窗口闪烁乱跳、或报「端口已被占用」。根因与修复（引入**核心代际号 `spawnSerial`**，所有延迟决策必须确认自己仍代表当前代际）：
  - **过期收养探测劫持手动重启**：核心意外退出后 exit 处理器对原端口轮询 12s（`probeServerUp`），回调只检查 `quitRequested`。用户按 Ctrl+Alt+R 重启后，新核心一绑上端口就被旧探测误认成「外部替身」——`adoptedPid` 记成壳自己的亲儿子、抢跑设 `dshUrl` 并再次 `openDSH`（与 `waitForServerThenOpen` 双重 `loadURL`）；若新核心绑端口晚于探测截止，又在正常重启中途弹崩溃面板。修复：探测回调与 `report()` 均校验 `restartRequested`/代际号/`dshProc`，过期探测一律静默；`probeServerUp` 轮询中发现重启接管即提前退出。
  - **迟到的 exit 事件误报崩溃**：`restartDSH` 原在 `killDSH` 回调里立刻清 `restartRequested`，而被杀核心的 `exit` 事件可能晚于此到达——守卫全 false、`dshUrl` 已清空，误弹「启动失败」面板。修复：`restartRequested` 从按下快捷键起一直保持到 `doSpawn()` 真正拿到新 child 才清除。
  - **连按两次 Ctrl+Alt+R 双 spawn 抢端口**：`restartRequested` 在异步 spawn 链（`ensureDSH`→`isPortFree`→`doSpawn`）期间原已复位，第二条链并发启动两个核心抢端口，输家 EADDRINUSE 又触发上面两条。修复：同上——重启标志覆盖整条链，链上所有中止路径（runtime 版本不足、端口预检失败、spawn error、找不到安装）与成功路径都会释放标志，重试永不悬挂；另加 `isUpdating` 守卫防止更新进行中的手动重启打断安装流程自身的重启链。
  - **重启后端口短暂未释放直接弹「端口已被占用」**：taskkill 杀大进程树（或杀软扫描）时端口释放可能滞后数秒，重启链的端口预检撞上就闪面板。修复：**重启链内**（`restartRequested` 保持期间）端口被占改为等待释放（最长 `PORT_RELEASE_WAIT_MS` = 10s，400ms 轮询）再 spawn，超时才弹面板；**冷启动不等待**——对它而言被占端口就是外部进程，直接弹面板换端口。

## [1.4.4] - 2026-08-27

### 修复

- **dsh-market「重启」与壳冲突（点击后壳无法在原端口启动）**：当用户在 profile 里**自行安装**了 dshmarket
  （`dsh.profile.bundles` 含 `dshmarket`），壳按「用户自己的拷贝优先」原则完全跳过市场挂载行——于是
  `allowRestart: false` 配置也随之丢失，市场的「重启」按钮处于激活状态。点击后市场的 detached helper
  会 spawn 一个脱离壳生命周期的替身核心抢占原端口：壳把旧进程退出误报成「进程已退出」崩溃面板，点重试
  又因端口被替身占用而报「端口已被占用」，陷入死锁。修复（两道防线）：① `prepareBundledMarket()`
  （原 `stageBundledMarket()`）检测到用户自装市场时仍生成一条**普通 `- id:` 覆盖行**（非 `- insert:`，
  不会重复挂载；附 `name` 守卫），强制 `config.allowRestart: false`——已用真实 `dsh --dump-config`
  验证组合结果恰好一行且配置生效；② 纵深防御：核心意外退出且此前已成功启动时，壳先探测原端口
  `ADOPT_RESTART_GRACE_MS`（12s），若替身核心起来了就**收养**它（记录监听 PID、窗口直接 reload 到原
  地址），不再弹崩溃面板；`killDSH()` 会带守卫地清理被收养的进程（`killAdoptedDSH`：仅当记录的 PID 仍
  是该端口监听者时才 taskkill），壳的重启/更新/退出路径因此对替身核心同样有效。已知限制：被收养的进程
  没有 exit 事件监听，它之后再死掉由 `did-fail-load` 兜底回错误面板。

## [1.4.3] - 2026-08-23

### 新增

- **设置导航自定义图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section
  统一画通用齿轮（没有公开图标字段）。`dsh-desktop-plugin/client.js` 新增 `registerSettingsNavIcons()`：
  用 MutationObserver 给设置对话框导航里文本等于 section label 的行打标记，CSS 隐藏默认齿轮、用
  `currentColor` mask 绘制 Lucide 图标——**核心**（cpu 芯片）与**桌面版**（monitor 显示器）两个设置
  页在侧栏导航里不再显示通用齿轮。换图标只需替换 CSS 里 data URI 的 SVG path。

## [1.4.2] - 2026-08-23

### 修复

- **GitHub Actions 构建的安装包缺失内置 Node（v1.4.1 发布缺陷）**：CI 工作流（`build-installers.yml`）
  用 `npx electron-builder` 直接构建，绕过了 package.json 脚本，因此从未执行 `fetch:node`——`build/node`
  在 CI 上不存在，`extraResources` 打不进内置 node，v1.4.1 的发布版实际回退到 Electron 内嵌运行时，
  Windows 命令弹窗问题依旧。修复：三个平台 job（win/linux/mac×x64/arm64）在 electron-builder 前显式
  增加 `node scripts/fetch-node.js` 步骤；mac 交叉构建（Apple Silicon runner 出 x64 dmg）通过
  `DSH_DESKTOP_NODE_ARCH` 指定目标架构下载对应 node 二进制。
- `scripts/fetch-node.js` 新增 `DSH_DESKTOP_NODE_ARCH` 环境变量：跨架构构建时指定要下载的 Node 架构
  （默认取当前 `process.arch`）。

## [1.4.1] - 2026-08-23

### 修复

- **Windows 下执行命令弹出控制台窗口（实测 Windows 11）**：DSH 核心曾改用 Electron 内嵌 Node
  （`ELECTRON_RUN_AS_NODE`）运行——Electron 二进制是 **GUI 子系统** PE，**永远不会获得/继承控制台**
  （GUI 进程不参与控制台继承，实测 pids=0），于是沙箱 runner 无控制台可传给受限 PowerShell 子进程，
  子进程只能**自己新建可见控制台窗口**，每条命令弹一个（移除独立 Node 后的回归）。修复：恢复**内置独立
  Node**（`scripts/fetch-node.js` 拉取 pin 版本 Node 24 LTS → `build/node/<平台-架构>` → extraResources
  `<resources>/node/<平台-架构>`），`dshRuntime()` 优先用它跑核心/安装器。真实 node 是 **Console 子系统**，
  `CREATE_NO_WINDOW` 下得到**无窗口控制台**，整棵进程树（沙箱 runner → 受限 PowerShell）都继承它——
  任何命令都不弹窗口，**且 DSH 核心代码保持 100% 原始**（升级/重装无兼容风险）。体积代价 ~30MB
  （安装包实测 106MB→128MB）。内置 node 版本低于核心要求（≥22.15）时自动回退 Electron 内嵌并记日志。

### 新增

- `scripts/fetch-node.js`：`npm run fetch:node` 下载固定版本 Node LTS（默认 24.19.0，
  `DSH_DESKTOP_NODE_VERSION` 覆盖，`DSH_DESKTOP_NODE_MIRROR` 换镜像，默认 npmmirror、回退 nodejs.org），
  已接入所有 `pack`/`dist:*` 构建脚本。

## [1.4.0] - 2026-08-22

### 修复

- **窗口控制条被右侧栏插件面板遮挡（实测 mac）**：控制条原本挂载在 `shell.overlay` 槽内、受 DSH 叠层
  上下文限制，右侧栏插件展开后会把最小化/最大化/关闭 + Session log 按钮盖住。修复：改用
  `ReactDOM.createPortal(..., document.body)` 渲染（loader 的 staticModules 暴露 `react-dom`，组件仍在槽的
  React 树里、仅 DOM 出口落到 body 层，`position:fixed` + 最大 z-index 保证最顶）。注：中间一版曾手动
  `appendChild` 把 React 管理的节点挪到 body，导致槽位宿主下次渲染时调和崩溃、按钮全部失效——
  已修正为 portal 正道。
- **打包版内置市场缺失**：electron-builder 会把 asar 里任何嵌套 `node_modules` 整体丢弃（即使 `files`
  白名单显式包含），`stageBundledMarket` 的源目录在打包版里不存在、市场从未真正随包分发。修复：
  `fetch-market-plugin.js` 先装进临时 prefix、再把 `node_modules/*` 展平到 `build/market-plugin/` 顶层。
- **核心启动后崩死（`--expose-internals is required for HMR service`）**：核心 rc.7+ 的启动器会无条件创建
  HMR 服务用于 `cordis.patch.yml` 热重载，而它要求进程以 `node --expose-internals` 启动——缺 flag 时核心
  启动后片刻即崩（全新 home 的 rc.7 与 0.1.1-rc.2 均实测复现，即**新用户首启必炸**，CLI 裸跑同样会炸，
  属核心侧问题）。修复：spawn 参数固定前置 `--expose-internals`（node 选项、不进核心 commander，
  新老核心均安全；实测两版完整启动 + HTTP 200）。
- **DSH 核心安装/更新极慢（arborist 病态解析）**：壳的安装形态是"裸目录 + `@latest`"——首次安装没有任何
  本地状态，更新时新版本的兄弟包依赖区间（钉当次发版线）也让旧 lockfile 失效，所以 npm 每次都从零全树解析；
  dsh 核心是 ~195 个互相依赖的 `@deepseek-ai/*` 包 + react peerDeps，npm 的 arborist 在这种树上 placeDep
  超线性爆炸，实测**仅解析阶段就烧 >10 分钟 CPU 还跑不完**（内置 npm 与系统 npm 同样病态，与网络无关）。
  修复：安装/更新改用**内置 pnpm**（`scripts/fetch-pnpm.js` 拉取 pin 版本，经 extraResources 打进
  `resources/pnpm`，运行时 `node <pnpm.cjs> add --dir <托管目录>`，不依赖 PATH）——同机同树实测
  解析+下载+链接 **17.8s**（npm 光解析就 >10min），热 store 更新 **3.5s**。pnpm 不存在时自动回退原 npm
  命令行。迁移：安装前自动清除 npm 时代留下的 node_modules（无 `.modules.yaml` 判定），pnpm store 固定在
  `<userData>/pnpm-store`（与托管目录同卷保证硬链接）。
- **版本检查去掉 `npm view` 子进程**：`queryLatest()` 改为直连 registry 的 `GET /<name>/<tag>` 单次 HTTP
  请求（每次检查省 ~1s 的子进程启动开销，也不再依赖 npm/pnpm 任何一方在场）。
- **安装进度轮询不再卡主进程**：`trackInstallProgress()` 由"每 1.5s 同步全树 `statSync`"（3.3 万文件单次
  ~615ms，曾把主进程约 40% 时间烧在重复 stat 上并与安装器抢磁盘 I/O）改为每 2s 一次的**异步**遍历，且进度条
  与下载看门狗共享同一个防叠加测量器；pnpm 的下载先落 store 再硬链进安装目录，两个目录一并计入进度。

### 新增

- **桌面壳内不再弹系统浏览器**：DSH 核心自 `0.1.0-rc.8` 起 `web` 命令默认打开系统浏览器，
  桌面壳有自己的 frameless 窗口、不需要这个动作。启动参数自动追加 `--no-open`（核心官方开关），
  并按核心版本做门禁（`supportsNoOpen()`：老核心的 commander 严格解析会把未知选项当错误，
  <0.1.0-rc.8 的核心不传该参数）。

### 变更

- **Electron 33 → 43**（内嵌运行时 Node 20.18→24.18 / Chromium 130→150）：Electron 33 早已 EOL、不再收
  Chromium 安全补丁；本壳用到的 API 面（BrowserWindow/Tray/ipcMain/Notification/powerSaveBlocker/nativeImage）
  全部稳定兼容，已通过 43.4.1 冒烟验证（窗口创建 + sandbox 页面加载 + 托盘图标解码）。注意 Electron 的
  postinstall 下载会被 npm 的 allow-scripts 门禁拦截，升级后若 `node_modules/electron/dist` 缺失，
  手动跑一次 `node node_modules/electron/install.js` 即可。
- **移除内置 Node 发行版，DSH 核心改跑 Electron 内嵌 Node**：Electron 43 内嵌 Node 24.18（满足核心
  ≥22.15 的 node:zlib zstd 需求）。`dshRuntime()` 以 `ELECTRON_RUN_AS_NODE=1` 把 Electron 二进制当纯
  Node 运行核心与安装器（已实测完整拉起核心、含 koffi/sharp/node-pty 等 NAPI 原生模块并 HTTP 200）；
  spawn 前校验内嵌版本，过低直接弹错误面板（1.2.0 zstd 事故的正式护栏）。安装包体积 ↓ ~30MB；
  `fetch-node.js`、`build/node/`、`DSH_DESKTOP_NODE_VERSION/MIRROR` 全部移除。代价（明确接受）：MCP
  子进程依赖用户 PATH 里的 node/npx（终端 Profile 合并已覆盖常规场景）。

## [1.3.1] - 2026-08-21

### 修复

- **内置插件市场在打包安装后不加载（大坑，v1.3.0 回归）**：`stagePackage()` 用
  `fs.cpSync(src, dst, { recursive: true })` 从 `app.asar` 里把 `dshmarket` 复制进
  profile 的 `node_modules`。Electron 的 asar 补丁只覆盖单文件原语
  （`readdirSync`/`statSync`/`copyFileSync`/…），`fs.cpSync` 内部的递归遍历走底层
  `opendir`，绕过补丁——从 asar 内复制目录会抛 `ENOTDIR`/`ENOENT`。该异常一路冒泡到
  `prepareDesktopPlugin()` 的 try/catch，导致整个 patch 文件不生成、`--patch` 不传，
  打包版 dshmarket（甚至窗口控制条）全部不挂载。开发机上"能用"只是因为 profile 里是
  真实的 pnpm 安装（`stageBundledMarket` 检测到已装就直接跳过、从不走这条复制路径）。
  修复：改为逐项 `readdirSync`+`statSync`+`copyFileSync` 的递归复制（全部 asar 安全原语），
  并把市场暂存失败改为非致命——单次失败只记录日志、不拖垮窗口控制条 patch。

## [1.3.0] - 2026-08-20

### 新增

- **内置插件市场（dshmarket，开箱即用）**：桌面壳自带 [dsh-market](https://github.com/dsh-market/dsh-market)
  插件市场（当前 pin 1.15.0），无需用户手动安装即可浏览/搜索/一键安装社区插件。
  构建期由 `scripts/fetch-market-plugin.js`（`npm run fetch:market`，已接入各 `dist:*`
  脚本与 CI）把插件及其运行时闭包（js-yaml/undici/argparse）装进
  `build/market-plugin/`；启动时 `stageBundledMarket()` 把它暂存进 web profile 的
  `node_modules` 并经 `--patch` 覆盖层挂载。**若用户已在 profile 里自行安装过插件市场，
  以用户的安装为准、不重复挂载**（Cordis `- insert:` 是无条件追加，同 id 再插一行会把
  插件挂载两次）。桌面版设置新增「插件市场」开关（默认开，改动需重启 DSH 生效）——
  用户在 profile 里卸载市场后可凭此开关避免壳再次自动装回。内置挂载以
  `allowRestart: false` 挂载：DSH 进程生命周期归 Electron 壳管，插件自带的重启会绕过壳、
  被误判为崩溃。

### 修复

- **窗口控制条/Session log 胶囊在浅色模式下显示异常**：控制条按钮与重做的 Session log
  胶囊此前硬编码深色主题颜色（`#9aa5b8` 文字、白色半透明 hover 背景），浅色模式下文字
  发灰、hover 近乎不可见。全部改用 DSH 主题 token（`--dsw-alias-label-primary/secondary`、
  `--dsw-alias-border-l2`、`--dsw-alias-interactive-bg-hover` 等，与
  `dsh-session-log-export` 原版按钮一致），随明暗主题自动切换；主进程兜底控制条同步更新。
- **macOS 拖拽区盖住会话标题栏、侧栏顶部无法拖动窗口**：拖拽区原本是整条 36px 高的顶部条
  且容器 `pointer-events:auto`，盖住会话头部（其 `padding-top` 仅 12px），macOS 上拖拽区
  会整个吃掉点击，标题栏操作难以点中。现在：控制条容器改为 `pointer-events:none`（透明区
  不再吞点击）；拖拽条改为**细条**，高度由 `topClearance()` 运行时测量——恰好只覆盖会话头部
  顶部留白（兜底 12px，主拖拽条 clamp 6–16px、侧栏 6–28px）；另新增 `.dsh-desktop-drag-side`
  拖拽条铺满侧栏顶部（logo/按钮上方的留白，高度同样运行时测量），侧栏上方也能拖动窗口。
  兜底控制条同步改为细拖拽条方案。
- **macOS 托盘图标比正常菜单栏图标小约一半**：模板图曾在 16×16 方画布上按鲸鱼**宽度**
  80% 适配，鲸鱼宽高比 ≈1.36:1 导致可见高度只有画布的 59%（垂直边距约 40%）。改为
  **22×16pt 宽画布**（菜单栏宽图标是常规形态，如电池）+ 按**高度** 87.5% 适配，可见高度
  14pt，与标准菜单栏图标一致；@2x 相应为 44×32px。

## [1.2.0] - 2026-08-19

### 新增

- **内置 Node.js（解决 mac 从 Finder/Dock 启动无 node/npm 的根本问题）**：macOS 从
  Finder/Dock 启动的 app 没有用户 shell 的 PATH，`spawn("node")`/`spawn("npm")` 会
  ENOENT。现在把官方 Node 发行版（默认 v24.19.0 LTS，自带 npm）随 app 一起打包到
  `resources/node/`（`scripts/fetch-node.js` 下载到 `build/node/<os>-<arch>/`，
  electron-builder `extraResources` 按 `${os}-${arch}` 分发）。运行时优先用内置
  node 跑 DSH，npm 用 `node <npm-cli.js>` 跑（不依赖 PATH，Windows 顺带绕开 cmd 引号坑）；
  找不到内置时才回退系统 node。CI 各构建 job 已加入 fetch 步骤。
- **继承终端 Profile（默认开启，MCP 修复）**：macOS 从 Finder/Dock 启动的 app 没有
  用户 shell 的环境变量，DSH 拉起的 **MCP 服务**（npx/uvx/python 等）找不到可执行文件。
  桌面壳在**启动 DSH 之前**加载用户登录+交互 shell（`<shell> -l -i -c env`，带超时）导出的
  环境变量，合并进 DSH 子进程环境——MCP 作为 DSH 的子进程，启动时就有终端环境。桌面版
  设置新增「继承终端 Profile」开关（默认开），关闭后下次 DSH 重启生效。

### 修复

- **macOS 未签名导致"已损坏，无法打开"**：新增 `scripts/mac-sign.js`（`afterPack` 钩子）——
  未配置 Developer ID 证书时自动对 .app 做 **ad-hoc 自签名**，把 arm64 上吓人的"已损坏"错误变成标准的
  "无法验证开发者"（右键 → 打开 即可运行）。配置了 Developer ID 证书时该钩子不生效。
- **macOS 全选/复制/粘贴失效**：应用菜单缺少「编辑」角色菜单，macOS 不会把 Cmd+C/V/X/A
  路由给页面——补上标准的撤销/剪切/复制/粘贴/全选角色菜单。
- **macOS 托盘图标显示过大**：菜单栏需要小尺寸的「模板」图标（黑 + 透明），原 64px
  彩色图标渲染过大——新增 16px/32px@2x 黑色鲸鱼模板图（`build/tray-iconTemplate*.png`）。
- **subagent 完成任务也弹通知**：任务通知对「任务完成」只弹**主 agent** 完成（subagent
  频繁完成是噪音，不再逐个弹窗）；主 agent 完成、任务失败、需要确认时才会弹桌面通知。
- **macOS 无法拖动窗口**：原拖拽区只是右上角控制条内 18px 的细缝；改为从侧栏右缘延伸到
  按钮的整条 36px 顶部拖拽区（除右侧按钮外均可拖）。
- **会话头部向左避让关闭按钮**：原 CSS 把会话头部右侧工具向左推 150px（`padding-right`）
  以避开右上角控制条，很丑；最终方案：**把 Session log 按钮搬进窗口控制条**（最小化按钮
  左边，四周留呼吸间距），CSS 隐藏 DSH 头部的原按钮——会话头部完全恢复原始布局
  （crumbs/tabs 间距不变），不再用任何下移/左挤 hack。**没有打开的会话、或空白新会话
  （还没有对话内容）时不显示该按钮**（订阅 `sessions.list`：`current` 有值且该会话
  `summary.blank` 不为 true 才渲染，与 DSH 头部隐藏逻辑一致；控制条用 `MutationObserver`
  在按钮出现/消失时重新测量拖拽区终点）。侧栏保持通顶不被遮挡——控制条从侧栏右缘开始
  （JS 实时测量侧栏宽度与按钮起点）。
- **GitHub Release 说明只有版本号+日期**：发布工作流提取 CHANGELOG 章节的正则带了 `m`
  标志，懒匹配在标题行就停住，Release 说明只剩 `## [x.y.z] - 日期` 一行——去掉 `m` 标志，
  Release 说明现在包含完整的变更列表。
- **首发包内置 Node v22.14.0 导致 DSH 启动即失败（1.2.0 已重建）**：DSH 核心 0.1.0-rc.7
  的会话持久化插件（`dsh-session-persistence-jsonl`）需要 `node:zlib` 的 zstd API
  （Node ≥22.15.0 才有），而内置 node 优先级高于系统 node，导致核心一升级应用就打不开
  （报 `does not provide an export named 'createZstdDecompress'`）。重建时内置 Node
  升级到 **v24.19.0 LTS**；`fetch-node.js` 同时改为校验本地缓存版本与目标一致才跳过，
  不一致强制重新下载（避免旧版本缓存被打进新安装包）。

### 变更

- 壳版本号 `1.1.0 → 1.2.0`。
- **移除 Windows 32 位（x86/ia32）安装包**：Node 官方从 24 起不再发布 win-x86 发行版，
  无法为 32 位 Windows 内置 node，Windows 仅保留 x64（`dist:win:x86` 脚本已删除）。

## [1.1.0] - 2026-08-18

### 新增

- **桌面版设置显示壳版本号**：「设置 → 桌面版」顶部新增「壳版本」行。
- **壳自身自更新（GitHub Releases）**：桌面版设置新增「检查更新」；从
  `MoonlitDropOfBlood/DSH-Desktop` 的 GitHub Release 查询最新版本，发现新版本后
  **按当前系统下载对应安装包**（Windows `.exe` / macOS arm64 `.dmg` / macOS x64 `.dmg` /
  Linux `.AppImage`），带下载进度，完成后自动启动安装程序（Windows 下自动退出以便替换）。
- 更新前探测 npm 镜像（原来只有首次安装探测）。

### 修复

- **安装 DSH 失败（ENOENT mkdir，退出码 4294963238）**：Windows 上 npm 命令的引号被
  `cmd /s /c` 弄坏导致路径被空格截断——改为把 `npm` 与每个参数作为独立 argv 传入。
- **点更新"一直没下载"**：npm 连上镜像 CDN 的"黑洞节点"（TCP 握手成功但不传数据）后干等。
  新增四道防线：`fetch-timeout=30s` 快速失败重试、`--loglevel=info` 实时可见下载、
  下载看门狗（120s 无进展自动终止并提示）、更新前镜像探测。
- **更新时主进程崩溃**：全局捕获 `uncaughtException` / `unhandledRejection`，错误显示在
  启动页错误面板（可复制），不再弹无法复制的系统崩溃框。
- **macOS 右上角关闭/最小化按钮无反应**：`-webkit-app-region: drag` 嵌套导致点击被吞——
  改为独立拖拽条 + 按钮显式 `no-drag`；启动页 CSP 补上 `script-src`。
- **核心/插件加载失败时无法关窗**：页面加载失败/渲染进程崩溃回退到自带窗口控制条的启动页；
  插件未挂载时主进程注入兜底控制条；菜单加 `CmdOrCtrl+W/M` 逃生通道。
- **常驻通知栏开启后托盘图标不出现**：改为开启设置即创建托盘图标，无需先点一次关闭。
- **更新覆盖运行中核心导致崩溃**：更新改为先停 DSH 核心再安装，失败可「用当前版本继续」。
- **端口被占用时无法换端口**：启动前预检端口，被占弹「换端口并重试」面板（端口持久化）。
- **任务通知在窗口有焦点时也弹出**：改为只在后台/最小化/藏托盘时通知。
- **任务通知桥无认证**：改为每次启动随机端口 + 随机令牌，外部 Web Origin 直接拒绝。
- **双击图标会启动第二个实例**：拿不到单实例锁时跳过整个启动引导（`gotSingleInstanceLock`）。
- **安装失败弹出系统模态框无法复制**：统一改为启动页错误面板，带「复制错误信息」按钮。

### 变更

- 壳版本号 `1.0.0 → 1.1.0`。

## [1.0.0] - 2026-08-16

### 新增

- 初始版本：DeepSeek Harness 桌面壳。
  - frameless 沉浸式窗口，DSH Web UI 全屏显示，右上角窗口控制条。
  - DSH 核心按需安装（npm `@deepseek-ai/dsh`）与定位（托管目录 / node_modules / `_npx` 缓存）。
  - 设置页：核心版本 / 检查更新 / 自动更新；常驻通知栏 / 阻止休眠 / 任务通知。
  - 系统托盘（开启常驻通知栏后可用）、启动页、崩溃重启、进程树清理。
  - Windows / macOS / Linux 安装包（NSIS / dmg / AppImage+deb+rpm），GitHub Actions 自动发布。
