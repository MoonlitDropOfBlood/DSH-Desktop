# AGENTS.md — DeepSeek Harness Desktop

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其是"关键机制"和"重要注意事项"两节，记录了本项目踩过的大量坑。

## 项目是什么

把 **DeepSeek Harness（DSH）** 包装成一个桌面应用（Electron 外壳）：

- **DSH 核心不打进包里**——目标机器上通过 `npm install @deepseek-ai/dsh@latest` 动态安装（首次自动装，之后复用）。
- 窗口是 **frameless**（无原生标题栏），窗口控制按钮（最小化/最大化/关闭）由**嵌入 DSH UI 的客户端插件**渲染。
- 提供：设置页（版本/更新、常驻通知栏、阻止休眠、任务通知）、系统托盘、启动页、崩溃重启、进程树清理。
- 支持 Windows / macOS / Linux（托盘在无托盘桌面环境的 Linux 上优雅降级）。

## 目录结构

```
dsh-desktop/
├── main.js                 # Electron 主进程：全部生命周期、IPC、托盘、设置、通知桥
├── preload.js              # contextBridge：暴露 dshDesktop.* 给渲染进程（DSH 页面）
├── splash.html             # 启动页（frameless 下自带标题条）
├── package.json            # electron-builder 配置 + 脚本
├── dsh-desktop-plugin/     # DSH 客户端+主机插件包（随应用一起打包，非 DSH 核心）
│   ├── package.json        #   dsh.client: { platform: "web" } + exports["./client"]
│   ├── index.js            #   Host 半部：监听 DSH 任务事件 → POST 通知桥
│   └── client.js           #   Client 半部：窗口控制条、侧栏更新徽章、设置页
├── scripts/
│   ├── make-tray-icon.js   # 用 @resvg/resvg-js 从 whale.svg 生成各尺寸图标
│   ├── fetch-market-plugin.js # 下载内置插件市场 dshmarket 到 build/market-plugin/
│   ├── fetch-pnpm.js       # 下载 pin 版本的 pnpm 到 build/pnpm/（DSH 核心的安装器）
│   └── embed-exe-icon.js   # 本机无法解压 winCodeSign 时，用 rcedit 手动嵌 exe 图标
└── build/
    ├── market-plugin/      # 内置插件市场（gitignore；打包时经 files 随 app 分发）
    ├── whale.svg           # DeepSeek 鲸鱼矢量源（从 DSH FishLogo 提取）
    ├── icon.png            # 256px（Windows）
    ├── icon-512.png        # 512px（macOS / Linux）
    ├── tray-icon.png       # 64px（系统托盘）
    └── icon.ico            # 多尺寸 ICO（embed-exe-icon 产物）
```

## 关键机制

### 1. DSH 动态安装与定位（main.js `resolveDSHBin` / `ensureDSH` / `installDSH`）

启动时按顺序找 DSH 安装：
1. 应用托管目录 `%APPDATA%\...\dsh\node_modules\@deepseek-ai\dsh`
2. 应用自身 `node_modules`
3. npm `_npx` 缓存里最新的一份完整安装（**复用，避免重复下载**）

找不到就 `pnpm add --dir <托管目录> @deepseek-ai/dsh@latest`（**内置 pnpm**：经 `node <resources>/pnpm/bin/pnpm.cjs` 运行，不依赖 PATH；含 registry 探测 + 失败重试/换镜像）。pnpm 不存在时（未跑 `fetch:pnpm` 的开发环境）回退老的 `npm install --prefix <托管目录> --no-save …`。

**为什么用 pnpm 装核心（实测大坑，勿改回）**：壳的安装形态是"裸目录 + `@latest`"——首次安装没有任何本地状态；更新时新版本的兄弟包依赖区间钉在当次发版线（`^0.1.1-rc.x`），旧 lockfile 照样全部失效，所以**每次都是从零全树解析**。dsh 核心是 ~195 个互相依赖的 `@deepseek-ai/*` 包 + react peerDeps，npm 的 arborist 在这种树上 placeDep 超线性爆炸——实测**仅解析阶段就烧 >10 分钟 CPU 还没跑完**（内置 npm 11.17 与系统 npm 11.9 同样病态，与网络快慢无关）。同机同树实测 pnpm 解析+下载+链接（446 包）：**17.8s**；热 store 更新 **3.5s**。终端 npx/npm"快"只是因为命中 `_npx` 缓存或项目 lockfile，根本没做全树解析。

**pnpm 化要点（main.js `installPlan` / `prepareManagedDir`）**：① 托管目录先补一个最小 `package.json`（`pnpm add` 需要），并**清掉 npm 时代留下的、无 `.modules.yaml` 的 node_modules**（pnpm 只覆盖它认识的包，旧文件会滞留 ~210MB 死重）；② store 固定在 `<userData>/pnpm-store`——必须与托管目录同卷，否则硬链接退化为全量复制；③ 必须带 `--config.confirmModulesPurge=false` 和 `--reporter=append-only`（splash 无 TTY，任何交互提示都会挂死安装；append-only 输出才能被进度日志逐行解析）；④ pnpm 默认不跑依赖的 install 脚本——本树的原生包（koffi/sharp/node-pty）全部以平台预编译包随 tarball 分发，无需脚本，与 npm 时代被 allow-scripts 门禁跳过的行为一致；⑤ `@tanstack/react-virtual` 的宽 peer 区间会让 pnpm 把 react-dom 解到 19.x（react 是 18.3.1）并打一条 "unmet peer" 警告——**惰性无害**（web 客户端是预构建 bundle，服务端不加载 react-dom），`pnpm.overrides` 的 `$react` 语法要求 react 是直接依赖、用不了，别加。⑥ 版本检查 `queryLatest()` 已改为直连 registry 的 `GET /<name>/<tag>`（一次 HTTP，不再 spawn `npm view`）。

**Windows 上 spawn npm 的引号坑（大坑，必读）**：pnpm 主路径经 `node <pnpm.cjs>` 直跑、不经过 cmd，天然免疫此坑；npm 回退路径仍需遵守——**绝不要**把 npm 命令预拼成一个字符串再丢给 `cmd /d /s /c`，例如 `cmd /d /s /c "npm install --prefix "C:\...\dsh" ..."`，也不要用 `JSON.stringify(path)` 给参数加引号——cmd 的 `/s` 引号剥离会弄坏内嵌引号、按空格截断参数，npm 就会收到一个**相对路径** `--prefix "C:\...\DeepSeek`，然后报 `ENOENT: mkdir`，退出码 `4294963238`（只要路径含空格就必炸，例如 `C:\Users\wwhby\AppData\Roaming\DeepSeek Harness Desktop\dsh`）。**正确做法**：每个参数（含带空格的路径）作为独立 argv 传入 `spawn`，让 Node 的 CreateProcess 自动加引号；`--prefix`/`--dir` 传原始路径、不要 JSON.stringify。

**DSH 的 npm 仓库**：`@deepseek-ai/dsh` 发布在官方 **npmjs.org**（`https://registry.npmjs.org`），国内常用 npmmirror 镜像同步。默认 `DEFAULT_NPM_REGISTRY` = npmmirror（国内快），探测/失败时回退 npmjs.org。可用 `DSH_DESKTOP_NPM_REGISTRY` 覆盖。

**不要用 `npx` 启动 DSH**：本机网络下 npx 在线解析 `@latest` 会挂死在 CDN 节点，`npx --offline` 在 npm 11 + 大缓存下病态空转。**直接 `node <bin> web --patch <patch>` 最可靠**。

**rc.8+ 核心会默认打开系统浏览器（桌面壳必须拦截）**：核心 0.1.0-rc.8 起 `web` 命令默认把 URL 交给系统浏览器（`dsh-web-app` 配置 `openBrowser` 默认 true，官方开关 `--no-open`）。桌面壳有自己的 frameless 窗口，`doSpawn()` 固定追加 `--no-open`——但**必须按核心版本门禁**（`supportsNoOpen()`）：老核心的 commander 严格解析、遇未知选项直接 `error: unknown option` 退出（实测 rc.7 即炸），所以 <0.1.0-rc.8 的核心绝不能传。比较版本时注意 semver 形态：`0.1.0` 正式版比所有 `0.1.0-rc.N` 都新，先比数字三元组、相同再比 rc 号。

### 1b. DSH 运行时 = Electron 内嵌 Node（ELECTRON_RUN_AS_NODE）

**机制**：Electron 43 内嵌 Node 24.18——已满足 DSH 核心的 Node ≥22.15 需求（node:zlib zstd）。`dshRuntime()` 直接返回 `process.execPath`（Electron 二进制自身），spawn 时加环境变量 `ELECTRON_RUN_AS_NODE=1`，该进程就是**纯 Node**（Chromium 完全不初始化）——已实测用它完整拉起 DSH 核心（含 koffi/sharp/node-pty 原生模块）并 HTTP 200。`DSH_DESKTOP_NODE` / `npm_node_execpath` 可覆盖为真实 node 二进制（此时不加 flag）；`runtimeSupportsDsh()` 在 spawn 前校验内嵌 Node 版本，过低弹错误面板而不是让核心启动即炸（1.2.0 事故的正式护栏）。

- **不要恢复内置 Node**（`fetch-node.js` / `build/node/` 已删除）：内置 Node 曾是 macOS 裸环境的兜底，现在 Electron 内嵌运行时天然免疫；省 ~30MB 安装包体积，且 Electron 升级即 Node 升级，消灭"内置 node 版本漂移"这类事故（1.2.0 的 zstd 事故就是内置 22.14 落后于核心需求）。
- **代价（明确接受）**：DSH 的子进程（MCP 服务、`dsh plugin` 等）只能看到**用户 PATH** 里的 node/npm/pnpm（终端 Profile 合并已覆盖 GUI 裸环境）；一台完全没装 Node 的机器能跑 DSH 但跑不了 npx 系 MCP 服务。
- **原生模块前提**：Electron 的 NODE_MODULE_VERSION 与官方 Node 不同，但 DSH 树的原生包全是 **NAPI**（ABI 跨运行时稳定）所以兼容——**往核心里引入 NAN 原生包会破坏此方案**（届时该包需针对 Electron 重建）。
- 开发时（`npm start`）：`process.execPath` 就是 `node_modules/electron/dist/electron`，同一条路径，行为一致。
- **spawn 参数固定带 `--expose-internals`（node 选项，非核心参数）**：核心 rc.7+ 的启动器在组合里没有 hmr 服务时会**无条件创建** `cordis-plugin-hmr`（用于监听 `cordis.patch.yml` 热重载），而 `Hmr` 构造函数硬性要求进程以 `node --expose-internals` 启动（`ctx.loader.internal` 只在该 flag 下存在）——没有它核心会启动后片刻崩死（rc.7 与 0.1.1-rc.2 全新 home 均实测复现，CLI 裸跑 `dsh web` 同样会炸，属核心侧问题）。该 flag 放在 `bin.js` **之前**、由 node 自己消费，永远到不了核心的 commander，**对新老核心都安全、无需版本门禁**（实测两版均完整启动 + HTTP 200）。

### 1c. 继承终端 Profile（MCP 修复，设置"继承终端 Profile"默认开）

**问题**：从 Finder/Dock 启动的 mac app 没有用户 shell 的环境变量，DSH 继承的就是这个"裸"环境，DSH 拉起的 **MCP 服务**（npx/uvx/python 等子进程）找不到可执行文件，起不来。

**机制（保证在 MCP 之前）**：桌面壳在主进程 **spawn DSH 之前**用 `execFileSync` 跑用户的登录+交互 shell（`<shell> -l -i -c env`，依次回退 `-l`、`-i`，8s 超时，`PS1=''` + 过滤 `KEY=VALUE` 行），把导出的环境变量解析出来，合并进 `childEnv()`。**合并语义 = 用户环境优先**：`childEnv()` 基底就是应用自身的 `process.env`（终端启动、`launchctl setenv`、LaunchAgent 注入的变量全都在，直接透传给 DSH/MCP）；Profile 只**补缺**（应用已有的 key 不被覆盖，避免 `.zshrc` 覆盖你在启动前 export 的值）；PATH 特殊处理——Profile 的 PATH **前置**（裸环境下 MCP 必须要用户 PATH）。DSH 是 MCP 的父进程 → MCP 一定在出生时就有终端环境。Windows 跳过（注册表环境已够用）。开关存 `update-settings.json` 的 `inheritTerminalProfile`（默认 true），桌面版设置页可关；`_terminalEnv` 缓存，切开关后置空、下次 DSH 重启生效（`restartDSH`/更新时）。

### 2. 客户端插件挂载（`prepareDesktopPlugin` + `--patch`）

窗口控制条、设置页、更新徽章都是 DSH 客户端插件，通过 composition patch 挂载：
- 插件包复制到 `<DSH_HOME>/profiles/web/node_modules/dsh-desktop-plugin`（`client-modules` 的 baseUrl 是 profile 目录，`require.resolve("dsh-desktop-plugin/package.json")` 从那里解析）。
- `plugins.patch.yml` / 生成的 `desktop-plugin.patch.yml` 用 **`- insert:`** 语法新增行（普通 `- id:` 是覆盖已有行，新 id 会报 "entry not found"）。
- 启动命令：`node <bin> --patch <patch> --profile web [--port X]`。
  **`--patch` 是 launcher 参数，必须放 `--profile` 之前**；放 `web` 子命令后会报 "web takes none of parent --patch"。

客户端 bundle 的**正确格式**（否则报 "loaded without registering via __ModuleLoader__.load"）：
```js
window.__ModuleLoader__.load({
  id: "dsh-desktop-plugin",
  factory: (require) => {
    var module = { exports: {} }; var exports = module.exports;
    const React = require("react");
    const ui = require("@deepseek-ai/dsh-client-ui-primitives"); // Button/Toast 等
    function apply(ctx) { ... }
    exports.apply = apply;
    exports.inject = ["slots"]; // 用 ctx.slots 必须声明 inject
    return module.exports;
  }
});
```
- `package.json` 必须 `exports` 里包含 `"./package.json"`，否则 `require.resolve("<pkg>/package.json")` 失败（exports 字段会封锁子路径）。
- `ctx.slots` 直接访问需要 `exports.inject = ["slots"]`，否则 "cannot get property slots without inject"。

### 2b. 内置插件市场（dshmarket，`stageBundledMarket`）

壳自带 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场（pin 版本，`DSH_DESKTOP_MARKET_VERSION` 覆盖），开箱即用、目标机器零下载：

- **构建期**：`scripts/fetch-market-plugin.js`（`npm run fetch:market`，已接入所有 `dist:*` 脚本和 CI 各 job）用 `npm install --prefix build/market-plugin --no-save --omit=dev dshmarket@<pin>` 拉取插件及其运行时闭包；幂等（版本一致跳过，不一致清空重装）。`build/market-plugin/` 已 gitignore，经 `files: ["build/market-plugin/**"]` 打进 asar。
- **只暂存 4 个包**：`dshmarket` + `js-yaml` + `undici` + `argparse`。dshmarket 的 `@deepseek-ai/*` 导入（`dsh-settings`、`schemastery`，以及 client 的 inject 包）**由 DSH 加载器对核心安装目录解析**，profile 安装版也不带这些包进 profile（已用真实 pnpm profile 的 lockfile 验证：它的依赖只有 js-yaml/undici/argparse）——**不要**把 `@deepseek-ai/*` 拷进 profile（会出现核心包第二实例）。
- **运行时**：`prepareDesktopPlugin()`（每次 spawn DSH 前）先 `stageBundledMarket()`：把包暂存进 `<DSH_HOME>/profiles/web/node_modules`（`dshmarket` 每次覆盖——壳拥有这份拷贝；依赖包只在**缺失或主版本不一致**时填充，绝不覆盖 profile 里兼容的拷贝——pnpm 可能管理着那棵 node_modules），然后在生成的 patch 里追加 `- insert: { id: dsh-market, name: 'dshmarket', config: { allowRestart: false } }`。
- **从 asar 复制必须用 asar 安全原语（大坑，v1.3.0 打包后市场不加载的根因）**：`build/market-plugin/**` 经 `files` 打进 `app.asar`，打包版里 `__dirname` 就是 asar 路径。**`fs.cpSync(src, dst, {recursive:true})` 从 asar 内复制目录会抛 `ENOTDIR`/`ENOENT`**——Electron 的 asar 补丁只覆盖单文件原语（`readdirSync`/`statSync`/`copyFileSync`/`existsSync`/`readFileSync`…），`cpSync` 的递归遍历走底层 `opendir`，绕过补丁。**必须**用逐项 `readdirSync`+`statSync`+`copyFileSync` 的递归复制（`copyDirRecursive()`，全部 asar 安全原语）。诊断特征：开发机（profile 里 pnpm 真装 dshmarket → `stageBundledMarket` 检测到已装直接跳过）永远正常，打包安装的机器市场不出现、且日志只有 `prepareDesktopPlugin failed: ENOTDIR`。另注意 `stageBundledMarket` 暂存失败已被改为**非致命**（只记日志、继续挂载窗口控制条），别把它改回 throw——否则一个市场的复制错误会连带让整个 patch 不生成。
- **`allowRestart: false` 必须带**：插件自带的"重启 DSH"会直接 spawn 一个新核心进程，绕过 Electron 壳的生命周期管理——壳会把原进程退出误判成崩溃弹错误面板。壳有自己的 DSH 重启机制（`restartDSH`/更新流程）。
- **用户已自行安装时绝不重复挂载**（大坑）：Cordis 的 `- insert:` 是**无条件追加**（源码见 `dsh-app-boot` 的 `applyEntryPatches`），同 id 再插一行会把插件**挂载两次**（服务/UI 全重复）。所以挂载前先检测 profile 是否已挂载 dshmarket：`profiles/web/package.json` 的 `dsh.profile.bundles` 含 `"dshmarket"`，或 `cordis.patch.yml` 文本含 `dshmarket`——命中则**不暂存、不加行**，以用户自己的安装为准。
- **开关**：设置"内置插件市场"（`bundleMarket`，默认开，存 `update-settings.json`）关掉后不再暂存/挂载——用户在 profile 里卸载市场后靠它避免壳自动装回。改动**重启 DSH 生效**（patch 每次 spawn 才重组装）。
- profile 的 node_modules 可能被 pnpm 管理，pnpm prune 会清掉壳暂存的"外来"拷贝——无妨，下次 spawn DSH 会重新暂存（自愈）。

### 3. Electron ↔ DSH 通信（三条通道）

| 通道 | 方向 | 用途 |
|---|---|---|
| `preload` 的 `dshDesktop.*` IPC | 渲染进程(DSH 页面)→主进程 | 窗口控制、设置读写、更新、重启 |
| `dsh:update-state` 事件 | 主进程→渲染进程 | 推送版本/设置状态给插件 UI |
| **通知桥** `http://127.0.0.1:<随机端口>` | DSH Host 进程→Electron 主进程 | 任务通知（主 agent 完成 `agent/status` / `agent/error` / `approval/request` 转发） |

任务通知：插件 **Host 半部**（index.js，运行在 DSH 进程里）监听 `agent/status`(running→idle=完成，**仅主 agent**)、`agent/error`(失败)、`approval/request`(waterfall，需调 next)，POST 到主进程的本地 HTTP 桥，主进程弹 `Notification`。
**subagent 完成不通知**（频繁完成，逐个弹窗是噪音）——subagent 的 session header 带
`parentSession`/`origin:'subagent'`/`delegationDepth≥1`，据此过滤；只有**主 agent** 完成、失败、需要确认才弹。

**通知桥安全（重要）**：
- **焦点抑制**：桌面窗口**有焦点且可见时不弹通知**（用户正在看 DSH，任务状态已内联显示；弹原生通知只是噪音），只在后台/最小化/藏托盘时才通知。判断：`mainWindow.isVisible() && isFocused() && !isMinimized()`。
- 桥只绑定 `127.0.0.1`（不暴露局域网），且**端口是每次启动随机**（`40000–50000`，`generateNotifyCredentials()`），避免固定端口被本地进程抢占。
- 带**每次启动随机的 bearer token**（`crypto.randomBytes(24)`），通过 `DSH_DESKTOP_NOTIFY_PORT`/`DSH_DESKTOP_NOTIFY_TOKEN` 环境变量只传给被 spawn 的 DSH 进程，插件 POST 时带 `x-dsh-notify-token` 头；桥校验不符直接 401。
- 带**外部 Web Origin 的请求直接 403**（浏览器页面拿不到 token 也到不了这层；配合 Chrome/Firefox 的 Private Network Access 双重防护）；只收 POST（其余 405）；body 上限 4KB，超限断开。
- 因此网页/无关本地进程无法伪造或刷屏通知。真机上可用 `curl -X POST -H "x-dsh-notify-token: <token>" -d '{"kind":"done"}' http://127.0.0.1:<port>/` 手工验证（token 在 DSH 子进程环境里，app 本身不落盘）。

### 4. 窗口控制条（沉浸式，不重叠）

- frameless 窗口；控制条用 `shell.overlay` Slot，是一条 **36px 顶部条**，**起点 = 侧栏右缘**（插件/兜底都用 JS 量侧栏 `getBoundingClientRect().right` 设 `left`，侧栏收窄/折叠/窗口缩放时用 `ResizeObserver` + `resize` 同步）。**容器本身 `pointer-events:none`**——透明区绝不吞掉下方会话头部/侧栏的点击；只有按钮、胶囊和拖拽条各自恢复 `pointer-events:auto`。
- **macOS 按钮点不动（大坑）**：`-webkit-app-region: drag` 放在**父容器**上时，macOS 会把整条区域当成拖拽区，`no-drag` 子按钮偶尔收不到点击。**修复**：容器本身**不带 app-region**，改用独立的绝对定位 `.dsh-desktop-drag` 兄弟条承载 `drag`，按钮显式 `no-drag` + `pointer-events:auto`（`shell.overlay` 宿主层是 `pointer-events:none`，子级靠 `.overlayLayer>*{pointer-events:auto}` 恢复，仍要显式加固）。
- **窗口拖拽区（细条 + 运行时量高，勿改回整条 36px）**：曾经拖拽区是整条 36px 高的顶部条——它盖住会话头部（DSH 头部 `padding-top` 只有 12px），macOS 上拖拽区会整个吃掉点击，标题栏 crumbs/tabs/操作点不动。现在两条拖拽条都是**细条**，高度由 `topClearance()` **运行时测量**：该区域第一个**可见**可交互元素（`button/a/[role=button]/input…`，隐藏元素跳过）距窗口顶部的距离减 2px，兜底 12px（= 头部 padding-top）。① `.dsh-desktop-drag` 在会话/详情列上方，高度 = 会话头部（`[data-slot="conversation.session.header"]`）的空余量，clamp **6–16px**（上限故意压低：万一头部首行全是纯文本、第一个可交互元素是第二行的 tab，细条也不会探进 title row）；② `.dsh-desktop-drag-side` 用 `right:100%` 探出控制条左缘、铺满侧栏宽度，高度 = 侧栏第一个按钮（brand/toggle）上方的空余量，clamp 6–28px——**侧栏 logo 和按钮上方也能拖窗口**。**不要**给侧栏容器本身加 drag（会触发上面那条 macOS 吞点击的坑，brand/折叠按钮必须永远可点）。
- **侧栏保持通顶、不被遮挡**：控制条从侧栏右缘才开始（JS 测量），侧栏品牌/折叠按钮永远可点、侧栏背景通到窗口顶部。**不要**用"整个 AppFrame 下移"方案（`div:has(> [data-shell-overlay]){padding-top:36px}`）——那样侧栏顶部会空出 36px 页面背景的缝，很难看。
- **Session log 按钮搬进控制条**：DSH 头部原来在右上角的 "Session log" 按钮与控制条按钮相撞。**不再用任何"下移/左挤"方案**（`padding-right:150px`、整屏下移、整行/单按钮下移都已废弃——都会拉高头部或留下难看的空隙）。改为：① 在控制条里**最小化按钮左边**重做一个 `Session log` 胶囊按钮（`SessionLogButton`，`ctx.sessions.list.getSnapshot().current` 拿当前会话 id，复刻 `dsh-session-log-export` 的下载逻辑：`HEAD /api/session.export?sessionId=<id>&includeDescendants=true` 后触发浏览器下载）；② CSS `[data-dsh-desktop] [class*="sessionLogButton"]{display:none!important}` 隐藏 DSH 原按钮——**只限桌面**：`apply()` 检测到 Electron 桥（`window.dshDesktop`）时给 `<html>` 打 `data-dsh-desktop` 标记，普通浏览器不打标记、保留 DSH 原按钮（桌面壳拉起的同一个 DSH 实例被浏览器直接访问时，插件仍挂载，必须靠这个标记区分）。**会话头部完全保持原始布局**（crumbs/tabs 间距不变）。③ 按钮**只在有打开的、且已有对话内容的会话时显示**——`SessionLogButton` 订阅 `sessions.list`：`current` 有值 **且** 该会话 `summary.blank` 不为 true 才渲染（空白新会话——还没有任何对话内容——不显示，与 DSH 头部隐藏逻辑一致）；控制条用 `MutationObserver` 监听子节点变化，按钮出现/消失时重新测量拖拽区终点，避免拖拽区盖住按钮。
- **拖拽区终点 = 按钮起点**：控制条 `left` 用 JS 量侧栏右缘，拖拽区 `right` 也用 JS 量最左按钮（Session log 胶囊宽度不固定，不能写死 132px）——`window.innerWidth - firstBtnRect.left`，随窗口缩放/侧栏变化同步。
- **兜底控制条**：主进程在 DSH 页 `did-finish-load` 后延迟 1.5s/6s 用 `executeJavaScript` 检查 `.dsh-desktop-controls`；若插件没挂上（核心/插件加载失败），注入一套原生样式的 `.dsh-desktop-fallback` 按钮条（同样从侧栏右缘开始 + 拖拽条，最小化/最大化/关闭），保证 frameless 窗口永远可关。
- **窗口按钮被右侧栏插件面板遮挡（大坑，实测 mac）**：插件控制条挂载在 `shell.overlay` 槽内，而 `[data-shell-overlay]` 宿主在 DSH 自己的叠层上下文里——右侧栏插件展开的面板一旦高于这个上下文，就把三个金刚按钮 + Session log 按钮盖住。修复：`WindowControls` 用 **`ReactDOM.createPortal(..., document.body)`** 渲染控制条（loader 的 staticModules 明确暴露 `react-dom`/`react-dom/client`，可直接 require），DOM 落在 body 层、`position:fixed` + 最大 z-index 赢过一切页面层，与 main.js 兜底条同层。**千万别手动 `appendChild` 把 React 管理的节点挪到 body**——那是偷走 React 的 DOM，槽位宿主下次渲染调和直接抛 `NotFoundError`，按钮全部失效（实测教训）；portal 才是官方逃生口（组件仍在槽的 React 树里、props/生命周期不变，只有 DOM 出口换了）。
- **原生逃生通道**：菜单加 `CmdOrCtrl+M`（最小化）/ `CmdOrCtrl+W`（关闭窗口）；macOS 上 Cmd+Q 走系统 appMenu。即使页面 DOM 按钮全部失效也能关窗/退出。
- **macOS 复制/粘贴/全选失效（大坑）**：frameless Electron 应用没有「编辑」菜单时，macOS 不把 Cmd+C/V/X/A 路由到页面。**修复**：`buildMenu()` 里加标准角色子菜单（`undo/redo/cut/copy/paste/selectAll`），Windows/Linux 也一并获得对应快捷键。

### 5. 托盘（`Tray`）+ 常驻通知栏

- 设置"常驻通知栏"开启后，关窗 `event.preventDefault()` + `mainWindow.hide()` 到托盘；托盘右键菜单"打开/退出"。
- **托盘图标在开启设置的当下就创建**（`whenReady` 时 `readSettings().closeToTray && ensureTray()`；开关 IPC 里 `setCloseToTray` 即时 `ensureTray()/destroyTray()`）——**不能只在用户点关闭时才建托盘**，否则用户不开窗就永远看不到图标、也没法恢复窗口。
- 托盘图标：Windows/Linux 用 `build/tray-icon.png`（DeepSeek 蓝圆角 + 白鲸鱼，带边距）；**macOS 必须用小尺寸「模板」图**（菜单栏图标，黑 + 透明），用 `build/tray-iconTemplate.png`(**22×16pt**) + `tray-iconTemplate@2x.png`(44×32px)，`setTemplateImage(true)` 让系统按明/暗菜单栏着色——原 64px 彩色图在 Mac 菜单栏会显示得过大。**模板图是宽画布、鲸鱼按高度适配（87.5%）**：鲸鱼本身宽高比 ≈1.36:1，曾经在 16×16 方画布上按宽度 80% 适配，可见高度只有画布的 59%（垂直边距 ~40%），菜单栏里看着比别的图标小一半；宽画布（如电池图标）+ 按高度适配后可见高度 14pt，与标准菜单栏图标一致。Linux 无托盘环境 `new Tray` 失败会优雅降级（关窗直接退出）。
- 真正退出（菜单退出、更新重启、app.quit）必须先 `isQuitting = true`，否则 close 拦截会把窗口藏进托盘。
- macOS `activate`（点 Dock 图标）改为：窗口存在（哪怕藏在托盘）就 `show()+focus()`，否则重建——否则 Dock 点了没反应。

### 6. 阻止休眠 / 任务通知

- 阻止休眠：`powerSaveBlocker.start("prevent-app-suspension")`，返回 id，`powerSaveBlocker.stop(id)` 释放；设置持久化在 `update-settings.json`。
- 设置项：`autoUpdate` / `closeToTray` / `preventSleep` / `taskNotify` / `bundleMarket` / `port`，都存在 `%APPDATA%\...\update-settings.json`。

### 7. 图标

- 源 = `build/whale.svg`（DeepSeek 鲸鱼，从 `@deepseek-ai/dsh-client-ui-primitives` 的 `FishLogo` 提取的 path）。
- `npm run icon` 用 `@resvg/resvg-js`（纯 Node SVG 光栅化）生成 64/256/512 PNG，外加 macOS 托盘模板图 `tray-iconTemplate.png`(22×16pt)/`tray-iconTemplate@2x.png`(44×32px，黑色鲸鱼+透明，宽画布按高度适配)。**不要用 Electron 离屏渲染**（本机 >128px 就崩）。
- electron-builder 的 `win.icon`/`mac.icon`/`linux.icon` 打包时自动转换 .ico/.icns。
- Windows 任务栏图标跟随 **exe 资源图标**（开发 `npm start` 显示 electron 默认图标，打包后才是鲸鱼——Electron 固有限制）。

### 8. 启动页 = 错误面板 + 进度（splash.html / `showStartupError` / `trackInstallProgress`）

- **splash 的 CSP 必须有 `script-src 'unsafe-inline'`**（内联脚本），否则标题条按钮监听不注册、进度/日志全不更新——这是"按钮没反应"最常见原因。
- 所有启动/崩溃/安装失败都走 splash 错误面板（`dsh:startupError` + `dsh:startupChoice`），**绝不弹原生模态框/系统崩溃弹窗**：面板渲染动态操作按钮（重试 / 换端口并重试 / 退出 / 安装失败时 重试·换镜像·用当前版本继续·退出），并可**一键「复制错误信息」**（`dsh:copyText` → 主进程 `clipboard`；内容=消息+详情+最近日志）。
- **主进程崩溃可视化**：`process.on("uncaughtException")` + `process.on("unhandledRejection")` 兜底——任何未捕获 JS 错误/未处理 Promise 都转成页面错误面板，而不是 Windows "has stopped working" 系统弹窗（那种弹窗用户没法复制错误）。换端口写入 `update-settings.json` 的 `port`，`effectivePort()` 优先环境变量再读它。
- **端口占用预检**：spawn 前 `isPortFree(effectivePort())`，被占就直接弹"端口已被占用"面板（而不是等 DSH 报错退出）；退出日志含 `EADDRINUSE` 也走换端口面板。
- **安装进度**：`trackInstallProgress()` 每 2s 经共享的**异步**测量器（`createSizeMeter`，进度条与看门狗共用，互不叠加遍历）测 `pnpm-store + dshDir()` 增长，按 `INSTALL_ESTIMATE_MB`（默认 250，可 `DSH_DESKTOP_INSTALL_ESTIMATE_MB` 覆盖）算百分比推到 splash 进度条（`dsh:progress`）。**不要改回同步 `dirSizeSync` 轮询**——3.3 万文件的树单次同步遍历 ~615ms，每 1.5s 一次曾把主进程约 40% 时间烧在重复 stat 上并和安装器抢磁盘 I/O；pnpm 的下载先落 store 再硬链进安装目录，所以两个目录都要测。
- `did-fail-load`（非 file:、非 ERR_ABORTED）/ `render-process-gone` → 回退 splash 错误面板，绝不留"关不掉的死窗"。
- **安装失败**（`installWithRetry`）同样用页面面板 + `pendingInstallCb`（重试/换镜像/用当前版本继续/退出），**不再用 `dialog.showMessageBoxSync`**——统一可复制的错误出口。更新时 `isUpdating` 标志让 DSH 被故意停掉时不误报"进程已退出"。
- **下载黑洞节点（大坑，实测）**：镜像 CDN 的某个节点可能 **TCP 握手成功但永不传数据**（如广州移动 AS9808 节点），安装器挂着多条 Established 连接、CPU 狂转、字节却零流动——表现就是"点更新一直没下载、任务管理器没流量"。**四道防线**：① `childEnv` 设 `npm_config_fetch_timeout=120000` + `fetch_retries=3`（pnpm 同样读 `npm_config_*` 环境变量），2 分钟无数据快速失败并重试（可能换到别的节点）——**别改回 30s**：慢速但正常的网络下 30s 会掐断未回完的请求触发重试风暴，让"分析依赖"比终端 npm 慢好几倍；② 安装输出必须逐行可见（pnpm 走 `--reporter=append-only` 的 Progress 行；npm 回退走 `--loglevel=info`），用户能在日志看到活动、看门狗能识别"有进展"；③ `installDSH` 下载看门狗：**只在磁盘开始写入（`downloadStarted`）后才生效**——pnpm store + dshDir 无增长**且**安装器无输出持续 `INSTALL_STALL_MS`（默认 120s，可 `DSH_DESKTOP_INSTALL_STALL_SECONDS` 覆盖）就 taskkill 整棵安装器进程树并弹"下载无进展，请重试或换镜像"。**依赖解析阶段不打印日志也不写盘，看门狗绝不能杀它**（macOS GUI 启动无 shell 环境变量，该覆盖项在 mac 上设不了，默认必须安全）；④ 更新前也 `probeFastestRegistry` 探测镜像（原来只有首次安装探测）。

### 9. 更新安全（先停 DSH 再装，防崩溃）

- **更新会崩的根因**：安装器直接覆盖**正在运行**的 DSH 目录（`<userData>/dsh/node_modules/@deepseek-ai/dsh`）。Windows 下运行中进程文件被替换 → EPERM/EBUSY，安装报错且 DSH 进程被删文件而崩。
- **修复**：`updateDSH()` 先 `killDSH()` 停掉核心 → 回 splash → 安装（带进度条）→ `restartDSH()` 起新版本。失败时 `resolveDSHBin()` 回退旧版本/缓存，不会留死状态。**更新只重启核心，不需要重启整个 Electron 壳**。
- 安装失败操作（重试 / 换镜像重试 / **用当前版本继续**（有旧版时）/ 退出）都在页面错误面板里，`pendingInstallCb` 保存续作回调。
- 若更新过程仍异常，`dsh:installUpdate` 有 try/catch、主进程有全局 `uncaughtException`/`unhandledRejection` 兜底，都会把错误打到页面面板（可复制）而不是系统弹窗。

### 10. 单实例（双击图标防双开）

- `requestSingleInstanceLock()` 失败时**只调 `app.quit()` 是不够的**：`app.whenReady()` 仍会在退出生效前触发，第二实例照样 `createWindow()` + `startDSH()`（于是出现第二个窗口、第二个 DSH 撞端口）。**必须用 `gotSingleInstanceLock` 标志把整个 whenReady 引导跳过**（`if (!gotSingleInstanceLock) { app.quit(); return; }`）。
- 第二实例（双击桌面图标）由第一实例的 `second-instance` 事件恢复窗口：`showMainWindow()`（藏在托盘/最小化都恢复）；若第一实例还在启动中（窗口未建），置 `pendingSecondInstanceFocus`，whenReady 建窗后补一次 `show()+focus()`。

### 11. 壳自身自更新（GitHub Releases，区别于 DSH 核心的 npm 更新）

- 壳的版本来源：`app.getVersion()`（package.json），`pushUpdateState()` 里带 `shellVersion`，桌面版设置页显示。
- 检查更新：`dsh:checkShellUpdate` → `queryShellLatest()` 查 `https://api.github.com/repos/${SHELL_REPO}/releases/latest`（默认 `MoonlitDropOfBlood/DSH-Desktop`，可 `DSH_DESKTOP_SHELL_REPO` 覆盖），`compareVersions` 比较 dotted 版本。
- 按平台选资产 `shellAssetForPlatform`：win32→`.exe`；darwin→arm64 用 `arm64.dmg`、x64 优先非 arm64 的 `.dmg`（**别用 `.find(/\.dmg$/)` 会误拿 arm64**）；linux→`.AppImage`（回退 `.deb`/`.rpm`）。
- 下载：`dsh:downloadShellUpdate` → `downloadFile()`（`https.get` + 跟随 302 重定向，GitHub 资产会跳转 `objects.githubusercontent.com`；socket 30s 无数据超时）→ 进度经 `dsh:shellDownloadProgress` 推给桌面版设置 UI → `launchShellInstaller()`：win 打开 NSIS 安装包并 2s 后退出应用（安装器要替换运行中的 exe）；mac 打开 dmg；linux chmod +x 后打开 AppImage。
- GitHub API 未认证限速 60 次/时，够用；网络不可达时优雅失败（toast 提示）。
- 发布流程：打 `v*` 标签 → GitHub Actions 构建并上传资产到 Release（见 `.github/workflows/build-installers.yml`）。

## 开发 / 运行 / 验证

```bash
npm install          # 装依赖（首次）
npm run icon         # 重新生成图标（改了鲸鱼配色/边距后）
npm start            # 开发运行（frameless 窗口）
npm run fetch:market # 下载内置插件市场到 build/market-plugin/（dist:* 会自动跑）
npm run fetch:pnpm   # 下载内置 pnpm 到 build/pnpm/（dist:* 会自动跑；dev 下不跑则安装回退 npm）
npm run pack         # 打包目录到 dist/win-unpacked/（会先 fetch market + pnpm）
npm run dist:win     # NSIS 安装包
npm run dist:mac     # macOS dmg
npm run dist:linux   # Linux AppImage（会自动 fetch market + pnpm）
```

**开发运行注意**：
- 默认端口 3080。**如果浏览器里开着另一个 DSH（当前会话），必须先 `$env:DSH_DESKTOP_PORT="3100"` 隔离端口，否则新实例绑定失败**。
- 启动时只隔离端口即可（`DSH_DESKTOP_PORT`），**不要用 `DSH_DESKTOP_HOME` 隔离环境**——用户要看真实 `~/.dsh` 数据。
- 启动/清理进程时**绝对不要碰 3080 的进程**（那是当前运行环境，杀了会中断会话）。只清理桌面应用自己的进程（匹配 `dsh-desktop` / `electron.exe .` / `win-unpacked`）。

### 验证一个改动（推荐顺序）

1. `node --check` 所有改动过的 JS。
2. 改 `dsh-desktop-plugin/` 后：重启应用（`prepareDesktopPlugin` 会在启动时重新复制插件到 profile，**必须重启整个应用**才生效）。
3. 改主进程 IPC/设置后：`npm start` 重启验证。
4. 改图标后：`npm run icon`，`npm run pack`，检查 `dist/win-unpacked/*.exe` 图标（System.Drawing 提取）。

## 打包已知问题

- **winCodeSign 符号链接失败**：Windows 未开开发者模式时，7z 解压 winCodeSign 无法创建 symlink（`Cannot create symbolic link`）。解决：开 Windows 开发者模式；或 `signAndEditExecutable: false` 跳过资源编辑（但 exe 会没有自定义图标），再用 `node scripts/embed-exe-icon.js <exe>` 手动嵌图标（用 winCodeSign 缓存里仍可用的 rcedit）。
- **`CSC_IDENTITY_AUTO_DISCOVERY=false`** 跳过代码签名（无签名证书时需要）。注意该开关**不影响 `CSC_LINK`**——配了 `CSC_LINK`+`CSC_KEY_PASSWORD` 仍会签名。
- **macOS 未签名导致"已损坏/无法验证"（重要）**：壳**有 arm64 版本**（release 里的 `*-arm64.dmg`），但 GitHub Actions 的 mac job 默认 `CSC_IDENTITY_AUTO_DISCOVERY=false` **不签名**。macOS（尤其 Apple Silicon）对下载的未签名 App 会报"已损坏，无法打开"（arm64 表现最明显，x64 常显示"无法验证开发者"）。三层方案：
  - **① 免费：`scripts/mac-sign.js`（afterPack 钩子）ad-hoc 自签名**——未配置证书时自动 `codesign --force --deep --sign -`，"已损坏"变成"无法验证开发者"（右键→打开可用）。已配置任意真实证书（含自签名）或已 ad-hoc 的都跳过，不会覆盖。
  - **② 免费：自制（自签名）证书**——Windows 上 `New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=DeepSeek Harness Desktop" -KeyExportPolicy Exportable`，`Export-PfxCertificate` 导出 .p12；把 base64 配 `CSC_LINK`、密码配 `CSC_KEY_PASSWORD`、证书名（CN）配 `CSC_NAME`。electron-builder 导入后用该证书签名。**注意：自签名证书只在本机/信任它的 Mac 上免提示打开，其他用户仍是"无法验证开发者"**（与 ad-hoc 等价）；`codesign` 能签，但 macOS 信任链不认自签证书。
  - **③ 彻底解决（付费 Apple Developer 账号）**：Developer ID 证书 + 公证 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`（或 `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`，注意 25.1.8 读的是 `APPLE_API_ISSUER` 不是 `APPLE_API_KEY_ISSUER`）；配齐后 electron-builder 自动签名+notarytool 公证（`hardenedRuntime` 默认已开，见 macPackager.js:328）。**签名凭据与公证凭据要配就配全套**，只配一半会构建失败。
  - 没任何证书的临时绕过（给用户）：右键→打开，或 `xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness Desktop.app"`。
- asar 内容验证：`node node_modules/@electron/asar/bin/asar.js list dist/win-unpacked/resources/app.asar`。

## 任务通知编码坑（重要）

插件 Host 半部 POST 到通知桥时，**中文 summary 会被破坏成 `??`**，如果直接用 `body: JSON.stringify(...)` 字符串发送（某些 DSH host 环境的 fetch 对 string 编码处理异常）。修复：用 `TextEncoder` 转成 **Uint8Array** 字节发送。

## 常规开发命令

```bash
node --check <file>      # 语法检查
npm start                # 运行
npm run pack             # 打包目录
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 指定端口（默认 3080） |
| `DSH_DESKTOP_HOME` | 覆盖 DSH_HOME（默认 `~/.dsh`；调试隔离用，日常勿设） |
| `DSH_DESKTOP_USER_DATA` | 覆盖整个 userData（托管安装/pnpm store/设置；与 `DSH_DESKTOP_HOME`+`DSH_DESKTOP_PORT` 组合可完整模拟新用户首启，单实例锁也随 userData 隔离） |
| `DSH_DESKTOP_NPM_REGISTRY` | npm 镜像（默认 npmmirror，国内网络需要） |
| `DSH_DESKTOP_NPM_CACHE` | npm 缓存目录 |
| `DSH_DESKTOP_SPEC` | DSH npm 规格（默认 `@deepseek-ai/dsh@latest`） |
| `DSH_DESKTOP_TIMEOUT` | 启动看门狗超时秒数（默认 1800s） |
| `DSH_DESKTOP_INSTALL_ESTIMATE_MB` | 安装进度条估算总大小（默认 250MB） |
| `DSH_DESKTOP_INSTALL_STALL_SECONDS` | 下载无进展判定秒数（默认 120s，超时 kill npm） |
| `DSH_DESKTOP_SHELL_REPO` | 壳自更新的 GitHub 仓库（默认 `MoonlitDropOfBlood/DSH-Desktop`） |
| `DSH_DESKTOP_NODE` | 用真实的 Node 二进制覆盖 DSH 运行时（默认用 Electron 内嵌 Node + `ELECTRON_RUN_AS_NODE`；调试用） |
| `DSH_DESKTOP_NPM` | 覆盖 npm 回退路径要 spawn 的 npm 可执行文件绝对路径（仅 pnpm 缺失的回退时用） |
| `DSH_DESKTOP_MARKET_VERSION` | `scripts/fetch-market-plugin.js` 下载的 dshmarket 版本（默认 1.15.0） |
| `DSH_DESKTOP_PNPM_VERSION` | `scripts/fetch-pnpm.js` 下载的内置 pnpm 版本（默认 10.33.0） |
