# 设计：浮窗锚点 `float.window.*`（桌面宠物 / 悬浮小组件）

状态：**已实现（2026-09-04）**，e2e 15/15 通过（`scripts/e2e-float-window.js`，对隔离实例直调桥）。动机用例是桌面宠物——一个不在主窗口里、始终悬浮在桌面上的形象，根据 DSH 空闲/繁忙切换姿态。同一原语也能支撑迷你状态条、倒计时浮牌、自定义 toast 等场景。

## 0. 一句话

给插件一种「创建并控制小型悬浮窗口」的能力：窗口由壳（Electron 主进程）创建和持有，内容由插件提供，状态经 RPC 桥下行推送、页面交互经反向通道回投——完全复用现有桥的令牌、eventPort、代际清理惯例，不新增信任模型。

## 1. 设计原则（对齐现有桥惯例）

1. **同一信任域**：能调桥就能建窗，不引入新的鉴权；但加一个**用户总开关**（设置页可关，默认开）作为廉价保险。
2. **窗口是壳的资产**：创建后登记进贡献簿，随核心代际清理（`resetBridgeContributions` / exit `report()`）与壳退出统一销毁——绝不留孤儿窗口。
3. **旧壳优雅降级**：`ok:false, error:"unknown method"` = 壳太旧，插件静默降级（与 notify/tray 同一约定）。另在 `bridge.register` 响应里新增 `capabilities: ["float.window", ...]` 数组做干净的特性探测。
4. **窗口不可抢焦点**：固定 `focusable:false` + `showInactive` 语义、`skipTaskbar`、不可调大小——浮窗永远不干扰主窗口输入。

## 2. 窗口形态（固定参数，不接受协商）

| 项 | 值 | 理由 |
| --- | --- | --- |
| frame / titleBar | 无 | 悬浮件标配 |
| transparent | 可选，默认 `true` | 宠物需要异形轮廓 |
| alwaysOnTop | 固定 `true`（level `floating`） | 浮在桌面上；不追「screen-saver」级，避免压住全屏应用的状态条生态位争议 |
| focusable / activatable | 固定 `false` | 永不抢焦点（Windows `showInactive`；mac 对应非激活 NSPanel） |
| skipTaskbar | 固定 `true` | 不占任务栏（macOS 同步不进 Dock） |
| resizable | 固定 `false` | 尺寸只经 create/move 定 |
| clickThrough | 可选，默认 `false` | 纯装饰件可开；实现为 `setIgnoreMouseEvents(true, { forward: true })`——鼠标穿透但页面仍收 move 事件可做悬停感知 |

## 3. RPC 方法（Host 半部调用）

前置：与 `tray.setMenu` 相同——先 `bridge.register` 带 `eventPort`（要收回投事件就必须有）。

### `float.window.create`

```jsonc
// 请求
{ "plugin": "my-pet", "html": "<!doctype html>...",   // 二选一
  "url": "http://127.0.0.1:61039/pet/index.html",      // 二选一
  "width": 160, "height": 160,
  "x": null, "y": null,          // 缺省 = 主屏工作区右下角（留 24px 边距）
  "transparent": true, "clickThrough": false }
// 响应
{ "ok": true, "id": "f-7", "x": 2116, "y": 1340, "width": 160, "height": 160 }
```

- `id` 由壳分配，后续方法都寻址它；响应里的实际 bounds 用于多屏/边界钳制后的校准。
- **`html` 模式（轻量）**：内联 HTML 字符串（≤256KB，`data:` URL 加载，须完整转义编码）。页面与插件之间的全部通信走壳中继（见 §4/§5），受 4KB 桥 body 上限约束。
- **`url` 模式（重量级逃生口）**：仅接受 `http://127.0.0.1:<port>/...`（插件自己的本地服务器——反正 eventPort 已经在跑）。页面由插件服务器直出，插件与宠物页面之间可以自建 WebSocket/HTTP 双向通道，**绕开壳中继与 4KB 限制**，适合富动画、资源加载。壳对这两种模式一视同仁，只是加载方式不同。

### 其余方法

| 方法 | 参数 | 说明 |
| --- | --- | --- |
| `float.window.state` | `plugin, id, state` | 下行推送任意 JSON（≤2.5KB）。语义=**替换最新值**（非队列）：壳缓存它，页面未就绪时暂存、`did-finish-load` 后补发。宠物每秒推 `{pose:"busy", text:"跑着呢"}` 即可 |
| `float.window.move` | `plugin, id, x, y` | 钳制进虚拟桌面工作区后生效（防丢到屏外） |
| `float.window.close` | `plugin, id` | 显式关闭 |
| `float.window.closeAll` | `plugin` | 清掉该插件全部浮窗 |

### 回投事件（经 eventPort，同一令牌信封）

| 事件 | data | 触发 |
| --- | --- | --- |
| `float.window.input` | `{ id, data }` | 宠物页面调 `__dshFloat.send(data)`（≤2KB JSON）——点击宠物、双击等交互 |
| `float.window.closed` | `{ id, reason }` | 渲染进程崩溃 / 系统级关闭；壳同时把窗口从贡献簿移除 |

## 4. 页面契约（插件作者视角）

浮窗加载的页面运行在**极简专用 preload**下（`contextIsolation` + `sandbox` 全开、无 Node），全局只多一个对象：

```js
window.__dshFloat.onState(cb)   // 收壳中继的 float.window.state（html 模式；url 模式自行约定）
window.__dshFloat.send(data)    // 上行 → 反向通道 float.window.input
```

- **拖动宠物零协议**：页面自己写 `-webkit-app-region: drag`（拖把区域）+ `no-drag`（交互点）——原生窗口拖拽，不走任何 RPC。
- 宠物的视觉表现（CSS/SVG 动画、姿势切换）完全在页面内实现；`state` 只推「语义状态」，不推帧。

## 5. 生命周期

| 时机 | 行为 |
| --- | --- |
| 核心重启（`resetBridgeContributions`） | 关闭上一代全部浮窗，等插件随新核心加载后自行重建 |
| 核心死透（exit `report()`） | 同上——插件死了它的宠物必须消失 |
| 渲染进程崩溃 / 系统关闭窗口 | 移出贡献簿 + 回投 `float.window.closed` |
| 壳退出 | 全部销毁（本就是壳的子窗口） |
| 主窗口最小化 / 藏托盘 | **浮窗常驻**（刻意的：宠物不随主窗口消失）；托盘退出才是终点 |

限额：每插件 ≤3 个浮窗、全局 ≤6；超出 `ok:false, error:"too many float windows"`。

## 6. 安全与校验

- 用户总开关 `allowFloatWindows`（默认开，桌面版设置页一个开关行）：关闭时 `create` 返回 `ok:false, error:"float windows disabled"`；已存在的浮窗在开关关闭瞬间全部关闭。
- `url` 白名单：仅 `http://127.0.0.1:<port>/...` 或 `http://localhost:<port>`——拒绝 `file:`、`https:`、局域网 IP（壳不做通用浏览器）。
- 数值钳制：width/height 16–800；x/y 钳进虚拟工作区；`html` ≤256KB；`state` ≤2.5KB（桥 body 总上限 4KB 之内）。
- 浮窗 preload 不暴露 `windowAction`/`pluginSettingsGet` 等任何主窗口桥面——宠物页面攻破也拿不到壳 IPC 面（攻击面 = `__dshFloat` 两个方法）。

## 7. 平台注意

- **Windows**：transparent 窗口记得 `thickFrame:false`（否则方形边角伪影）；`setIgnoreMouseEvents(true,{forward:true})` 即点击穿透+悬停感知。
- **macOS**：`roundedCorners:false`；非激活面板（`focusable:false`）从 Finder 场景拖不出焦点问题；skipTaskbar 即不进 Dock。
- **Linux**：透明依赖合成器，无合成器时退化为方形底板（可接受，不做检测）。

## 8. 壳侧实现要点（预估，未动工）

- `main.js`：`float.window.*` 六个 handler（复用现有桥 handler 表）+ `floatWindows` 贡献簿（`Map<plugin, Set<id>>`，接进 `resetBridgeContributions`/`report()`/退出清理）+ `createFloatWindow()`（约 60 行，纯 Electron 原生参数）。
- 新增 `float-preload.js`（约 15 行，只暴露 `__dshFloat` 两方法）。
- `bridge.register` 响应加 `capabilities` 数组（一处小改）。
- 设置项 `allowFloatWindows`：`readSettings`/`writeSettings` 固定字段 + 桌面版设置页一行开关（照抄「阻止休眠」的模式）。
- 无新依赖。

## 9. 明确不做

- 不做浮窗之间的通信、不做多插件共享同一浮窗。
- 不做远程 URL（见 §6 白名单）。
- 不做浮窗内嵌 DSH Web UI（那是主窗口的事）。
- 不做逐帧视频通道（富内容走 `url` 模式 + 插件自有服务器）。

## 10. 验收清单（实现时照此手测）

1. curl 直调桥：`float.window.create`（html 模式，一个 CSS 小方块）→ 屏幕右下角出现、任务栏无图标、点击主窗口输入框焦点不被抢走。
2. `float.window.state` 推 `{pose}` → 页面动画切换；连推 10 次只保留最新。
3. 页面拖拽区拖动浮窗；交互点点击 → 主日志可见 `float.window.input` 回投。
4. `restartDSH`（Ctrl+Alt+R）→ 浮窗关闭、新核心起、插件重新 create 成功。
5. taskkill 核心（模拟崩溃）→ 12s 收养探测窗口内浮窗已消失，不留孤儿。
6. 设置页关「允许插件浮窗」→ 现存浮窗立即关闭，create 被拒。
7. `clickThrough:true` 的浮窗：点它穿透到桌面；页面仍能感知悬停。
