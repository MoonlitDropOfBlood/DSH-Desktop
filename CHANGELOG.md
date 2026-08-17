# Changelog

本项目所有重要变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布流程：改动记录在 `## [Unreleased]`；打 `v*` 标签发布时，把对应内容移到新的 `## [x.y.z] - <日期>` 小节。
> GitHub Actions 发布 Release 时会自动取 `## [<版本号>]` 这一节作为 Release 说明。

## [Unreleased]

### 修复

- **macOS 未签名导致"已损坏，无法打开"**：新增 `scripts/mac-sign.js`（`afterPack` 钩子）——
  未配置 Developer ID 证书时自动对 .app 做 **ad-hoc 自签名**，把 arm64 上吓人的"已损坏"错误变成标准的
  "无法验证开发者"（右键 → 打开 即可运行）。配置了 Developer ID 证书时该钩子不生效。

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
