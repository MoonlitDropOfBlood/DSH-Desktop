<p align="center">
  <img src="build/whale.svg" alt="DeepSeek Harness Desktop" width="120">
</p>

<h3 align="center">为 DeepSeek Harness 打造的桌面端体验</h3>

<p align="center">
  <img src="https://img.shields.io/badge/Desktop-App-4D6BFE?style=flat" alt="Desktop application">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-2EA44F?style=flat" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-4493F8?style=flat-square" alt="Platforms">
  <img src="https://img.shields.io/badge/DSH-not%20bundled-22C55E?style=flat" alt="DSH core not bundled">
</p>

<p align="center"><sub>中文</sub></p>

---

把 **DeepSeek Harness（DSH）** 包装成一个原生桌面应用。它负责窗口、托盘、更新与桌面运行环境，同时完整保留官方 DSH 的智能体、模型、工具、会话与 Web UI。

**DSH 核心不打进安装包**：目标机器首次启动时自动通过 `npm` 安装最新版 DSH，之后直接复用本机已有的完整安装——既保持轻量，又能随时更新到最新。

> **DSH 来自哪个 npm 仓库？** 核心 `@deepseek-ai/dsh` 发布在官方 **npmjs.org**（`https://registry.npmjs.org`）。国内网络下默认使用 npmmirror 镜像（`registry.npmmirror.com`），探测不可用或安装失败时会自动回退 npmjs.org，也可用 `DSH_DESKTOP_NPM_REGISTRY` 指定。安装过程会显示**实时进度条与已下载大小**。

## 主要功能

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>沉浸式桌面窗口</h3>
      <p>无边框（frameless）窗口，DSH Web UI 占满整个屏幕；最小化/最大化/关闭按钮以半透明方式融入界面右上角，不遮挡任何 DSH 内容。</p>
    </td>
    <td width="50%" valign="top">
      <h3>系统托盘</h3>
      <p>DeepSeek 鲸鱼托盘图标，右键「打开 / 退出」。开启「常驻通知栏」后，关闭窗口最小化到托盘，后台持续运行。</p>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <h3>保持最新</h3>
      <p>内置「核心」设置页显示 DSH 版本、一键检查更新，支持自动更新（新版本自动下载并提示重启）。</p>
    </td>
    <td width="50%" valign="top">
      <h3>任务通知</h3>
      <p>任务完成、失败或需要确认时发送桌面通知；可选「阻止休眠」，任务运行期间防止系统睡眠。</p>
    </td>
  </tr>
</table>

## 与官方项目的关系

本项目基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 构建，并借助 [Cordis](https://github.com/cordiverse/cordis) 的插件化能力。

官方项目提供核心的智能体能力、插件系统与 Web UI；本项目负责：

- Electron 桌面应用封装（窗口、托盘、生命周期、崩溃重启、进程树清理）
- DSH 的自动安装、定位与更新
- 嵌入 DSH UI 的桌面插件（窗口控制条、设置页、更新徽章）
- Windows / macOS / Linux 安装包构建与 GitHub Actions 自动发布

如果你希望通过命令行运行 Harness，或参与核心功能开发，请优先查看[官方仓库](https://github.com/deepseek-ai/deepseek-harness)。

## 安装

从 **GitHub Releases** 下载对应平台安装包：

| 平台 | 格式 |
| --- | --- |
| Windows | NSIS 安装器（x64 / x86） |
| macOS | dmg（Apple Silicon / Intel） |
| Linux | AppImage · deb · rpm |

> 首次启动会自动安装最新版 DSH（约 250MB），之后启动为瞬时。运行环境需要 [Node.js](https://nodejs.org/) ≥ 18。

## 从源码运行 / 开发

```bash
npm install          # 安装依赖（首次）
npm start            # 启动桌面应用
npm run icon         # 重新生成鲸鱼图标（改配色/边距后）
```

### 打包

```bash
npm run pack         # 打包目录到 dist/（快速验证）
npm run dist:win     # Windows NSIS 安装器
npm run dist:mac     # macOS dmg
npm run dist:linux   # Linux AppImage + deb + rpm
```

GitHub Actions（`.github/workflows/build-installers.yml`）可在打 `v*` 标签或手动触发时，跨平台构建并自动发布到 Releases。

## 工作原理

```
npm start
  └─ Electron 主进程
       └─ 定位 DSH：应用托管目录 → node_modules → npm _npx 缓存（最新完整安装）
       └─ 没有则 npm install @deepseek-ai/dsh@latest（registry 探测 + 失败重试/换镜像 + 实时进度条）
       └─ 端口预检：被占用则弹「换端口并重试」面板（端口持久化）
       └─ spawn: node <dsh>/lib/bin.js --patch <desktop-plugin> --profile web --port X
            └─ 桌面插件嵌入 DSH UI：窗口控制条 / 设置页 / 更新徽章
            └─ DSH 打印 URL → 应用解析 → loadURL 到 frameless 窗口
       └─ 启动/加载失败或插件未挂载 → 回到启动页（自带窗口控制条 + 重试/换端口/退出），
           另注入兜底控制条，窗口永远可关闭
       └─ 更新：先停 DSH 核心 → 安装新版本（防 Windows 下覆盖运行中文件导致崩溃）→ 重启核心
       └─ 退出时 kill 整棵进程树；崩溃时一键重启
       └─ 任务事件经本地桥转发 → 桌面通知（可开关）
```

## 环境变量（可选）

| 变量 | 作用 |
| --- | --- |
| `DSH_DESKTOP_PORT` | 指定端口（默认 3080） |
| `DSH_DESKTOP_HOME` | 覆盖 `DSH_HOME`（默认 `~/.dsh`） |
| `DSH_DESKTOP_NPM_REGISTRY` | npm 镜像（默认 npmmirror） |
| `DSH_DESKTOP_NPM_CACHE` | npm 缓存目录 |
| `DSH_DESKTOP_SPEC` | DSH npm 规格（默认 `@deepseek-ai/dsh@latest`） |
| `DSH_DESKTOP_TIMEOUT` | 启动看门狗超时秒数（默认 720s） |
| `DSH_DESKTOP_INSTALL_ESTIMATE_MB` | 安装进度条估算总大小（默认 250MB） |

## 常见问题

- **端口冲突**：应用启动前会预检端口。若 3080 被占用（如浏览器里开着另一个 DSH），会弹出「端口已被占用」面板，可直接**换一个端口并重试**（端口会记住）；或设 `DSH_DESKTOP_PORT` 换端口。
- **首次安装慢/卡住**：首次会下载约 250MB 的 DSH 依赖树，启动页有**进度条 + 已下载大小**。若网络下载慢，设镜像：`$env:npm_config_registry = "https://registry.npmmirror.com"`。
- **启动失败看不到原因**：所有启动/崩溃错误都会显示在启动页的错误面板（含最近日志），提供「重试 / 换端口并重试 / 退出」。
- **点更新没反应或崩溃**：更新会先停掉 DSH 核心再安装新版本（避免 Windows 下覆盖运行中文件导致崩溃），失败时可选择「用当前版本继续」。
- **常驻通知栏看不到托盘图标**：开启「常驻通知栏」后**立即**创建托盘图标（无需先点一次关闭）。
- **electron 下载超时（GitHub 不可达）**：`npm install` 前设 `$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"`。
- **任务通知不弹**：在「设置 → 桌面版」确认「任务通知」已开启；另外**应用窗口有焦点且可见时不弹**（你正在看着界面，任务状态已内联显示），只在后台/最小化/藏托盘时才通知。
- **通知安全**：任务通知走本机回环 HTTP 桥（`127.0.0.1`），每次启动使用**随机端口 + 随机令牌**，网页和无关本地进程无法伪造或刷屏通知。
- **macOS 报"已损坏，无法打开" / "无法验证开发者"**：当前未签名，这是 macOS Gatekeeper 对下载的未签名 App 的拦截（Apple Silicon 上 arm64 版最常显示"已损坏"）。**不是包坏了**，壳有完整的 x64 和 arm64 版本（release 里的 `*-arm64.dmg`）。临时绕过：**右键应用 → 打开**，或终端执行 `xattr -dr com.apple.quarantine "/Applications/DeepSeek Harness Desktop.app"`。要彻底解决需给 macOS 包签名+公证（见下文「macOS 签名与公证」）。
- **macOS 签名与公证**：
  - **不买账号也能签**（自制自签名证书）：仓库 Secrets 配 `CSC_LINK`（.p12 的 base64）+ `CSC_KEY_PASSWORD` + `CSC_NAME`（证书名）。本仓库已附一个生成好的自签名证书（见工作流注释）。注意自签名证书**只在本机/信任它的 Mac 上免提示打开**，其他用户仍需右键 → 打开。
  - **彻底解决**（付费 Apple Developer 账号）：Developer ID 证书 + 公证凭据 `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID`（或 `APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER`），配齐后 GitHub Actions 自动签名并 notarytool 公证，所有 Mac 双击即开。
  - **什么都没配**时：`scripts/mac-sign.js` 自动做 ad-hoc 自签名，"已损坏" → "无法验证开发者"（右键 → 打开 可用）。
- **与浏览器里的 DSH 共用数据**：默认共用 `~/.dsh`，会话互通。

## 目录结构

```
dsh-desktop/
├── main.js                 # Electron 主进程：生命周期、IPC、托盘、设置、通知桥
├── preload.js              # contextBridge：暴露 dshDesktop.* 给 DSH 页面
├── splash.html             # 启动页
├── dsh-desktop-plugin/     # 嵌入 DSH UI 的桌面插件（窗口控制条/设置页/更新徽章）
│   ├── client.js           #   浏览器端：Slot UI
│   └── index.js            #   Host 端：任务事件 → 通知桥
├── scripts/                # 图标生成 / exe 图标嵌入
├── build/                  # 鲸鱼 SVG 与各平台图标
├── .github/workflows/      # GitHub Actions 跨平台构建发布
├── AGENTS.md               # 面向 AI agent 的开发指南（含踩坑记录）
└── LICENSE                 # MIT
```

## License

本项目遵循 [MIT License](LICENSE)。

> 本项目是基于 DeepSeek Harness 构建的社区桌面版本，并非 DeepSeek 官方产品。
