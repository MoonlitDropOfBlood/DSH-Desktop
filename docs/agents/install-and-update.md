# 安装与更新机制详解（AGENTS.md §1 / §1b / §1c / §9 / §11 详版）

> 主索引与红线清单在 [AGENTS.md](../../AGENTS.md)；本文承接其完整细节，两处需同步维护。

## §1. DSH 动态安装与定位（main.js `resolveDSHBin` / `ensureDSH` / `installDSH`）

启动时按顺序找 DSH 安装：
1. 应用托管目录 `%APPDATA%\...\dsh\node_modules\@deepseek-ai\dsh`
2. 应用自身 `node_modules`
3. npm `_npx` 缓存里最新的一份完整安装（**复用，避免重复下载**）

找不到就 `pnpm add --dir <托管目录> @deepseek-ai/dsh@latest`（**内置 pnpm**：经 `node <resources>/pnpm/bin/pnpm.cjs` 运行，不依赖 PATH；含 registry 探测 + 失败重试/换镜像）。pnpm 不存在时（未跑 `fetch:pnpm` 的开发环境）回退老的 `npm install --prefix <托管目录> --no-save …`。

**为什么用 pnpm 装核心（实测大坑，勿改回）**：壳的安装形态是"裸目录 + `@latest`"——首次安装没有任何本地状态；更新时新版本的兄弟包依赖区间钉在当次发版线（`^0.1.1-rc.x`），旧 lockfile 照样全部失效，所以**每次都是从零全树解析**。dsh 核心是 ~195 个互相依赖的 `@deepseek-ai/*` 包 + react peerDeps，npm 的 arborist 在这种树上 placeDep 超线性爆炸——实测**仅解析阶段就烧 >10 分钟 CPU 还没跑完**（内置 npm 11.17 与系统 npm 11.9 同样病态，与网络快慢无关）。同机同树实测 pnpm 解析+下载+链接（446 包）：**17.8s**；热 store 更新 **3.5s**。终端 npx/npm"快"只是因为命中 `_npx` 缓存或项目 lockfile，根本没做全树解析。

**pnpm 化要点（main.js `installPlan` / `prepareManagedDir`）**：① 托管目录先补一个最小 `package.json`（`pnpm add` 需要），并**清掉 npm 时代留下的、无 `.modules.yaml` 的 node_modules**（pnpm 只覆盖它认识的包，旧文件会滞留 ~210MB 死重）；② store 固定在 `<userData>/pnpm-store`——必须与托管目录同卷，否则硬链接退化为全量复制；③ 必须带 `--config.confirmModulesPurge=false` 和 `--reporter=append-only`（splash 无 TTY，任何交互提示都会挂死安装；append-only 输出才能被进度日志逐行解析）；④ pnpm 默认不跑依赖的 install 脚本——本树的原生包（koffi/sharp/node-pty）全部以平台预编译包随 tarball 分发，无需脚本，与 npm 时代被 allow-scripts 门禁跳过的行为一致；⑤ `@tanstack/react-virtual` 的宽 peer 区间会让 pnpm 把 react-dom 解到 19.x（react 是 18.3.1）并打一条 "unmet peer" 警告——**惰性无害**（web 客户端是预构建 bundle，服务端不加载 react-dom），`pnpm.overrides` 的 `$react` 语法要求 react 是直接依赖、用不了，别加。⑥ 版本检查 `queryLatest()` 已改为直连 registry 的 `GET /<name>/<tag>`（一次 HTTP，不再 spawn `npm view`）。

**Windows 上 spawn npm 的引号坑（大坑，必读）**：pnpm 主路径经 `node <pnpm.cjs>` 直跑、不经过 cmd，天然免疫此坑；npm 回退路径仍需遵守——**绝不要**把 npm 命令预拼成一个字符串再丢给 `cmd /d /s /c`，例如 `cmd /d /s /c "npm install --prefix "C:\...\dsh" ..."`，也不要用 `JSON.stringify(path)` 给参数加引号——cmd 的 `/s` 引号剥离会弄坏内嵌引号、按空格截断参数，npm 就会收到一个**相对路径** `--prefix "C:\...\DeepSeek`，然后报 `ENOENT: mkdir`，退出码 `4294963238`（只要路径含空格就必炸，例如 `C:\Users\wwhby\AppData\Roaming\DeepSeek Harness Desktop\dsh`）。**正确做法**：每个参数（含带空格的路径）作为独立 argv 传入 `spawn`，让 Node 的 CreateProcess 自动加引号；`--prefix`/`--dir` 传原始路径、不要 JSON.stringify。

**DSH 的 npm 仓库**：`@deepseek-ai/dsh` 发布在官方 **npmjs.org**（`https://registry.npmjs.org`），国内常用 npmmirror 镜像同步。默认 `DEFAULT_NPM_REGISTRY` = npmmirror（国内快），探测/失败时回退 npmjs.org。可用 `DSH_DESKTOP_NPM_REGISTRY` 覆盖。

**不要用 `npx` 启动 DSH**：本机网络下 npx 在线解析 `@latest` 会挂死在 CDN 节点，`npx --offline` 在 npm 11 + 大缓存下病态空转。**直接 `node <bin> web --patch <patch>` 最可靠**。

**rc.8+ 核心会默认打开系统浏览器（桌面壳必须拦截）**：核心 0.1.0-rc.8 起 `web` 命令默认把 URL 交给系统浏览器（`dsh-web-app` 配置 `openBrowser` 默认 true，官方开关 `--no-open`）。桌面壳有自己的 frameless 窗口，`doSpawn()` 固定追加 `--no-open`——但**必须按核心版本门禁**（`supportsNoOpen()`，实现走 `core-version.js` 的 prerelease 感知比较，行为锁在 `scripts/test-core-version.js`）：老核心的 commander 严格解析、遇未知选项直接 `error: unknown option` 退出（实测 rc.7 即炸），所以 <0.1.0-rc.8 的核心绝不能传。

**版本比较统一（2026-09-16）**：`compareVersions`（dot-int，对 prerelease 不敏感）只保留给**壳自己的** `v1.2.3` 标签比较；核心版本一律走 `core-version.js`——`isAtLeastByTriple`（忽略 prerelease，装 npm 门禁/自动挂载门禁语义）、`isNewer`/`compareCoreVersions`（prerelease 感知，`--no-open` 门禁与更新方向守卫语义）。**更新方向守卫**：`updateAvailable` 与启动自动更新都要求 `isNewer(latest, installed)`——dist-tag 回移或从 alpha 切回 latest 时绝不能把旧版当"更新"装回去；用户在设置页显式点的安装动作不受挡（§6b 契约）。

## §1b. DSH 运行时 = 内置独立 Node（首选）+ Electron 内嵌 Node（回退）

**为什么内置独立 Node（2026-08 恢复，曾因 Electron 内嵌够用而移除）**：DSH 核心由壳以 `windowsHide:true` spawn。Windows 控制台行为取决于被 spawn 二进制的 **PE 子系统**：
- **真实 node.exe（Console 子系统）** + `CREATE_NO_WINDOW` → 得到**无窗口控制台**，整棵进程树（沙箱 runner → 受限 PowerShell）都继承它，任何命令都不弹窗口——**且 DSH 核心代码零改动**。
- **Electron 二进制（GUI 子系统，`ELECTRON_RUN_AS_NODE` 当 node 用）** → **永远不会获得/继承控制台**（GUI 进程不参与控制台继承，实测 pids=0），于是沙箱 runner 无控制台可传，受限 PowerShell 子进程只能**自己新建可见控制台窗口**——每条命令弹窗（移除独立 node 后出现的回归，实测确认）。

因此 `scripts/fetch-node.js`（`npm run fetch:node`）把固定版本 Node LTS（`DSH_DESKTOP_NODE_VERSION` 覆盖，默认 24.19.0）下到 `build/node/<平台-架构>/node(.exe)`，经 `extraResources` 以 `<resources>/node/<平台-架构>` 随包分发（`build/node` 全量拷入）。**安装包体积代价 ~30MB（实测 106MB→128MB），换取核心零改动 + Windows 无弹窗**。`bundledNode()` 解析它；`dshRuntime()` 优先级：`DSH_DESKTOP_NODE`/`npm_node_execpath` 覆盖 → 内置 node → Electron 内嵌（回退）。内置 node 版本低于核心要求（≥22.15，`MIN_NODE_MAJOR/MIN_NODE_MINOR`）时自动回退内嵌并记日志；内嵌版本过低才弹错误面板（1.2.0 zstd 事故的护栏）。安装器（pnpm）与核心用**同一个 runtime**（`installPlan` 也走 `dshRuntime()`），且 `runInstaller`/`doSpawn` 都带 `windowsHide:true` → 安装过程同样无窗口。

- **为什么不用"给核心打补丁"修弹窗**：曾尝试壳托管补丁（启动时往 `dsh-sandbox-windows-acl`/`dsh-subprocess-local` 的 lib 注入 AllocConsole/windowsHide），但核心是 npm `@latest` 装的，补丁锚点随版本变化可能不匹配/不兼容——**已弃用**，核心保持 100% 原始（勿再往核心代码打补丁）。
- **原生模块前提**：DSH 树的原生包全是 **NAPI**（ABI 跨官方 Node/Electron 稳定），内置 node 与 Electron 内嵌都能加载 koffi/sharp/node-pty；往核心里引入 NAN 原生包会破坏此方案。
- **DSH 子进程可见的 node/npm/pnpm**：仍是**用户 PATH** 里的（终端 Profile 合并覆盖 GUI 裸环境）；内置 node 只用于跑核心/安装器，不会注入 PATH。一台完全没装 Node 的机器能跑 DSH 但跑不了 npx 系 MCP 服务。
- 开发时（`npm start`）：`bundledNode()` 回退到 `build/node/<平台-架构>`（dev 路径），与打包版 `process.resourcesPath/node` 一致；没跑 `fetch:node` 则用 Electron 内嵌。
- **spawn 参数固定带 `--expose-internals`（node 选项，非核心参数）**：核心 rc.7+ 的启动器在组合里没有 hmr 服务时会**无条件创建** `cordis-plugin-hmr`（用于监听 `cordis.patch.yml` 热重载），而 `Hmr` 构造函数硬性要求进程以 `node --expose-internals` 启动（`ctx.loader.internal` 只在该 flag 下存在）——没有它核心会启动后片刻崩死（rc.7 与 0.1.1-rc.2 全新 home 均实测复现，CLI 裸跑 `dsh web` 同样会炸，属核心侧问题）。该 flag 放在 `bin.js` **之前**、由 node 自己消费，永远到不了核心的 commander，**对新老核心都安全、无需版本门禁**（实测两版均完整启动 + HTTP 200）。

- **核心 >= 0.1.2-rc.1 打印的 URL 带认证 token，URL 提取必须保留完整行（大坑，勿截断）**：0.1.2-rc.1 起 `dsh web` 的启动链接是 `http://127.0.0.1:3080/?token=…`（query 带一次性认证 token；页面根路径交换 token 写 cookie 后跳回干净的 `/`，官方文档原话）。壳的 `handleLine` 曾用 `line.match(/(https?:\/\/127\.0\.0\.1:\d+)/)` 只截取到端口——token 直接丢掉，窗口加载无 token 的裸地址 → 页面一直卡在未认证的启动界面（"启动 web 丢失 token 卡住"的根因）。**修复**：URL 提取抽成纯函数模块 `url-extract.js`（`extractDshUrl`），匹配 `https?://127.0.0.1:\d+` 后继续吃 `[/?#]` 起的 query/fragment（`[^\s"'<>]*`，行尾标点修剪，剥 ANSI），返回**完整 URL** 交给 `waitForServerThenOpen` → `loadURL`；老核心的裸 URL 行同样兼容。**以后加正则相关改动时，先跑 `node scripts/test-url-extract.js`，绝不要把提取逻辑改回"只到端口"**。`dshUrl` 的所有消费点（布尔判断、`http.get` 探测、`loadURL`、菜单"在浏览器中打开"的 `openExternal`）都兼容带 query 的完整 URL；exit 处理器收养探测用的裸 `http://127.0.0.1:${port}` 是探活用途、不需要 token，保持不变。

## §1c. 继承终端 Profile（MCP 修复，设置"继承终端 Profile"默认开）

**问题**：从 Finder/Dock 启动的 mac app 没有用户 shell 的环境变量，DSH 继承的就是这个"裸"环境，DSH 拉起的 **MCP 服务**（npx/uvx/python 等子进程）找不到可执行文件，起不来。

**机制（保证在 MCP 之前）**：桌面壳在主进程 **spawn DSH 之前**用 `execFileSync` 跑用户的登录+交互 shell（`<shell> -l -i -c env`，依次回退 `-l`、`-i`，8s 超时，`PS1=''` + 过滤 `KEY=VALUE` 行），把导出的环境变量解析出来，合并进 `childEnv()`。**合并语义 = 用户环境优先**：`childEnv()` 基底就是应用自身的 `process.env`（终端启动、`launchctl setenv`、LaunchAgent 注入的变量全都在，直接透传给 DSH/MCP）；Profile 只**补缺**（应用已有的 key 不被覆盖，避免 `.zshrc` 覆盖你在启动前 export 的值）；PATH 特殊处理——Profile 的 PATH **前置**（裸环境下 MCP 必须要用户 PATH）。DSH 是 MCP 的父进程 → MCP 一定在出生时就有终端环境。Windows 跳过（注册表环境已够用）。开关存 `update-settings.json` 的 `inheritTerminalProfile`（默认 true），桌面版设置页可关；`_terminalEnv` 缓存，切开关后置空、下次 DSH 重启生效（`restartDSH`/更新时）。

## §9. 更新安全（先停 DSH 再装，防崩溃）

- **更新会崩的根因**：安装器直接覆盖**正在运行**的 DSH 目录（`<userData>/dsh/node_modules/@deepseek-ai/dsh`）。Windows 下运行中进程文件被替换 → EPERM/EBUSY，安装报错且 DSH 进程被删文件而崩。
- **修复**：`updateDSH()` 先 `killDSH()` 停掉核心 → 回 splash → 安装（带进度条）→ `restartDSH()` 起新版本。失败时 `resolveDSHBin()` 回退旧版本/缓存，不会留死状态。**更新只重启核心，不需要重启整个 Electron 壳**。
- 安装失败操作（重试 / 换镜像重试 / **用当前版本继续**（有旧版时）/ 退出）都在页面错误面板里，`pendingInstallCb` 保存续作回调。更新期间受管目录被 park 到 `dsh.prev`（见下），`updateParkedTree` 标志保证「用当前版本继续」按钮不消失。
- 若更新过程仍异常，`dsh:installUpdate` 有 try/catch、主进程有全局 `uncaughtException`/`unhandledRejection` 兜底，都会把错误打到页面面板（可复制）而不是系统弹窗。

### 9b. 更新三重防线（2026-09-04 事故后加，"点了更新就打不开"绝不能再发生）

事故：0.1.1-rc.2 → 0.1.2-rc.1 更新后核心秒崩。根因是 **pnpm 在存量目录上跨版本线更新时，peer 解析复用了树上的旧实例**——旧 lockfile 把 `dsh-subagent@0.1.2-rc.1` 的 peer `@deepseek-ai/dsh-attachment: ^0.1.2-rc.1` 解析成了残存的 0.1.1-rc.2（冻在旧 lockfile 里），新代码 import 旧包没有的导出 → ESM 链接期 SyntaxError → 整批核心包加载失败。全新目录 pnpm/npm 都不复现；npm 修复了 peer 解析成本（见 9c）但 pnpm 仍是默认。三道防线（`updateDSH()` → `parkManagedDirForUpdate` → `installWithRetry` → `smokeBootDSH` → 提交/回滚）：

- **① park（回滚锚）**：安装前把现役树整体 `renameSync` 成 `dsh.prev`（同卷元数据操作，瞬间完成），新树装进全新目录——既消除"存量状态"这个事故诱因，又让回滚变成一次 rename（零网络、零重装、离线可用）。rename 失败（AV 握着句柄）就降级为原地安装并记日志。**回滚绝不能"先 rmSync 目标再 rename"**：Windows 的删除是延迟生效的（delete-pending，AV 握着 share-delete 句柄时名字滞留命名空间），rm 成功后紧跟的 rename 会连续 EPERM（e2e 实测 3/3 失败），之后 `existsSync` 又为 true，壳会把核心 spawn 到一棵已被掏空的树上。`restoreParkedManagedDir()` 必须用"换名"策略：坏树 rename 到 `dsh.broken-<ts>`、旧树 rename 进来、坏树异步删，带 3 次退避重试。
- **② 冒烟启动（`smokeBootDSH`）**：提交前用同款运行时（`--expose-internals`、launcher 参数序）在随机临时端口上无头启动新核心，HTTP <400 即通过（30s 内），提前退出/超时即失败——树内版本错位这类故障在 import 阶段几秒内就死，远比重启进坏树便宜。三个必须：**一次性 home**（`env.DSH_HOME = userData/smoke-home-<ts>`，用完即删——让新核心启动真实 profile 会把它迁移到新版本格式，回滚后旧核心读不了；事故分类里的失败在全新 profile 上照样复现，冒烟不损失覆盖面）；**剥掉 `env.DSH_DESKTOP_PORT`**（冒烟端口来自 argv，壳级 env 会把核心引去真实端口、探针却盯着 argv 端口，表现为 90s 超时——e2e 实测）；**探针必须用核心自己打印的带 token URL**（`extractDshUrl(line)`，rc.1 起裸 `GET /` 不再 <400，探裸端口会永远"未就绪"）。失败时把子进程输出尾巴写进主日志（唯一现场证据）。
- **③ 失败自动回滚**：冒烟失败 → restore（见①）→ 通知「更新已自动回滚，已恢复到 <旧版>」→ 重启旧版，用户无感继续用；无处可回滚（首次安装/park 失败）才走原错误面板。**killTree 后必须等进程死透（taskkill 完成回调 + 500ms settle）再做文件手术**，taskkill 是异步的。

### 9c. 安装器选择（pnpm / npm 自动切换）

`installPlan()` 按目标版本线选安装器：**目标（`latestKnown`，渠道 tag 的解析结果）≥0.1.2 → npm，否则 pnpm**（三元组语义，`core-version.js` 的 `isAtLeastByTriple`）；`DSH_DESKTOP_INSTALLER=npm|pnpm` 强制覆盖；PATH 上没有 npm（裸机）→ 永远 pnpm。依据：0.1.2 优化了发布包的 peer dependency 图，npm arborist 从 0.1.1 时代的 >10 分钟解析爆炸（实测放弃）变成 23.7s 全新安装（实测 2026-09-04，npm 11.17 + npmmirror），且 npm 对 peer 按区间独立解析最高满足版本，**结构上不会复现 pnpm 的旧实例复用偏斜**（9b 事故根因）。npm 不随壳分发（走用户 PATH / `DSH_DESKTOP_NPM`），所以 `npmOnPath()` 探测失败就回落 pnpm。npm 安装前若发现 pnpm 时代的 `node_modules/.modules.yaml` 会先清掉（符号农场对 npm 是异物；镜像 `prepareManagedDir` 的反向策略）。更新流程永远先 park 再安装，所以 npm 实际总是面对空目录，pnpm→npm 迁移零风险。

### 9d. pnpm lockfile 是负资产（勿删此逻辑）

`prepareManagedDir()` 每次都删 `pnpm-lock.yaml`。壳只跑 `pnpm add <spec>`（每次全树重解析），lockfile 没有任何收益，却携带上一版本线的快照供 peer 解析器复用——9b 事故的直接载体。**加新逻辑时不要"优化"掉这行删除**。

## §11. 壳自身自更新（GitHub Releases，区别于 DSH 核心的 npm 更新）

- 壳的版本来源：`app.getVersion()`（package.json），`pushUpdateState()` 里带 `shellVersion`，桌面版设置页显示。
- 检查更新：`dsh:checkShellUpdate` → `queryShellLatest()` 查 `https://api.github.com/repos/${SHELL_REPO}/releases/latest`（默认 `MoonlitDropOfBlood/DSH-Desktop`，可 `DSH_DESKTOP_SHELL_REPO` 覆盖），逐源尝试 API（直连 → 各镜像前缀）。另有 `checkShellUpdateSilent()` 定时后台检查（开机 1min 后 + 每 12h），只喂侧栏徽章不弹面板。
- **User-Agent 必须 ASCII（2026-09-18 崩溃事故）**：`queryShellLatest`/`downloadFile` 的 UA 用 `SHELL_UA`（`"WhaleHarbor/" + app.getVersion()`）。曾用显示品牌 `APP_NAME`（"鲸港 WhaleHarbor" 含中文）——HTTP 头不允许非 latin1 字符，`https.get` **同步抛** `ERR_INVALID_CHAR`：v1.7.0 起手动「检查更新」被 `.catch` 吞成"检查失败"（壳自更新检查一直坏的根因），1.9.4 的 60s 后台检查定时器引爆成每次开机一分钟的崩溃面板。**显示文案用 APP_NAME，线上 HTTP 头一律 SHELL_UA**；定时器驱动的后台路径（checkShellUpdateSilent）整体加防御性 catch——绝不触发 uncaughtException 崩溃面板。recovery e2e 常驻 75s 存活断言覆盖该定时器窗口。
- 按平台选资产 `shellAssetForPlatform`（规则在 `shell-asset.js`，锁在 `scripts/test-shell-asset.js`）：win32→`.exe`；darwin→arm64 用 `arm64.dmg`、x64 优先非 arm64 的 `.dmg`（**别用 `.find(/\.dmg$/)` 会误拿 arm64**）；linux→`.AppImage`（回退 `.deb`/`.rpm`）。
- 下载：`dsh:downloadShellUpdate` → `downloadFile()`（`https.get` + 跟随 302 重定向，GitHub 资产会跳转 `objects.githubusercontent.com`；socket 30s 无数据超时）→ 进度经 `dsh:shellDownloadProgress` 推给桌面版设置 UI。**完整性校验（2026-09-16 起）**：下载完成后对 GitHub 资产的 `digest` 字段（`sha256:<hex>`，解析在 `shell-asset.js` 的 `parseAssetDigest`）做 SHA-256 校验，不匹配 = 该源失败、损坏文件删除、自动切下一源；Release 未提供 digest 时跳过校验并记日志。`asset.name` 经 `path.basename()` 清洗后才拼 temp 路径（镜像可控名字段的 `../` 逃逸封死）。全部源耗尽且发生过校验失败时，错误文案区分"校验失败"与"网络不可达"。
- 启动安装：`launchShellInstaller()`：win 打开 NSIS 安装包并 2s 后退出应用（安装器要替换运行中的 exe）；mac 打开 dmg；linux chmod +x 后打开 AppImage。**`shell.openPath` 失败（杀软拦截等）不再退出应用**——错误经 `dsh:shellDownloadProgress` 回给设置页，壳保持存活。
- GitHub API 未认证限速 60 次/时，够用；网络不可达时优雅失败（toast 提示）。
- 发布流程：打 `v*` 标签 → GitHub Actions 构建并上传资产到 Release（见 `.github/workflows/build-installers.yml`）。CI 同时上传 `*.exe.blockmap` 与 `latest.yml`（electron-builder 产物）——为将来差分更新/第二校验源预留。
- 镜像 `SHELL_MIRRORS`（`DSH_DESKTOP_SHELL_MIRRORS` 覆盖，空串禁用）默认仅 gh-proxy.com（ghproxy.net 实测恒定 403 已移除）；**镜像表/超时参数与 plugins/whaleharbor-promo 是两份拷贝**，任何一边改动必须检查另一边（两处互设了锚点注释）。
