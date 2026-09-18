# AGENTS.md — 鲸港 WhaleHarbor

面向 AI agent 与协作者的开发指南。**读这里再动手**，尤其是「关键机制（红线清单）」——每条红线都是实测事故的教训。本文件是**索引 + 红线清单**；各机制完整细节在 `docs/agents/` 主题文档，改到对应领域时**必须连主题文档一起读**：

| 主题文档 | 覆盖范围 |
|---|---|
| [install-and-update.md](docs/agents/install-and-update.md) | §1 安装/pnpm/引号坑、§1b 内置 Node 运行时、§1c 终端 Profile、§9 更新安全三重防线、§11 壳自更新 |
| [plugins-and-market.md](docs/agents/plugins-and-market.md) | §2 插件挂载、§2b 内置市场与重启/收养链全部坑、§2c whaleharbor-promo |
| [rpc-bridge.md](docs/agents/rpc-bridge.md) | §3 三通道/任务通知/RPC 协议/安全/浮窗/导航防护 |
| [desktop-ui.md](docs/agents/desktop-ui.md) | §4 窗口控制条、§5 托盘、§8 启动页 |

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
├── core-version.js         # 纯函数：核心版本解析/比较（prerelease 感知 + 三元组两种语义）
├── shell-asset.js          # 纯函数：壳自更新资产选择（arm64/x64 陷阱）+ GitHub digest 解析
├── settings-json.js        # 纯函数：设置 JSON 解析（BOM 剥离，勿内联回 main.js）
├── plugin-recovery.js      # 纯函数：插件故障日志 → 罪魁归因/自动卸载计划
├── url-extract.js          # 纯函数：核心启动日志 → 完整 URL（含 token，勿截断）
├── preload.js              # contextBridge：暴露 dshDesktop.* 给渲染进程（DSH 页面）
├── float-preload.js        # 浮窗专用迷你 preload（只暴露 __dshFloat）
├── splash.html             # 启动页（frameless 下自带标题条）
├── package.json            # electron-builder 配置 + 脚本（npm test 在 CI 直跑）
├── dsh-desktop-plugin/     # DSH 客户端+主机插件包（随应用一起打包，非 DSH 核心）
│   ├── index.js            #   Host 半部：任务事件 → notify.show；托盘状态项；反向事件服务器
│   └── client.js           #   Client 半部：窗口控制条、侧栏更新徽章、设置页
├── plugins/whaleharbor-promo/  # 鲸港 Web 引导插件（独立发 npm，见 docs/agents/plugins-and-market.md §2c）
├── scripts/                # fetch-*（node/pnpm/market）、test-*（零依赖单测）、e2e-*/repro-*（真机）
├── docs/
│   ├── index.html          # 宣传页（GitHub Pages，零 emoji 硬性要求）
│   └── agents/             # AGENTS.md 的主题详解（索引见文件头表格）
└── build/                  # whale.svg 源 + 图标产物；market-plugin/pnpm/node 为 gitignore 构建期下载
```

## 关键机制（红线清单）

### 1. DSH 动态安装与定位（main.js `resolveDSHBin` / `ensureDSH` / `installDSH`）

按序找现成安装（托管目录 → 应用自带 node_modules → npm `_npx` 缓存），找不到走 `installPlan()` 安装。红线：

- **pnpm 装核心是实测定稿，勿改回 npm 默认**——npm arborist 在"裸目录 + `@latest` 全树重解析"场景实测 >10 分钟 CPU 爆炸；npm 仅对 ≥0.1.2 目标自动启用（见 §9c）。
- pnpm 必带 `--reporter=append-only` + `--config.confirmModulesPurge=false`；store 固定 `<userData>/pnpm-store` 且必须与托管目录**同卷**（否则硬链接退化全量复制）。
- **spawn npm 参数必须逐个 argv 传入**，绝不预拼字符串、绝不 `JSON.stringify` 路径（Windows cmd `/s` 引号剥离大坑，路径含空格必炸 ENOENT mkdir）。
- **绝不用 `npx` 启动 DSH**——直接 `node <bin> --expose-internals <bin.js> --patch <patch> --profile web [--port X]`。
- `--no-open` 必须按 `supportsNoOpen()` 版本门禁追加（<0.1.0-rc.8 的核心遇未知选项直接退出；实现走 `core-version.js`，行为锁在 `scripts/test-core-version.js`）。
- registry 默认 npmmirror、失败回退 npmjs.org（`DSH_DESKTOP_NPM_REGISTRY` 覆盖）。
- **版本比较统一（2026-09-16）**：核心版本一律走 `core-version.js`（三元组门禁用 `isAtLeastByTriple`，更新方向用 `isNewer`）；main.js 的 `compareVersions` 只许比较壳自己的 `v1.2.3` 标签。**更新方向守卫**：`updateAvailable` 与启动自动更新都要求 `isNewer(latest, installed)`——渠道切回/dist-tag 回移绝不能把旧版当更新装；用户显式点的安装不受挡。

原理与细节 → [docs/agents/install-and-update.md](docs/agents/install-and-update.md) §1。

### 1b. DSH 运行时 = 内置独立 Node（首选）+ Electron 内嵌 Node（回退）

`dshRuntime()` 优先级：`DSH_DESKTOP_NODE`/`npm_node_execpath` 覆盖 → 内置 node（`build/node/<平台-架构>`，`npm run fetch:node`）→ Electron 内嵌。红线：

- 内置独立 Node 是**无弹窗方案**根基（Console 子系统 + CREATE_NO_WINDOW 整树继承无窗口控制台；Electron GUI 子系统无控制台可继承 → 每条命令弹窗）——**勿移除**。安装器与核心共用同一 runtime，`windowsHide:true` 全链路。
- **版本探测读 `.version` 标记文件**（fetch-node.js 与二进制同事务写入、随包分发），不再同步 spawn `node --version`（曾占每次核心 spawn 180–760ms 冷启动，AV 扫描首次进程诞生）；标记缺失/解析失败才回退 execFileSync 探测；`dshRuntime()` 结果进程级记忆化。
- spawn 参数固定带 `--expose-internals`（放 bin.js 之前）：rc.7+ 核心 HMR 硬要求，没有它核心启动后崩死；对新老核心安全、无需门禁。
- **核心保持 100% 原始，绝不打补丁**；原生包全是 NAPI（引入 NAN 包会破坏内置 Node 方案）。
- **URL 提取必须保完整 token**（`url-extract.js`）——改 URL 相关先跑 `node scripts/test-url-extract.js`，绝不要改回"只到端口"。

PE 子系统分析、fetch-node 细节 → [docs/agents/install-and-update.md](docs/agents/install-and-update.md) §1b。

### 1c. 继承终端 Profile（设置"继承终端 Profile"默认开）

主进程 spawn DSH **之前**跑用户登录 shell 导出环境变量合并进 `childEnv()`（mac 从 Dock 启动是裸环境，MCP 起不来）。语义 = **用户环境优先、Profile 只补缺**，但 Profile 的 PATH **前置**；Windows 跳过。开关 `inheritTerminalProfile` 存 `update-settings.json`，切换后下次 DSH 重启生效。

### 2. 客户端插件挂载（`prepareDesktopPlugin` + `--patch`）

红线：

- patch 新增行用 **`- insert:`（值必须是列表）**，普通 `- id:` 是覆盖；写成单映射核心 exit 1。`--patch` 必须放 `--profile` **之前**。
- client bundle 必须经 `window.__ModuleLoader__.load({id, factory})` 注册；`package.json` 的 `exports` 必须含 `"./package.json"`；访问 `ctx.slots` 必须 `exports.inject = ["slots"]`。
- 设置导航图标：MutationObserver 打标 + CSS mask 替换齿轮；sync 必须**早退 + 跳过冗余写**（否则流式输出期间每秒几十次全文档扫描）。

挂载机制、bundle 正确格式 → [docs/agents/plugins-and-market.md](docs/agents/plugins-and-market.md) §2。

### 2b. 内置插件市场（dshmarket，`prepareBundledMarket`）

红线（全部实测大坑）：

- 从 asar 复制**必须用逐项 asar 安全原语**（`copyDirRecursive`）——`fs.cpSync` 递归抛 ENOTDIR；暂存失败**非致命**（勿改回 throw）。
- `allowRestart: false` 必须带，**用户自装市场也不例外**（覆盖行强制；否则替身核心孤儿 + 端口死锁）。
- 用户已自装时**绝不重复挂载**（`- insert:` 是无条件追加）；自装检测**先于** `bundleMarket` 开关。
- 核心 ≥0.1.2 自动挂载 profile 包 → 用覆盖行；0.1.1.x 维持 `- insert:`。**两个版本门禁别合并成无条件覆盖行**（0.1.1.x 上覆盖行找不到目标，市场消失）。
- 只暂存 dshmarket + js-yaml + undici + argparse 四包；**不要**把 `@deepseek-ai/*` 拷进 profile（核心包第二实例）。

三态返回、收养外部重启、spawnSerial 代际校验、exit 晚到常态、taskkill 兜底、插件故障自动恢复（证据窗两条铁律）、e2e 钩子 → [docs/agents/plugins-and-market.md](docs/agents/plugins-and-market.md) §2b。

### 2c. 鲸港 Web 引导插件（whaleharbor-promo）

红线：`dsh.bundle` 清单勿删（收录门槛）；发布走 **`whaleharbor-promo-v*` 标签**（裸 `v*` 已被桌面壳构建占用），npm 走 OIDC Trusted Publishing（Node 24 勿降 20）；下载链 SHA-256 校验失败**隔离坏文件**（尺寸匹配短路会死循环）；架构探测走 `env.archProbe` 竞态 + 服务端 resolving 阶段重选资产；镜像表/30s 超时/arm64 资产规则与 main.js 是**两份拷贝**，改动必须两边同步。

全部细节 → [docs/agents/plugins-and-market.md](docs/agents/plugins-and-market.md) §2c。

### 3. Electron ↔ DSH 通信（三条通道）

| 通道 | 方向 | 用途 |
|---|---|---|
| `preload` 的 `dshDesktop.*` IPC | 渲染进程→主进程 | 窗口控制、设置读写、更新、重启 |
| `dsh:update-state` 事件 | 主进程→渲染进程 | 推送版本/设置状态给插件 UI |
| **RPC 桥** `127.0.0.1:<随机端口>` | DSH Host 进程→主进程 | `bridge.register` / `notify.show` / `tray.setMenu` / settings KV / `window.*` / 浮窗 |
| **反向事件通道** | 主进程→DSH Host 进程 | 托盘点击/壳事件回投 |

红线：

- **只有主 agent 才能通知**（`isSubagent()` 过滤 session header）；`approvalPending` 的清零也必须在过滤**之后**（subagent 事件曾误清托盘"待确认"）。
- 桥安全模型：仅 127.0.0.1 + 每启随机端口/token + 外部 Origin 403 + 4KB 上限 + 焦点抑制；**桥始终监听**（勿按 taskNotify 门控）；`force:true` 只绕焦点抑制；legacy `{kind,summary}` 路由与未知 kind 丢弃行为不回归。
- `writeSettings`/`pluginSettingsSet` 必须合并 `readRawSettings()` 的 **raw 对象**（`readSettings()` 定形视图会擦掉 plugins 桶）；写失败经 IPC 返回 `writeError` 给设置页提示。
- 浮窗是壳的资产、随核心代际关停；主窗口真关闭必须 `closeAllFloatWindows()`（否则 window-all-closed 永不触发、应用退不出去）。
- 插件设置 UI 唯一扩展点 = 核心 `settings.section` 整页槽；**刻意不做行级 schema 层**（勿重新引入）。
- 主窗口有 `will-navigate` 防护：只放行 `file:` 与 `127.0.0.1|localhost:<port>/`（任意 path，兼容 token 跳转），其余 preventDefault——preload 桥不能被带去外部源。

协议全文（notify/tray/KV/window.*/事件总线/浮窗/生命周期/导航防护）→ [docs/agents/rpc-bridge.md](docs/agents/rpc-bridge.md)。

### 4. 窗口控制条（沉浸式，不重叠）

红线（全部实测大坑，勿退回旧方案）：

- 控制条从侧栏右缘开始（JS 测量），侧栏通顶；**不要**"整 AppFrame 下移"方案。
- 拖拽区是**细条 + `topClearance()` 运行时量高**，勿改回整条 36px；主条 clamp 6–16px 上限是故意的；勿给侧栏容器加 drag。
- macOS 吞点击坑：容器不带 app-region，独立细条承载 drag，按钮显式 no-drag。
- 控制条经 `ReactDOM.createPortal(..., document.body)` 渲染；**绝不手动 appendChild React 管理的节点**（调和 NotFoundError，按钮全灭）。
- 0.1.5+ 金刚键 = 原生风格 28px 角落小组件 + **常量** `margin-right:80px`（常量不测量）；**LEGACY(≤0.1.4) 完全保持现状**；模式判定权威信号 = 版本三元组 ≥0.1.5（DOM 标记只做解析前兜底；版本解析成功后 body 级观察者即 disconnect）。
- Session log 隐藏规则只限桌面（`data-dsh-desktop` 标记）；原生逃生通道（Ctrl+M/W、mac 编辑菜单角色）必须保留。
- `sync()` 测量**先读后写 + rAF 合并 + 侧栏失联自愈**（2026-09-16 优化，测量语义未动）。

完整方案与废弃方案史 → [docs/agents/desktop-ui.md](docs/agents/desktop-ui.md) §4。

### 5. 托盘 + 常驻通知栏

托盘图标在**开启设置当下**创建（勿只在关闭时建）；macOS 用模板图 `tray-iconTemplate(.png/@2x.png)`；一切退出路径先 `isQuitting = true`；托盘内置「重启核心」（Ctrl+Alt+R）与设置页按钮同一链路，`restartDSH()` 忙时静默 no-op 返回 false。细节 → [docs/agents/desktop-ui.md](docs/agents/desktop-ui.md) §5。

### 6. 阻止休眠 / 任务通知 / 设置持久化

- 阻止休眠：`powerSaveBlocker` prevent-app-suspension；设置项全部存 `%APPDATA%\...\update-settings.json`。
- **`parseSettingsText`（settings-json.js）剥 UTF-8 BOM 勿删**——一个 BOM 曾让全部设置静默回落默认值（2026-09 实测；行为锁在 `scripts/test-settings-json.js`）。**脚本写 UTF-8 一律 BOM-free**：`[System.IO.File]::WriteAllText($p, $text, (New-Object System.Text.UTF8Encoding($false)))`。
- BOM 的第二个受害者是 profile 插件的 `package.json`（typert-loader 裸 JSON.parse → 核心 exit 1，plugin-recovery 归因为系统包、不误卸）。

### 6b. 核心更新渠道（稳定版 latest / 体验版 next / 实验版 alpha）

`coreChannelTag()`/`coreSpec()` 把渠道映射为 npm dist-tag；**安装、版本检查、自动更新全走当前渠道**；`DSH_DESKTOP_SPEC` 优先。渠道暂无发布版本 → `queryLatest` 返回 null → 显示"已是最新"，不报错。切换渠道立即重查刷新显示。UI 文案在 client.js 的 `CORE_CHANNELS`/`CHANNEL_LABEL`。

### 6c. 界面 i18n（locales.js + 内嵌副本 + sync 守卫）

- **唯一源 = `locales.js`**：纯函数模块导出 `t(key, locale, fallback?, vars?)` + `detectLocale(acceptLanguage)` + `SUPPORTED_LOCALES`（`["zh-CN", "en-US"]`，新增语种先扩这里再加词典）；未知 key 永远不抛、走 `fallback` → 默认 locale → key 本身（可定位的「红色」调试位）；不支持的 locale 全部回落到 `zh-CN` —— **永远不要**把不在 SUPPORTED 列表的 locale 直接透传给用户（暴露没翻译的语种比强行翻译更糟）。
- **三处必须内嵌副本**：`splash.html`、`dsh-desktop-plugin/client.js`、以及任何未来加的"不能 `require()` 的渲染端"。每个副本顶部都带 `I18N = { ... }` 副本 + 极简 `t()` 函数，**与 `locales.js` 字节级同步**。CI 守卫 = `scripts/check-i18n-sync.js`：用 brace+string-aware extractor 抓出每个副本的字典，逐 key 与 `_DICTIONARIES` 比对；任何 drift 立刻红。改 i18n 三步：① 改 `locales.js` 源；② 同步复制到所有内嵌副本；③ 跑 `npm test`（含 `check-i18n-sync`）确认绿。
- **locale 三处下发**：① `app.getLocale()` → `currentLocale()` → `getThemeSync().locale` → splash 在首帧前消费，避免主题 + 语言双闪烁；② `pushUpdateState().locale` → renderer 侧 `useLocale()`；③ `<html lang>` 由 renderer 同步设、`registerSettingsNavIcons` 监听 `MutationObserver` 在 locale 切换时清旧 marker 重匹配。`DSH_DESKTOP_LOCALE` 环境变量覆盖系统 locale（CI / 调试用）。
- **DSH slot label 是注册时一次性**：ctx.slots.register 的 `label` 字段由 DSH 内部缓存、不响应运行时 locale 切换。slot 注册时用 `resolveInitialLocale()` 拿当前语种——**优先走 `getThemeSync().locale`**（sendSync IPC，注册时刻唯一可靠的同步信号；`<html lang>` 在 DSH 文档刚加载时尚未就绪，异步 `getUpdateState` 更没回来，曾导致 en-US 用户 slot label 永远落 zh-CN）；运行时切语种需要重启 DSH 才生效（**刻意保留**，避免 DSH 内部多处缓存 label 不一致）。设置 nav 行匹配（`registerSettingsNavIcons`）则完全跑 `MutationObserver`，每次按 `<html lang>` 当前值重算标签、不匹配即摘除旧 marker。
- **locale 切换不重启壳**：locale 变化仅推送 `dsh:update-state.locale` + `dsh:theme.locale`；壳进程本身不动；renderer 自己重新渲染。
- **i18n 测试必锁**：新增 key 必须在 `scripts/test-locales.js` 里加断言（至少 zh-CN + en-US 两条），否则该 key 实际是"默默未翻译"。

### 6d. 电池友好（powerplan.js + powerMonitor + renderer 电量上报）

- **唯一源 = `powerplan.js`**：`decidePowerPlan({onBattery, levelPercent}, mode)` 纯函数（`mode ∈ {"auto","lowpower","off"}`），`LOW_BATTERY_THRESHOLD === 20`（exclusive：`20%` 不算低电）。无效输入永不抛，未知 mode 回落到 `"auto"`。`formatPowerHint(plan, locale)` 给托盘 tooltip 用，⚡ 前缀写在 helper 里（不在词典），保证各语种一致；电量未知时降级短标签 `power.lowpower.short`（绝不渲染 `?%` 或裸 `{level}` 占位符）。
- **三档语义不可改**：auto = 未插电 + 电量 < 20% 时低功耗；lowpower = 强制低功耗；off = 强制正常。**auto 永不主动把电池良好的笔记本降级**（兜底：`levelPercent=null` = 电量未知 = 始终 normal，绝不误报）。
- **主进程没有电量 API（2026-09 对照 electron.d.ts 实证）**：`powerMonitor` 的电池面只有 `isOnBatteryPower()`（方法）+ `onBatteryPower`（属性）+ `on-battery` / `on-ac` 两事件；**不存在** `getBatteryLevel`、`isOnBattery`、`battery-changed`（草稿调用过这些幻影 API，auto 静默失效——勿再引入）。**电量唯一来源 = renderer 上报**：splash 启动即报一次、DSH 长驻页面订阅 `chargingchange`/`levelchange` 持续报，走 `dsh:batteryReport` IPC（入口校验：非法形状丢弃、电量钳 0–100）；未上报前安全默认 normal。**只在 mode 变化时调 `refreshTrayTooltip()`**（setToolTip 触发平台重绘，别刷屏）。
- **两条广播路径**：① `pushUpdateState().powerPlan` 给 renderer（设置页「当前：…」提示 + 托盘 tooltip）；② `childEnv().DSH_DESKTOP_POWER_PLAN` 给 spawn 出去的 DSH 核心（whpromo 等下游插件启动期读 env；本期只发信号，whpromo 实际轮询逻辑在其独立仓库独立发版）。**env 是 boot-time 信号**，运行时切档靠 IPC。
- **IPC `dsh:setPowerSaveMode`**：白名单 `["auto","lowpower","off"]`，无效值在 read 端 fall back（永不 reject —— 与 `coreChannel` 同语义）。
- **测试必锁**：`scripts/test-powerplan.js` 覆盖三档 × 边界（19% / 20% / null level / 无 level 字段）+ tooltip 本地化与短标签分支，缺一不可；真机闭环 `npm run test:e2e:i18n-power`（种子 lowpower → 日志 + spawn env 断言；`DSH_DESKTOP_LOCALE=en-US` → `ui locale: en-US`）。**e2e 脚本红线：spawn 必须带 `DSH_DESKTOP_USER_DATA`/`DSH_DESKTOP_HOME` 隔离——漏传会撞用户真实单实例锁静默退出，隔离日志永远为空（2026-09 实测大坑）。**

### 7. 图标

源 = `build/whale.svg`；`npm run icon` 用 `@resvg/resvg-js` 光栅化（**不要用 Electron 离屏渲染**，>128px 崩）；electron-builder 自动转 .ico/.icns；Windows 任务栏图标开发态显示 electron 默认（固有限制）。

### 8. 启动页 = 错误面板 + 进度（splash.html）

红线：**CSP 必须含 `script-src 'unsafe-inline'`**；一切启动/崩溃/安装失败走页面错误面板（`dsh:startupError` + `dsh:startupChoice`，可复制错误），**绝不弹原生模态框**；`did-fail-load`/`render-process-gone` 回退 splash；安装进度用共享**异步** size meter（勿改回同步 dirSizeSync 轮询——曾烧主进程 40% CPU）；端口占用预检 + 换端口面板；安装"成功"但定位不到核心时弹错误面板（勿静默返回）。**下载黑洞节点四道防线**（120s fetch timeout 勿改回 30s、逐行输出、看门狗只在 `downloadStarted` 后武装、更新前也探测镜像）→ [docs/agents/desktop-ui.md](docs/agents/desktop-ui.md) §8。

### 9. 更新安全（先停 DSH 再装）+ 三重防线

- 更新 = `killDSH()` → 安装（带进度）→ `restartDSH()`；**只重启核心，不重启壳**；失败面板提供 重试/换镜像/用当前版本继续/退出。
- **三重防线勿删**：① park 到 `dsh.prev`，回滚用**换名** rename（**绝不能先 rmSync 再 rename**——Windows delete-pending 实测 3/3 失败）；② 冒烟启动 `smokeBootDSH` 三必须（一次性 home、剥 `DSH_DESKTOP_PORT`、探针用带 token URL）；③ 冒烟失败自动回滚（killTree 等死透再做文件手术）。
- 安装器按目标版本线自动选 npm/pnpm（≥0.1.2 → npm；`DSH_DESKTOP_INSTALLER` 覆盖；裸机无 npm → pnpm）。
- **`prepareManagedDir` 每次删 `pnpm-lock.yaml` 勿删**——lockfile 是 peer 偏斜事故（9b）的直接载体。

事故复盘与全部细节 → [docs/agents/install-and-update.md](docs/agents/install-and-update.md) §9。

### 10. 单实例（双击图标防双开）

`requestSingleInstanceLock()` 失败时**必须用 `gotSingleInstanceLock` 标志跳过整个 whenReady 引导**（只 `app.quit()` 不够——第二实例仍会建窗 + 起 DSH 撞端口）；第二实例由第一实例的 `second-instance` 事件恢复窗口。

### 11. 壳自身自更新（GitHub Releases）

`queryShellLatest` 逐源查（直连 → `SHELL_MIRRORS` 镜像前缀）；`shellAssetForPlatform`（规则在 `shell-asset.js`，**勿用裸 `.find(/\.dmg$/)` 误拿 arm64**）；**下载完成必须校验 GitHub 资产 `digest`（SHA-256）才允许启动安装**——镜像（gh-proxy.com）是社区代理，不可信任；`asset.name` 过 `path.basename()` 再拼 temp 路径；`openPath` 失败（杀软拦截）**不退出应用**、错误回设置页；`compareVersions` 只用于壳版本。**HTTP 头 UA 必须用 `SHELL_UA`（ASCII），严禁塞 `APP_NAME`**——APP_NAME 含中文，HTTP 头不允许非 latin1，塞进去 `https.get` 同步抛 `ERR_INVALID_CHAR`：v1.7.0 品牌更名起潜伏（手动检查被 `.catch` 吞成"检查失败"）、1.9.4 的 60s 后台检查定时器引爆成开机崩溃面板；定时器驱动的路径一律加防御性 catch。发布 = `v*` 标签 → build-installers.yml（CI 同时上传 `.blockmap`/`latest.yml` 备用）。**build-installers 发布 job 用内置 `GITHUB_TOKEN`（工作流顶部 `permissions: contents: write` 已授权），不依赖任何仓库 secret——别改回 `secrets.GH_TOKEN` 个人 PAT（v1.10.0 事故：secret 未配/失效 → gh `401 Bad credentials`，Release 发不出去）**。**镜像表/超时与 whaleharbor-promo 是两份拷贝，改动两边同步**。细节 → [docs/agents/install-and-update.md](docs/agents/install-and-update.md) §11。

## 开发 / 运行 / 验证

```bash
npm install          # 装依赖（首次）
npm test             # 全部零依赖单测（url-extract / plugin-recovery / core-version /
                     #   shell-asset / settings-json / locales / powerplan /
                     #   check-i18n-sync / 宣传页守卫）——CI 的 ci.yml 每次 push/PR 都跑
npm run icon         # 重新生成图标（改了鲸鱼配色/边距后）
npm start            # 开发运行（frameless 窗口）
npm run fetch:market # 下载内置插件市场到 build/market-plugin/（dist:* 会自动跑）
npm run fetch:pnpm   # 下载内置 pnpm 到 build/pnpm/（dist:* 会自动跑；dev 下不跑则安装回退 npm）
npm run fetch:node   # 下载内置 Node 到 build/node/
npm run pack         # 打包目录到 dist/<平台>-unpacked/（会先 fetch 三件套）
npm run dist:win     # NSIS 安装包（dist:mac / dist:linux / dist:portable 同理）
```

**测试分层（2026-09-16 起）**：

- **CI 可跑**：`npm test` 全部零 npm 依赖，`.github/workflows/ci.yml` 在每次 push/PR 上跑它 + 对所有追踪 .js 的 `node --check` 语法清扫。**改正则/版本语义/设置解析相关代码，测试必须先过。**
- **必须真机（非沙箱，绝不进 CI）**：`npm run test:e2e:recovery`（插件故障自愈全链路，需 GUI + taskkill）、`npm run test:e2e:i18n-power`（i18n locale + 电源计划全链路）、`npm run test:e2e:float`（浮窗，需对活壳实例 + `DSH_DESKTOP_NOTIFY_TOKEN`）、`npm run repro:restart-race`、`npm run repro:plugin-failure`。运行时路径默认自动探测（打包安装 / dev 的 `build/node`），可用 `DSH_DESKTOP_TEST_NODE`（node 可执行文件）与 `DSH_DESKTOP_TEST_MANAGED`（DSH 托管目录）覆盖。

**开发运行注意**：

- 默认端口 3080。**如果浏览器里开着另一个 DSH（当前会话），必须先 `$env:DSH_DESKTOP_PORT="3100"` 隔离端口，否则新实例绑定失败**。
- 启动时只隔离端口即可（`DSH_DESKTOP_PORT`），**不要用 `DSH_DESKTOP_HOME` 隔离环境**——用户要看真实 `~/.dsh` 数据。
- 启动/清理进程时**绝对不要碰 3080 的进程**（那是当前运行环境，杀了会中断会话）。只清理桌面应用自己的进程（匹配 `dsh-desktop` / `electron.exe .` / `win-unpacked`）。

### 验证一个改动（推荐顺序）

1. `npm test`（含 node --check 全量语法清扫；本地可只跑 `node --check <改动的js>`）。
2. 改 `dsh-desktop-plugin/` 后：重启应用（`prepareDesktopPlugin` 启动时重拷插件，**必须重启整个应用**才生效）。
3. 改主进程 IPC/设置后：`npm start` 重启验证。
4. 改图标后：`npm run icon`，`npm run pack`，检查 `dist/win-unpacked/*.exe` 图标。
5. 涉及重启/更新链的改动：真机跑 `DSH_DESKTOP_E2E_RESTARTS` 回归钩子。

## 打包已知问题

- **winCodeSign 符号链接失败**：Windows 未开开发者模式时，7z 解压 winCodeSign 无法创建 symlink。解决：开开发者模式；或 `signAndEditExecutable: false` 跳过资源编辑（exe 没图标），再 `node scripts/embed-exe-icon.js <exe>` 手动嵌图标（rcedit 缓存路径可用 `DSH_DESKTOP_WINCODESIGN_CACHE` 覆盖，默认探测 `%LOCALAPPDATA%\electron-builder\Cache\winCodeSign`）。
- **`CSC_IDENTITY_AUTO_DISCOVERY=false`** 跳过代码签名（无签名证书时需要）。注意该开关**不影响 `CSC_LINK`**——配了仍会签名。
- **macOS 未签名导致"已损坏/无法验证"**：三层方案——① `scripts/mac-sign.js`（afterPack）ad-hoc 自签名兜底（"已损坏"→"无法验证开发者"，永不 fail build）；② 自制自签名证书（只在信任它的 Mac 上免提示）；③ 付费 Apple Developer：Developer ID + notarytool 公证（CI 的 CSC_LINK/APPLE_* secrets 已全部接好，配就配全套，只配一半会构建失败；`--deep` 路径仅 ad-hoc 兜底在用，真配证书后走 electron-builder 原生流程）。Windows 侧目前无代码签名（SmartScreen 警告）。
- asar 内容验证：`node node_modules/@electron/asar/bin/asar.js list dist/win-unpacked/resources/app.asar`。
- **`build.files` 是逐文件白名单**——main.js 新增本地 require 模块必须逐个登记（core-version.js / shell-asset.js / settings-json.js / plugin-recovery.js / url-extract.js 均已登记）；漏登记 = 开发版正常、打包版 `Cannot find module`。

## 宣传页（docs/index.html，GitHub Pages）约定

- **硬性要求：全文零表情符号**——图标一律内联 SVG（Lucide 风格），改完跑 `node scripts/check-docs-page.js`（已并入 `npm test`）。
- 版本/更新日志浏览器端自动 fetch GitHub Releases；**离线兜底内容（`latestVer`/`rel.fallback`）需在发版时手动同步**（曾落后 2 版）。
- 中英双语：`data-i18n` + `I18N` 词典，`localStorage["dsh-desktop-lang"]`；新增文案必须双语同步。
- 视觉验证：无头 Edge 截图需非沙箱；`--dump-dom` 验证动态内容更可靠。

## 常规开发命令

```bash
npm test                 # 全部单测 + 宣传页守卫
node --check <file>      # 单文件语法检查
npm start                # 运行
npm run pack             # 打包目录
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_DESKTOP_PORT` | 指定端口（默认 3080） |
| `DSH_DESKTOP_HOME` | 覆盖 DSH_HOME（默认 `~/.dsh`；调试隔离用，日常勿设） |
| `DSH_DESKTOP_USER_DATA` | 覆盖整个 userData（托管安装/pnpm store/设置；与 HOME+PORT 组合可完整模拟新用户首启，单实例锁也随 userData 隔离） |
| `DSH_DESKTOP_NPM_REGISTRY` | npm 镜像（默认 npmmirror，国内网络需要） |
| `DSH_DESKTOP_NPM_CACHE` | npm 缓存目录 |
| `DSH_DESKTOP_SPEC` | 覆盖 DSH npm 规格（默认按「更新渠道」tag 组成；设了则优先，调试/CI 用） |
| `DSH_DESKTOP_TIMEOUT` | 启动看门狗超时秒数（默认 1800s） |
| `DSH_DESKTOP_NOTIFY_TOKEN` | **e2e/调试钩子（生产绝不设置）**：钉住 RPC 桥 token |
| `DSH_DESKTOP_INSTALL_ESTIMATE_MB` | 安装进度条估算总大小（默认 250MB） |
| `DSH_DESKTOP_INSTALL_STALL_SECONDS` | 下载无进展判定秒数（默认 120s，超时 kill npm） |
| `DSH_DESKTOP_SHELL_REPO` | 壳自更新的 GitHub 仓库（默认 `MoonlitDropOfBlood/DSH-Desktop`） |
| `DSH_DESKTOP_SHELL_MIRRORS` | 壳自更新镜像前缀（逗号分隔，空串禁用；默认 gh-proxy.com） |
| `DSH_DESKTOP_NODE` | 用真实的 Node 二进制覆盖 DSH 运行时（优先于内置 node 与 Electron 内嵌；调试用） |
| `DSH_DESKTOP_NODE_VERSION` | `fetch:node` 下载的内置 Node 版本（默认 24.19.0） |
| `DSH_DESKTOP_NODE_MIRROR` | 内置 Node 二进制镜像（默认 npmmirror，回退 nodejs.org） |
| `DSH_DESKTOP_NPM` | 覆盖 npm 回退路径要 spawn 的 npm 可执行文件绝对路径 |
| `DSH_DESKTOP_MARKET_VERSION` | `fetch:market` 下载的 dshmarket 版本（默认 1.15.0） |
| `DSH_DESKTOP_PNPM_VERSION` | `fetch:pnpm` 下载的内置 pnpm 版本（默认 10.33.0） |
| `DSH_DESKTOP_INSTALLER` | 强制核心安装器：`npm` / `pnpm`（默认自动，见 §9c） |
| `DSH_DESKTOP_SMOKE_SECONDS` | 更新冒烟启动判定秒数（默认 90s；生产绝不设置） |
| `DSH_DESKTOP_E2E_RESTARTS` | e2e 回归钩子：每次打开 DSH 页后自动跑 N 次真实重启链（生产绝不设置） |
| `DSH_DESKTOP_TEST_NODE` | 真机 e2e/repro 脚本的 node 可执行文件覆盖（默认自动探测） |
| `DSH_DESKTOP_TEST_MANAGED` | 真机 e2e/repro 脚本的 DSH 托管目录覆盖 |
| `DSH_DESKTOP_WINCODESIGN_CACHE` | embed-exe-icon 的 winCodeSign 缓存根覆盖 |
| `DSH_DESKTOP_LOCALE` | 覆盖界面 locale（默认 `app.getLocale()`；值必须在 locales.js 的 SUPPORTED 列表内；CI/调试用） |
| `DSH_DESKTOP_POWER_PLAN` | **下游只读（主进程 spawn 时写入）**：当前生效的电源计划（`lowpower` / `normal`）；whpromo 等插件启动期读 env 决定是否降级心跳轮询 |
| `WHPROMO_*`（REPO/MIRRORS/RELEASE_JSON） | whaleharbor-promo 插件环境变量（见 docs/agents/plugins-and-market.md §2c） |
