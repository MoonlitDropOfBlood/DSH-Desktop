# DeepSeek Harness Desktop

把 DeepSeek Harness（DSH）包装成一个桌面应用：Electron 窗口内部**直接运行已安装的
DSH**（`node <dsh>/lib/bin.js web`），启动瞬时、不依赖 npm/npx、不会卡在网络；
默认使用 DSH 的固定端口 **3080**（可用 `DSH_DESKTOP_PORT` 覆盖）。

## 特性

- **启动永不卡住**：启动时直接用 `node` 运行本机已安装的 DSH，零网络请求、零
  npx/npm 解析。此前「一直停在启动中」的根因是 npx 每次启动都要在线解析
  `@latest`，在部分网络环境下会挂死在某个 CDN 节点上（npmjs 慢、npmmirror 部分
  CDN 节点间歇性卡死、`npx --offline` 在 npm 11 大缓存下病态空转）。
- **定位策略**：优先用本应用 `node_modules` 里的 DSH（更新目标）；若尚未装好，
  自动扫描并复用 npm `_npx` 缓存中最新的一份**完整** DSH 安装，保证开箱即用。
- **保持最新（显式更新）**：启动后在后台**非阻塞**查询最新版本（`npm view`，快），
  发现新版本弹系统通知；也可随时通过菜单 **DSH → 检查并更新 DSH** 用 `npm install`
  下载最新版并重启。首次全新安装（本机没有任何 DSH）时自动执行 `npm install`。
- **固定端口 3080**：默认不传 `--port`，DSH 使用其默认端口 3080，URL 稳定为
  `http://127.0.0.1:3080`；应用解析 DSH 打印的 `dsh web: http://127.0.0.1:<port>`
  行来确认真实地址。需要换端口时设置 `DSH_DESKTOP_PORT`。
- **原生窗口 + 启动页**：启动时显示加载动画，Web 服务就绪后自动载入 GUI。
- **进程树清理**：退出应用时通过 `taskkill /T /F`（Windows）或进程组信号
  （macOS/Linux）杀掉整个 DSH 进程树，不会残留后台进程。
- **崩溃重启**：DSH 意外退出时弹出提示，可一键重启。
- **单实例**：重复打开只聚焦已有窗口。

> **注意**：桌面应用会启动一个**独立的 DSH 实例**。若 3080 已被占用（例如
> 浏览器里还开着另一个 DSH），新实例无法绑定端口，应用会报错——请先关闭其他
> DSH，或用 `DSH_DESKTOP_PORT` 指定其它端口。

## 前置要求

- [Node.js](https://nodejs.org/) ≥ 18（含 npm）
- 能访问 npm registry（安装/更新 DSH 用；运行已装好的 DSH 不需要网络）

## 安装与运行

```bash
cd dsh-desktop
npm install          # 安装 electron、electron-builder 与 DSH 依赖
npm start            # 启动桌面应用
```

> 若 `npm install` 因网络下载 DSH 依赖树（约 250MB）卡住，可设置镜像后重试：
> `$env:npm_config_registry = "https://registry.npmmirror.com"`。即便 DSH 尚未装进
> 本应用，应用也会自动复用 npm `_npx` 缓存里已有的完整 DSH（例如之前通过
> `npx @deepseek-ai/dsh@latest web` 装好的那份）。

## 打包成可安装的 exe

```bash
npm run dist             # 生成 NSIS 安装包，输出到 dist/
npm run dist:portable    # 或生成便携版 exe
```

打包后的应用（包括随附的 electron 与 DSH 依赖）在用户机器上不需要安装 Node，也
不需要网络（除非要「检查并更新 DSH」）。请确保打包时 `@deepseek-ai/dsh` 已安装到
`node_modules`（`npm install` 完成后执行 `npm run dist` 即可）。

## 工作原理

```
npm start
  └─ Electron 主进程
       └─ 定位 DSH：本应用 node_modules，或 npm _npx 缓存里最新的一份完整安装
       └─ spawn: node <dsh>/lib/bin.js web   (默认端口 3080，零网络请求)
            └─ DSH web 启动后打印: dsh web: http://127.0.0.1:<port>
       └─ 解析该 URL，轮询直到 HTTP 响应，然后 loadURL 到窗口
       └─ 退出时 kill 整棵进程树
       └─ （后台）npm view @deepseek-ai/dsh version 检查最新版，有新版本则通知
```
            └─ DSH web 启动后打印: dsh web: http://127.0.0.1:<port>
       └─ 解析该 URL，轮询直到 HTTP 响应，然后 loadURL 到窗口
       └─ 退出时 kill 整棵进程树
       └─ （后台）npm view @deepseek-ai/dsh version 检查最新版，有新版本则通知
```

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_NPM_REGISTRY` | 覆盖 npm 镜像源，默认 `https://registry.npmmirror.com`（npmjs.org 在国内极慢，会让启动卡在下载） |
| `DSH_DESKTOP_PORT` | 指定端口；默认不传 `--port`，DSH 使用默认端口 3080 |
| `DSH_DESKTOP_HOME` | 覆盖 `DSH_HOME`（DSH 数据目录），默认沿用系统的 `~/.dsh` |
| `DSH_DESKTOP_NPM_CACHE` | 覆盖 npm 缓存目录（`npm_config_cache`），受限环境可用 |
| `DSH_DESKTOP_SPEC` | 覆盖要运行的 npm 包规格，默认 `@deepseek-ai/dsh@latest` |

示例：

```powershell
$env:DSH_DESKTOP_PORT = "8099"
$env:DSH_DESKTOP_HOME = "D:\dsh-data"
npm start
```

## 常见问题

- **首次使用 / 全新机器**：本机还没有任何 DSH 安装时，启动会先自动执行一次
  `npm install @deepseek-ai/dsh`（从 npmmirror 拉取，约 250MB）。装好后启动为
  瞬时。若网络下载卡住，先设置镜像再重试：
  `$env:npm_config_registry = "https://registry.npmmirror.com"`。
- **一直停在「启动中」**：已根治——启动不再走 npx/npm（直接用 `node` 运行已装的
  DSH）。若 DSH 迟迟不打印 URL，多半是端口被占用（见上方「注意」）或 DSH 自身
  启动报错，可查看应用控制台日志。
- **为什么不用 npx 了**：本机网络环境下 npx 在线解析 `@latest` 会间歇性挂死在某个
  CDN 节点，`npx --offline` 在 npm 11 + 大缓存下会病态空转（CPU/内存暴涨且不派发
  进程）。改为直接运行已安装的 DSH 后彻底绕开这两条路径；「保持最新」改为后台
  `npm view` 检查 + 菜单「检查并更新 DSH」显式更新。
- **`npm` 报 EPERM / 权限错误**：通常是没有权限写 npm 缓存目录。可设置
  `DSH_DESKTOP_NPM_CACHE` 指向一个可写目录，或改用管理员权限运行。
- **electron 二进制下载超时（GitHub 不可达）**：`npm install` 阶段 electron 的
  postinstall 会从 GitHub Releases 下载二进制；若网络访问不了 GitHub，先设置
  npmmirror 镜像再安装：

  ```powershell
  $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
  npm install
  ```
- **想和现有浏览器里的 DSH 共用数据**：默认共用 `~/.dsh`，会话互通。
  想隔离就在启动前设置 `DSH_DESKTOP_HOME`。
- **macOS/Linux**：同样支持，进程组清理使用 `SIGTERM`。

## 目录结构

```
dsh-desktop/
├── package.json        # 依赖、脚本、electron-builder 配置
├── main.js             # Electron 主进程：spawn DSH / 解析 URL / 进程管理
├── preload.js          # contextBridge，把状态事件暴露给启动页
├── splash.html         # 启动/加载页
├── scripts/make-icon.js# 用 Node 内置库生成 build/icon.png（node scripts/icon 重新生成）
├── build/icon.png      # 应用图标（打包用）
└── README.md
```
