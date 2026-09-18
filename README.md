# zcode-block-upload

> 阻止 [ZCode](https://zcode.z.ai) 桌面端把**整个工作区（含完整 `.git` 历史）**打包加密后上传到阿里云 OSS。
>
> Blocks ZCode (a Chinese AI coding desktop app) from silently packaging your whole workspace — including the
> full `.git` history — encrypting it and uploading it straight to Alibaba Cloud OSS on every prompt.

一句话原理：ZCode 上传快照前必须先向服务端换一份"上传凭据"，本工具把那**一个**凭据端点
在客户端代码里等长替换成一个 404 路径，于是整条链路在第一步就静默放弃——不枚举文件、
不打包、不加密、不落盘、没有任何数据外发。

> **这不是智谱官方工具**，不在任何官方渠道分发。它修改的是你自己机器上的软件，
> 请先读文末[免责声明](#免责声明)再决定是否使用。

## 简介

ZCode 会在每次发消息前和任务结束时，把整个工作区打 tar.gz、用随机 AES-256-CTR 密钥加密、
再用服务端下发的 RSA 公钥把密钥包起来，直接 POST 到阿里云 OSS——包里含 `.git` 的完整对象库、
reflog 和 LFS 缓存，还会夹带你的 MCP 配置、skills、commands、hooks 和 AGENTS.md。
界面上的"优化体验""仓库快照索引"两个开关并不控制这条链路。

这个工具从用户侧把它切断：把取凭据端点 `/api/v1/snapshot/upload-credential` 等长替换成一个
404 路径（字节长度一致，asar 头部两万多个文件偏移全部保持有效，无需重建归档），
整条链路就在第一步静默放弃——不枚举文件、不打包、不加密、不落盘、零外发。
再借 ZCode 自己的 `SessionStart` 钩子，每次开会话自动检查一遍，升级覆盖后自动把补丁补回来。

已在 Windows 版 ZCode 3.11.2 上逐条核验（端点、加密方案、打包范围、触发时机）。
遇到不认识的版本会拒绝改动文件并提示人工复查；所有改动前自动备份，可一键还原。
非官方工具，使用前请自行核对软件许可与相关条款。

## 目录

- [简介](#简介)
- [背景](#背景)
- [它拦的是什么](#它拦的是什么)
- [安装](#安装)
- [使用](#使用)
- [它是怎么做到的](#它是怎么做到的)
- [升级后如何复查](#升级后如何复查)
- [常见问题](#常见问题)
- [文件说明](#文件说明)
- [卸载与还原](#卸载与还原)
- [免责声明](#免责声明)
- [许可](#许可)

## 背景

事情的起点是 ferstar 的分析文章
[《ZCode 静默上传工作区快照》](https://blog.ferstar.org/posts/zcode-silent-workspace-snapshot-upload/)：
作者发现 ZCode 在登录状态下会静默把工作区（含 `.git` 完整历史、LFS 缓存、reflog）
打包加密上传到阿里云 OSS。

我在 Windows 版 ZCode 3.11.2 上独立复核了他的结论——直接解剖官方安装包里的
`resources/app.asar`，逐条验证端点、加密方案、打包范围、触发时机与"关不掉的开关"，
结论一致。本仓库是据此做的**用户侧拦截工具**，并补充了原文未提及的几处细节（见下文）。

## 它拦的是什么

以下每条都在官方 `app.asar` 里核对过（文件路径以 3.11.2 为准）：

| 环节 | 事实 |
| --- | --- |
| 触发时机 | **每次发消息前**（`sessionSend` 之前调用捕获调度）与**任务结束时**（`captureStage: "terminal"`，内容 `repo-wiki-update`） |
| 取凭据 | `GET {origin}/api/v1/snapshot/upload-credential?workspace_id=<hash>`，头带 `Authorization: Bearer <登录 JWT>` |
| 打包范围 | 清单来自 `git ls-files --cached --others --exclude-standard`，**再额外遍历 `.git/` 目录**；`.git` 路径被强制包含，**绕过 1MB 大小限制与二进制检查** |
| 排除项 | `node_modules`、`.cache`/`.turbo`、`dist`/`build`/`out`/`.next`/`coverage`、以及按**文件名**匹配的敏感文件表（`.env*`、`.npmrc`、`id_rsa` 等、`*.pem`/`*.key`/`*.p12`/`*.pfx`、文件名含 `token`/`secret` 的） |
| 加密 | 打 `tar.gz` → 随机 AES-256-CTR 密钥加密 → 该密钥用**服务端下发的 RSA 公钥**做 RSA-OAEP-SHA256 包裹；产物 `repo-snapshot.tar.gz.enc`。私钥只在云端，本地无法解密 |
| 上传 | 用凭据里的预签名表单 + STS 临时凭证，**POST 直传阿里云 OSS**（`n.oss.host`），`callback: {mode:"oss-callback"}` 由 OSS 回调智谱后端——载荷不经过智谱服务器 |
| 附带上传 | 每次快照都夹带全局配置：行为设置（**包括那两个隐私开关自身的值**）、MCP 服务器、user 级 skills、全局 commands、hooks、plugins、memory、subagents、instructions（`AGENTS.md`） |
| 开关无效 | 界面上的"优化体验"`optimizeAgentExperienceEnabled`、"仓库快照索引"`repoSnapshotIndexingEnabled` **不控制**这条链路——它们在那段代码里只作为"被上传的配置内容"出现，不是判断条件 |
| 关不掉 | 侧车服务 `new RepoSnapshotSidecarService({...})` 是裸构造，无设置判断、无平台判断、无特性开关；唯一前置条件是 `tokenProvider()` 能拿到登录 JWT |
| 删了还传 | 待上传队列持久化在本地，失败次数按回合累加，每次发消息都会重试 |

### 与原文的差异

- 原文说"可能连敏感配置和密钥一起打包"**偏重了**：代码里确实有一份按文件名匹配的排除表
  （上面"排除项"一行）。但这个防护很薄——**只检查文件名**，`config/prod.yaml` 里明文写的
  密码、`.env.backup` 之类照样上传；而 `.git/**` 在更前面就无条件放行，**完全绕过这项检查**，
  所以 `.git/config` 里内嵌凭证的 remote URL、历史提交里的密钥仍在包里。
- 全局配置那条路径还有一层按键名脱敏（`api_key|token|secret|password|credential|authorization|cookie`），
  原文没提到，这算一个真实的缓解措施。
- 本机复核时发现：**拦截之前，这台机器上其实从未成功上传过**——没有 `v2/checkpoints` 目录、
  没有 `.enc`/`envelope`/`state.json`、日志里相关关键字命中为 0。原因是取凭据那一步
  服务端没有签发可用凭据（客户端 `getUploadKey()` 返回空即静默返回）。
  也就是说**真正的总闸在服务端**，本工具做的是在你这一侧把这条链路彻底堵死。

## 安装

### 前置条件

- Windows（本项目只在 Windows 上开发与验证过；见[常见问题](#常见问题)里的 macOS 说明）
- ZCode 桌面端已安装
- [Node.js](https://nodejs.org) 16+（脚本用它执行；`install.cmd` 会自动找 node，找不到会提示）

### 方式一：单文件（推荐，连解压都不用）

```bash
node build-oneclick.js      # 生成 一键安装.cmd（含全部载荷，约 40KB）
```

双击生成的 `一键安装.cmd` 即可：它把内置的工具包解压到
`%LOCALAPPDATA%\ZCodeSnapshotBlock`（稳定位置），自动识别 node / `app.asar` / 配置路径，
完成打补丁 + 写入钩子 + 自检。

### 方式二：解压后双击 `install.cmd`

把仓库（或 Release 里的 zip）解压到任意目录，双击 `install.cmd`。等价于：

```bash
node setup.js
```

`setup.js` 会自动完成四件识别 + 三件操作：

1. 识别**自身所在目录**（钩子脚本路径由此得出）
2. 识别 **node**（`process.execPath`，不靠猜）
3. 识别 **`app.asar`**（正在运行的 ZCode 进程目录 → 常见安装位置 → 盘根浅扫）
4. 识别**配置文件**（`ZCODE_DATA_BASE_DIR` → `%USERPROFILE%` → `HOME`，取已存在 `.zcode` 的那个）
5. 给 `app.asar` 打补丁（已打过则跳过；改前自动备份原始文件）
6. 写入 `~/.zcode/cli/config.json` 的 `SessionStart` 钩子（保留文件里其它内容，改前备份）
7. 自检（复核补丁 + 试跑钩子）

**然后重启一次 ZCode**，让补丁进入内存。之后 ZCode 每次开始会话，钩子会自动检查一次；
升级覆盖了 `app.asar` 时也会在下次会话启动时自动补回。

## 使用

| 操作 | 命令 | 说明 |
| --- | --- | --- |
| 查看状态 | `verify.cmd` / `node zcode-block-upload.js --verify` | 归档信息、原始/替换端点串计数、备份列表 |
| 打补丁 | `apply.cmd` / `node zcode-block-upload.js --apply` | 自动备份；可重复运行，已打过则跳过 |
| 还原原始文件 | `restore.cmd` / `node zcode-block-upload.js --restore` | 用最新备份还原，当前版本另存为 `.patched-<时间>` |
| 安装钩子 | `install.cmd` / `node setup.js` | 上面的全自动流程 |
| 移除钩子 | `uninstall.cmd` / `node uninstall.js` | 只移除本工具的钩子条目，其它配置保留 |
| 可选：常驻守卫 | `install-guard.cmd` / `uninstall-guard.cmd` | 额外的兜底（登录自启 + 文件监听），平时用不到 |

**确认它在工作**：新开一个会话或重启 ZCode，看 `zcode-hook-state.json` 的 `checkedAt`
是否刷新（快路径只更新时间戳、不写日志，所以日志干净是正常的）。

所有脚本都接受 `--asar "<路径>"` 指定归档，也认环境变量 `ZCODE_ASAR`；不给就自动探测。

## 它是怎么做到的

### 1. 等长字节替换（不重建归档）

把 `app.asar` 里这个端点常量

```
/api/v1/snapshot/upload-credential      （34 字节）
/api/v1/snapshot/upload-disabled-x      （34 字节，替换后）
```

逐字节替换。**长度完全一致**，因此 asar 头部记录的 2 万多个文件偏移量全部保持有效，
不需要重建归档，也不必在应用关闭时操作。

### 2. 为什么在这个位置下手是安全的

因为取凭据之后的失败分支是**静默返回**：

```js
let n = await this.tokenProvider();          // 有没有登录
if (!n) return;
let a = await this.uploadClient.getUploadKey(n, i, t.traceId);
if (!a) return;                              // ← 拿不到凭据就到此为止
// 之后才会枚举文件、打包、加密、写盘、发 OSS
```

这条分支正是**服务端拒绝签发凭据时客户端本来就会走的路径**——两个调用点
（发消息前、任务结束）的错误都被 `.catch(()=>{})` 吞掉，所以拦截后：
不枚举、不打包、不加密、不落盘、零外发，且对话/工具调用/任务流程完全不受影响。

补充：替换成"不存在的路径"会让该请求返回 404；这也顺带说明，网络层如果能看到
`POST *.aliyuncs.com` 就等于漏了——因为载荷是直传 OSS 的。

### 3. 用 ZCode 自己的 `SessionStart` 钩子自愈

一次性补丁会被升级覆盖，所以把它变成**持续状态**：在用户配置
（`~/.zcode/cli/config.json`，位于数据目录、升级不会清掉）里注册一个 `SessionStart` 钩子，
指向本工具的 `zcode-session-hook.js`：

```json
{ "hooks": { "enabled": true, "events": { "SessionStart": [
  { "hooks": [ { "type": "process",
      "command": "<node.exe>",
      "args": ["<安装目录>\\zcode-session-hook.js"],
      "timeoutMs": 60000,
      "statusMessage": "检查快照上传拦截状态" } ] } ] } } }
```

钩子每次会话启动时内联执行（会话会等它跑完才继续，所以补丁必然在第一次快照捕获之前就位）：

- **快路径**：签名与上次一致且已确认打过补丁 → 约 0.3 秒静默退出；
- **慢路径**：`app.asar` 被替换过（升级）→ 重新打补丁，约 2~3 秒；
- 两条硬约束：**绝不向 stdout 输出**（钩子 stdout 会被当 JSON 解析，非 JSON 会把这次运行
  标记为失败）、**绝不以非 0 退出**（会被视为错误甚至阻塞会话）。所有信息写进 `zcode-guard.log`。

### 4. 不认识的版本就拒绝动手

如果新版本改了代码结构、找不到目标端点串，工具**不会盲改**：

```
错误: 归档里找不到目标端点串，可能版本已变化；请勿盲目替换，先人工确认。
```

实测：文件 md5 一字节不变，且连备份都不会创建（拒绝发生在备份之前），
同时写 `NEEDS-REVIEW.txt` 提示人工复查。

## 升级后如何复查

`audit-tools/` 里是这次取证用的三个脚本，升级后可以自己复查：

```bash
cd D:\zcode\resources

# 1) 端点还在不在、有几处
grep -abo "upload-credential" app.asar

# 2) 把可疑位置切出来读（比 grep -C 稳，asar 里是一行到底的压缩 JS）
node <仓库目录>\audit-tools\asar_slice.js app.asar 253995697 900 900

# 3) 确认 asar 完整性校验仍然关闭（开了就不能改包了）
node <仓库目录>\audit-tools\fuses_all.js D:\zcode\ZCode.exe
```

顺带一提，也可以直接看行为：**ZCode 使用一段时间后，`~/.zcode/v2/checkpoints` 目录
始终不存在，就说明没有任何快照被打包落盘。**

## 常见问题

**会不会影响正常使用？**
不影响对话、工具调用、任务流程。补丁只改了一个快照上传端点；本地 git 回滚点功能
（`GitCheckpointStore`，写 `v2/checkpoints/<hash>/*.json`）走的是另一条路径，也不受影响
——这也正是本项目**没有**采用"目录加只读锁"那种方案的原因（那种做法会连带废掉本地回滚）。

**和直接改 hosts / 屏蔽域名比，好在哪？**
OSS 的 bucket 域名是服务端凭据里动态下发的，hosts 无法枚举、通配；而窗口防火墙规则要按 IP，
阿里云段又大又易变。从"取凭据"这一步切断是唯一精确且不误伤的点——而且不碰网络层，
不会影响模型调用等正常流量。

**为什么不拦截 OSS 请求，而是拦截取凭据？**
因为打到取凭据就**连打包都不会发生**（不读盘、不算哈希、不占用 CPU），
而拦截 OSS 请求时数据已经打包加密落盘了，还会不断重试堆积。

**为什么不默认装一个常驻进程？**
不需要。`SessionStart` 钩子是内联的，会话会等它执行完，没有任何竞态窗口，
也不占内存、不需要管理员权限。想再加一层保险可以 `install-guard.cmd`。

**提示"找不到 app.asar"？**
用 `--asar "<路径>"` 指定，或设环境变量 `ZCODE_ASAR`。一般是 ZCode 装在非常规位置。
`setup.js` 的探测顺序见[安装](#安装)一节。

**提示"找不到目标端点串"？**
说明这个版本的代码结构变了，工具出于安全拒绝修改。用上面的
[升级后如何复查](#升级后如何复查)流程确认新结构后再处理；此时补丁未生效。

**改了别人的软件，会不会被检测/破坏签名？**
Windows 上 `app.asar` 不在 `ZCode.exe` 的 Authenticode 签名覆盖范围内，改它不会破坏可执行
文件签名；运行时 Electron 也没有对 asar 的完整性校验（本机已确认 fuse 第 4 位为 0）。
所有改动都有备份，`restore.cmd` 可一键还原。

**macOS 能用吗？**
不建议用"改包"这条路：`app.asar` 位于 `.app` 包内、属于代码签名覆盖范围，改动会让签名失效，
签名/公证过的应用启动会被系统拒绝。macOS 上应改用目录只读锁或网络层拦截。
（Linux 机制上成立，但本项目未在 Linux 上验证过。）

**这是不是"破解"？**
不是。它不绕过任何付费/授权机制，也不修改服务端，只是在你自己的机器上阻止一个
客户端外发行为。但**是否允许这样修改，请自行核对软件许可与相关条款**，见下。

**为什么必须"双击一次"而不能"解压即生效"？**
因为任何操作系统都不会在"解压"这个动作上执行代码——解压是压缩软件的纯数据操作，
能自动运行就等于给病毒开了传播通道。`一键安装.cmd` 已经把这一步压到最小：一个文件、一次双击。

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `zcode-block-upload.js` | 核心：等长替换打补丁 / 校验 / 还原（含备份、按内容哈希命名） |
| `detect-asar.js` | 定位 `app.asar` 的公共探测逻辑，所有脚本共用 |
| `setup.js` / `install.cmd` | 一键安装：自动识别 + 打补丁 + 写钩子 + 自检 |
| `uninstall.js` / `uninstall.cmd` | 移除钩子配置（保留文件里其它内容） |
| `zcode-session-hook.js` | `SessionStart` 钩子：会话启动时自愈（快/慢两条路径） |
| `zcode-guard.js` + `guard-install.js` | 可选的常驻守卫（登录自启 + 监听文件变化） |
| `build-oneclick.js` | 把整个工具包打包成单文件 `一键安装.cmd` |
| `apply.cmd` / `verify.cmd` / `restore.cmd` | 手动入口 |
| `hooks-config.example.json` | 手动配置钩子时的模板 |
| `audit-tools/asar_slice.js` | 按字节偏移切 asar 内容并标出所属文件 |
| `audit-tools/ctx.js` | 在压缩 JS 里按字符串取上下文 |
| `audit-tools/fuses_all.js` | 读 Electron fuse，确认 asar 完整性校验是否开启 |

运行期产物（`zcode-guard.log`、`zcode-hook-state.json`、`zcode-guard.pid`、`NEEDS-REVIEW.txt`、
`*.bak-*`）不进版本库，已列入 `.gitignore`。

## 卸载与还原

```bash
uninstall.cmd              # 移除钩子配置（ZCode 不再自动检查）
uninstall.cmd --restore-asar   # 同时把 app.asar 还原成原始文件
restore.cmd                # 只还原 app.asar
```

卸载后 ZCode 回到原始状态。备份文件在 `app.asar.orig-<时间>-<内容哈希>`，
按内容哈希命名是为了避免升级后拿旧版本备份去覆盖新版本。

## 免责声明

- 本项目**不是**智谱（Zhipu AI）/ ZCode 官方项目，与官方无任何关联，未获其授权或认可。
- 它修改的是**你本机**上已安装软件的一个归档文件，并只阻止一个客户端外发行为；
  不绕过授权、不修改服务端、不接触他人数据。
- **请自行确认这样做是否符合你所在地区的法律、以及 ZCode 的软件许可与服务条款。**
  若条款禁止修改客户端，请不要使用本工具。
- 修改第三方软件存在风险（升级后行为变化、厂商调整实现等）。工具已尽量做成
  "不认识的版本就拒绝动手 + 自动备份 + 一键还原"，但仍请**自行评估并承担使用风险**，
  作者不对任何后果负责。
- 文中引用的代码片段来自公开分发的安装包，仅用于说明技术原理。

## 许可

[MIT](LICENSE)
