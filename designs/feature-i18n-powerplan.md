# 功能 15 + 16 实施方案：splash/设置 i18n + 电池友好模式

## 总目标
- **15**：把 `splash.html` + 设置页（`dsh-desktop-plugin/client.js`）的中文文案抽成 i18n 词典，
  跟随系统 locale（zh-CN / en-US）切换，沿用 `docs/index.html` 的 `data-i18n` + `I18N` 词典模式。
- **16**：基于 Electron `powerMonitor` 探测电池状态，笔记本用户
  在「未插电 + 低电量（默认 <20%）」时自动降级：暂停桌面宠物浮窗动画、拉长 whpromo 轮询间隔、
  设置「阻止休眠」默认开 → 关时仅警告一次。提供手动「低功耗模式」开关（覆盖自动判定）。

## 设计原则（红线）
1. **不破坏现有桥面**：i18n 通过现有 `dsh:getThemeSync` 桥的扩展字段 `{ preference, systemDark, locale }`
   一并下发；不新增 IPC（splash 是单文件可直读 `<html lang>`）。
2. **settings 字段命名延续现有约定**：`preventSleep` 是「阻止休眠」开关，新字段 `powerSaveMode`（lowpower|auto|off）独立。
3. **客户端插件必须可独立运行（无壳）**：`bridge()` 缺位时 i18n 不能崩，沿用 `client.js` 既有的 `hasBridge()` 守卫。
4. **不引入 npm 依赖**：i18n 是纯数据 + 一个 `t(key, locale)` 纯函数模块；自研 `locales.js`。
5. **测试锁定行为**：新增 `scripts/test-locales.js` 与 `scripts/test-powerplan.js`，并入 `npm test`。

---

## 实施步骤（红绿重构）

### 第 1 步：纯模块 `locales.js`（t 函数 + 词典）
**接口**（从测试倒推）：
```js
const { t, SUPPORTED_LOCALES, detectLocale } = require("./locales.js");
t("splash.title", "en-US")        // → "WhaleHarbor"
t("splash.title", "zh-CN")        // → "鲸港 WhaleHarbor"
t("unknown.key", "en-US", "fallback")  // → "fallback"
detectLocale("zh-CN,en;q=0.9")    // → "zh-CN"（白名单优先，否则按质量降序，再否则默认 zh-CN）
```

**结构**：
```
locales.js                  # 模块导出
locales/
  zh-CN.js                  # 中文词典
  en-US.js                  # 英文词典
```

**测试**（先 RED）：
- 已知 key 命中两语种各自正确
- 未知 key 走 fallback 字符串
- 空 key / null locale 走默认值
- `detectLocale` 解析常见 Accept-Language
- 不在 SUPPORTED 列表的 locale 降级到默认

### 第 2 步：bridge 透传 locale
**改动**：
- `preload.js`：`getThemeSync` 返回新增 `locale` 字段（主进程从 `app.getLocale()` 取）。
- `main.js`：设置 IPC `dsh:getThemeSync` 同步返回 `{ preference, systemDark, locale }`。
- 现有调用方（splash、client.js）零侵入升级。

**测试**：因桥面已锁定行为（已有 `getThemeSync`），扩展字段属**非破坏性加法**——不动 `test-*`，
但 `preload.js` 端用 `node --check` 语法清扫即可。

### 第 3 步：`splash.html` 文案 i18n 化
**改动**：
- 在 `<script>` 里硬编码一份与 `locales.js` 同源的 `I18N = { "zh-CN": {...}, "en-US": {...} }`（避免跨进程读文件）。
- 新增 `applyLocale(locale)`：把所有 `data-i18n="..."` 节点的 `textContent` 替换为对应翻译。
- 桥就绪时用 `bridge.getThemeSync().locale`，否则读 `<html lang>` 兜底。
- `<html lang>` 初值由主进程 IPC 渲染前注入（已在 `createWindow` 后 → 加载 splash → IPC 异步可达）；
  改为在 splash 顶部 IIFE 里默认 `document.documentElement.lang = 'zh-CN'`，再桥就绪后覆盖。

**范围**：
- 标题、副标题
- 状态初始文本「正在启动…」
- 标题条按钮 `title`（最小化/最大化/关闭）
- 错误面板标题/详情、复制按钮 label
- 端口输入提示、复制完成提示
- 日志面板无需翻译（DSH 原生日志）

### 第 4 步：`dsh-desktop-plugin/client.js` 文案 i18n 化
**改动**：
- 新增 `i18n.js` 子模块（或直接内联小词典，因插件 bundle 是 IIFE 自包含）。
- 设置入参：`{ locale: state.locale }` 从 `useUpdateState()`。
- 范围：
  - 窗口控制条 `title`（min/max/close）
  - 设置页 SectionHeader 文案（核心 / 桌面版 → Core / Desktop）
  - 各 ToggleRow `label`（自动更新 / 常驻通知栏 / 阻止休眠 / 任务通知 / 继承终端 Profile / 插件市场 / 允许插件浮窗）
  - 各 hint 文本
  - Toast 文案
  - 渠道下拉 `label`
  - 快捷键提示（按平台语言自适应不变）

**Locale 注入方式**：`pushUpdateState()` 多带一个 `locale: app.getLocale()` 字段；
`useUpdateState` 不需改（已透传所有字段）。

### 第 5 步：托盘/菜单 i18n
**改动**（`main.js`）：
- 托盘菜单 + 应用菜单在 `buildMenu` 时按 `app.getLocale()` 选文案（白名单 zh-CN/en-US，其它落 zh-CN）。
- `trayContribs` 来自插件的菜单项由插件自己负责多语（壳只负责壳自己生成的菜单）。
- `showMainWindow` 通知标题、托盘"重启核心"等内置项统一走 `t()`。
- `Tray.setToolTip` 同步。

**测试**：构建期单测无法覆盖 Electron Tray 的实际渲染；只测 `t()` 函数 + `buildMenu` 调用时传入的 key。
手测：开机切换系统语言看托盘是否同步。

### 第 6 步：电池友好（`powerplan.js` 纯模块）
**接口**（从测试倒推）：
```js
const { decidePowerPlan, formatPowerHint } = require("./powerplan.js");
// decidePowerPlan({ onBattery, levelPercent }, "auto")
//   → { mode: "lowpower" | "normal", reason: "..." }
//   auto:  level<20% 且 未插电 → lowpower；否则 normal
//   lowpower：恒 lowpower
//   off：恒 normal
// formatPowerHint(state, locale) → 给托盘 tooltip / 错误面板用的本地化字符串
```

**主进程接入**：
- 新增 `powerMonitor` 监听 `on-battery-changed` 与 `battery-changed`（Electron 5+ 均支持，desktop-only）。
- 启动时初始化一次 + 后续每次变化重新决策。
- 决策后：
  - **通知 DSH 子进程**（新增 `powerPlan` env 变量：DSH_DESKTOP_POWER_PLAN=lowpower/normal）
    - whpromo 自检环境（避免主进程 → 子进程 IPC 路径）
    - 由子进程启动时读 env；运行期轮询策略见后
  - **暂停浮窗动画**：经 bridge 反向事件 `power.plan { mode }` 推给插件（client 浮窗自身响应）
  - **更新托盘 tooltip**：附「⚡ 低功耗」标识

**设置项**（`update-settings.json`）：
- `powerSaveMode: "auto" | "lowpower" | "off"`，默认 `auto`。
- 接入 `readSettings()` / `pushUpdateState()` / IPC `dsh:setPowerSaveMode`。

**whpromo 接入**（外部插件代码，主壳**只发信号**）：
- 文档里新增一段：whpromo 启动期读 `DSH_DESKTOP_POWER_PLAN` env；为 `lowpower` 时轮询间隔拉长到 60s（活动期亦同）。
- **本次提交只做主进程侧**，whpromo 改动在其独立仓库；壳侧通过 CHANGELOG 说明需 whpromo 同步升级。

### 第 7 步：测试锁定
- `scripts/test-locales.js`：`t()` + `detectLocale()` 全断言
- `scripts/test-powerplan.js`：`decidePowerPlan()` 三档位 + 边界（null level、exactly 20%）+ `formatPowerHint` 本地化
- 注册进 `npm test` 链

### 第 8 步：CI / 验证
- `node --check` 全部改动文件
- `npm test` 全绿
- 手测项（CHANGELOG 列出）：
  - 切 Windows/macOS 系统语言为 English → splash + 设置页是否同步英文
  - 笔记本拔电 + 把电量降到 18%（用 Android 模拟器或 macOS `pmset` 模拟）→ 托盘 tooltip 是否出现低功耗标识
  - 设置「低功耗模式」手动开/关/自动 三个档位 → 决策是否符合预期

---

## 不在本期范围
- 第三方插件 i18n（由各插件自己处理；壳只示范）
- 用户手动切换语言 UI（用系统 locale 足够；CHANGELOG 注明 `DSH_DESKTOP_LOCALE` 环境变量覆盖）
- Linux 电池探测兼容细节（`powerMonitor` 行为差异，CHANGELOG 注明 GNOME/KDE 桌面一般 OK）
- whpromo 实际代码改动（独立仓库独立发版；本期只发信号）

## 文件改动清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `locales.js` | 新增 | t 函数 + 词典入口（合并 zh-CN/en-US） |
| `powerplan.js` | 新增 | decidePowerPlan + formatPowerHint 纯函数 |
| `scripts/test-locales.js` | 新增 | 单测 |
| `scripts/test-powerplan.js` | 新增 | 单测 |
| `package.json` | 改 | `test` 加两个新单测；`build.files` 白名单加 `locales.js` + `powerplan.js` |
| `preload.js` | 改 | `getThemeSync` 返回字段加 `locale` |
| `main.js` | 改 | `pushUpdateState` 加 `locale` 与 `powerPlan`；新增 IPC `dsh:setPowerSaveMode` + `dsh:getPowerPlan`；`powerMonitor` 监听 + env 透传；托盘/菜单文案走 `t()`；新增 `readSettings` 字段 `powerSaveMode` |
| `splash.html` | 改 | 内嵌 I18N + applyLocale + data-i18n |
| `dsh-desktop-plugin/client.js` | 改 | 内嵌 I18N + 三段 UI 文案走 t() |
| `CHANGELOG.md` | 改 | Unreleased 新增两条 |
| `AGENTS.md` | 改 | § 关键机制补 i18n 红线 + powerplan 红线 |
