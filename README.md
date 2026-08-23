# WebSSH

一个基于 Go、WebSocket 和 xterm.js 的 Web SSH 终端，支持密码/私钥认证、IPv4/IPv6、SFTP、系统监控、多终端标签、连接书签以及可同步的脚本书签。

## 功能特性

- IPv4、域名和 IPv6 SSH 登录；裸 IPv6 与带方括号 IPv6 均可识别
- 密码、私钥及带口令私钥认证
- SOCKS5 代理、多标签终端、SFTP 文件管理和系统信息监控
- RDP 远程桌面：浏览器内 IronRDP WASM 客户端，画面不经服务端转码；支持窗口化全屏、真全屏、自定义分辨率，以及 SOCKS5/SSH 跳板中转
- SFTP 多标签工作台：文件新建/在线编辑、图片/ICO/视频预览、删除、流式上传，以及带进度的文件/文件夹下载
- 脚本名称/命令片段即时搜索
- 彩色 Emoji 分类、分类筛选和分类增删改查
- 脚本及分类导入、导出和账号云同步；管理员可备份/恢复全站用户书签
- 管理员用户列表，支持用户增、删、改、查及重置密码
- xterm.js、插件、中文字体和等宽字体全部随程序/Docker 镜像部署，不依赖远程 CDN
- Docker Compose 交互式部署，以及带健康校验/回滚的页面和命令行更新
- 移动端和 iPad 响应式界面

## 快速部署

### 交互式部署（推荐）

```bash
git clone https://github.com/a06342637/webssh2.git
cd webssh2
sh setup.sh
```

向导会依次询问：

```text
服务端口 [默认 8008，直接回车跳过]
是否仅允许本机反向代理访问？(y=仅监听 127.0.0.1  [回车]=监听所有网卡)
是否显示底部版权页脚？([回车]=显示  n=不显示)
是否启用 Web 登录验证？(y=启用  [回车]=不启用)
是否禁止游客直接连接 SSH/SFTP？(y=必须登录  [回车]=允许游客)
书签管理员用户名 [默认 admin]
书签管理员密码 [回车=自动随机生成；至少 7 个字符，最多 72 UTF-8 字节]
是否启用页面内版本更新？(y=启用  [回车]=禁用)
```

这里的“书签管理员”用于账号同步、脚本书签/Emoji 分类同步、用户管理和页面更新；它不是目标 SSH 服务器账号，也不是可选的 Web 页面 Basic Auth。

书签账号密码至少需要 7 个字符，并且不能超过 72 个 UTF-8 字节（bcrypt 限制）。密码留空时会在首次创建管理员时随机生成，并只打印在首次启动日志中：

```bash
docker compose logs webssh | grep -A8 "WebSSH 管理员账号"
```

向导还会检测宿主机的全局 IPv6 地址和默认 IPv6 路由：

- 检测到可用 IPv6：不额外提示。
- 未检测到 IPv6：提示“本机没有 IPv6，无法直接连接 IPv6 SSH”，按回车继续。
- 宿主机有 IPv6、容器却没有 IPv6 路由：启动后给出 Docker IPv6 配置警告。

向导生成的 `.env` 权限为 `0600`。重复运行时会先生成 `.env.backup.时间戳.PID`，保留向导不认识的自定义键，再原子替换 `.env`；这些文件已加入 `.gitignore`，仍不要手工提交。

Docker Compose 的 `.env` 密码建议使用单引号，避免 `$` 被 Compose 当作变量插值；密码本身包含单引号时写成 `\'`。

### 普通 Docker Compose 部署

```bash
git clone https://github.com/a06342637/webssh2.git
cd webssh2
docker compose up -d --build
docker compose ps
```

默认端口为 `8008`，并绑定 `0.0.0.0`。安装后可以直接访问 `http://服务器IP:8008`，指向该服务器的域名也可以使用相同端口访问。普通 Compose **不会挂载源码目录和 Docker socket**，页面内更新默认关闭。

公网裸 HTTP 会明文传输 Web 登录信息、SSH 密码/私钥和终端数据，建议开放测试完成后尽快配置 HTTPS/WSS，并通过防火墙限制不需要的来源。

自定义端口：

```bash
PORT=3000 docker compose up -d --build
```

如果只允许同机 Nginx/Caddy/其他反向代理访问，可显式绑定本机回环地址：

```bash
BIND_ADDRESS=127.0.0.1 docker compose up -d --build
```

停止服务：

```bash
docker compose down
```

## IPv6 SSH 登录

SSH 主机输入框支持以下两种写法：

```text
2603:c021:8012:ef00:0:dd95:ca1:7387
[2603:c021:8012:ef00:0:dd95:ca1:7387]
```

后端会去掉已有方括号，并用 Go 的 `net.JoinHostPort` 生成标准拨号地址，例如：

```text
[2603:c021:8012:ef00:0:dd95:ca1:7387]:22
```

如果浏览器无法访问配置的终端直连 WSS，页面会自动改用当前网站同源的 `/term` 再连接一次，避免直连域名、证书或网络策略异常导致 IPv4/IPv6 SSH 直接失败。

### WebSSH 宿主机没有 IPv6 时能否连接？

通常不能直接连接只有 IPv6 地址的 SSH 服务器。浏览器只负责访问 WebSSH 页面，真正发起 SSH TCP 连接的是 WebSSH 服务端/容器，因此服务端必须具有可用 IPv6 地址、默认路由以及容器 IPv6 出口。

例外：如果在连接页配置了一个能够访问 IPv6 的 SOCKS5 代理，也可以让 WebSSH 通过代理连接 IPv6 目标。

Compose 默认网络已启用 IPv6 并分配 ULA 子网 `fd42:7765:6273:7368::/64`，但这不能凭空为宿主机提供公网 IPv6；宿主机和 Docker daemon 仍需具备正确的 IPv6 转发/路由能力。

## URL 快速登录

### 推荐：URL Fragment（密码和私钥）

推荐格式：

```text
https://你的域名/#ssh=<base64url-json>
```

JSON 可使用这些字段：

```json
{
  "host": "2603:c021:8012:ef00:0:dd95:ca1:7387",
  "port": 22,
  "user": "root",
  "password": "SSH密码",
  "authType": "password"
}
```

私钥示例：

```json
{
  "hostname": "2603:c021:8012:ef00:0:dd95:ca1:7387",
  "port": 22,
  "username": "root",
  "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
  "passphrase": "私钥口令",
  "authType": "key"
}
```

兼容字段：`host/hostname`、`user/username`、`pass/password`、`logintype/loginType`。Fragment 不会包含在浏览器发送给 WebSSH 服务端的 HTTP 请求或访问日志中，解析后页面也会清理地址栏；但它仍可能出现在浏览器历史、书签、剪贴板或截图中，不应把生产凭据发给不可信的人。默认配置允许未登录 WebSSH 书签账号的游客打开这类分享链接并建立 SSH；如果管理员启用了 `WEBSSH_REQUIRE_ACCOUNT=true`，访客需先登录书签账号。

在浏览器控制台生成 Base64URL：

```javascript
const login = { host: "2603:c021:8012:ef00:0:dd95:ca1:7387", port: 22, user: "root", password: "SSH密码" };
const bytes = new TextEncoder().encode(JSON.stringify(login));
let binary = "";
bytes.forEach(byte => binary += String.fromCharCode(byte));
const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
console.log(location.origin + "/#ssh=" + encoded);
```

### 兼容：旧路径格式（默认关闭）

旧路径会把密码/私钥发送到 Web 服务器、反向代理和访问日志，因此默认不解析。只有迁移旧系统时才临时设置：

```env
WEBSSH_ALLOW_LEGACY_PATH_LOGIN=true
```

| URL 格式 | 结果 |
|---|---|
| `/192.168.1.1:22/mypass` | `root@192.168.1.1:22`，密码登录 |
| `/192.168.1.1/2222/admin/mypass` | `admin@192.168.1.1:2222`，密码登录 |
| `/192.168.1.1/admin/mypass` | `admin@192.168.1.1:22`，密码登录 |
| `/192.168.1.1/@12345/mypass` | 数字用户名 `12345`，默认端口 22 |
| `/2603:c021:8012:ef00:0:dd95:ca1:7387/mypass` | 裸 IPv6，默认端口 22 |
| `/[2603:c021:8012:ef00:0:dd95:ca1:7387]/admin/mypass` | 带括号 IPv6，用户 admin |
| `/2603:c021:8012:ef00:0:dd95:ca1:7387/2222/admin/mypass` | 裸 IPv6，自定义端口 2222 |
| `/[2603:c021:8012:ef00:0:dd95:ca1:7387]:2222/admin/mypass` | 带括号 IPv6 和端口 |

迁移完成后应恢复为 `false` 并清理相关访问日志。新链接只使用上面的 `#ssh=` Fragment 格式。

旧路径只在凭据包含明确的 PEM 标记（如 `-----BEGIN OPENSSH PRIVATE KEY-----`）时识别为私钥；长密码不会再因为超过 200 字符被误判。数字用户名请加 `@`，以免与端口混淆。

路径里的用户名、密码、私钥及特殊字符必须使用 `encodeURIComponent` 编码。**旧路径会进入反向代理/服务端访问日志，生产环境优先使用 Fragment 格式。**

## WebSSH 书签账号和密码管理

WebSSH 中可能同时存在三类密码：

| 类型 | 用途 | 修改方法 |
|---|---|---|
| 书签/账号同步密码 | 脚本同步、用户管理、页面更新 | 账号同步弹窗或管理员用户列表 |
| Web 页面验证 `authInfo` | 打开页面前的 Basic Auth 门禁 | 修改 `.env` 后重建容器 |
| SSH 密码/私钥 | 登录目标服务器 | 在目标 SSH 服务器上管理 |

默认允许游客发起 SSH、SFTP、系统信息和文件任务，因此分享链接可以直接连接。如果要禁止游客，在 `.env` 中配置：

```env
WEBSSH_REQUIRE_ACCOUNT=true
```

启用后，未登录书签账号时页面会先打开账号登录窗口。若同时配置了页面 Basic Auth，已通过 Basic Auth 的请求也可访问 SSH/SFTP 网关；脚本云同步和账号管理始终仍需要登录书签账号。要恢复游客连接，设置 `WEBSSH_REQUIRE_ACCOUNT=false` 或删除该配置。

### 用户修改自己的密码

登录书签账号后打开“账号同步”，选择修改密码，输入当前密码和新密码。修改成功后，同账号在其他浏览器中的会话会失效。

### 用户忘记密码

普通用户不能绕过验证自行找回密码，需要联系管理员。管理员在“账号同步 → 账号管理”中打开用户列表，可新增、查看、编辑、删除用户，或直接为用户设置新密码。管理员重置用户密码后，该用户的旧会话会失效。

系统会阻止删除或降级最后一个管理员。

### 忘记书签管理员密码：Docker Compose 重置

数据库只保存 bcrypt 哈希，无法反向读取当前明文密码。首次随机密码若已不在日志中，请直接重置。

编辑项目目录中的 `.env`：

```env
WEBSSH_ADMIN_USER=admin
WEBSSH_ADMIN_PASSWORD='请替换为新的高强度密码'
WEBSSH_ADMIN_RESET=true
```

重建并查看日志：

```bash
docker compose up -d --force-recreate
docker compose logs --tail=80 webssh
```

确认新密码可登录后，立即改回并再次重建：

```env
WEBSSH_ADMIN_RESET=false
```

```bash
docker compose up -d --force-recreate
```

重置不会删除账号、脚本书签或分类，但会使该管理员的旧登录会话失效。只修改 `WEBSSH_ADMIN_PASSWORD` 而不打开一次 `WEBSSH_ADMIN_RESET`，不会覆盖已经存在的管理员密码。

> 管理员用户名为 5–32 位字母或数字，密码至少 7 个 Unicode 字符。密码首尾空格属于密码内容，不会被自动删除。不要把真实密码提交到 GitHub、截图或工单。

### 注册、账号和会话限制

公开注册默认关闭；用户由管理员创建。确需开放时：

```env
WEBSSH_ALLOW_REGISTRATION=true
```

相关限制：

- 注册：每个来源 IP 每小时最多 5 次。
- 登录：每个来源 IP 每分钟最多 30 次。
- 页面 Basic Auth 失败：每个来源 IP 每 5 分钟最多 30 次。
- 最大账号数：`WEBSSH_MAX_ACCOUNTS=200`。
- 每用户最大活动会话：`WEBSSH_MAX_SESSIONS_PER_USER=20`，超出后淘汰最旧会话。

经过 Nginx、Render、Railway 等反向代理时，只能在明确知道代理出口网段的前提下信任转发地址。例如代理与 WebSSH 位于 `172.20.0.0/16`：

```env
WEBSSH_TRUSTED_PROXIES=172.20.0.0/16
```

支持英文逗号分隔多个 CIDR 或单个 IP。服务端会从 `X-Forwarded-For` 右侧开始跳过可信代理，取第一个不可信地址作为用户 IP；未配置、直连来源不可信或转发链格式错误时，完全忽略转发头。不要配置 `0.0.0.0/0` 或 `::/0`，否则客户端可伪造限流身份。

## 脚本书签和 Emoji 分类

- 推荐脚本顶部搜索框可按脚本名称或命令片段即时过滤。
- 搜索框下方的 Emoji 分类按钮可一键筛选。
- “书签管理”统一提供导入、导出和账号同步。
- 个人备份与管理员全站备份使用不同格式，前后端都会拒绝混用；全站恢复只按用户名覆盖当前网站中已存在账号的云端脚本和分类，不创建账号，也不修改密码、权限或登录会话。
- 全站恢复会建立新的云端修订边界，恢复前仍打开的旧页面不能再把旧书签合并回云端。
- “分类管理”支持 Emoji、备注名称及分类增删改查；鼠标悬停 Emoji 会显示名称。
- 书签侧栏顶部的“书签管理”和“分类管理”是两个独立入口，分别打开对应管理界面；切换 Emoji 分类筛选不会关闭书签侧栏。
- 页面脚本和样式会随版本号自动更新缓存，页面升级后无需手动清理旧版静态资源缓存。
- 新建或编辑脚本时可选择已有分类。
- 单行脚本点击即运行；多行脚本会先弹出确认框并展示完整内容，避免误点后一次性执行整段命令。
- 多行脚本在远端启用 bracketed paste 时会整段提交，不会因为中间某行启动了交互式程序而把后续命令喂给它。
- 单条脚本命令最多保存 20,000 个 Unicode 字符；导入和同步也执行相同限制。
- 每账号最多同步 500 条脚本和 100 个分类。
- 每个账号序列化后的脚本与分类工作区最多 8 MiB；同步请求本身最多 16 MiB。

浏览器本地存储不可用或已满时，页面会提示而不是直接崩溃。

## SSH 主机密钥安全

默认使用 TOFU（Trust On First Use）验证主机密钥：

```env
WEBSSH_HOST_KEY_POLICY=tofu
```

TOFU 记录会按浏览器生成的高熵信任作用域隔离，写入 `${WEBSSH_DATA_DIR}/known_hosts.d/<scope-hash>.known_hosts`。不同浏览器不会再共享或覆盖同一份主机记录。以后同一地址密钥变化时，页面会显示旧指纹和新指纹，并要求用户明确选择：取消、仅本次信任，或更新该目标的指纹后连接。不会自动覆盖旧指纹；“仅本次信任”在当前 SSH 会话建立后立即消费，后续重连会再次确认。

可选策略：

| 值 | 行为 |
|---|---|
| `tofu` | 默认；首次记录，后续严格匹配 |
| `strict` | 只允许管理员维护的全局 `known_hosts` 中的密钥；文件不存在即连接失败 |
| `insecure` | 不校验主机密钥，仅为兼容旧部署，不推荐 |

目标服务器重装导致密钥合法变化时，应先通过云厂商控制台或服务器本机可信渠道核对新指纹，再在页面点击“更新指纹并连接”。更新只替换当前 `主机:端口` 的记录，不会影响其他服务器；也可以选择“仅本次信任”而不写入 `known_hosts`。

升级到作用域隔离后，旧的全局 TOFU 文件不会自动复制给每个浏览器；首次连接需重新核对一次指纹。如果无法使用页面确认，也可以手动清空全部作用域记录，下一次连接会重新进入 TOFU：

```bash
docker compose exec webssh sh -c 'find /app/data/known_hosts.d -maxdepth 1 -type f -name "*.known_hosts" -delete'
```

默认采用 Go SSH 的安全算法集合。只有必须连接老旧设备时才临时启用 CBC 等旧算法：

```env
WEBSSH_ALLOW_LEGACY_CIPHERS=true
```

## SFTP 数据链路、在线编辑和传输安全

SFTP 不是浏览器直接连接目标 SSH 服务器。浏览器本身也不支持直接建立 SSH/SFTP TCP 连接。实际数据路径是：

```text
浏览器
  → HTTPS/WSS 访问 WebSSH 网站服务器
  → WebSSH 服务器建立 SSH/SFTP 连接
  → SSH 目标服务器:22
```

因此，SFTP 目录列表、新建文件、在线编辑/保存、上传和下载的数据都会经过 WebSSH 网站服务器。目标 SSH 服务器看到的连接来源通常是 WebSSH 服务器的 IP；如果配置了 SOCKS5，则路径是 `WebSSH → SOCKS5 代理 → SSH 目标`，目标看到的是代理出口 IP。可选的终端专用 WSS 直连只改变“浏览器 → WebSSH”的终端输入/输出路径，不会让 SFTP 变成浏览器直连目标机。

在 SFTP 列表中可以在当前目录新建文件，重命名文件、文件夹或符号链接，也可以打开现有 UTF-8 文本文件（包括可访问的符号链接目标）进行在线编辑。重命名不会覆盖同目录已有目标；文件夹改名后，其中已经打开的工作台标签会同步更新路径。同一个 SSH 会话中的文件共用一个工作台：顶部标签过多时会自动换行，支持逐个关闭、整体最小化/恢复和最大化，关闭未保存内容前会要求选择保存、不保存或取消。编辑器会按扩展名识别 HTML、CSS、JavaScript/TypeScript、JSON、Python、Shell、YAML、Go、SQL、配置文件和 Markdown 等常见文本，提供轻量语法着色、行号以及右侧可点击/拖动的代码缩略图；文本超过 384 KiB 时自动关闭语法着色以减少浏览器开销，但仍可继续编辑和保存。

首次建立 SSH 终端连接后，页面会在后台预热该标签的 SFTP 会话；后续切换目录会复用同一条短期 SFTP 连接，并使用 8 秒目录缓存立即显示最近结果，再按需刷新，避免每次进入文件夹都重新进行 SSH 握手。标签关闭、重连、连接中断、请求取消或空闲超时后会主动释放连接。默认空闲 120 秒、全局最多 32 条、同一来源最多 4 条，可通过下方环境变量调整。

图片、图标和视频也会在同一工作台中以独立标签预览，支持 JPG/JPEG、PNG、GIF、WebP、BMP、AVIF、SVG、ICO、MP4、WebM、OGG/OGV、MOV 和 M4V。SVG 既可以按文本编辑，也可以按图片预览。媒体预览请求可以随标签关闭、SSH 断开或页面离开而取消，标签关闭时会释放浏览器 Blob URL。服务端只允许显式支持的扩展名和普通文件，并在打开后再次校验文件类型与大小；默认媒体预览上限为 128 MiB。

在线保存使用文件版本校验和目标路径校验，防止无声覆盖已被其他人修改或重新指向的内容。普通文件可在二次确认后删除，删除符号链接时只删除链接本身；删除文件时，同一路径已经打开的文本和媒体标签也会一并安全关闭。

文件夹下载会先在目标 SSH 服务器生成权限为 `0600` 的临时 `.tar.gz`，界面依次显示扫描/压缩进度与浏览器下载进度、速度和剩余时间，并支持取消；下载完成、失败、取消或超时后会自动删除临时压缩包。为避免异常目录耗尽资源，默认最多扫描 500,000 个项目，可通过 `WEBSSH_FOLDER_ARCHIVE_MAX_ENTRIES` 调整。

默认限制：

```env
WEBSSH_UPLOAD_MAX_BYTES=1073741824
WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES=1073741824
WEBSSH_EDITOR_MAX_BYTES=2097152
WEBSSH_PREVIEW_MAX_BYTES=134217728
WEBSSH_SFTP_SESSION_IDLE_SECONDS=120
WEBSSH_MAX_SFTP_SESSIONS=32
WEBSSH_MAX_SFTP_SESSIONS_PER_CLIENT=4
```

普通上传和远程下载都会先写同目录随机临时文件，完整写入并关闭成功后再原子替换目标；失败、超限、关闭标签或离开页面会取消请求并清理临时文件，不会先截断已有目标。浏览器下载使用原生流式下载，不再先把整个大文件读进内存。

为防 SSRF，远程下载默认拒绝 loopback、私网、链路本地、组播、CGNAT、云元数据及其他保留地址，并在每次重定向和实际拨号时重新验证解析结果。确实需要下载内网 URL 时才打开：

```env
WEBSSH_ALLOW_PRIVATE_DOWNLOADS=true
```

该开关会扩大服务端网络访问能力，请仅在受信环境使用。

## RDP 远程桌面

登录页顶部可以在 **SSH 终端 / RDP 远程桌面** 之间切换。切换后端口会在 22 与 3389 之间自动跟随，
默认用户名在 `root` 与 `Administrator` 之间跟随——只在你没有手动改过时才跟随。

### 架构：画面不经服务端转码

```
浏览器（IronRDP WASM 客户端） <--ws--> /rdp 网关 <--TCP/TLS--> Windows 主机
```

RDP 协议本身（含位图解码、CredSSP/NLA）全部在浏览器里完成，后端只做两件事：

1. **RDCleanPath 握手**：代客户端建立 TCP 连接、转发 X.224 协商、完成 TLS 握手，
   并把服务端证书链回传给浏览器（WASM 侧用它做 CredSSP 通道绑定）。
2. **透明字节转发**：之后就是一条不做任何解析、不做缓冲合并的管道。

和 Guacamole 那类方案相比，这里少了「服务端把 RDP 位图重新编码成 PNG/JPEG」这一轮，
因此延迟更低、带宽更省；代价是解码发生在浏览器里，低端设备在高分辨率下会更吃 CPU。

> TLS 版本被刻意限制在 **TLS 1.2**。CredSSP 的通道绑定依赖 TLS 1.2 的握手语义，
> 协商到 TLS 1.3 时 Windows 会在 CredSSP 阶段回一个 internal error alert 直接掐断连接。
> FreeRDP 等原生客户端同样这么处理。

### 显示设置

登录表单里的「远程桌面设置 → 显示」提供：

| 选项 | 说明 |
|---|---|
| 分辨率 | 适应窗口（默认）/ 若干预设 / 自定义宽高 |
| 全屏启动会话 | 连上后自动进入浏览器全屏 |
| 在调整大小时更新会话分辨率 | 窗口变化时用 DVC 通知远端改分辨率，**需要 Windows 8.1 / Server 2012 R2 及以上** |
| 缩放方式 | 等比适应 / 拉伸填满 / 1:1 原始像素 |
| 针对高分屏优化 | 按 devicePixelRatio 请求分辨率，画面更锐利但带宽和解码开销明显增加 |

会话工具栏上还有全屏按钮。全屏后可通过 Keyboard Lock 把 Alt+Tab、Win 键等交给远端，
具体取决于浏览器支持情况。

### 中转（SOCKS5 / SSH 跳板）

「远程桌面设置 → 中转」可以让 RDP 流量先经过一跳：

- **SOCKS5 代理**：填地址、端口和可选的用户名/密码
- **SSH 跳板**：填跳板机地址和账号，支持密码或私钥；跳板机的主机密钥沿用 SSH 侧的 TOFU 策略

**中转不等于加速。** 多一跳只在直连线路本身劣质（高丢包、绕路）时才可能变快；
线路质量正常时中转只会增加延迟。另外 SSH 跳板会把 RDP 的 TCP 套进另一层 TCP，
丢包时两层重传互相叠加，反而可能更卡。真要提速，优先考虑在中转节点上用 UDP 隧道或开 BBR。

### 安全模型

RDP 网关**不接受**从 WebSocket 直接指定目标——那样任何能打开页面的人都能拿它当开放 TCP 代理扫内网。
实际流程是：

1. 前端先 `POST /rdp/session` 提交目标和中转配置，服务端校验端口白名单后发一张
   **一次性票据**（TTL 90 秒，用后即焚）。
2. 票据作为 RDCleanPath 的 `proxy_auth` 字段传给 WASM 客户端。
3. 网关握手时校验票据，并**只连票据里登记的目标**；WASM 报上来的 destination 仅用于核对。

目标端口默认只放行 3389，需要非标端口时用 `WEBSSH_RDP_ALLOWED_PORTS` 显式配置。
中转凭据只有在你勾选「记住中转配置」时才写入浏览器本地存储，且从不上传云端。

### 已知限制

- 音频重定向、打印机/驱动器重定向、多显示器尚未接入
- 「颜色质量」「关闭壁纸/动画」等性能开关未提供：当前 WASM 客户端没有暴露对应的
  RDP performance flags，做成开关只会是摆设
- 需要 Windows 侧启用 NLA；仅支持 NTLM，Kerberos 未验证

## WebSocket 与 HTTP 安全配置

- WebSocket 同时校验 Host 与 http/https scheme；所有状态变更接口（包括登录、注册、SSH 检查、系统信息和文件操作）要求可信 Origin/Referer。无 Origin/Referer 的非浏览器客户端仍允许。
- 额外可信来源可用英文逗号分隔：

```env
WEBSSH_ALLOWED_ORIGINS=https://webssh.example.com,https://admin.example.com
```

- `/healthz` 用于 Docker 健康检查；启用 Basic Auth 时仍可访问，但只返回 `{"status":"ok"}`。
- SSH 凭据不再放进 `/check`、`/sysinfo`、`/file/list` 和 `/file/download` 的查询字符串；这些接口使用 POST 请求体。
- WebSocket 初始 SSH 配置限制为 128 KiB，并要求 15 秒内发送；握手完成后终端单帧输入上限切换为 4 MiB，避免大段粘贴沿用初始化限制而断线。
- 默认普通请求体上限为 4 MiB，上传接口使用独立限制。
- JSON 接口必须使用 `application/json`，拒绝未知字段、多个 JSON 值和超过 30 秒仍未读完的请求体；`/api` 响应统一 `no-store`。
- 默认最多同时建立 64 个 SSH 任务、同一客户端 8 个；可用 `WEBSSH_MAX_CONCURRENT_SSH` 和 `WEBSSH_MAX_CONCURRENT_SSH_PER_CLIENT` 调整。
- SFTP 目录浏览默认复用空闲 120 秒的短期连接池，全局最多 32 条、同一客户端 4 条；可用 `WEBSSH_SFTP_SESSION_IDLE_SECONDS`、`WEBSSH_MAX_SFTP_SESSIONS` 和 `WEBSSH_MAX_SFTP_SESSIONS_PER_CLIENT` 调整。
- 默认最多同时进行 4 个上传、同一客户端 2 个；可用 `WEBSSH_MAX_CONCURRENT_UPLOADS` 和 `WEBSSH_MAX_CONCURRENT_UPLOADS_PER_CLIENT` 调整。
- 系统信息命令最长执行 12 秒、输出最多 1 MiB；客户端断开时会关闭对应 SSH/SFTP 连接。
- 服务端发送 `nosniff`、`SAMEORIGIN`、`no-referrer` 和权限策略响应头。

## 版本更新（页面或命令行）

普通 Compose 默认不具有 Docker socket 权限，页面更新也默认关闭。只有安装向导中明确输入 `y` 才会在 `.env` 写入：

```env
COMPOSE_FILE=docker-compose.yml:docker-compose.update.yml
WEBSSH_ENABLE_SELF_UPDATE=true
WEBSSH_HOST_PROJECT_DIR="/宿主机绝对路径/webssh2"
```

`docker-compose.update.yml` 才会挂载源码目录和 `/var/run/docker.sock`。禁用更新时使用：

```env
COMPOSE_FILE=docker-compose.yml
WEBSSH_ENABLE_SELF_UPDATE=false
```

管理员点击普通更新，或在项目目录执行 `sh update.sh` 时会：

1. 检查当前分支和远端版本。
2. 在 `.webssh-update-backups/时间戳/` 保存 Git 状态、差异、提交记录、bundle 和 `.env` 备份。
3. 执行 `git pull --ff-only`。
4. **先构建新镜像，构建期间旧容器继续服务**。
5. 切换到新镜像后等待 Docker 健康检查，并核对容器内实际版本。
6. 新容器启动或校验失败时，自动恢复更新前的 Docker 镜像，避免更新失败后网站一直离线。

普通更新遇到分叉或本地冲突会停止，**不会强制覆盖源码**。只有管理员明确选择“强制更新”，或命令行传入 `--force` 时才执行 `git reset --hard`；强制更新会覆盖所有受 Git 跟踪的本地修改。备份目录为 `0700`、文件为 `0600`，最多保留 20 份并清理 30 天前的目录；卡在 `created` 超过 10 分钟的更新助手也会在下次更新前清理。

页面会把当前更新任务保存在浏览器中。即使小型服务器构建十几分钟、WebSSH 容器中途重启或页面被刷新，管理员重新登录后仍会自动恢复日志轮询；只有更新助手明确返回非零退出码才显示失败，不会再因固定的 4–5 分钟前端超时误报失败。

在线更新只会取得当前仓库、当前分支已经提交并推送的内容。Render、Railway 等通常无法在容器内控制 Docker，应使用平台重新部署。

### 命令行更新

进入 WebSSH 仓库后执行：

```bash
cd /root/webssh2
sudo sh update.sh
```

如果项目安装在其他目录，把第一行改为实际路径。强制与远端当前分支保持一致：

```bash
cd /root/webssh2
sudo sh update.sh --force
```

从 `v0.5.63` 或更早版本首次切换到新脚本时，可以直接从当前仓库的远端分支取出脚本再执行，不需要先停止容器：

```bash
cd /root/webssh2
git fetch origin main
git show origin/main:update.sh > /tmp/webssh-update.sh
sudo sh /tmp/webssh-update.sh --project-dir "$(pwd)"
rm -f /tmp/webssh-update.sh
```

默认只对新容器的启动/健康检查等待 240 秒（镜像构建时间不计入）。如果应用启动环境特别慢，可临时调整：

```bash
WEBSSH_UPDATE_HEALTH_TIMEOUT=600 sudo -E sh update.sh
```

## Web 页面 Basic Auth

交互向导可以启用页面门禁。手动配置：

```env
AUTH_INFO="admin:请替换为强密码"
```

启用后页面、静态资源、API 和 WebSocket 都受保护；只有最小化健康检查 `/healthz` 免认证。它和书签账号以及目标 SSH 账号完全独立。失败尝试受 IP 限流；Basic Auth 只做编码、不提供加密，公网必须配合 HTTPS 使用。

## 本地静态资源

浏览器运行所需的 xterm.js、FitAddon、WebLinksAddon、Noto Sans SC 和 JetBrains Mono 都位于 `public/static`，构建时嵌入 Go 二进制并随 Docker 镜像发布。页面启动不请求 jsDelivr、Google Fonts 等远程 CDN。

第三方版本、许可证和 SHA-256 记录在 `public/static/THIRD_PARTY_ASSETS.md`，许可证文件位于 `public/static/vendor/licenses/`。推荐命令中出现的下载 URL、用户自行设置的远程背景图和页脚外链不是页面启动依赖。
## SSH 低延迟与本地资源

- 首次连接、重连和新标签连接不再固定等待 120–300 ms，会在终端完成首帧布局后立即建立 WebSocket/SSH。
- SSH 输出使用二进制 WebSocket 帧直接交给 xterm.js，减少 UTF-8 重复校验、字符串转换和大输出时的浏览器开销，并可正确处理跨数据块的多字节字符。
- SSH TCP 连接显式启用 `TCP_NODELAY`；域名双栈连接的备用地址族回退时间缩短到 100 ms。
- 大段命令粘贴会循环写完全部数据，避免底层发生短写时命令被截断。
- WebSocket 使用共享的 32 KiB 写缓冲池，提高连续命令输出吞吐，同时不启用可能增加交互延迟的 WebSocket 压缩。
- 配置终端直连地址后，首页会提前发送 DNS prefetch / preconnect 提示，尽早预热 WSS 的 DNS、TCP 和 TLS 连接，减少首次登录等待。
- 配置终端直连地址后，页面还会以低优先级静默请求直连入口的 `/healthz`，进一步预热连接；请求失败不会影响正常登录。
- 终端直连 WSS 在建立 SSH 会话前失败时会自动回退到页面同源 `/term`；回退时只提示线路切换，不再重复出现“连接失败/无法连接”错误。
- 如果启用了顶部服务器状态检测，首次检测会延后到终端首屏建立后执行，避免登录初期额外 SSH 检测和终端抢占资源；后续仍按设置的间隔刷新。
- 顶部服务器状态检测只在当前可见终端标签运行，切换到后台标签时会暂停，避免同时连接多台机器时额外创建后台 SSH 检测连接。
- 后端普通按键输入走字节快速路径，只对 resize 控制帧进行文本解析，减少多终端同时输入时的无效字符串分配。
- 进入终端后会暂停粒子和渐变背景动画，减少浏览器主线程/GPU 占用，让输入、回显和命令输出更跟手；返回登录页后自动恢复。

xterm.js、FitAddon、WebLinksAddon、Noto Sans SC、JetBrains Mono、应用 JavaScript 和 CSS 均嵌入 Go 程序并随 Docker 镜像本地部署。页脚链接、推荐脚本中的下载地址以及用户主动填写的远程下载/背景地址不会在页面启动时加载。

实际按键延迟仍受“浏览器 → WebSSH 服务器 → SSH 目标服务器”的网络往返时间、反向代理和目标服务器负载影响。若两台服务器跨洲或线路丢包，应用无法消除物理网络延迟，建议将 WebSSH 部署在靠近 SSH 目标服务器的地区。

### 终端专用 WebSocket 地址（可选）

如果页面域名经过高延迟 CDN、跨洲反向代理或远程 Worker，可以只让终端 WebSocket 使用一个靠近 WebSSH 建站机的直连 HTTPS/WSS 入口：

```env
WEBSSH_TERMINAL_WS_URL=wss://direct-webssh.example.com/term
WEBSSH_ALLOWED_ORIGINS=https://webssh.example.com
```

`WEBSSH_TERMINAL_WS_URL` 为空时使用页面同源 `/term`，普通部署不需要配置它。这里的“终端专用直连地址”不是浏览器直连 SSH 目标机，而是为终端 WebSocket 另外指定一个更直接的 WebSSH 入口，用来避开页面域名前面可能较慢的 CDN/Worker/跨洲反代。配置后只有 SSH 终端输入/输出改走该地址，页面、API、SFTP 和静态资源仍使用当前网站。

专用入口不可用或 4 秒内无法建立 WebSocket 时，页面会自动改用当前网站同源的 `/term`；这就是界面提示“正在改用当前网站连接”的含义，不需要手动操作。专用入口必须具备浏览器信任的 TLS 证书、支持 WebSocket Upgrade，并反向代理到 WebSSH 的 `/term`；跨域时还必须把页面 Origin 加入 `WEBSSH_ALLOWED_ORIGINS`。

该方式减少的是反向代理绕路延迟，不能消除 WebSSH 建站机到 SSH 目标机之间的物理 RTT。项目没有使用不安全的“本地假回显”，因此不会重复字符、破坏 Vim/nano，也不会在远端关闭回显时泄露密码输入。

## 从源码运行

```bash
# Go 1.25.12+
go mod download
go run .

# 自定义端口
go run . -p 3000

# 页面 Basic Auth
go run . -a admin:password
```

## 配置参数

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `PORT` / `port` | 8008 | HTTP 服务端口 |
| `BIND_ADDRESS` | 0.0.0.0（Compose） | Docker 发布端口的监听地址；仅允许同机反代访问时设为 `127.0.0.1` |
| `AUTH_INFO` / `authInfo` | 空 | 页面 Basic Auth，格式 `user:pass` |
| `SAVE_PASS` / `savePass` | true | 是否在浏览器保存 SSH/SOCKS5 密码；设为 false 时不再写入并清除旧字段 |
| `SHOW_FOOTER` / `showFooter` | true | 是否显示页脚 |
| `WEBSSH_RDP_ALLOWED_PORTS` | 3389 | RDP 网关允许连接的目标端口白名单，逗号分隔。**放宽等于把网关变成 TCP 代理，务必谨慎** |
| `WEBSSH_MAX_CONCURRENT_RDP` | 16 | 全局并发 RDP 会话上限 |
| `WEBSSH_MAX_CONCURRENT_RDP_PER_CLIENT` | 4 | 单客户端并发 RDP 会话上限 |
| `WEBSSH_RDP_DEBUG` | false | 打印 RDP 握手与转发层日志，排障用 |
| `WEBSSH_ADMIN_USER` | admin | 书签管理员用户名 |
| `WEBSSH_ADMIN_PASSWORD` | 首次随机 | 书签管理员初始/重置密码；7 个字符起，最多 72 UTF-8 字节 |
| `WEBSSH_ADMIN_RESET` | false | 与管理员密码一起用于一次性重置 |
| `WEBSSH_ALLOW_REGISTRATION` | false | 是否开放自助注册 |
| `WEBSSH_MAX_ACCOUNTS` | 200 | 最大账号数 |
| `WEBSSH_MAX_SESSIONS_PER_USER` | 20 | 每用户活动会话上限 |
| `WEBSSH_REQUIRE_ACCOUNT` | false | 是否禁止游客使用 SSH/SFTP；设为 true 后要求书签账号会话或已通过页面 Basic Auth |
| `WEBSSH_MAX_CONCURRENT_SSH` | 64 | 全局同时进行的终端、SFTP、检查和系统信息 SSH 任务上限 |
| `WEBSSH_MAX_CONCURRENT_SSH_PER_CLIENT` | 8 | 同一来源客户端的 SSH 任务上限 |
| `WEBSSH_MAX_CONCURRENT_UPLOADS` | 4 | 全局并发上传任务上限 |
| `WEBSSH_MAX_CONCURRENT_UPLOADS_PER_CLIENT` | 2 | 同一来源客户端的并发上传任务上限 |
| `WEBSSH_SFTP_SESSION_IDLE_SECONDS` | 120 | SFTP 目录浏览复用连接的空闲保留秒数（15 至 900） |
| `WEBSSH_MAX_SFTP_SESSIONS` | 32 | 全站短期 SFTP 连接池上限 |
| `WEBSSH_MAX_SFTP_SESSIONS_PER_CLIENT` | 4 | 同一来源客户端的短期 SFTP 连接池上限 |
| `WEBSSH_HOST_KEY_POLICY` | tofu | SSH 主机密钥策略 |
| `WEBSSH_ALLOW_LEGACY_CIPHERS` | false | 是否加入老旧 CBC cipher |
| `WEBSSH_UPLOAD_MAX_BYTES` | 1073741824 | 单次上传请求上限 |
| `WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES` | 1073741824 | 远程下载文件上限 |
| `WEBSSH_EDITOR_MAX_BYTES` | 2097152 | SFTP 在线编辑器可打开和保存的 UTF-8 文本大小上限（1024 字节至 64 MiB） |
| `WEBSSH_PREVIEW_MAX_BYTES` | 134217728 | SFTP 图片、图标和视频在线预览大小上限（1 MiB 至 1 GiB） |
| `WEBSSH_FOLDER_ARCHIVE_MAX_ENTRIES` | 500000 | 单次文件夹下载允许扫描并压缩的最大目录项目数 |
| `WEBSSH_ALLOW_PRIVATE_DOWNLOADS` | false | 是否允许远程下载访问私网/本机 |
| `WEBSSH_ALLOWED_ORIGINS` | 空 | WebSocket 与登录 Cookie 写接口额外允许来源 |
| `WEBSSH_TRUSTED_PROXIES` | 空 | 可读取转发客户端 IP 的可信反向代理 CIDR/IP 列表 |
| `WEBSSH_TERMINAL_WS_URL` | 空（同源 `/term`） | 可选的终端专用 `ws://` / `wss://` WebSSH 入口，用于绕过高延迟页面代理；不是浏览器直连 SSH 目标 |
| `WEBSSH_ALLOW_LEGACY_PATH_LOGIN` | false | 是否兼容会进入服务器日志的旧路径凭据快速登录 |
| `WEBSSH_ENABLE_SELF_UPDATE` | false | 是否启用页面内更新；启用会挂载源码和 Docker socket |
| `WEBSSH_SOURCE_DIR` | /app/source | 容器内源码目录 |
| `WEBSSH_HOST_PROJECT_DIR` | 空 | 页面更新使用的宿主机绝对路径 |
| `WEBSSH_DATA_DIR` | data | 账号数据库、全局 strict `known_hosts` 和作用域 TOFU 目录 |

命令行参数：`-p` 端口、`-a user:pass` 页面验证、`-t` SSH 会话超时分钟数、`-s` 是否保存密码、`-v` 版本。

## Railway / Render

托管平台部署时建议设置：

```env
WEBSSH_ADMIN_USER=admin
WEBSSH_ADMIN_PASSWORD=请替换为高强度密码
WEBSSH_ENABLE_SELF_UPDATE=false
```

若忘记书签管理员密码，临时增加 `WEBSSH_ADMIN_RESET=true` 并重新部署；确认登录后恢复为 `false`。平台应挂载持久化数据卷，否则重部署可能丢失账号、书签和主机密钥记录。

仓库中的 Render 配置会把 1 GiB persistent disk 挂载到 `/app/data`；Railway 配置声明了同一路径的必需挂载点。若平台提示缺少 volume，请先创建并挂载 `/app/data` 再部署。该目录保存账号数据库、登录 session、云脚本书签和 TOFU 主机指纹。

## 技术栈

- 后端：Go、Gin、gorilla/websocket、golang.org/x/crypto/ssh、pkg/sftp
- 前端：原生 HTML/CSS/JavaScript、xterm.js、IronRDP（WebAssembly）
- 部署：Docker、Docker Compose、Railway、Render

## 效果图

<img width="1280" height="675" alt="image" src="https://github.com/user-attachments/assets/f3ef06c5-9479-4123-9c93-9b4ac69f007f" />
<img width="1280" height="415" alt="image" src="https://github.com/user-attachments/assets/2bcf4d98-3a95-4d43-867b-f4af5fd94948" />
<img width="1280" height="512" alt="image" src="https://github.com/user-attachments/assets/5040cc7d-bd31-44c9-9b94-4382fb59764e" />
<img width="369" height="634" alt="image" src="https://github.com/user-attachments/assets/b6978860-c82e-413a-ab3e-3e29c4776a9a" />
<img width="521" height="737" alt="image" src="https://github.com/user-attachments/assets/e8dfbd1c-87ae-495d-a8bb-cabf714f0878" />
<img width="1042" height="249" alt="image" src="https://github.com/user-attachments/assets/b6d99e78-563e-4572-b094-1ebf36dd440a" />
<img width="525" height="466" alt="image" src="https://github.com/user-attachments/assets/c2a573d2-1af3-42dd-b6c2-76b3eabbe0ea" />
