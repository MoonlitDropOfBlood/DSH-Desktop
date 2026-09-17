# 插件挂载、内置市场与引导插件（AGENTS.md §2 / §2b / §2c 详版）

> 主索引与红线清单在 [AGENTS.md](../../AGENTS.md)；本文承接其完整细节，两处需同步维护。

## §2. 客户端插件挂载（`prepareDesktopPlugin` + `--patch`）

窗口控制条、设置页、更新徽章都是 DSH 客户端插件，通过 composition patch 挂载：
- 插件包复制到 `<DSH_HOME>/profiles/web/node_modules/dsh-desktop-plugin`（`client-modules` 的 baseUrl 是 profile 目录，`require.resolve("dsh-desktop-plugin/package.json")` 从那里解析）。
- `plugins.patch.yml` / 生成的 `desktop-plugin.patch.yml` 用 **`- insert:`** 语法新增行（普通 `- id:` 是覆盖已有行，新 id 会报 "entry not found"）。**`insert` 的值是列表**（`- insert:` 下一行 `- id: ...` 缩进成数组项）——写成单个映射（`insert:` 直接挂 `id:`）会让核心启动即 exit 1（2026-09 手写 profile `cordis.patch.yml` 实测踩中）。
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

**设置导航图标**：DSH 0.1.x 的 `settings.section` 只投影 `id/order/label`，设置壳对每个外部 section 统一画通用齿轮（`client-ui-settings-general` 的 `navIcon()`，没有公开图标字段）。client.js 里 `registerSettingsNavIcons(SETTINGS_NAV_ENTRIES)` 用 MutationObserver 给 `[role="dialog"] nav button` 中文本等于 section label 的行打 `data-dsh-desktop-core-settings-nav` / `data-dsh-desktop-shell-settings-nav` 标记，CSS 再隐藏 `>svg:first-child` 齿轮、用 `currentColor` mask 画 cpu（核心）/ monitor（桌面版）Lucide 图标（16px，跟随原生 hover/active 颜色）。换图标只需替换 CSS 里 data URI 的 SVG path（Lucide，24×24，stroke-width 2，stroke 用 black——mask 只取 alpha）。**性能注意（2026-09-16）**：sync 回调必须先早退（`[role="dialog"] nav` 不存在直接 return）再全文档扫描，且已正确的 marker 跳过重复写——否则流式输出期间（characterData 突变每秒几十次）每次都是全文档 selector 扫描。

## §2b. 内置插件市场（dshmarket，`prepareBundledMarket`）

壳自带 [dsh-market](https://github.com/dsh-market/dsh-market) 插件市场（pin 版本，`DSH_DESKTOP_MARKET_VERSION` 覆盖），开箱即用、目标机器零下载：

- **构建期**：`scripts/fetch-market-plugin.js`（`npm run fetch:market`，已接入所有 `dist:*` 脚本和 CI 各 job）用 `npm install --prefix build/market-plugin --no-save --omit=dev dshmarket@<pin>` 拉取插件及其运行时闭包；幂等（版本一致跳过，不一致清空重装）。`build/market-plugin/` 已 gitignore，经 `files: ["build/market-plugin/**"]` 打进 asar。
- **只暂存 4 个包**：`dshmarket` + `js-yaml` + `undici` + `argparse`。dshmarket 的 `@deepseek-ai/*` 导入（`dsh-settings`、`schemastery`，以及 client 的 inject 包）**由 DSH 加载器对核心安装目录解析**，profile 安装版也不带这些包进 profile（已用真实 pnpm profile 的 lockfile 验证：它的依赖只有 js-yaml/undici/argparse）——**不要**把 `@deepseek-ai/*` 拷进 profile（会出现核心包第二实例）。
- **运行时**：`prepareDesktopPlugin()`（每次 spawn DSH 前）先 `prepareBundledMarket()`，返回三态：① `"staged"`——把包暂存进 `<DSH_HOME>/profiles/web/node_modules`（`dshmarket` 每次覆盖——壳拥有这份拷贝；依赖包只在**缺失或主版本不一致**时填充，绝不覆盖 profile 里兼容的拷贝——pnpm 可能管理着那棵 node_modules），然后在生成的 patch 里追加 `- insert: { id: dsh-market, name: 'dshmarket', config: { allowRestart: false } }`；② `"user"`——profile 自己挂载了 dshmarket（见下"用户已自行安装"条），**不暂存**，改为追加一条普通 `- id:` **覆盖行**强制 `allowRestart: false`；③ `null`——开关关闭或 bundle 缺失，不加行。
- **从 asar 复制必须用 asar 安全原语（大坑，v1.3.0 打包后市场不加载的根因）**：`build/market-plugin/**` 经 `files` 打进 `app.asar`，打包版里 `__dirname` 就是 asar 路径。**`fs.cpSync(src, dst, {recursive:true})` 从 asar 内复制目录会抛 `ENOTDIR`/`ENOENT`**——Electron 的 asar 补丁只覆盖单文件原语（`readdirSync`/`statSync`/`copyFileSync`/`existsSync`/`readFileSync`…），`cpSync` 的递归遍历走底层 `opendir`，绕过补丁。**必须**用逐项 `readdirSync`+`statSync`+`copyFileSync` 的递归复制（`copyDirRecursive()`，全部 asar 安全原语）。诊断特征：开发机（profile 里 pnpm 真装 dshmarket → `prepareBundledMarket` 检测到用户自装、返回 `"user"` 直接跳过暂存）永远正常，打包安装的机器市场不出现、且日志只有 `prepareDesktopPlugin failed: ENOTDIR`。另注意 `prepareBundledMarket` 暂存失败已被改为**非致命**（只记日志、继续挂载窗口控制条），别把它改回 throw——否则一个市场的复制错误会连带让整个 patch 不生成。
- **`allowRestart: false` 必须带，对用户自装的市场也不例外（实测大坑）**：插件自带的"重启 DSH"会 spawn 一个 detached helper，先 SIGTERM 当前核心、等端口释放后重放原启动命令拉起替身核心——全程绕过 Electron 壳的生命周期管理：壳把原进程退出误判成崩溃弹错误面板，替身抢占原端口后壳的任何重试都撞"端口已被占用"死锁，且替身是孤儿进程、壳退出后仍残留。因此：壳暂存挂载时用 `- insert:` 行带 `config.allowRestart: false`；**用户自装时**用普通 `- id: dsh-market` 覆盖行（带 `name: 'dshmarket'` 守卫）强制同值——覆盖是**整对象替换**该行 `config`（`applyEntryPatches` 逐 key 赋值、无深合并），dshmarket 自带挂载行本无 config，其余配置键（`profile`/`maxSnapshots`）都有 argv/默认值兜底，安全。市场设置页里有 `allowRestart` 开关可被用户显式重新打开（其值经 `installSettingsSection` 的 `onChange` 直接写回运行时配置）——那是用户知情选择，由下一条的收养机制兜底。壳有自己的 DSH 重启机制（`restartDSH`/更新流程/菜单 CmdOrCtrl+Alt+R）。
- **纵深防御：收养外部重启的核心（exit 处理器）**：`dshProc` 意外退出**且此前已成功启动**时，不立即弹崩溃面板，先探测原端口 `ADOPT_RESTART_GRACE_MS`（12s）——若替身核心起来了则**收养**：`listenerPid()` 记录监听 PID（Windows 解析 `netstat -ano` / POSIX `lsof`），`dshUrl` 指回原地址、窗口直接 reload。收养后 `killDSH()` 经 `killAdoptedDSH()` 清理：**带守卫**——仅当记录的 PID 仍是该端口监听者时才 `taskkill /T /F`（防 PID 复用误杀无关进程），壳的重启/更新/退出路径因此对替身同样有效。已知限制：被收养进程没有 exit 事件监听，它之后再死掉靠 `did-fail-load` 兜底回错误面板；探测 12s 超时（替身没起来=真崩溃）按原逻辑弹崩溃面板，行为不回归。
- **收养探测必须做代际校验（v1.4.5 大坑，勿改回）**：收养探测是 12s 的**长延迟决策**，而它的存活窗口内用户很可能按 Ctrl+Alt+R 手动重启——重启拉起的新核心一绑上端口就会被旧探测误认成"外部替身"收养（`adoptedPid` 记成壳自己的亲儿子 + 双重 `openDSH` 抢跑闪烁），绑端口晚于探测截止则反过来在正常重启中途弹"进程已退出"崩溃面板——这就是 v1.4.4 后"手动 Ctrl+Alt+R 刷新不稳定"的根因。规则：**每次 `doSpawn` 递增 `spawnSerial`（核心代际号），exit 处理器里的 `report()` 与收养探测回调都是延迟决策，行动前必须校验自己仍代表当前代际**（`quitRequested || restartRequested || serial !== spawnSerial || dshProc` 任一命中即静默放弃）；`probeServerUp` 轮询中发现重启接管（`restartRequested`）也提前退出。配套地，**`restartRequested` 从 `restartDSH()` 入口一直保持到 `doSpawn()` 真正拿到新 child 才清除**（勿改回在 `killDSH` 回调里清——被杀核心的 exit 事件可能晚于该回调到达，守卫全 false 时误弹"启动失败"；且异步 spawn 链期间标志提前复位会让连按两次快捷键并发起两条链、两个核心抢端口，输家 EADDRINUSE 又喂给收养探测）。链上所有中止路径（runtime 过旧、端口预检失败、spawn error、找不到安装）与成功路径都必须释放标志，保证错误面板的「重试」永不悬挂；`restartDSH` 另带 `isUpdating` 守卫（更新流程结尾有自己的 restartDSH，别被手动重启打断）。
- **被杀核心的 exit 事件晚于新核心的 `doSpawn` 到达是常态而非例外（e2e 实测 8/8 全中）**：重启链里 `loadFile`(splash) + `resolveDSHBin`/`prepareDesktopPlugin` 的同步 IO 拥堵主事件循环，libuv 的 child-wait 回调排队，旧核心的 `exit` 平均晚几十~几百 ms 送达（极端环境可任意延迟，独立复现脚本里 stdio:'ignore' 时 30s 内都没送达）。因此 **exit 处理器里的任何状态变更都必须先过身份/代际守卫**：`if (dshProc === child) dshProc = null`（否则把新核心的簿记清掉——新核心变孤儿，下一次重启无子可杀、端口被它一直占着，"端口已被占用"必现且之后的重启全挂——v1.4.5 后"偶发端口被占用"的残留根因）、`if (serial !== spawnSerial) return` 之后才允许 `clearWatchdog()`（否则缴掉新核心的启动看门狗）。
- **taskkill 可能静默失败，必须有兜底**：`killDSH` 检查 taskkill 退出码（"not found"/"access denied" 时 `close` 照常触发），非零记日志并回退 `child.kill("SIGKILL")` 直杀；重启链端口等待（`PORT_RELEASE_WAIT_MS`）期间，若 `listenerPid()` 发现占用者仍是**刚被杀的那个 pid**（`lastKilledPid`——壳持有其子进程句柄、pid 不会被复用，无误杀风险），每 2.5s 重新 taskkill 一次自愈。POSIX 侧不再盲等 2s：200ms 轮询进程组存活（`-pid` 信号 0），死了立刻继续，2s 未死升级 SIGKILL。
- **主进程日志持久化**：`log()` 同时写 `<userData>/dsh-desktop-main.log`（启动时 >1MB 轮转为 `.old`）——打包版没有控制台，没有它任何重启 flake 事后零证据。"端口已被占用"面板附带占用进程 PID（`listenerPid()`）。
- **重启链路 e2e 回归钩子**：`DSH_DESKTOP_E2E_RESTARTS="N[,ms]"`（env）让应用在每次 `openDSH` 后自动跑 N 次真实 `restartDSH()`（生产绝不设置；配合 `DSH_DESKTOP_USER_DATA`/`DSH_DESKTOP_HOME`/`DSH_DESKTOP_PORT` 全隔离）。`scripts/repro-restart-race.js` 独立实测"taskkill → 端口释放"时序（空闲核心实测 ~370ms；注意沙箱内 taskkill 会被 ACL 拒绝，需非沙箱运行）。
- **插件故障自动恢复（`plugin-recovery.js` + exit 处理器接线，"DSH 被玩坏"时的自愈）**：核心**启动期**被插件加载失败杀死时，壳解析日志找出罪魁插件、自动卸载、重启，成功后弹蓝色信息面板列出被卸载的插件。要点（全部有实测依据，勿凭猜改动）：
  - **故障日志格式（core 0.1.1-rc.2 实测，`scripts/repro-plugin-failure.js` 抓取，全量样本在 `scripts/.testdata/`）**：模块语法错/apply 抛错/多插件同时挂，统一形如 `failed to import|apply loader entry <name> (<spec>): <err>`（[cause] 链会嵌套重复同一条目，需去重；链首固定是根包装条目 `include (cordis:include)`，**必须排除**）；bundle 缺失/清单非法形如 `cannot resolve profile bundle "X"` / `profile bundle "X" declares no dsh.bundle`。这些故障全部**快速 exit 1**（不挂死）；另有源码级兜底模式 `plugin(s) failed to load: a, b` 与 `N entries did not activate\n<name>: <stack>`（条目行零缩进、stack 续行有缩进）。
  - **证据窗口两条铁律**：① 只解析**本代核心自己的输出**——`doSpawn` 记 `child.logStart = logTail.length`，exit 时从该处切片（上一轮的失败日志还在 logTail 里，绝不能让它们误判后续无关退出）；② 只取**末尾 80 行**——运行期 HMR 热重载用户补丁失败的措辞与启动失败**完全相同**，但之后会有大量正常日志，限尾窗可排除。
  - **罪魁 → bundle 映射**：条目名 == 包名或为 `<pkg>/` 前缀直接命中 `dsh.profile.bundles`；否则读各 bundle 的 `dsh.bundle.patch` 文件里的 `name:` 挂载名做归因。**`@deepseek-ai/*` 系统插件只报告、绝不自动卸载**（修它们靠核心更新，profile 编辑修不了）。
  - **卸载 = 同时从 `dsh.profile.bundles` 和 `dependencies` 移除**（只删 bundles 会被下次 `dsh plugin` 安装时的 reconcile 按已装包重新挂载）；node_modules 里的文件留着不管（pnpm 可自行 prune）。原子写（tmp+rename）。
  - **两个特例**：罪魁是 `dshmarket` → 除卸载外必须 `bundleMarket:false`，否则壳下次 spawn 会把内置市场重新暂存挂载、等于没卸；罪魁是壳自己的 `dsh-desktop-plugin` → 该代生成的 patch 不带它的挂载行（窗口控制由 main.js 的兜底控制条接管），patch 无任何行时干脆不传 `--patch`。
  - **预算**：每壳会话最多 `PLUGIN_RECOVERY_MAX`（4）次自动恢复；系统插件/无法归因/超预算/证据为空都落回原来的错误面板（日志尾部照常展示）。
  - **成功后的提示**：`openDSH` 拦截——`removed.length > notifiedCount` 时先弹 splash 面板（`tone:"info"` 蓝色样式 + 「进入 DeepSeek Harness」按钮，`startupChoice` 的 `continue` 动作放行 stash 的 URL），每批卸载只提示一次。
  - **测试**：`scripts/test-plugin-recovery.js`（内嵌真实日志摘录的单测 + 对 `.testdata/` 全量样本的回归）；`scripts/e2e-plugin-recovery.js` 全链路 e2e（隔离环境预置两个坏插件 → 自动卸载 → 重启成功 → 面板日志标记）。
- **用户已自行安装时绝不重复挂载**（大坑）：Cordis 的 `- insert:` 是**无条件追加**（源码见 `dsh-app-boot` 的 `applyEntryPatches`），同 id 再插一行会把插件**挂载两次**（服务/UI 全重复）。所以挂载前先检测 profile 是否已挂载 dshmarket：`profiles/web/package.json` 的 `dsh.profile.bundles` 含 `"dshmarket"`，或 `cordis.patch.yml` 文本含 `dshmarket`——命中则**不暂存、不 insert**，只追加上一条所述的 `allowRestart: false` 覆盖行（普通 `- id:` 行作用于已有条目，不会新增；用户手写行若换了 id，覆盖行找不到目标、loader 只警告跳过，无害）。此检测**先于** `bundleMarket` 开关——开关只管壳暂存的拷贝，生命周期保护不因开关关闭而缺席。
- **开关**：设置"内置插件市场"（`bundleMarket`，默认开，存 `update-settings.json`）关掉后不再暂存/挂载——用户在 profile 里卸载市场后靠它避免壳自动装回。改动**重启 DSH 生效**（patch 每次 spawn 才重组装）。
- **核心 ≥0.1.2 会自动挂载 profile node_modules 里的包（大坑，2026-09-04 e2e 实测）**：壳暂存的 dshmarket 拷贝会被新核心自己mount成 loader 条目，此时 patch 里的 `- insert:` 行就成了第二条 → `duplicate loader entry id: dsh-market` 启动崩。所以 `prepareBundledMarket()` 在 `coreAutoMountsProfilePackages()`（装到的核心 ≥0.1.2，三元组语义走 `core-version.js`）时返回 `"staged-auto"`，`prepareDesktopPlugin()` 照 `"user"` 模式发**覆盖行**（`- id:` 找到核心自动建的条目改 config，正好把 `allowRestart: false` 附上）；0.1.1.x 不自动挂载，维持 `- insert:`。**别把这个版本门禁合并成无条件覆盖行**——0.1.1.x 上自动挂载不存在，覆盖行找不到目标只会静默跳过，市场就消失了。
- profile 的 node_modules 可能被 pnpm 管理，pnpm prune 会清掉壳暂存的"外来"拷贝——无妨，下次 spawn DSH 会重新暂存（自愈）。

## §2c. 鲸港 Web 引导插件（whaleharbor-promo，仓库目录 `plugins/whaleharbor-promo/`）

把普通浏览器里的 DSH 会话变成"鲸港简版客户端"，同时后台下载完整安装包并提示安装（Web → Desktop 的转化漏斗）。**不经 Electron 打包分发**（不在 electron-builder `files` 里），作为 profile 插件经 awesome-dsh-plugin 收录 + dshmarket 分发。放 `plugins/` 子目录是 awesome CI 的硬要求（它只扫根包和 `packages/`·`plugins/`·`apps/` 子包的 `package.json`）。结构与 `dsh-desktop-plugin/` 相同：`index.js`（Host）+ `client.js`（Client bundle）+ `package.json` + **`cordis.patch.yml`**。

- **`dsh.bundle` 清单是收录门槛（大坑，勿删）**：`package.json` 必须声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web" } }`——只声明 `dsh.client` 会被 awesome CI 拒（"that alone is not installable"）。`cordis.patch.yml` 随包，内容就是挂载行（`- insert:` **值是列表**，写成单映射会让核心启动 exit 1，见 §2）。发 npm 时 `repository` 字段必须指回 DSH-Desktop 仓库（awesome 的 npm↔仓库映射靠它关联）。
- **三段式流程**：① 普通标签页打开时 Host 用本机浏览器（win: Chrome/Edge/Brave 常见安装路径 + `where` 兜底；mac: `/Applications`+`~/Applications` 的 .app；linux: `which`）spawn `--app=<当前页 URL>` 独立窗口（无浏览器 UI），只自动开一次（localStorage `whprom.appOpened`）；② 独立窗口内 Client 渲染简版客户端顶栏（`shell.overlay` 顶部胶囊：品牌/下载进度 chip/浏览器任务通知开关/全屏/收起）+ 右下角引导卡（`shell.overlay`，CSS 画的客户端预览 + 真实下载状态机），侧栏底部"客户端"按钮可重开；③ Host 后台下载完整安装包到 `<home>/Downloads`：发布元信息 `[WHPROMO_RELEASE_JSON(自有 OSS latest.json，方案A槽位) → GitHub API → gh-proxy.com 镜像]`，二进制 `[browser_download_url → 镜像]` 顺序兜底，单请求超时 30s（gh-proxy 冷启动实测 ~17s，15s 会误杀唯一可用兜底——v1.9.1 壳更新同款教训），下完用 `crypto` 对 GitHub 资产的 `digest` 做 SHA-256 校验，校验失败**隔离损坏文件**（改名 `.sha256-mismatch`/删除——文件尺寸恰好等于 total，留在原地会让"同尺寸跳过下载"短路反复校验同一个坏文件，重试按钮死循环，2026-09-16 修）；完成后引导卡强制弹一次"完整功能需要安装客户端"（`whprom.donePrompted` 只弹一次）+ `explorer /select` 定位。**镜像默认只有 gh-proxy.com**：ghproxy.net 实测恒定 403（v1.9.1 已把它从 `SHELL_MIRRORS` 移除，插件与之对齐）。
- **架构探测（2026-09-16 修）**：UA 字符串冻结 x64，真实架构靠 UA-CH `getHighEntropyValues(["architecture"])` **异步**回填；探测 promise 挂在 `env.archProbe` 上，`ensureBegin` 与之 `Promise.race` 800ms 超时后才首次 `/begin`，若探测晚到且架构变了会再发一次 `/begin`——服务端 `/begin` 在 `resolving` 阶段允许重选资产（`state.pendingArch`）。**注意旧代码在 detectEnv 回调里给越界 `env` 赋值（ReferenceError 被 catch 吞掉），架构修正从未生效**——修复后 env 由 detectEnv 内部闭包持有。
- **下载守卫**：`downloadMulti` 有 settle-once 守卫（成功 finish 后迟到的 res error/超时不再触发下一源与第二次回调——旧代码会在已 end 的 HTTP 响应上二次 `writeHead` 抛未捕获异常）。
- **通知积压**：`/state` 响应带 `notifySeq`（当前 feed 水位）；client 首次 `/state` 把 `/notify` 游标 pin 到该值——页面关闭期间积压的通知（feed 保留 50 条）不再在重开页面时一次性全弹。
- **Client→Host 通道**：profile 插件没有动态插件的 `host.call`，Host 起 `127.0.0.1:<random>` HTTP 服务（每运随机 token，`x-wh-promo-token` 头校验 + CORS `*`），经 `webServer.tapIndex` 把 `{port, token}` 注入每个 index 页 `window.__WH_PROMO__`；Client 轮询 `/state`（1s）与 `/notify`（3s）。**无 host→client 推送通道**，任务通知（agent/status、agent/error、approval/request，同样只报主 agent）走轮询 + 浏览器 `Notification` API。
- **环境门禁**：`window.dshDesktop` 存在（已在完整客户端里）→ 全部 UI no-op；`matchMedia('(display-mode: standalone)')` 为真（`--app` 窗口）→ 渲染顶栏，标签页只渲染引导卡 + "以独立窗口打开" CTA。**认证 token 注意**：`--app` 用 Client 的 `location.href` 原样打开，首次启动的 `?token=…` 能带过去；标签页认证后 cookie 在 profile 里，换浏览器会遇 "authentication required" 页（属正常，按提示重开打印的 URL）。
- **CLI 子命令不可扩展**：`dsh` 的子命令在核心 `bin.js` 里 commander 硬编码（`web`/`plugin`），解析早于插件加载；插件能注册的是 UI 斜杠命令（`commands` 服务），本项目已决定不用。
- **壳自身更新链路同步多源（main.js）**：`SHELL_MIRRORS`（`DSH_DESKTOP_SHELL_MIRRORS` 覆盖，空串禁用）+ `queryShellLatest` 逐源尝试 API + `dsh:downloadShellUpdate` 逐源尝试下载。方案 A 落地后把自有 OSS 前缀加进 `SHELL_MIRRORS` 即可。**镜像表/30s 超时/mac arm64 资产规则与本插件是两份拷贝**——任何一边改动必须检查另一边。
- **子插件发布流程（与主项目发版严格区分，勿混淆）**：主项目（桌面壳）发版走 `v*` 标签 → `.github/workflows/build-installers.yml`（见 §11「壳自身自更新」），**子插件绝不使用裸 `v*`**——build-installers 已消费该模式，裸标签会触发桌面壳全平台构建。子插件发布走 **`whaleharbor-promo-v*` 前缀标签** → `.github/workflows/release-whaleharbor-promo.yml`（与上级目录兄弟插件 `dsh-git-manager/release.yml` 同款三段式）：① build job `npm pack` 出 tgz 传 artifact；② publish-npm job 走 **OIDC Trusted Publishing 免 token 发 npm**（Node 24 自带 npm 11 ≥11.5.1 是 tokenless 硬门槛，勿降 Node 20——其 npm 10 会失败；`id-token: write` + setup-node `registry-url`，仓库里不存在任何 NPM_TOKEN 路径），`npm view` 幂等跳过已发布版本；③ release job 用 `softprops/action-gh-release` 把 tgz 挂到同名 GitHub Release（`GH_TOKEN || GITHUB_TOKEN`，默认 token 够用）。**前置配置（一次性）**：npmjs.com 包设置 Trusted Publisher = `MoonlitDropOfBlood/DSH-Desktop` + workflow 文件名 `release-whaleharbor-promo.yml`（environment 留空）；首版 1.0.0 可先本机 `npm publish` bootstrap（scoped 包 public 由 `publishConfig` 兜底），之后全自动。**发新版本 = 改 `plugins/whaleharbor-promo/package.json` 的 `version` → `git tag whaleharbor-promo-vX.Y.Z && git push origin whaleharbor-promo-vX.Y.Z`**；workflow 的 `paths` 不限制，改包即触发该标签对应流程。发布命令永不带 `--registry`/`--access`（`publishConfig.registry = registry.npmjs.org` + `access: public` 已写死在 package.json）。
