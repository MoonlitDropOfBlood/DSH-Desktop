# Changelog

本项目所有重要变更都记录在此文件。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

> 发布流程：改动记录在 `## [Unreleased]`；打 `v*` 标签发布时，把对应内容移到新的 `## [x.y.z] - <日期>` 小节。
> GitHub Actions 发布 Release 时会自动取 `## [<版本号>]` 这一节作为 Release 说明。

## [Unreleased]

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
