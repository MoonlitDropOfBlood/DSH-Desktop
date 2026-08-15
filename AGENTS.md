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
| **通知桥** `http://127.0.0.1:34951` | DSH Host 进程→Electron 主进程 | 任务通知（`agent/status` 等事件转发） |

任务通知：插件 **Host 半部**（index.js，运行在 DSH 进程里）监听 `agent/status`(running→idle=完成)、`agent/error`(失败)、`approval/request`(waterfall，需调 next)，POST 到主进程的本地 HTTP 桥，主进程弹 `Notification`。

### 4. 窗口控制条（沉浸式，不重叠）

- frameless 窗口；控制条用 `shell.overlay` Slot，`position: fixed; top:0; right:0`，宽度 150px，**左侧可拖拽**（`-webkit-app-region: drag`），按钮 `no-drag`。
- 与 DSH 会话头部右上角（Session log 等）不重叠的关键：注入 CSS
  `[class*="headerUtilities"] { padding-right: 150px !important; }`
  （CSS modules 混淆类名保留 `headerUtilities` 子串，可稳定匹配）。
- 不要用"整行标题栏 + body padding-top"方案——用户明确要**沉浸式**（DSH 占满窗口、无标题栏条）。

### 5. 托盘（`Tray`）+ 常驻通知栏

- 设置"常驻通知栏"开启后，关窗 `event.preventDefault()` + `mainWindow.hide()` 到托盘；托盘右键菜单"打开/退出"。
- 托盘图标 = `build/tray-icon.png`（DeepSeek 蓝圆角 + 白鲸鱼，带边距）。Linux 无托盘环境 `new Tray` 失败会优雅降级（关窗直接退出）。
- 真正退出（菜单退出、更新重启、app.quit）必须先 `isQuitting = true`，否则 close 拦截会把窗口藏进托盘。

### 6. 阻止休眠 / 任务通知

- 阻止休眠：`powerSaveBlocker.start("prevent-app-suspension")`，返回 id，`powerSaveBlocker.stop(id)` 释放；设置持久化在 `update-settings.json`。
- 设置项：`autoUpdate` / `closeToTray` / `preventSleep` / `taskNotify`，都存在 `%APPDATA%\...\update-settings.json`。

### 7. 图标

- 源 = `build/whale.svg`（DeepSeek 鲸鱼，从 `@deepseek-ai/dsh-client-ui-primitives` 的 `FishLogo` 提取的 path）。
- `npm run icon` 用 `@resvg/resvg-js`（纯 Node SVG 光栅化）生成 64/256/512 PNG。**不要用 Electron 离屏渲染**（本机 >128px 就崩）。
- electron-builder 的 `win.icon`/`mac.icon`/`linux.icon` 打包时自动转换 .ico/.icns。
- Windows 任务栏图标跟随 **exe 资源图标**（开发 `npm start` 显示 electron 默认图标，打包后才是鲸鱼——Electron 固有限制）。

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
- **`CSC_IDENTITY_AUTO_DISCOVERY=false`** 跳过代码签名（无签名证书时需要）。
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
