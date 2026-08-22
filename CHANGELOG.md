# Changelog

本项目所有重要变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布流程：改动记录在 `## [Unreleased]`；打 `v*` 标签发布时，把对应内容移到新的 `## [x.y.z] - <日期>` 小节。
> GitHub Actions 发布 Release 时会自动取 `## [<版本号>]` 这一节作为 Release 说明。

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
