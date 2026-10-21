# 拾页 · DSH Knowledge Library

本地优先的 DeepSeek Harness 资料库插件。把网页、文字、文件和视频字幕保存到自己的电脑，按分类与专题整理，再让 Agent 检索、引用并形成知识笔记。

[npm](https://www.npmjs.com/package/dsh-knowledge-library) · [下载 v0.1.1](https://github.com/Alan-dong-dong/dsh-knowledge-library/releases/tag/v0.1.1) · [更新记录](CHANGELOG.md) · [反馈问题](https://github.com/Alan-dong-dong/dsh-knowledge-library/issues) · [MIT](LICENSE)

这是社区插件，与 DeepSeek 官方没有隶属关系。插件已声明 dsh 原生加载配置，通过 `dsh plugin add` 安装后自动加载，无需另行注册账号或申请插件 ID。插件通过 npm 和 GitHub Release 分发；发布到 npm 不代表已收录进官方或第三方插件目录。

**兼容基线：DeepSeek Harness `0.2.1-rc.2`、Cordis `4.0.5`、Node.js `22.23.0`。**
使用 Node 内置 SQLite，最低要求 Node `22.13.0`。DSH 仍处于预览阶段，其他版本需要重新验证。原生界面已针对 **本机 DSH Web** 验证；桌面发行版、远程部署尚未验证，不能直接视为兼容。

## 已实现

- dsh 原生侧栏「资料库」，跟随宿主深浅主题、字体与按钮样式，支持窄窗口阅读。
- 网页正文提取、原始 HTML 保存、来源地址与作者记录。
- 文本 / Markdown 收集；UTF-8 文本、HTML、SRT、VTT 文件导入。
- 视频、音频、PDF 等文件原样归档，并明确标记「仅归档」。
- 分类对应本地目录；标签与专题用于跨分类组织。
- 中文全文与短词搜索、类型筛选、资料去重。
- 稳定资料 ID、段落引用、字幕时间戳、带来源的知识笔记；点击引用定位原段落。
- 导出单份 Markdown，下载原始附件。
- 网页采集任务持久化，失败可重试，重启后恢复中断任务。
- 从原始资料目录重建 SQLite 索引；校验正文和段落文件，避免外部修改静默改变引用。
- 8 个原生 Agent 工具，直接使用 dsh 的模型与对话。

本插件不主动调用模型、上传资料或监听剪贴板。Agent 读取资料后，所读内容会进入该会话配置的模型上下文；如果模型在云端，相应内容会发送到模型服务商。

![本机 DSH Web 中的拾页资料库（浅色）](https://raw.githubusercontent.com/Alan-dong-dong/dsh-knowledge-library/v0.1.1/assets/screenshots/dsh-library.png)

![本机 DSH Web 中的拾页资料库（深色）](https://raw.githubusercontent.com/Alan-dong-dong/dsh-knowledge-library/v0.1.1/assets/screenshots/dsh-library-dark.png)

截图来自隔离的 DSH Web 测试实例，使用测试资料。

## 安装到 dsh

先安装 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，确保终端可以运行 `dsh`。在 PowerShell 或其他终端执行下面这条命令，从 npm 下载并安装**已经构建好的**插件，不需要克隆源码、安装 GitHub CLI 或注册 npm 账号：

```powershell
dsh plugin --profile web add dsh-knowledge-library@0.1.1 --registry=https://registry.npmjs.org/
```

重启 DSH Web，再在浏览器中按 `Ctrl+Shift+R` 刷新，点击侧栏 **资料库**。界面与 Agent 工具共享同一份本地资料。示例安装到 `web` profile；如果你实际使用其他 profile，请先确认宿主版本与界面兼容性后替换。已验证的宿主为 `0.2.1-rc.2`。

也可以安装 GitHub Release 中的同一版本：

```powershell
dsh plugin --profile web add "https://github.com/Alan-dong-dong/dsh-knowledge-library/releases/download/v0.1.1/dsh-knowledge-library-0.1.1.tgz" --registry=https://registry.npmjs.org/
```

如果终端无法直接下载 GitHub 地址，可以从 [Releases](https://github.com/Alan-dong-dong/dsh-knowledge-library/releases) 下载 `.tgz` 与 `SHA256SUMS`，然后安装本地包：

```powershell
# 将输出与 SHA256SUMS 中的值比较。
Get-FileHash 'D:/下载/dsh-knowledge-library-0.1.1.tgz' -Algorithm SHA256
dsh plugin --profile web add "D:/完整路径/dsh-knowledge-library-0.1.1.tgz"
```

安装过程中仍需从 npm 下载运行依赖。插件包含 `dsh.bundle.patch` 配置和符合 dsh lazy-CJS 协议的客户端入口。更新时将安装命令中的版本号替换为新版本，或安装新 Release 的版本化 `.tgz` 地址，再重启宿主。卸载可执行 `dsh plugin --profile web remove dsh-knowledge-library`；已保存的资料保留在独立资料目录。

如果安装后没有入口，先确认安装的 profile 与启动的 profile 相同，重启并刷新，再用 `dsh --profile web --dump-config` 检查是否存在启用的 `knowledge-library`。网页采集遇到代理 fake-IP 提示时，参见下方配置。

### 从源码安装

适合开发或需要自己构建的用户：

```powershell
git clone https://github.com/Alan-dong-dong/dsh-knowledge-library.git
cd dsh-knowledge-library
npm ci
npm run build
$pluginPath = (Get-Location).Path.Replace('\', '/')
npx --no-install dsh plugin --profile web add "link:$pluginPath"
npx --no-install dsh web
```

## 独立预览

不需要模型密钥，也可以单独打开资料库：

```powershell
npm run build
npm start
```

访问 <http://127.0.0.1:4317>。这只是同一个插件界面的本地预览，不是另一个资料系统。

自定义目录与端口：

```powershell
$env:KNOWLEDGE_LIBRARY_ROOT = 'D:/KnowledgeLibrary'
$env:PORT = '4317'
npm start
```

同一个资料库只能由一个写入实例打开。使用 dsh 插件前，请关闭使用同一目录的独立预览。

## dsh 配置

默认资料目录为当前用户主目录下的 `Documents/DSH-Knowledge-Library`，不是插件安装目录或聊天工作区。

在 dsh 的配置中修改 `knowledge-library` 项，或者创建一个覆盖文件：

GitHub 当前源码还提供界面入口：打开资料库右上角的 **设置 → 选择目录**，选择目标文件夹后点击 **切换资料库**。Harness 使用系统选择窗口或网页内目录浏览器，也可以直接填写完整绝对路径。选择过程可以取消；只有确认切换后才保存插件配置，重启后仍使用新目录。此功能尚未发布到 npm，npm `0.1.1` 仍需通过下方配置修改目录。

切换目录会读取目标资料库并将后续内容保存到那里；旧资料保留在原目录，不会自动搬迁。需要迁移时先关闭 Harness，复制整个资料库（包含 `.system`）到新目录后再切换。目标目录被占用、无法写入或插件重载失败时，会显示错误。新旧资料库应位于互不包含的独立目录。使用命令行 `--patch` 或主目录覆盖文件固定 `root` 时，需要先调整该覆盖配置，才能从界面保存新目录。独立预览通过启动环境变量指定目录。

手动配置示例：

```yaml
- id: knowledge-library
  config:
    root: D:/KnowledgeLibrary
    allowProxyFakeIp: false
```

通过以下命令加载：

```powershell
dsh --profile web --patch ./library.patch.yml
```

`root` 必须是绝对路径。卸载插件、删除聊天都不会删除这个资料目录。

### 本机代理的 fake-IP DNS

若网页采集提示检测到 `198.18.*`，且你确认本机正在使用 Clash/Mihomo 的 TUN fake-IP 模式，可以把 `allowProxyFakeIp` 设为 `true`。

GitHub 当前源码提供 **资料库设置 → 网页采集 → Clash/Mihomo 代理兼容（fake-IP）**：勾选后点击 **保存采集设置**，保存成功后重新采集失败任务。任务遇到 fake-IP 错误时，也可以直接点击 **代理兼容设置**进入；保存后会返回任务列表。仅勾选而不保存不会改变配置。此界面入口尚未发布到 npm；npm `0.1.1` 可在 Harness 插件配置中手动修改 `allowProxyFakeIp`，保留其他字段并重新加载插件。

GitHub 当前源码的独立预览也可直接勾选并保存，保存后对后续采集生效，无需重启。设置保存在当前资料库的 `.system/preview-settings.json`，重启后继续生效；Harness 使用自身 profile 的插件配置。

尚未保存预览设置时，可以用环境变量指定初始值：

```powershell
$env:KNOWLEDGE_LIBRARY_ALLOW_FAKE_IP = '1'
npm start
```

通过界面保存后，以保存的预览设置为准，包括手动关闭兼容模式。

此开关默认关闭，只放行**域名解析结果**中的 `198.18.0.0/15`。它不允许直接访问此范围的 IP URL，也不放开 `127.*`、`10.*`、`192.168.*` 等其他本机和内网地址。该模式依赖你对本机代理 DNS 的信任。本机公网采集验证在显式启用此开关后通过。

兼容模式解决 fake-IP DNS 的访问限制，不保证站点本身可访问。微信公众号链接仍可能连接超时或要求浏览器验证；重试仍失败时，可以复制正文保存为文本，或导入本地 HTML。

### 网页返回验证页面

GitHub 当前源码会识别明确的微信“环境异常”和常见 Cloudflare 验证页结构。识别到时，任务显示 **需浏览器验证**，不会把验证提示当作文章正文保存；保存下来的验证页 HTML 也会被拒绝。相关修复尚未发布到 npm。

在采集任务中点击 **打开原网页**，自行在浏览器中完成验证，再点击 **粘贴正文**，粘贴实际文章内容保存。文本摘录会预填 **来源网页**，可以核对或修改；也可以导入浏览器保存的实际文章 HTML。后台采集不共享浏览器登录或验证状态，浏览器验证完成后直接重试后台请求仍可能被拦截。

识别依据是站点路径、页面结构和提示的组合，普通文章中提到“验证”或“环境异常”仍可正常采集。此前已误存的记录会保留，需要重新收集实际正文。

## 对 Agent 说什么

> 把这段文字保存到“技术/AI”，添加“待读”标签，归入“个人知识库”专题。

> 搜索资料库中有关混合检索的内容，读取相关段落，整理成一份带来源引用的笔记。

> 导入 D:/资料/课程字幕.vtt，保留时间戳，归入“课程学习”专题。

| 工具 | 用途 |
|---|---|
| `library_capture` | 保存文本，或创建网页采集任务 |
| `library_import_file` | 复制用户指定的本地文件，最多 64 MB |
| `library_search` | 按关键词、分类、标签、专题、类型检索 |
| `library_read` | 分段读取正文与字幕，返回引用位置 |
| `library_update_metadata` | 修改标题、分类、标签、专题与备注 |
| `library_save_note` | 保存笔记，并验证引用资料与段落存在 |
| `library_jobs` | 查看网页任务，重试失败任务 |
| `library_overview` | 查看资料库统计与索引警告 |

工具返回结构化 JSON，避免把整库内容一次性送入上下文。`library_read` 默认返回 12 个段落，最多 30 个；资料内容均被描述为待分析的不可信输入。引用格式：

```text
library://r_资料UUID/p0002
```

笔记引用验证的是来源存在与定位有效性，**不自动证明笔记中的结论正确**。

## 本地文件结构

```text
DSH-Knowledge-Library/
├─ materials/
│  └─ 技术/AI/
│     └─ r_资料UUID/
│        ├─ metadata.json      分类、标签、来源、引用、校验值
│        ├─ content.md         提取后的正文
│        ├─ segments.json      稳定段落及字幕时间戳
│        └─ original.html      原始文件（如有）
└─ .system/
   ├─ index.sqlite            可重建索引
   ├─ jobs.json               持久化网页任务
   └─ writer.lock             单写入实例锁
```

资料创建后正文保持不可变，修改理解时创建笔记；需要修订原文时重新导入。标题、分类、标签和专题可以在界面中修改。手动改写 `content.md` 或 `segments.json` 会在重建索引时报告校验异常，避免引用指向已被改写的证据。

备份时先关闭插件或预览，再复制整个资料目录。不要只复制 SQLite 文件。索引丢失可以重建；任务历史保存在 `jobs.json`。启动时会忽略未提交的 `.pending-*` 目录并报告无法解析的资料。

## 当前边界

- 网络视频平台自动下载、音视频自动转写、关键帧分析、PDF 文本提取和 OCR 未接入。可以先导入原文件与外部生成的字幕。
- 网页采集适用于直接可访问的文章；登录页、反爬或复杂动态页面请复制文本，或导入保存的 HTML。
- 网页正文和原始 HTML 会保存；图片保留远程引用，不下载资源，不保证原网页完整离线还原。
- 网页最多 6 MB，文本最多 200 万字符，单个文件最多 64 MB。
- 搜索以本地全文和字面匹配为主；当前不含向量语义检索、自动分类或自动摘要。
- 前端安全显示文本和标题，不执行资料 HTML。Markdown 的复杂表格、公式等尚无专用排版。
- 当前专题为单值字段，标签可多值；尚无批量专题压缩包导出、同步和多人协作。
- 后台网页任务随宿主停止；下次启动可重试恢复，不会在退出 dsh 后常驻运行。
- HTTP 界面仅接受本机连接、精确 Host 与同源写入；远程 Web、代理前缀部署与桌面 IPC 需要单独适配。
- 暂不提供删除入口，避免资料或笔记引用被误删。

## 开发与验证

```powershell
npm ci
npm run build
npm test
npm run pack:check

# 浏览器测试使用 Python Playwright。
python -m pip install -r requirements-test.txt
python -m playwright install chromium
npm run test:ui
```

`npm test` 覆盖内容持久化、索引重建、中文检索、去重、分类移动、引用、字幕、文件归档、原生 Cordis 工具注册与卸载，以及 HTTP 接口边界。

`npm run test:ui` 启动临时资料库和无头浏览器，验证采集、搜索、笔记引用跳转、信息编辑、重新加载、字幕上传、类型筛选、文本渲染和移动端布局，并完整停止和重启独立预览验证代理开关持久化。数据与服务日志位于 `.test-runtime/`，截图与结果位于 `test-results/`，不会修改默认资料库。

`tests/dsh_smoke.py` 用于已经启动的**隔离 dsh 实例**，从 `DSH_TEST_URL` 读取带本机启动令牌的地址，验证原生侧栏与真实插件界面。不要把启动令牌提交到仓库。

运行上述原生检查后，可以在同一隔离实例中执行 `python tests/dsh_style.py`。该检查要求宿主外观保持默认的“跟随系统”，会对比资料库与原生自动化任务页面的字体和按钮颜色，并验证深浅主题切换、弹窗、分类导航以及窄窗口布局。截图与报告保存在 `test-results/style-*`。

`npm run test:dsh:directory` 会创建独立的 DSH profile 与资料目录，验证宿主目录浏览、取消选择、目标目录错误、插件加载失败回滚、切换后保留原资料，以及完整重启后的目录和资料持久化。测试使用网页内浏览方式，不会弹出系统选择窗口，也不会更改个人 Harness 配置；报告和截图位于 `test-results/directory-*`。

该命令还执行 `tests/dsh_proxy.py`，验证代理兼容开关的手动保存、关闭、失败保留旧值、采集错误入口、返回重试与重启持久化，以及验证页失败后的原网页入口和保留来源的正文粘贴。任务展示使用固定测试数据，配置保存与正文保存调用真实 Harness 接口；报告和截图位于 `test-results/proxy-*` 和 `test-results/verification-*`。

源码分层：

- `src/core/`：存储、检索、网页提取、字幕和任务队列。
- `src/tools.ts`：dsh Agent 工具。
- `src/index.ts`：Cordis 宿主插件及生命周期。
- `src/http.ts`：本机界面接口。
- `src/client.tsx`：dsh 原生侧栏与主面板注册。
- `src/ui/`：中文资料库界面。
- `src/standalone.ts`：同一界面的独立预览。

未调用付费模型或使用真实模型凭据测试模型推理。已验证工具能被实际 dsh/Cordis 运行时注册与执行；具体模型如何选择工具，取决于你的模型与 dsh 配置。

## 维护与发布

`npm run verify` 执行构建、行为测试与安装包检查。产物位于 `release/`：版本化 `.tgz`、`SHA256SUMS` 和包文件清单。发布包只包含构建文件、插件配置与说明，不包含本地资料、测试实例或开发依赖。

仓库的 `automation/workflows/` 提供 Windows / Linux 持续集成和版本发布的 GitHub Actions 模板，当前尚未启用。维护者如需自动化，可将模板复制到 `.github/workflows/`，再使用具有 workflow 写入权限的凭据推送。发布模板要求标签与 `package.json` 版本一致，验证后会上传安装包与 SHA-256 校验文件。

发布前运行本机 `npm run verify`，检查隔离安装与原生界面，再将同一个版本化安装包发布到 npm 和 GitHub Release。上传 Release 时只选择本次版本的 `.tgz` 与对应 `SHA256SUMS`。

npm 发布需要维护权限与有效认证。更新 GitHub 源码不会自动更新 npm；必须递增版本号并发布新包，用户再按新版本安装并重启宿主。
