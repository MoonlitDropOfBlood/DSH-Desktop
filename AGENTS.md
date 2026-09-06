# AGENTS.md — 鲸港 WhaleHarbor

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其是"关键机制"和"重要注意事项"两节，记录了本项目踩过的大量坑。

> **命名说明（2026-09）**：显示品牌已更名「鲸港 WhaleHarbor」（GitHub 上 DSH-Desktop 重名过多）。**内部标识一律不变**：npm 包名 `dsh-desktop`、`DSH_DESKTOP_*` 环境变量、`dsh:*` IPC 通道、`dsh-desktop-plugin` 插件包、`package.json` 的 `productName`（决定 userData 路径与安装身份，动了会导致设置丢失/并存安装）——只有用户可见文案携带新品牌。

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
│   ├── index.js            #   Host 半部：任务事件 → notify.show；托盘状态项（tray.setMenu）；反向事件服务器
│   └── client.js           #   Client 半部：窗口控制条、侧栏更新徽章、设置页
├── scripts/
│   ├── make-tray-icon.js   # 用 @resvg/resvg-js 从 whale.svg 生成各尺寸图标
│   ├── fetch-market-plugin.js # 下载内置插件市场 dshmarket 到 build/market-plugin/
│   ├── fetch-pnpm.js       # 下载 pin 版本的 pnpm 到 build/pnpm/（DSH 核心的安装器）
│   ├── embed-exe-icon.js   # 本机无法解压 winCodeSign 时，用 rcedit 手动嵌 exe 图标
│   ├── repro-restart-race.js  # 独立实测"taskkill → 端口释放"时序（需非沙箱）
│   ├── repro-plugin-failure.js # 抓取插件故障的真实核心日志格式（需非沙箱）
│   ├── test-plugin-recovery.js # plugin-recovery.js 解析器单测 + .testdata 回归
│   ├── e2e-plugin-recovery.js  # 插件故障自动恢复全链路 e2e（需非沙箱）
│   └── check-docs-page.js      # 宣传页回归守卫：内联脚本语法解析 + 全文表情符号扫描（页面硬性要求零 emoji）
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

### 1b. DSH 运行时 = 内置独立 Node（首选）+ Electron 内嵌 Node（回退）

**为什么内置独立 Node（2026-08 恢复，曾因 Electron 内嵌够用而移除）**：DSH 核心由壳以 `windowsHide:true` spawn。Windows 控制台行为取决于被 spawn 二进制的 **PE 子系统**：
- **真实 node.exe（Console 子系统）** + `CREATE_NO_WINDOW` → 得到**无窗口控制台**，整棵进程树（沙箱 runner → 受限 PowerShell）都继承它，任何命令都不弹窗口——**且 DSH 核心代码零改动**。
- **Electron 二进制（GUI 子系统，`ELECTRON_RUN_AS_NODE` 当 node 用）** → **永远不会获得/继承控制台**（GUI 进程不参与控制台继承，实测 pids=0），于是沙箱 runner 无控制台可传，受限 PowerShell 子进程只能**自己新建可见控制台窗口**——每条命令弹窗（移除独立 node 后出现的回归，实测确认）。

因此 `scripts/fetch-node.js`（`npm run fetch:node`）把固定版本 Node LTS（`DSH_DESKTOP_NODE_VERSION` 覆盖，默认 24.19.0）下到 `build/node/<平台-架构>/node(.exe)`，经 `extraResources` 以 `<resources>/node/<平台-架构>` 随包分发（`build/node` 全量拷入）。**安装包体积代价 ~30MB（实测 106MB→128MB），换取核心零改动 + Windows 无弹窗**。`bundledNode()` 解析它；`dshRuntime()` 优先级：`DSH_DESKTOP_NODE`/`npm_node_execpath` 覆盖 → 内置 node → Electron 内嵌（回退）。内置 node 版本低于核心要求（≥22.15，`MIN_NODE_MAJOR/MIN_NODE_MINOR`）时自动回退内嵌并记日志；内嵌版本过低才弹错误面板（1.2.0 zstd 事故的护栏）。安装器（pnpm）与核心用**同一个 runtime**（`installPlan` 也走 `dshRuntime()`），且 `runInstaller`/`doSpawn` 都带 `windowsHide:true` → 安装过程同样无窗口。

- **为什么不用"给核心打补丁"修弹窗**：曾尝试壳托管补丁（启动时往 `dsh-sandbox-windows-acl`/`dsh-subprocess-local` 的 lib 注入 AllocConsole/windowsHide），但核心是 npm `@latest` 装的，补丁锚点随版本变化可能不匹配/不兼容——**已弃用**，核心保持 100% 原始（勿再往核心代码打补丁）。
- **原生模块前提**：DSH 树的原生包全是 **NAPI**（ABI 跨官方 Node/Electron 稳定），内置 node 与 Electron 内嵌都能加载 koffi/sharp/node-pty；往核心里引入 NAN 原生包会破坏此方案。
- **DSH 子进程可见的 node/npm/pnpm**：仍是**用户 PATH** 里的（终端 Profile 合并覆盖 GUI 裸环境）；内置 node 只用于跑核心/安装器，不会注入 PATH。一台完全没装 Node 的机器能跑 DSH 但跑不了 npx 系 MCP 服务。
- 开发时（`npm start`）：`bundledNode()` 回退到 `build/node/<平台-架构>`（dev 路径），与打包版 `process.resourcesPath/node` 一致；没跑 `fetch:node` 则用 Electron 内嵌。
- **spawn 参数固定带 `--expose-internals`（node 选项，非核心参数）**：核心 rc.7+ 的启动器在组合里没有 hmr 服务时会**无条件创建** `cordis-plugin-hmr`（用于监听 `cordis.patch.yml` 热重载），而 `Hmr` 构造函数硬性要求进程以 `node --expose-internals` 启动（`ctx.loader.internal` 只在该 flag 下存在）——没有它核心会启动后片刻崩死（rc.7 与 0.1.1-rc.2 全新 home 均实测复现，CLI 裸跑 `dsh web` 同样会炸，属核心侧问题）。该 flag 放在 `bin.js` **之前**、由 node 自己消费，永远到不了核心的 commander，**对新老核心都安全、无需版本门禁**（实测两版均完整启动 + HTTP 200）。

- **核心 >= 0.1.2-rc.1 打印的 URL 带认证 token，URL 提取必须保留完整行（大坑，勿截断）**：0.1.2-rc.1 起 `dsh web` 的启动链接是 `http://127.0.0.1:3080/?token=…`（query 带一次性认证 token；页面根路径交换 token 写 cookie 后跳回干净的 `/`，官方文档原话）。壳的 `handleLine` 曾用 `line.match(/(https?:\/\/127\.0\.0\.1:\d+)/)` 只截取到端口——token 直接丢掉，窗口加载无 token 的裸地址 → 页面一直卡在未认证的启动界面（"启动 web 丢失 token 卡住"的根因）。**修复**：URL 提取抽成纯函数模块 `url-extract.js`（`extractDshUrl`），匹配 `https?://127.0.0.1:\d+` 后继续吃 `[/?#]` 起的 query/fragment（`[^\s"'<>]*`，行尾标点修剪，剥 ANSI），返回**完整 URL** 交给 `waitForServerThenOpen` → `loadURL`；老核心的裸 URL 行同样兼容。**以后加正则相关改动时，先跑 `node scripts/test-url-extract.js`，绝不要把提取逻辑改回"只到端口"**。`dshUrl` 的所有消费点（布尔判断、`http.get` 探测、`loadURL`、菜单"在浏览器中打开"的 `openExternal`）都兼容带 query 的完整 URL；exit 处理器收养探测用的裸 `http://127.0.0.1:${port}` 是探活用途、不需要 token，保持不变。

### 1c. 继承终端 Profile（MCP 修复，设置"继承终端 Profile"默认开）

**问题**：从 Finder/Dock 启动的 mac app 没有用户 shell 的环境变量，DSH 继承的就是这个"裸"环境，DSH 拉起的 **MCP 服务**（npx/uvx/python 等子进程）找不到可执行文件，起不来。

**机制（保证在 MCP 之前）**：桌面壳在主进程 **spawn DSH 之前**用 `execFileSync` 跑用户的登录+交互 shell（`<shell> -l -i -c env`，依次回退 `-l`、`-i`，8s 超时，`PS1=''` + 过滤 `KEY=VALUE` 行），把导出的环境变量解析出来，合并进 `childEnv()`。**合并语义 = 用户环境优先**：`childEnv()` 基底就是应用自身的 `process.env`（终端启动、`launchctl setenv`、LaunchAgent 注入的变量全都在，直接透传给 DSH/MCP）；Profile 只**补缺**（应用已有的 key 不被覆盖，避免 `.zshrc` 覆盖你在启动前 export 的值）；PATH 特殊处理——Profile 的 PATH **前置**（裸环境下 MCP 必须要用户 PATH）。DSH 是 MCP 的父进程 → MCP 一定在出生时就有终端环境。Windows 跳过（注册表环境已够用）。开关存 `update-settings.json` 的 `inheritTerminalProfile`（默认 true），桌面版设置页可关；`_terminalEnv` 缓存，切开关后置空、下次 DSH 重启生效（`restartDSH`/更新时）。

### 2. 客户端插件挂载（`prepareDesktopPlugin` + `--patch`）

窗口控制条、设置页、更新徽章都是 DSH 客户端插件，通过 composition patch 挂载：
- 插件包复制到 `<DSH_HOME>/profiles/web/node_modules/dsh-desktop-plugin`（`client-modules` 的 baseUrl 是 profile 目录，`require.resolve("dsh-desktop-plugin/package.json")` 从那里解析）。
- `plugins.patch.yml` / 生成的 `desktop-plugin.patch.yml` 用 **`- insert:`** 语法新增行（普通 `- id:` 是覆盖已有行，新 id 会报 "entry not found"）。**`insert` 的值是列表**（`- insert:` 下一行 `- id: ...` 缩进成数组项）——写成单个映射（`insert:` 直接挂 `id:`）会让核心启动即 exit 1（2026-09 手写 profile `cordis.patch.yml` 实测踩中）。
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

**设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcons(SETTINGS_NAV_ENTRIES)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-desktop-core-settings-nav` / `data-dsh-desktop-shell-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 cpu（核心）/ monitor（桌面版）Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。

### 2b. 内置插件市场（dshmarket，`prepareBundledMarket`）

壳自带 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场（pin 版本，`DSH_DESKTOP_MARKET_VERSION` 覆盖），开箱即用、目标机器零下载：

- **构建期**：`scripts/fetch-market-plugin.js`（`npm run fetch:market`，已接入所有 `dist:*` 脚本和 CI 各 job）用 `npm install --prefix build/market-plugin --no-save --omit=dev dshmarket@<pin>` 拉取插件及其运行时闭包；幂等（版本一致跳过，不一致清空重装）。`build/market-plugin/` 已 gitignore，经 `files: ["build/market-plugin/**"]` 打进 asar。
- **只暂存 4 个包**：`dshmarket` + `js-yaml` + `undici` + `argparse`。dshmarket 的 `@deepseek-ai/*` 导入（`dsh-settings`、`schemastery`，以及 client 的 inject 包）**由 DSH 加载器对核心安装目录解析**，profile 安装版也不带这些包进 profile（已用真实 pnpm profile 的 lockfile 验证：它的依赖只有 js-yaml/undici/argparse）——**不要**把 `@deepseek-ai/*` 拷进 profile（会出现核心包第二实例）。
- **运行时**：`prepareDesktopPlugin()`（每次 spawn DSH 前）先 `prepareBundledMarket()`，返回三态：① `"staged"`——把包暂存进 `<DSH_HOME>/profiles/web/node_modules`（`dshmarket` 每次覆盖——壳拥有这份拷贝；依赖包只在**缺失或主版本不一致**时填充，绝不覆盖 profile 里兼容的拷贝——pnpm 可能管理着那棵 node_modules），然后在生成的 patch 里追加 `- insert: { id: dsh-market, name: 'dshmarket', config: { allowRestart: false } }`；② `"user"`——profile 自己挂载了 dshmarket（见下"用户已自行安装"条），**不暂存**，改为追加一条普通 `- id:` **覆盖行**强制 `allowRestart: false`；③ `null`——开关关闭或 bundle 缺失，不加行。
- **从 asar 复制必须用 asar 安全原语（大坑，v1.3.0 打包后市场不加载的根因）**：`build/market-plugin/**` 经 `files` 打进 `app.asar`，打包版里 `__dirname` 就是 asar 路径。**`fs.cpSync(src, dst, {recursive:true})` 从 asar 内复制目录会抛 `ENOTDIR`/`ENOENT`**——Electron 的 asar 补丁只覆盖单文件原语（`readdirSync`/`statSync`/`copyFileSync`/`existsSync`/`readFileSync`…），`cpSync` 的递归遍历走底层 `opendir`，绕过补丁。**必须**用逐项 `readdirSync`+`statSync`+`copyFileSync` 的递归复制（`copyDirRecursive()`，全部 asar 安全原语）。诊断特征：开发机（profile 里 pnpm 真装 dshmarket → `prepareBundledMarket` 检测到用户自装、返回 `"user"` 直接跳过暂存）永远正常，打包安装的机器市场不出现、且日志只有 `prepareDesktopPlugin failed: ENOTDIR`。另注意 `prepareBundledMarket` 暂存失败已被改为**非致命**（只记日志、继续挂载窗口控制条），别把它改回 throw——否则一个市场的复制错误会连带让整个 patch 不生成。
- **`allowRestart: false` 必须带，对用户自装的市场也不例外（实测大坑）**：插件自带的"重启 DSH"会 spawn 一个 detached helper，先 SIGTERM 当前核心、等端口释放后重放原启动命令拉起替身核心——全程绕过 Electron 壳的生命周期管理：壳把原进程退出误判成崩溃弹错误面板，替身抢占原端口后壳的任何重试都撞"端口已被占用"死锁，且替身是孤儿进程、壳退出后仍残留。因此：壳暂存挂载时用 `- insert:` 行带 `config.allowRestart: false`；**用户自装时**用普通 `- id: dsh-market` 覆盖行（带 `name: 'dshmarket'` 守卫）强制同值——覆盖是**整对象替换**该行 `config`（`applyEntryPatches` 逐 key 赋值、无深合并），dshmarket 自带挂载行本无 config，其余配置键（`profile`/`maxSnapshots`）都有 argv/默认值兜底，安全。市场设置页里有 `allowRestart` 开关可被用户显式重新打开（其值经 `installSettingsSection` 的 `onChange` 直接写回运行时配置）——那是用户知情选择，由下一条的收养机制兜底。壳有自己的 DSH 重启机制（`restartDSH`/更新流程/菜单 CmdOrCtrl+Alt+R）。
- **纵深防御：收养外部重启的核心（exit 处理器）**：`dshProc` 意外退出**且此前已成功启动**时，不立即弹崩溃面板，先探测原端口 `ADOPT_RESTART_GRACE_MS`（12s）——若替身核心起来了则**收养**：`listenerPid()` 记录监听 PID（Windows 解析 `netstat -ano` / POSIX `lsof`），`dshUrl` 指回原地址、窗口直接 reload。收养后 `killDSH()` 经 `killAdoptedDSH()` 清理：**带守卫**——仅当记录的 PID 仍是该端口监听者时才 `taskkill /T /F`（防 PID 复用误杀无关进程），壳的重启/更新/退出路径因此对替身同样有效。已知限制：被收养进程没有 exit 事件监听，它之后再死掉靠 `did-fail-load` 兜底回错误面板；探测 12s 超时（替身没起来=真崩溃）按原逻辑弹崩溃面板，行为不回归。
- **收养探测必须做代际校验（v1.4.5 大坑，勿改回）**：收养探测是 12s 的**长延迟决策**，而它的存活窗口内用户很可能按 Ctrl+Alt+R 手动重启——重启拉起的新核心一绑上端口就会被旧探测误认成"外部替身"收养（`adoptedPid` 记成壳自己的亲儿子 + 双重 `openDSH` 抢跑闪烁），绑端口晚于探测截止则反过来在正常重启中途弹"进程已退出"崩溃面板——这就是 v1.4.4 后"手动 Ctrl+Alt+R 刷新不稳定"的根因。规则：**每次 `doSpawn` 递增 `spawnSerial`（核心代际号），exit 处理器里的 `report()` 与收养探测回调都是延迟决策，行动前必须校验自己仍代表当前代际**（`quitRequested || restartRequested || serial !== spawnSerial || dshProc` 任一命中即静默放弃）；`probeServerUp` 轮询中发现重启接管（`restartRequested`）也提前退出。配套地，**`restartRequested` 从 `restartDSH()` 入口一直保持到 `doSpawn()` 真正拿到新 child 才清除**（勿改回在 `killDSH` 回调里清——被杀核心的 exit 事件可能晚于该回调到达，守卫全 false 时误弹"启动失败"；且异步 spawn 链期间标志提前复位会让连按两次快捷键并发起两条链、两个核心抢端口，输家 EADDRINUSE 又喂给收养探测）。链上所有中止路径（runtime 过旧、端口预检失败、spawn error、找不到安装）与成功路径都必须释放标志，保证错误面板的「重试」永不悬挂；`restartDSH` 另带 `isUpdating` 守卫（更新流程结尾有自己的 restartDSH，别被手动重启打断）。
- **被杀核心的 exit 事件晚于新核心的 `doSpawn` 到达是常态而非例外（e2e 实测 8/8 全中）**：重启链里 `loadFile`(splash) + `resolveDSHBin`/`prepareDesktopPlugin` 的同步 IO 拥堵主事件循环，libuv 的 child-wait 回调排队，旧核心的 `exit` 平均晚几十~几百 ms 送达（极端环境可任意延迟，独立复现脚本里 stdio:'ignore' 时 30s 内都没送达）。因此 **exit 处理器里的任何状态变更都必须先过身份/代际守卫**：`if (dshProc === child) dshProc = null`（否则把新核心的簿记清掉——新核心变孤儿，下一次重启无子可杀、端口被它一直占着，"端口已被占用"必现且之后的重启全挂——v1.4.5 后"偶发端口被占用"的残留根因）、`if (serial !== spawnSerial) return` 之后才允许 `clearWatchdog()`（否则缴掉新核心的启动看门狗）。
- **taskkill 可能静默失败，必须有兜底**：`killDSH` 检查 taskkill 退出码（"not found"/"access denied" 时 `close` 照常触发），非零记日志并回退 `child.kill("SIGKILL")` 直杀；重启链端口等待（`PORT_RELEASE_WAIT_MS`）期间，若 `listenerPid()` 发现占用者仍是**刚被杀的那个 pid**（`lastKilledPid`——壳持有其子进程句柄、pid 不会被复用，无误杀风险），每 2.5s 重新 taskkill 一次自愈。POSIX 侧不再盲等 2s：200ms 轮询进程组存活（`-pid` 信号 0），死了立刻继续，2s 未死升级 SIGKILL。
- **主进程日志持久化**：`log()` 同时写 `<userData>/dsh-desktop-main.log`（启动时 >1MB 轮转为 `.old`）——打包版没有控制台，没有它任何重启 flake 事后零证据。"端口已被占用"面板附带占用进程 PID（`listenerPid()`）。
- **重启链路 e2e 回归钩子**：`DSH_DESKTOP_E2E_RESTARTS="N[,ms]"`（env）让应用在每次 `openDSH` 后自动跑 N 次真实 `restartDSH()`（生产绝不设置；配合 `DSH_DESKTOP_USER_DATA`/`DSH_DESKTOP_HOME`/`DSH_DESKTOP_PORT` 全隔离）。`scripts/repro-restart-race.js` 独立实测"taskkill → 端口释放"时序（空闲核心实测 ~370ms；注意沙箱内 taskkill 会被 ACL 拒绝，需非沙箱运行）。
- **插件故障自动恢复（`plugin-recovery.js` + exit 处理器接线，"DSH 被玩坏"时的自愈）**：核心**启动期**被插件加载失败杀死时，壳解析日志找出罪魁插件、自动卸载、重启，成功后弹蓝色信息面板列出被卸载的插件。要点（全部有实测依据，勿凭猜改动）：
  - **故障日志格式（core 0.1.1-rc.2 实测，`scripts/repro-plugin-failure.js` 抓取，全量样本在 `scripts/.testdata/`）**：模块语法错/apply 抛错/多插件同时挂，统一形如 `failed to import|apply loader entry <name> (<spec>): <err>`（[cause] 链会嵌套重复同一条目，需去重；链首固定是根包装条目 `include (cordis:include)`，**必须排除**）；bundle 缺失/清单非法形如 `cannot resolve profile bundle "X"` / `profile bundle "X" declares no dsh.bundle`。这些故障全部**快速 exit 1**（不挂死）；另有源码级兜底模式 `plugin(s) failed to load: a, b` 与 `N entries did not activate\n<name>: <stack>`（条目行零缩进、stack 续行有缩进）。
  - **证据窗口两条铁律**：① 只解析**本代核心自己的输出**——`doSpawn` 记 `child.logStart = logTail.length`，exit 时从该处切片（上一轮的失败日志还在 logTail 里，绝不能让它们误判后续无关退出）；② 只取**末尾 80 行**——运行期 HMR 热重载用户补丁失败的措辞与启动失败**完全相同**，但之后会有大量正常日志，限尾窗可排除。
  - **罪魁 → bundle 映射**：条目名 == 包名或为 `<pkg>/` 前缀直接命中 `dsh.profile.bundles`；否则读各 bundle 的 `dsh.bundle.patch` 文件里的 `name:` 挂载名做归因。**`@deepseek-ai/*` 系统插件只报告、绝不自动卸载**（修它们靠核心更新，profile 编辑修不了）。
  - **卸载 = 同时从 `dsh.profile.bundles` 和 `dependencies` 移除**（只删 bundles 会被下次 `dsh plugin` 安装时的 reconcile 按已装包重新挂载）；node_modules 里的文件留着不管（pnpm 可自行 prune）。原子写（tmp+rename）。
  - **两个特例**：罪魁是 `dshmarket` → 除卸载外必须 `bundleMarket:false`，否则壳下次 spawn 会把内置市场重新暂存挂载、等于没卸；罪魁是壳自己的 `dsh-desktop-plugin` → 该代生成的 patch 不带它的挂载行（窗口控制由 main.js 的兜底控制条接管），patch 无任何行时干脆不传 `--patch`。
  - **预算**：每壳会话最多 `PLUGIN_RECOVERY_MAX`（4）次自动恢复；系统插件/无法归因/超预算/证据为空都落回原来的错误面板（日志尾部照常展示）。
  - **成功后的提示**：`openDSH` 拦截——`removed.length > notifiedCount` 时先弹 splash 面板（`tone:"info"` 蓝色样式 + 「进入 DeepSeek Harness」按钮，`startupChoice` 的 `continue` 动作放行 stash 的 URL），每批卸载只提示一次。
  - **测试**：`scripts/test-plugin-recovery.js`（内嵌真实日志摘录的单测 + 对 `.testdata/` 全量样本的回归）；`scripts/e2e-plugin-recovery.js` 全链路 e2e（隔离环境预置两个坏插件 → 自动卸载 → 重启成功 → 面板日志标记）。
- **用户已自行安装时绝不重复挂载**（大坑）：Cordis 的 `- insert:` 是**无条件追加**（源码见 `dsh-app-boot` 的 `applyEntryPatches`），同 id 再插一行会把插件**挂载两次**（服务/UI 全重复）。所以挂载前先检测 profile 是否已挂载 dshmarket：`profiles/web/package.json` 的 `dsh.profile.bundles` 含 `"dshmarket"`，或 `cordis.patch.yml` 文本含 `dshmarket`——命中则**不暂存、不 insert**，只追加上一条所述的 `allowRestart: false` 覆盖行（普通 `- id:` 行作用于已有条目，不会新增；用户手写行若换了 id，覆盖行找不到目标、loader 只警告跳过，无害）。此检测**先于** `bundleMarket` 开关——开关只管壳暂存的拷贝，生命周期保护不因开关关闭而缺席。
- **开关**：设置"内置插件市场"（`bundleMarket`，默认开，存 `update-settings.json`）关掉后不再暂存/挂载——用户在 profile 里卸载市场后靠它避免壳自动装回。改动**重启 DSH 生效**（patch 每次 spawn 才重组装）。
- **核心 ≥0.1.2 会自动挂载 profile node_modules 里的包（大坑，2026-09-04 e2e 实测）**：壳暂存的 dshmarket 拷贝会被新核心自己mount成 loader 条目，此时 patch 里的 `- insert:` 行就成了第二条 → `duplicate loader entry id: dsh-market` 启动崩。所以 `prepareBundledMarket()` 在 `coreAutoMountsProfilePackages()`（装到的核心 ≥0.1.2）时返回 `"staged-auto"`，`prepareDesktopPlugin()` 照 `"user"` 模式发**覆盖行**（`- id:` 找到核心自动建的条目改 config，正好把 `allowRestart: false` 附上）；0.1.1.x 不自动挂载，维持 `- insert:`。**别把这个版本门禁合并成无条件覆盖行**——0.1.1.x 上自动挂载不存在，覆盖行找不到目标只会静默跳过，市场就消失了。
- profile 的 node_modules 可能被 pnpm 管理，pnpm prune 会清掉壳暂存的"外来"拷贝——无妨，下次 spawn DSH 会重新暂存（自愈）。

### 3. Electron ↔ DSH 通信（三条通道）

| 通道 | 方向 | 用途 |
|---|---|---|
| `preload` 的 `dshDesktop.*` IPC | 渲染进程(DSH 页面)→主进程 | 窗口控制、设置读写、更新、重启 |
| `dsh:update-state` 事件 | 主进程→渲染进程 | 推送版本/设置状态给插件 UI |
| **RPC 桥** `http://127.0.0.1:<随机端口>` | DSH Host 进程→Electron 主进程 | **插件 RPC 扩展面（一期）**：`bridge.register` / `notify.show`（任务通知）/ `tray.setMenu`（托盘菜单贡献） |
| **反向事件通道** `http://127.0.0.1:<插件eventPort>` | Electron 主进程→DSH Host 进程 | 壳→插件事件回投（托盘菜单点击 `tray.click`）；插件在 DSH 进程内自起 Tiny HTTP server 并经 `bridge.register` 上报端口 |

任务通知：插件 **Host 半部**（index.js，运行在 DSH 进程里）监听 `agent/status`(running→idle=完成)、`agent/error`(失败)、`approval/request`(waterfall，需调 next)，经 `notify.show` RPC 发到主进程，主进程弹 `Notification`。
**只有主会话（主 agent）才能通知**——三个事件通道全部经 `isSubagent()` 过滤：subagent 的 session header 带
`parentSession`/`origin:'subagent'`/`delegationDepth≥1`（核心 `dsh-subagent` 创建子会话时写入），据此过滤；subagent 频繁完成、错误由父 agent 收容、审批被宿主自动拒绝，逐个弹窗全是噪音。三个事件都是 scope 路由事件、必然携带主体 agent（`agent/status`/`agent/error` 在 payload 上，`approval/request` 在 `req.agent` 上），过滤可靠。只有**主 agent** 完成、失败、需要确认才弹。

**RPC 桥协议（一期扩展点，2026-09 落地）**：
- 请求体 `{ method, params }` → 响应 `{ ok: true, ... }` / `{ ok: false, error }`（400）。**旧形态 `{ kind, summary }`（无 method）仍路由到 `notify.show`**，旧版插件拷贝对新壳继续可用（反向：新插件对旧壳通知会静默丢失——壳与插件同包发布、`prepareDesktopPlugin` 每次 spawn 重拷，偏斜只是瞬态）。
- `bridge.register { plugin, eventPort }`：先注册才能 `tray.setMenu`（点击事件要回投到 eventPort）。插件名只是**组织键**（整个 DSH 进程共享同一 token，不是插件间安全边界）。插件侧网络失败按 1.5s~20s 退避重试 5 次；收到 `ok:false` 则不重试（= 旧壳无 RPC 桥）。
- `notify.show { kind?, title?, body?, force? }`：通用通知。`kind=done/error/approval` 有默认标题/文案；显式 method 形态下未知 kind 兜底标题为应用名；**legacy 形态的未知 kind 仍然丢弃**（行为不回归）。`force:true` **只绕过焦点抑制**（保留给"用户显式动作的回执"，如点击托盘贡献项——托盘菜单关闭时焦点可能已回到窗口，不 bypass 会被吞）；`taskNotify` 总开关永远生效。被抑制也会写主日志（`notify suppressed (任务通知 off|window focused)`）——排查"没弹通知"先看主日志。
- `tray.setMenu { plugin, items: [{ id, label, enabled? }] }`：替换该插件的托盘菜单分区（空数组=清除）。`rebuildTrayMenu()` 组装：内置「打开」「重启核心」→ 各插件分区（按注册序，前置 separator）→ 内置「退出」。校验：id ≤64 字符、label ≤80、每插件 ≤10 项。
- `settings.get { plugin, key? }` / `settings.set { plugin, key, value }`：**插件设置 KV**（二期）。持久化在 `update-settings.json` 的 `plugins` 桶（`{ plugins: { "<plugin>": { key: scalar } } }`）；value 限 string/number/boolean（string ≤500 字符，number 须有限），`null` 删除该 key；key 格式 `PLUGIN_KEY_RE`，每插件 ≤50 key。不强制先 register（KV 只是存储）。**`writeSettings` 必须合并 raw 对象（`readRawSettings()`）而非 `readSettings()` 的定形视图**——否则任何 `dsh:set*` 写入都会擦掉整个 plugins 桶（readSettings 只认识固定字段）。
- `window.<action>`（二期）：`progress {value}`（Electron 语义：-1 清除 / 0..1 确定 / >1 不确定）、`flash {flag}`（true 时挂一次性 focus 监听自动停止，防遗忘常闪）、`badge {text}`（macOS dock / Linux launcher count，Windows 空操作）、`overlay {dataUrl, description}`（Windows 任务栏角标，base64 png/jpeg ≤32KB，空串清除）、`alwaysOnTop {flag}`、`show` / `hide`（无托盘时降级为 minimize——没有托盘图标的隐藏窗口不可达）、`minimize`。窗口已销毁时干净报错（badge 除外，它不依赖窗口）。
- **壳事件总线（二期）**：`bridge.register` 可带 `events: ["window.visibility", "core.lifecycle"]` 订阅（未知名静默丢弃，向前兼容）；壳经反向通道回投 `{ event, data }`（与 tray.click 同一信封）。渲染进程侧走 `dsh:shell-event` 通道（preload `dshDesktop.onShellEvent`）。事件源：`window.visibility`（show/hide/focus/blur/minimize/restore 的快照 `{visible, focused, minimized}`；注意 Windows 最小化时 `isVisible()=false`）、`core.lifecycle`（`starting`@doSpawn / `ready`@openDSH / `restarting`@restartDSH 入口 / `exited`@核心死透的 report()）。**顺序注意**：`starting` 在 `resetBridgeContributions()` 之后发出——重启链上旧注册已清，只有 `restarting` 能送到上一代订阅者。**渲染进程投递在页面导航期间会丢**（splash→DSH 是一次导航，期间 `webContents.send` 的事件没有接收者；重启链的 `ready` 常因此到不了刚刷新的页面）——关键状态由 Host 侧反向通道兜底，客户端插件别依赖导航窗口期的事件。
- **浮窗（`float.window.*`，桌面宠物等二级窗口；设计全文 `designs/float-window.md`）**：插件可创建小型悬浮窗（透明/无边框/置顶 `floating` 级/不进任务栏/`focusable:false` 永不抢焦点，经 `showInactive` 显示）。`create {plugin, html|url, width, height, x?, y?, transparent?=true, clickThrough?=false}`（html 内联 ≤256KB data: 加载，或 `url` 仅允许 `http://127.0.0.1:<port>/`——插件自己的本地服务器，富内容走这条自建双向通道）；`state {plugin,id,state}` 下行推 JSON ≤2.5KB、**替换最新值**语义（壳缓存、did-finish-load 补发）；`move`/`close`/`closeAll`。页面交互上行：浮窗页面 `__dshFloat.send(data)`（专用迷你 preload `float-preload.js`，**只暴露这一个对象**，绝不能给它主窗口的桥面）→ 反向通道 `float.window.input {id, data}`；崩溃/系统关闭回投 `float.window.closed {id, reason}`。**拖动零协议**：页面自己写 `-webkit-app-region: drag`。**窗口是壳的资产、随核心代际走**：`resetBridgeContributions()` 关全部浮窗（核心重启/死透不留孤儿宠物）；主窗口真关闭（非托盘路径）也必须关——否则 `window-all-closed` 因浮窗存在永不触发、应用退不出去（易踩！）。限额每插件 3 / 全局 6；用户总开关 `allowFloatWindows`（默认开，桌面版设置页即时生效：关闭时现存浮窗全部关闭）。`bridge.register` 响应带 `capabilities: ["float.window", ...]` 供插件特性探测。e2e：`node scripts/e2e-float-window.js <port> <token> <userData>`（15 项断言）。
- **客户端插件的对应 IPC**（preload `dshDesktop.*`）：`windowAction(action, params)`（与 `window.*` RPC 同一实现）、`pluginSettingsGet/Set`（同一 KV 校验）、`onShellEvent(cb)`。**插件设置 UI 的唯一扩展点是核心的 `settings.section` 槽**（`ctx.slots.register({name:"settings.section", id, order, label}, Component)`，桌面版区自身就是这么挂的），持久化用插件设置 KV（host 插件 `settings.get/set` RPC，客户端插件 `dshDesktop.pluginSettingsGet/Set`）。**刻意不做行级声明式 schema 层**——2026-09 实现过一版（全局队列注册 + toggle/select/text/password/number/custom 六种行级控件）后移除：整页 settings.section 能覆盖全部场景且少一套要维护的注册协议。
- **生命周期**：`doSpawn()` 抬代际时 `resetBridgeContributions()` 清空全部注册/贡献（新核心的插件启动后会重注册）；exit 处理器 `report()`（核心死透、无重启在途）里也清一次——托盘不残留指向死端口的菜单项。`closeToTray` 关闭时贡献照样存着，`ensureTray()` 建图标时一次装配。
- **桥始终监听**（`whenReady` 无条件 `startNotifyServer()`）——它是通用 RPC 载体，不再只是通知传输；`taskNotify` 开关只决定通知**弹不弹**（`notifyTaskEvent` 内判定），不决定桥监听与否。**勿改回"按 taskNotify 门控监听"**——那样托盘贡献等其他 RPC 在开关关闭时全灭。

**RPC 桥安全（重要）**：
- **焦点抑制**：桌面窗口**有焦点且可见时不弹通知**（用户正在看 DSH，任务状态已内联显示；弹原生通知只是噪音），只在后台/最小化/藏托盘时才通知。判断：`mainWindow.isVisible() && isFocused() && !isMinimized()`。
- 桥只绑定 `127.0.0.1`（不暴露局域网），且**端口是每次启动随机**（`40000–50000`，`generateNotifyCredentials()`），避免固定端口被本地进程抢占。
- 带**每次启动随机的 bearer token**（`crypto.randomBytes(24)`），通过 `DSH_DESKTOP_NOTIFY_PORT`/`DSH_DESKTOP_NOTIFY_TOKEN` 环境变量只传给被 spawn 的 DSH 进程，插件 POST 时带 `x-dsh-notify-token` 头；桥校验不符直接 401。**反向通道同一 token**：壳 POST 插件 eventPort 时带同一头，插件事件服务器验不符 401。
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

- 设置"常驻通知栏"开启后，关窗 `event.preventDefault()` + `mainWindow.hide()` 到托盘；托盘右键菜单"打开/重启核心/退出"。
- **托盘内置「重启核心」**：`rebuildTrayMenu()` 在「打开」之下发一条 `restartDSH()`（先 `showMainWindow()` 让用户看到 splash 进度），并带 `accelerator: CommandOrControl+Alt+R`——托盘菜单里的 accelerator 仅展示、不注册（真正的注册在 app 菜单），但 Windows 的 frameless 窗口**没有可见菜单栏**，托盘和设置页是用户发现快捷键的唯一入口。同一链路的第三个入口是设置页「核心 → 重启核心」按钮（preload `dshDesktop.restartCore` → `dsh:restartCore` IPC，返回是否真正启动）；`restartDSH()` 在 `restartRequested || isUpdating || installInProgress` 时静默 no-op（返回 false），按钮/托盘据此提示「稍后再试」。
- **托盘图标在开启设置的当下就创建**（`whenReady` 时 `readSettings().closeToTray && ensureTray()`；开关 IPC 里 `setCloseToTray` 即时 `ensureTray()/destroyTray()`）——**不能只在用户点关闭时才建托盘**，否则用户不开窗就永远看不到图标、也没法恢复窗口。
- 托盘图标：Windows/Linux 用 `build/tray-icon.png`（DeepSeek 蓝圆角 + 白鲸鱼，带边距）；**macOS 必须用小尺寸「模板」图**（菜单栏图标，黑 + 透明），用 `build/tray-iconTemplate.png`(**22×16pt**) + `tray-iconTemplate@2x.png`(44×32px)，`setTemplateImage(true)` 让系统按明/暗菜单栏着色——原 64px 彩色图在 Mac 菜单栏会显示得过大。**模板图是宽画布、鲸鱼按高度适配（87.5%）**：鲸鱼本身宽高比 ≈1.36:1，曾经在 16×16 方画布上按宽度 80% 适配，可见高度只有画布的 59%（垂直边距 ~40%），菜单栏里看着比别的图标小一半；宽画布（如电池图标）+ 按高度适配后可见高度 14pt，与标准菜单栏图标一致。Linux 无托盘环境 `new Tray` 失败会优雅降级（关窗直接退出）。
- 真正退出（菜单退出、更新重启、app.quit）必须先 `isQuitting = true`，否则 close 拦截会把窗口藏进托盘。
- macOS `activate`（点 Dock 图标）改为：窗口存在（哪怕藏在托盘）就 `show()+focus()`，否则重建——否则 Dock 点了没反应。

### 6. 阻止休眠 / 任务通知

- 阻止休眠：`powerSaveBlocker.start("prevent-app-suspension")`，返回 id，`powerSaveBlocker.stop(id)` 释放；设置持久化在 `update-settings.json`。
- 设置项：`autoUpdate` / `closeToTray` / `preventSleep` / `taskNotify` / `allowFloatWindows`（插件浮窗总开关，默认开；关闭时现存浮窗立即全部关闭）/ `bundleMarket` / `coreChannel` / `port`，都存在 `%APPDATA%\...\update-settings.json`。
- **`readSettings()` 解析前剥 UTF-8 BOM（勿删）**：手编/脚本写出的设置文件常带 BOM（如部分宿主的 `Set-Content -Encoding utf8`），裸 `JSON.parse` 遇 BOM 抛异常 → catch 回落**整份默认值**——一个 BOM 让 `port`/`coreChannel` 等所有设置瞬间静默失效（2026-09 实测踩中：托盘点击通知不弹，根因就是 BOM 让 `taskNotify` 读成默认 false）。**BOM 的第二个受害者是 profile 插件的 `package.json`**（2026-09-04 实测）：typert-loader 扫描 profile node_modules 时对每个 package.json 裸 `JSON.parse`，遇 BOM 抛 `Unexpected token '﻿'` → `plugin tree failed to load: loader fibers failed` → 核心 exit 1；plugin-recovery 把故障归因到 `[typert-loader, modules]`（= 系统包/无法归因）落回错误面板，不会误卸插件。**脚本写 UTF-8 文件一律用 BOM-free 写法**：`[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))`，写完可查首字节（`{`=123）确认。

### 6b. 核心更新渠道（设置「核心」→「更新渠道」）

- 桌面版设置页「核心」提供**更新渠道**下拉：**稳定版=latest / 体验版=next / 实验版=alpha**（npm dist-tag，设置存 `coreChannel`，默认 `latest`）。`main.js` 的 `coreChannelTag()` 把渠道映射为 tag，`coreSpec()` 返回 `@deepseek-ai/dsh@<tag>`——**安装（`installPlan`）、版本检查（`queryLatest`）、自动更新（启动时）全部走当前渠道**；`DSH_DESKTOP_SPEC` 环境变量仍优先生效（调试/CI 覆盖）。
- dist-tag 是**移动指针**：每次 `queryLatest` 实时解析对应 tag 的版本；某渠道暂时没有发布版本（如 alpha tag 尚未打）时 `queryLatest` 返回 null → 显示"已是最新版本"，不报错。切换渠道经 `dsh:setCoreChannel` IPC 持久化并**立刻重查**该渠道的 latest（`updateAvailable`/「最新」显示随之刷新）；下次更新安装也按新渠道。
- tag 语义（截至 0.1.1-rc.2 验证）：`latest` 与 `next` 都存在且都指向 0.1.1-rc.2；版本线另有 0.1.2-alpha.x / 0.1.2-rc.1 预发布，`alpha` tag 属前瞻渠道。UI 文案/下拉项在 `dsh-desktop-plugin/client.js` 的 `CORE_CHANNELS`/`CHANNEL_LABEL`，加渠道或改文案改这两处即可。

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
- 安装失败操作（重试 / 换镜像重试 / **用当前版本继续**（有旧版时）/ 退出）都在页面错误面板里，`pendingInstallCb` 保存续作回调。更新期间受管目录被 park 到 `dsh.prev`（见下），`updateParkedTree` 标志保证「用当前版本继续」按钮不消失。
- 若更新过程仍异常，`dsh:installUpdate` 有 try/catch、主进程有全局 `uncaughtException`/`unhandledRejection` 兜底，都会把错误打到页面面板（可复制）而不是系统弹窗。

#### 9b. 更新三重防线（2026-09-04 事故后加，"点了更新就打不开"绝不能再发生）

事故：0.1.1-rc.2 → 0.1.2-rc.1 更新后核心秒崩。根因是 **pnpm 在存量目录上跨版本线更新时，peer 解析复用了树上的旧实例**——旧 lockfile 把 `dsh-subagent@0.1.2-rc.1` 的 peer `@deepseek-ai/dsh-attachment: ^0.1.2-rc.1` 解析成了残存的 0.1.1-rc.2（冻在旧 lockfile 里），新代码 import 旧包没有的导出 → ESM 链接期 SyntaxError → 整批核心包加载失败。全新目录 pnpm/npm 都不复现；npm 修复了 peer 解析成本（见 9d）但 pnpm 仍是默认。三道防线（`updateDSH()` → `parkManagedDirForUpdate` → `installWithRetry` → `smokeBootDSH` → 提交/回滚）：

- **① park（回滚锚）**：安装前把现役树整体 `renameSync` 成 `dsh.prev`（同卷元数据操作，瞬间完成），新树装进全新目录——既消除"存量状态"这个事故诱因，又让回滚变成一次 rename（零网络、零重装、离线可用）。rename 失败（AV 握着句柄）就降级为原地安装并记日志。**回滚绝不能"先 rmSync 目标再 rename"**：Windows 的删除是延迟生效的（delete-pending，AV 握着 share-delete 句柄时名字滞留命名空间），rm 成功后紧跟的 rename 会连续 EPERM（e2e 实测 3/3 失败），之后 `existsSync` 又为 true，壳会把核心 spawn 到一棵已被掏空的树上。`restoreParkedManagedDir()` 必须用"换名"策略：坏树 rename 到 `dsh.broken-<ts>`、旧树 rename 进来、坏树异步删，带 3 次退避重试。
- **② 冒烟启动（`smokeBootDSH`）**：提交前用同款运行时（`--expose-internals`、launcher 参数序）在随机临时端口上无头启动新核心，HTTP <400 即通过（30s 内），提前退出/超时即失败——树内版本错位这类故障在 import 阶段几秒内就死，远比重启进坏树便宜。三个必须：**一次性 home**（`env.DSH_HOME = userData/smoke-home-<ts>`，用完即删——让新核心启动真实 profile 会把它迁移到新版本格式，回滚后旧核心读不了；事故分类里的失败在全新 profile 上照样复现，冒烟不损失覆盖面）；**剥掉 `env.DSH_DESKTOP_PORT`**（冒烟端口来自 argv，壳级 env 会把核心引去真实端口、探针却盯着 argv 端口，表现为 90s 超时——e2e 实测）；**探针必须用核心自己打印的带 token URL**（`extractDshUrl(line)`，rc.1 起裸 `GET /` 不再 <400，探裸端口会永远"未就绪"）。失败时把子进程输出尾巴写进主日志（唯一现场证据）。
- **③ 失败自动回滚**：冒烟失败 → restore（见①）→ 通知「更新已自动回滚，已恢复到 <旧版>」→ 重启旧版，用户无感继续用；无处可回滚（首次安装/park 失败）才走原错误面板。**killTree 后必须等进程死透（taskkill 完成回调 + 500ms settle）再做文件手术**，taskkill 是异步的。

#### 9c. 安装器选择（pnpm / npm 自动切换）

`installPlan()` 按目标版本线选安装器：**目标（`latestKnown`，渠道 tag 的解析结果）≥0.1.2 → npm，否则 pnpm**；`DSH_DESKTOP_INSTALLER=npm|pnpm` 强制覆盖；PATH 上没有 npm（裸机）→ 永远 pnpm。依据：0.1.2 优化了发布包的 peer dependency 图，npm arborist 从 0.1.1 时代的 >10 分钟解析爆炸（实测放弃）变成 23.7s 全新安装（实测 2026-09-04，npm 11.17 + npmmirror），且 npm 对 peer 按区间独立解析最高满足版本，**结构上不会复现 pnpm 的旧实例复用偏斜**（9b 事故根因）。npm 不随壳分发（走用户 PATH / `DSH_DESKTOP_NPM`），所以 `npmOnPath()` 探测失败就回落 pnpm。npm 安装前若发现 pnpm 时代的 `node_modules/.modules.yaml` 会先清掉（符号农场对 npm 是异物；镜像 `prepareManagedDir` 的反向策略）。更新流程永远先 park 再安装，所以 npm 实际总是面对空目录，pnpm→npm 迁移零风险。

#### 9d. pnpm lockfile 是负资产（勿删此逻辑）

`prepareManagedDir()` 每次都删 `pnpm-lock.yaml`。壳只跑 `pnpm add <spec>`（每次全树重解析），lockfile 没有任何收益，却携带上一版本线的快照供 peer 解析器复用——9b 事故的直接载体。**加新逻辑时不要"优化"掉这行删除**。

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

## 宣传页（docs/index.html，GitHub Pages）约定

- **硬性要求：全文零表情符号**——图标一律内联 SVG（Lucide 风格 24×24 stroke），窗口控制符号用纯 CSS 画。改完跑 `node scripts/check-docs-page.js`（内联脚本语法解析 + 表情码点扫描，任一不过即失败）。
- **版本与更新日志自动获取，发版无需改页面**：浏览器端 fetch `https://api.github.com/repos/MoonlitDropOfBlood/DSH-Desktop/releases/latest`（CORS 开放，按访客 IP 限速 60 次/时，够用），成功后：hero 版本号（词典里用 `{ver}` 占位）、下载区「最新版本」卡片（发布日期按当前语言本地化、发布说明经内置迷你 Markdown 渲染器 `mdToHtml` 渲染，支持 `##/###` 标题、`-` 列表、粗体、行内代码、链接）、六个下载按钮改指**最新资产直链**（按文件名模式匹配：`.exe` / `arm64.dmg` / 其余 `.dmg` / `.AppImage` / `.deb` / `.rpm`，附带文件大小 title）。**API 失败/离线时保留静态兜底内容**（兜底版本号手动维护，发版时顺手更新 `latestVer` 与 `rel.fallback`）。
- 中英双语：所有文案走 `data-i18n` + `I18N` 词典（含 HTML 的字符串用 innerHTML 写入），`localStorage["dsh-desktop-lang"]` 记忆、浏览器语言自动检测。新增文案必须双语同步加 key。
- 视觉验证：无头 Edge 截图（`--headless=new --screenshot=<绝对路径> --window-size=1440,N --virtual-time-budget=8000`，需非沙箱；**相对路径的 --screenshot 不生效**，锚点滚动截图因 `scroll-behavior:smooth` 会出空白，用 `--dump-dom` 验证动态内容更可靠）。

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
| `DSH_DESKTOP_SPEC` | 覆盖 DSH npm 规格（默认按设置「更新渠道」的 tag 组成 `@deepseek-ai/dsh@<latest\|next\|alpha>`；设了此变量则优先生效，用于调试/CI） |
| `DSH_DESKTOP_TIMEOUT` | 启动看门狗超时秒数（默认 1800s） |
| `DSH_DESKTOP_NOTIFY_TOKEN` | **e2e/调试钩子（生产绝不设置）**：钉住 RPC 桥 token，使测试可直接 curl 桥方法；同一 env 经 childEnv 继承给核心，认证自然对齐 |
| `DSH_DESKTOP_INSTALL_ESTIMATE_MB` | 安装进度条估算总大小（默认 250MB） |
| `DSH_DESKTOP_INSTALL_STALL_SECONDS` | 下载无进展判定秒数（默认 120s，超时 kill npm） |
| `DSH_DESKTOP_SHELL_REPO` | 壳自更新的 GitHub 仓库（默认 `MoonlitDropOfBlood/DSH-Desktop`） |
| `DSH_DESKTOP_NODE` | 用真实的 Node 二进制覆盖 DSH 运行时（优先于内置 node 与 Electron 内嵌；调试用） |
| `DSH_DESKTOP_NODE_VERSION` | `scripts/fetch-node.js` 下载的内置 Node 版本（默认 24.19.0，Node 24 LTS，≥核心 22.15 门槛） |
| `DSH_DESKTOP_NODE_MIRROR` | 内置 Node 二进制镜像（默认 npmmirror，回退 nodejs.org） |
| `DSH_DESKTOP_NPM` | 覆盖 npm 回退路径要 spawn 的 npm 可执行文件绝对路径（仅 pnpm 缺失的回退时用） |
| `DSH_DESKTOP_MARKET_VERSION` | `scripts/fetch-market-plugin.js` 下载的 dshmarket 版本（默认 1.15.0） |
| `DSH_DESKTOP_PNPM_VERSION` | `scripts/fetch-pnpm.js` 下载的内置 pnpm 版本（默认 10.33.0） |
| `DSH_DESKTOP_INSTALLER` | 强制核心安装器：`npm` / `pnpm`（默认自动：更新目标 ≥0.1.2 用 npm，其余 pnpm；见"9c. 安装器选择"） |
| `DSH_DESKTOP_SMOKE_SECONDS` | 更新冒烟启动的判定秒数（默认 90s；生产绝不设置，e2e 用极小值强制冒烟失败验证回滚） |
| `DSH_DESKTOP_E2E_RESTARTS` | e2e 回归钩子：`"N[,ms]"` 让应用每次打开 DSH 页后自动执行 N 次真实重启链（生产绝不设置；配合 USER_DATA/HOME/PORT 全隔离用） |
