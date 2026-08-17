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
│   └── embed-exe-icon.js   # 本机无法解压 winCodeSign 时，用 rcedit 手动嵌 exe 图标
└── build/
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

找不到就 `npm install --prefix <托管目录> @deepseek-ai/dsh@latest`（含 registry 探测 + 失败重试/换镜像）。

**Windows 上 spawn npm 的引号坑（大坑，必读）**：**绝不要**把 npm 命令预拼成一个字符串再丢给 `cmd /d /s /c`，例如 `cmd /d /s /c "npm install --prefix "C:\...\dsh" ..."`，也不要用 `JSON.stringify(path)` 给参数加引号——cmd 的 `/s` 引号剥离会弄坏内嵌引号、按空格截断参数，npm 就会收到一个**相对路径** `--prefix "C:\...\DeepSeek`，然后报 `ENOENT: mkdir`，退出码 `4294963238`（只要路径含空格就必炸，例如 `C:\Users\wwhby\AppData\Roaming\DeepSeek Harness Desktop\dsh`）。**正确做法**：`spawn(cmd.exe, ["/d","/s","/c","npm", ...args])`，`npm` 和每个参数（含带空格的路径）作为独立 argv 传入，让 Node 的 CreateProcess 自动加引号；`--prefix` 传原始路径、不要 JSON.stringify。`queryLatest` 同理。

**DSH 的 npm 仓库**：`@deepseek-ai/dsh` 发布在官方 **npmjs.org**（`https://registry.npmjs.org`），国内常用 npmmirror 镜像同步。默认 `DEFAULT_NPM_REGISTRY` = npmmirror（国内快），探测/失败时回退 npmjs.org。可用 `DSH_DESKTOP_NPM_REGISTRY` 覆盖。

**不要用 `npx` 启动 DSH**：本机网络下 npx 在线解析 `@latest` 会挂死在 CDN 节点，`npx --offline` 在 npm 11 + 大缓存下病态空转。**直接 `node <bin> web --patch <patch>` 最可靠**。

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

### 3. Electron ↔ DSH 通信（三条通道）

| 通道 | 方向 | 用途 |
|---|---|---|
| `preload` 的 `dshDesktop.*` IPC | 渲染进程(DSH 页面)→主进程 | 窗口控制、设置读写、更新、重启 |
| `dsh:update-state` 事件 | 主进程→渲染进程 | 推送版本/设置状态给插件 UI |
| **通知桥** `http://127.0.0.1:<随机端口>` | DSH Host 进程→Electron 主进程 | 任务通知（`agent/status` 等事件转发） |

任务通知：插件 **Host 半部**（index.js，运行在 DSH 进程里）监听 `agent/status`(running→idle=完成)、`agent/error`(失败)、`approval/request`(waterfall，需调 next)，POST 到主进程的本地 HTTP 桥，主进程弹 `Notification`。

**通知桥安全（重要）**：
- **焦点抑制**：桌面窗口**有焦点且可见时不弹通知**（用户正在看 DSH，任务状态已内联显示；弹原生通知只是噪音），只在后台/最小化/藏托盘时才通知。判断：`mainWindow.isVisible() && isFocused() && !isMinimized()`。
- 桥只绑定 `127.0.0.1`（不暴露局域网），且**端口是每次启动随机**（`40000–50000`，`generateNotifyCredentials()`），避免固定端口被本地进程抢占。
- 带**每次启动随机的 bearer token**（`crypto.randomBytes(24)`），通过 `DSH_DESKTOP_NOTIFY_PORT`/`DSH_DESKTOP_NOTIFY_TOKEN` 环境变量只传给被 spawn 的 DSH 进程，插件 POST 时带 `x-dsh-notify-token` 头；桥校验不符直接 401。
- 带**外部 Web Origin 的请求直接 403**（浏览器页面拿不到 token 也到不了这层；配合 Chrome/Firefox 的 Private Network Access 双重防护）；只收 POST（其余 405）；body 上限 4KB，超限断开。
- 因此网页/无关本地进程无法伪造或刷屏通知。真机上可用 `curl -X POST -H "x-dsh-notify-token: <token>" -d '{"kind":"done"}' http://127.0.0.1:<port>/` 手工验证（token 在 DSH 子进程环境里，app 本身不落盘）。

### 4. 窗口控制条（沉浸式，不重叠）

- frameless 窗口；控制条用 `shell.overlay` Slot，`position: fixed; top:0; right:0`，宽度 150px，**左侧可拖拽**（`-webkit-app-region: drag`），按钮 `no-drag`。
- **macOS 按钮点不动（大坑）**：`-webkit-app-region: drag` 放在**父容器**上时，macOS 会把整条区域当成拖拽区，`no-drag` 子按钮偶尔收不到点击。**修复**：容器本身**不带 app-region**，改用一个独立的绝对定位 `.dsh-desktop-drag` 兄弟条（`left:0; right:132px`）承载 `drag`，按钮显式 `no-drag` + `pointer-events:auto`（`shell.overlay` 宿主层是 `pointer-events:none`，子级靠 `.overlayLayer>*{pointer-events:auto}` 恢复，仍要显式加固）。
- 与 DSH 会话头部右上角（Session log 等）不重叠的关键：注入 CSS
  `[class*="headerUtilities"] { padding-right: 150px !important; }`
  （CSS modules 混淆类名保留 `headerUtilities` 子串，可稳定匹配）。
- **兜底控制条**：主进程在 DSH 页 `did-finish-load` 后延迟 1.5s/6s 用 `executeJavaScript` 检查 `.dsh-desktop-controls`；若插件没挂上（核心/插件加载失败），注入一套原生样式的 `.dsh-desktop-fallback` 按钮条（最小化/最大化/关闭），保证 frameless 窗口永远可关。
- **原生逃生通道**：菜单加 `CmdOrCtrl+M`（最小化）/ `CmdOrCtrl+W`（关闭窗口）；macOS 上 Cmd+Q 走系统 appMenu。即使页面 DOM 按钮全部失效也能关窗/退出。
- 不要用"整行标题栏 + body padding-top"方案——用户明确要**沉浸式**（DSH 占满窗口、无标题栏条）。

### 5. 托盘（`Tray`）+ 常驻通知栏

- 设置"常驻通知栏"开启后，关窗 `event.preventDefault()` + `mainWindow.hide()` 到托盘；托盘右键菜单"打开/退出"。
- **托盘图标在开启设置的当下就创建**（`whenReady` 时 `readSettings().closeToTray && ensureTray()`；开关 IPC 里 `setCloseToTray` 即时 `ensureTray()/destroyTray()`）——**不能只在用户点关闭时才建托盘**，否则用户不开窗就永远看不到图标、也没法恢复窗口。
- 托盘图标 = `build/tray-icon.png`（DeepSeek 蓝圆角 + 白鲸鱼，带边距）。Linux 无托盘环境 `new Tray` 失败会优雅降级（关窗直接退出）。
- 真正退出（菜单退出、更新重启、app.quit）必须先 `isQuitting = true`，否则 close 拦截会把窗口藏进托盘。
- macOS `activate`（点 Dock 图标）改为：窗口存在（哪怕藏在托盘）就 `show()+focus()`，否则重建——否则 Dock 点了没反应。

### 6. 阻止休眠 / 任务通知

- 阻止休眠：`powerSaveBlocker.start("prevent-app-suspension")`，返回 id，`powerSaveBlocker.stop(id)` 释放；设置持久化在 `update-settings.json`。
- 设置项：`autoUpdate` / `closeToTray` / `preventSleep` / `taskNotify` / `port`，都存在 `%APPDATA%\...\update-settings.json`。

### 7. 图标

- 源 = `build/whale.svg`（DeepSeek 鲸鱼，从 `@deepseek-ai/dsh-client-ui-primitives` 的 `FishLogo` 提取的 path）。
- `npm run icon` 用 `@resvg/resvg-js`（纯 Node SVG 光栅化）生成 64/256/512 PNG。**不要用 Electron 离屏渲染**（本机 >128px 就崩）。
- electron-builder 的 `win.icon`/`mac.icon`/`linux.icon` 打包时自动转换 .ico/.icns。
- Windows 任务栏图标跟随 **exe 资源图标**（开发 `npm start` 显示 electron 默认图标，打包后才是鲸鱼——Electron 固有限制）。

### 8. 启动页 = 错误面板 + 进度（splash.html / `showStartupError` / `trackInstallProgress`）

- **splash 的 CSP 必须有 `script-src 'unsafe-inline'`**（内联脚本），否则标题条按钮监听不注册、进度/日志全不更新——这是"按钮没反应"最常见原因。
- 所有启动/崩溃/安装失败都走 splash 错误面板（`dsh:startupError` + `dsh:startupChoice`），**绝不弹原生模态框/系统崩溃弹窗**：面板渲染动态操作按钮（重试 / 换端口并重试 / 退出 / 安装失败时 重试·换镜像·用当前版本继续·退出），并可**一键「复制错误信息」**（`dsh:copyText` → 主进程 `clipboard`；内容=消息+详情+最近日志）。
- **主进程崩溃可视化**：`process.on("uncaughtException")` + `process.on("unhandledRejection")` 兜底——任何未捕获 JS 错误/未处理 Promise 都转成页面错误面板，而不是 Windows "has stopped working" 系统弹窗（那种弹窗用户没法复制错误）。换端口写入 `update-settings.json` 的 `port`，`effectivePort()` 优先环境变量再读它。
- **端口占用预检**：spawn 前 `isPortFree(effectivePort())`，被占就直接弹"端口已被占用"面板（而不是等 DSH 报错退出）；退出日志含 `EADDRINUSE` 也走换端口面板。
- **安装进度**：`trackInstallProgress()` 每 1.5s 测 `dshDir()` 增长，按 `INSTALL_ESTIMATE_MB`（默认 250，可 `DSH_DESKTOP_INSTALL_ESTIMATE_MB` 覆盖）算百分比推到 splash 进度条（`dsh:progress`）。
- `did-fail-load`（非 file:、非 ERR_ABORTED）/ `render-process-gone` → 回退 splash 错误面板，绝不留"关不掉的死窗"。
- **安装失败**（`installWithRetry`）同样用页面面板 + `pendingInstallCb`（重试/换镜像/用当前版本继续/退出），**不再用 `dialog.showMessageBoxSync`**——统一可复制的错误出口。更新时 `isUpdating` 标志让 DSH 被故意停掉时不误报"进程已退出"。
- **下载黑洞节点（大坑，实测）**：镜像 CDN 的某个节点可能 **TCP 握手成功但永不传数据**（如广州移动 AS9808 节点），npm 挂着 13 条 Established 连接、CPU 狂转、字节却零流动——表现就是"点更新一直没下载、任务管理器没流量"。**四道防线**：① `childEnv` 设 `npm_config_fetch_timeout=30000` + `fetch_retries=3`，npm 30s 快速失败并重试（可能换到别的节点）；② 安装加 `--loglevel=info`，npm 下载时逐请求打印，用户能在日志看到活动、看门狗能识别"有进展"；③ `installDSH` 下载看门狗：dshDir 无增长**且** npm 无输出持续 `INSTALL_STALL_MS`（默认 120s，可 `DSH_DESKTOP_INSTALL_STALL_SECONDS` 覆盖）就 taskkill 整棵 npm 树并弹"下载无进展，请重试或换镜像"；④ 更新前也 `probeFastestRegistry` 探测镜像（原来只有首次安装探测）。

### 9. 更新安全（先停 DSH 再装，防崩溃）

- **更新会崩的根因**：`npm install --prefix <托管目录>` 直接覆盖**正在运行**的 DSH 目录（`<userData>/dsh/node_modules/@deepseek-ai/dsh`）。Windows 下运行中进程文件被替换 → EPERM/EBUSY，npm 报错且 DSH 进程被删文件而崩。
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
npm run pack         # 打包目录到 dist/win-unpacked/
npm run dist:win     # NSIS 安装包
npm run dist:mac     # macOS dmg
npm run dist:linux   # Linux AppImage
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
| `DSH_DESKTOP_NPM_REGISTRY` | npm 镜像（默认 npmmirror，国内网络需要） |
| `DSH_DESKTOP_NPM_CACHE` | npm 缓存目录 |
| `DSH_DESKTOP_SPEC` | DSH npm 规格（默认 `@deepseek-ai/dsh@latest`） |
| `DSH_DESKTOP_TIMEOUT` | 启动看门狗超时秒数（默认 720s） |
| `DSH_DESKTOP_INSTALL_ESTIMATE_MB` | 安装进度条估算总大小（默认 250MB） |
| `DSH_DESKTOP_INSTALL_STALL_SECONDS` | 下载无进展判定秒数（默认 120s，超时 kill npm） |
| `DSH_DESKTOP_SHELL_REPO` | 壳自更新的 GitHub 仓库（默认 `MoonlitDropOfBlood/DSH-Desktop`） |
