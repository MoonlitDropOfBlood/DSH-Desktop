# @duke-dsh-plugins/whaleharbor-promo

鲸港 Web 引导插件：把普通浏览器里的 DSH 会话变成「鲸港简版客户端」（独立窗口），同时后台下载完整桌面安装包并提示安装（Web → Desktop 转化漏斗）。

## 工作流程

1. **独立窗口（简版客户端）**：普通标签页打开 DSH 时，Host 探测本机 Chrome / Edge / Brave（Windows：常见安装路径 + `where` 兜底；macOS：`/Applications` 与 `~/Applications` 的 .app；Linux：`which`），以 `--app=<当前页 URL>` 拉起无浏览器 UI 的独立窗口（自动只开一次，localStorage `whprom.appOpened`）。独立窗口内渲染：
   - 顶部胶囊栏：品牌 / 下载进度 / 任务通知开关（浏览器 Notification）/ 全屏 / 收起；
   - 右下角引导卡：客户端预览 + 下载状态机；
   - 侧栏底部「客户端」按钮：随时重开引导卡。
2. **后台下载完整安装包**：发布元信息按 `[WHPROMO_RELEASE_JSON → GitHub API → gh-proxy.com 镜像]` 顺序探测；安装包按 `[browser_download_url → 镜像]` 顺序下载到 `~/Downloads`；完成后用 GitHub 资产 `digest` 做 SHA-256 校验。单请求超时 30s（gh-proxy 冷启动实测 ~17s）。
3. **安装提示**：下载完成引导卡弹出一次「安装包已就绪 — 完整功能需要安装客户端」+ `explorer /select`（macOS `open -R`、Linux `xdg-open`）定位安装包。

已在鲸港桌面客户端内运行时（`window.dshDesktop` 存在）全部 UI 自动禁用。

## 安装（profile 插件）

包内自带 `dsh.bundle` 清单（`cordis.patch.yml` 随包挂载），一条命令即可：

```bash
dsh plugin --profile web add @duke-dsh-plugins/whaleharbor-promo
```

或在 dshmarket 插件市场里一键安装。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `WHPROMO_REPO` | `MoonlitDropOfBlood/DSH-Desktop` | 发布仓库（owner/repo） |
| `WHPROMO_MIRRORS` | `https://gh-proxy.com/` | 镜像前缀（逗号分隔，带尾斜杠）；空串禁用镜像。默认只留 gh-proxy.com——ghproxy.net 实测恒定 403（v1.9.1 起与壳 `SHELL_MIRRORS` 对齐） |
| `WHPROMO_RELEASE_JSON` | 空 | **自有 latest.json（推荐/方案 A）**，逗号分隔多个，形状同 GitHub release 对象（`tag_name` + `assets[]` 含 `name/size/browser_download_url/digest`），探测优先级最高 |

## 备注

- **认证 token**：`--app` 用当前页 `location.href` 原样打开，首次启动的一次性 `?token=…` 可以带过去；在已认证标签页手动打开时，若目标浏览器 profile 不同会见到 "authentication required" 页——按页面提示重开 `dsh web` 打印的 URL 即可。
- **CLI 子命令**：`dsh` 的子命令由核心硬编码（`web` / `plugin`），插件无法扩展；本插件不提供斜杠命令。
- 上架 dshmarket 时把本目录打包发布即可（`dsh.client.platform = web`，Client 走 `window.__ModuleLoader__` 格式）。
