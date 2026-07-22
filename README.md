# WebSSH

一个基于 Go、WebSocket 和 xterm.js 的 Web SSH 终端，支持密码/私钥认证、IPv4/IPv6、SFTP、系统监控、多终端标签、连接书签以及可同步的脚本书签。

## 功能特性

- IPv4、域名和 IPv6 SSH 登录；裸 IPv6 与带方括号 IPv6 均可识别
- 密码、私钥及带口令私钥认证
- SOCKS5 代理、多标签终端、SFTP 文件管理和系统信息监控
- 脚本名称/命令片段即时搜索
- 彩色 Emoji 分类、分类筛选和分类增删改查
- 脚本及分类导入、导出和账号云同步
- 管理员用户列表，支持用户增、删、改、查及重置密码
- xterm.js、插件、中文字体和等宽字体全部随程序/Docker 镜像部署，不依赖远程 CDN
- Docker Compose 交互式部署及可选页面内更新
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
是否显示底部版权页脚？([回车]=显示  n=不显示)
是否启用 Web 登录验证？(y=启用  [回车]=不启用)
书签管理员用户名 [默认 admin]
书签管理员密码 [回车=自动随机生成；至少 7 个字符，最多 72 UTF-8 字节]
是否启用页面内版本更新？([回车]=启用  n=禁用)
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

向导生成的 `.env` 权限为 `0600`。不要把它提交到 Git。

Docker Compose 的 `.env` 密码建议使用单引号，避免 `$` 被 Compose 当作变量插值；密码本身包含单引号时写成 `\'`。

### 普通 Docker Compose 部署

```bash
git clone https://github.com/a06342637/webssh2.git
cd webssh2
docker compose up -d --build
docker compose ps
```

默认端口为 `8008`。普通 Compose **不会挂载源码目录和 Docker socket**，页面内更新默认关闭，攻击面更小。

自定义端口：

```bash
PORT=3000 docker compose up -d --build
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

兼容字段：`host/hostname`、`user/username`、`pass/password`、`logintype/loginType`。Fragment 不会包含在浏览器发送给 WebSSH 服务端的 HTTP 请求或访问日志中，解析后页面也会清理地址栏；但它仍可能出现在浏览器历史、书签、剪贴板或截图中，不应把生产凭据发给不可信的人。

在浏览器控制台生成 Base64URL：

```javascript
const login = { host: "2603:c021:8012:ef00:0:dd95:ca1:7387", port: 22, user: "root", password: "SSH密码" };
const bytes = new TextEncoder().encode(JSON.stringify(login));
let binary = "";
bytes.forEach(byte => binary += String.fromCharCode(byte));
const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
console.log(location.origin + "/#ssh=" + encoded);
```

### 兼容：旧路径格式

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

旧路径只在凭据包含明确的 PEM 标记（如 `-----BEGIN OPENSSH PRIVATE KEY-----`）时识别为私钥；长密码不会再因为超过 200 字符被误判。数字用户名请加 `@`，以免与端口混淆。

路径里的用户名、密码、私钥及特殊字符必须使用 `encodeURIComponent` 编码。**旧路径会进入反向代理/服务端访问日志，生产环境优先使用 Fragment 格式。**

## WebSSH 书签账号和密码管理

WebSSH 中可能同时存在三类密码：

| 类型 | 用途 | 修改方法 |
|---|---|---|
| 书签/账号同步密码 | 脚本同步、用户管理、页面更新 | 账号同步弹窗或管理员用户列表 |
| Web 页面验证 `authInfo` | 打开页面前的 Basic Auth 门禁 | 修改 `.env` 后重建容器 |
| SSH 密码/私钥 | 登录目标服务器 | 在目标 SSH 服务器上管理 |

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

- 注册：每个直连 IP 每小时最多 5 次。
- 登录：每个直连 IP 每分钟最多 30 次。
- 最大账号数：`WEBSSH_MAX_ACCOUNTS=200`。
- 每用户最大活动会话：`WEBSSH_MAX_SESSIONS_PER_USER=20`，超出后淘汰最旧会话。

## 脚本书签和 Emoji 分类

- 推荐脚本顶部搜索框可按脚本名称或命令片段即时过滤。
- 搜索框下方的 Emoji 分类按钮可一键筛选。
- “书签管理”统一提供导入、导出和账号同步。
- “分类管理”支持 Emoji、备注名称及分类增删改查；鼠标悬停 Emoji 会显示名称。
- 书签侧栏顶部的“书签管理”和“分类管理”是两个独立入口，分别打开对应管理界面；切换 Emoji 分类筛选不会关闭书签侧栏。
- 页面脚本和样式会随版本号自动更新缓存，页面升级后无需手动清理旧版静态资源缓存。
- 新建或编辑脚本时可选择已有分类。
- 单条脚本命令最多保存 20,000 个 Unicode 字符；导入和同步也执行相同限制。
- 每账号最多同步 500 条脚本和 100 个分类。

浏览器本地存储不可用或已满时，页面会提示而不是直接崩溃。

## SSH 主机密钥安全

默认使用 TOFU（Trust On First Use）验证主机密钥：

```env
WEBSSH_HOST_KEY_POLICY=tofu
```

首次连接会将目标主机密钥写入 `${WEBSSH_DATA_DIR}/known_hosts`（Docker 内为 `/app/data/known_hosts`）；以后同一地址密钥变化会拒绝连接，防止静默中间人攻击。

可选策略：

| 值 | 行为 |
|---|---|
| `tofu` | 默认；首次记录，后续严格匹配 |
| `strict` | 只允许已有 `known_hosts` 中的密钥；文件不存在即启动连接失败 |
| `insecure` | 不校验主机密钥，仅为兼容旧部署，不推荐 |

目标服务器重装导致密钥合法变化时，应先在可信渠道核对新指纹，再编辑或重建 `known_hosts`。清空全部记录的命令如下，下一次连接会重新进入 TOFU：

```bash
docker compose exec webssh sh -c 'rm -f /app/data/known_hosts'
```

默认采用 Go SSH 的安全算法集合。只有必须连接老旧设备时才临时启用 CBC 等旧算法：

```env
WEBSSH_ALLOW_LEGACY_CIPHERS=true
```

## SFTP 上传和远程下载安全

默认限制：

```env
WEBSSH_UPLOAD_MAX_BYTES=1073741824
WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES=1073741824
```

远程下载会限制重定向次数和流式大小，先写同目录临时文件，完整成功后再重命名，不会因超限而删除已有目标文件。

为防 SSRF，远程下载默认拒绝 loopback、私网、链路本地、组播、CGNAT、云元数据及其他保留地址，并在每次重定向和实际拨号时重新验证解析结果。确实需要下载内网 URL 时才打开：

```env
WEBSSH_ALLOW_PRIVATE_DOWNLOADS=true
```

该开关会扩大服务端网络访问能力，请仅在受信环境使用。

## WebSocket 与 HTTP 安全配置

- WebSocket 默认只允许同 Host Origin；无 Origin 的非浏览器客户端允许。
- 额外可信来源可用英文逗号分隔：

```env
WEBSSH_ALLOWED_ORIGINS=https://webssh.example.com,https://admin.example.com
```

- `/healthz` 用于 Docker 健康检查；启用 Basic Auth 时仍可访问，但只返回 `{"status":"ok"}`。
- SSH 凭据不再放进 `/check`、`/sysinfo`、`/file/list` 和 `/file/download` 的查询字符串；这些接口使用 POST 请求体。
- WebSocket 初始 SSH 配置限制为 128 KiB，并要求 15 秒内发送。
- 默认普通请求体上限为 4 MiB，上传接口使用独立限制。
- 服务端发送 `nosniff`、`SAMEORIGIN`、`no-referrer` 和权限策略响应头。

## 页面内版本更新

普通 Compose 默认不具有 Docker socket 权限。安装向导默认启用页面内版本更新（该问题直接回车即可）；`setup.sh` 会在 `.env` 写入：

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

管理员点击普通更新时会：

1. 检查当前分支和远端版本。
2. 在 `.webssh-update-backups/时间戳/` 保存 Git 状态、差异、提交记录、bundle 和 `.env` 备份。
3. 执行 `git pull --ff-only`。
4. 成功后执行 `docker compose up -d --build`。

普通更新遇到分叉或本地冲突会停止，**不会强制覆盖源码**。只有管理员明确选择“强制更新”时才执行 `git reset --hard`；强制更新会覆盖所有受 Git 跟踪的本地修改。备份目录为 `0700`，文件为 `0600`，并已加入 `.gitignore`。

在线更新只会取得当前仓库、当前分支已经提交并推送的内容。Render、Railway 等通常无法在容器内控制 Docker，应使用平台重新部署。

手动安全更新：

```bash
git pull --ff-only
docker compose up -d --build
```

## Web 页面 Basic Auth

交互向导可以启用页面门禁。手动配置：

```env
AUTH_INFO="admin:请替换为强密码"
```

启用后页面、静态资源、API 和 WebSocket 都受保护；只有最小化健康检查 `/healthz` 免认证。它和书签账号以及目标 SSH 账号完全独立。

## 本地静态资源

浏览器运行所需的 xterm.js、FitAddon、WebLinksAddon、Noto Sans SC 和 JetBrains Mono 都位于 `public/static`，构建时嵌入 Go 二进制并随 Docker 镜像发布。页面启动不请求 jsDelivr、Google Fonts 等远程 CDN。

第三方版本、许可证和 SHA-256 记录在 `public/static/THIRD_PARTY_ASSETS.md`，许可证文件位于 `public/static/vendor/licenses/`。推荐命令中出现的下载 URL、用户自行设置的远程背景图和页脚外链不是页面启动依赖。
## SSH 低延迟与本地资源

- 首次连接、重连和新标签连接不再固定等待 120–300 ms，会在终端完成首帧布局后立即建立 WebSocket/SSH。
- SSH 输出使用二进制 WebSocket 帧直接交给 xterm.js，减少 UTF-8 重复校验、字符串转换和大输出时的浏览器开销，并可正确处理跨数据块的多字节字符。
- SSH TCP 连接显式启用 `TCP_NODELAY`；域名双栈连接的备用地址族回退时间缩短到 100 ms。
- 大段命令粘贴会循环写完全部数据，避免底层发生短写时命令被截断。
- WebSocket 使用共享的 32 KiB 写缓冲池，提高连续命令输出吞吐，同时不启用可能增加交互延迟的 WebSocket 压缩。

xterm.js、FitAddon、WebLinksAddon、Noto Sans SC、JetBrains Mono、应用 JavaScript 和 CSS 均嵌入 Go 程序并随 Docker 镜像本地部署。页脚链接、推荐脚本中的下载地址以及用户主动填写的远程下载/背景地址不会在页面启动时加载。

实际按键延迟仍受“浏览器 → WebSSH 服务器 → SSH 目标服务器”的网络往返时间、反向代理和目标服务器负载影响。若两台服务器跨洲或线路丢包，应用无法消除物理网络延迟，建议将 WebSSH 部署在靠近 SSH 目标服务器的地区。

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
| `AUTH_INFO` / `authInfo` | 空 | 页面 Basic Auth，格式 `user:pass` |
| `SAVE_PASS` / `savePass` | true | 是否在浏览器保存 SSH 密码 |
| `SHOW_FOOTER` / `showFooter` | true | 是否显示页脚 |
| `WEBSSH_ADMIN_USER` | admin | 书签管理员用户名 |
| `WEBSSH_ADMIN_PASSWORD` | 首次随机 | 书签管理员初始/重置密码；7 个字符起，最多 72 UTF-8 字节 |
| `WEBSSH_ADMIN_RESET` | false | 与管理员密码一起用于一次性重置 |
| `WEBSSH_ALLOW_REGISTRATION` | false | 是否开放自助注册 |
| `WEBSSH_MAX_ACCOUNTS` | 200 | 最大账号数 |
| `WEBSSH_MAX_SESSIONS_PER_USER` | 20 | 每用户活动会话上限 |
| `WEBSSH_HOST_KEY_POLICY` | tofu | SSH 主机密钥策略 |
| `WEBSSH_ALLOW_LEGACY_CIPHERS` | false | 是否加入老旧 CBC cipher |
| `WEBSSH_UPLOAD_MAX_BYTES` | 1073741824 | 单次上传请求上限 |
| `WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES` | 1073741824 | 远程下载文件上限 |
| `WEBSSH_ALLOW_PRIVATE_DOWNLOADS` | false | 是否允许远程下载访问私网/本机 |
| `WEBSSH_ALLOWED_ORIGINS` | 空 | WebSocket 额外允许来源 |
| `WEBSSH_ENABLE_SELF_UPDATE` | true（Docker Compose） | 是否启用页面内更新；Render/Railway 仍需使用平台重新部署 |
| `WEBSSH_SOURCE_DIR` | /app/source | 容器内源码目录 |
| `WEBSSH_HOST_PROJECT_DIR` | 空 | 页面更新使用的宿主机绝对路径 |
| `WEBSSH_DATA_DIR` | data | 账号数据库和 `known_hosts` 目录 |

命令行参数：`-p` 端口、`-a user:pass` 页面验证、`-t` SSH 会话超时分钟数、`-s` 是否保存密码、`-v` 版本。

## Railway / Render

托管平台部署时建议设置：

```env
WEBSSH_ADMIN_USER=admin
WEBSSH_ADMIN_PASSWORD=请替换为高强度密码
WEBSSH_ENABLE_SELF_UPDATE=false
```

若忘记书签管理员密码，临时增加 `WEBSSH_ADMIN_RESET=true` 并重新部署；确认登录后恢复为 `false`。平台应挂载持久化数据卷，否则重部署可能丢失账号、书签和主机密钥记录。

## 技术栈

- 后端：Go、Gin、gorilla/websocket、golang.org/x/crypto/ssh、pkg/sftp
- 前端：原生 HTML/CSS/JavaScript、xterm.js
- 部署：Docker、Docker Compose、Railway、Render

## 效果图

<img width="1280" height="675" alt="image" src="https://github.com/user-attachments/assets/f3ef06c5-9479-4123-9c93-9b4ac69f007f" />
<img width="1280" height="415" alt="image" src="https://github.com/user-attachments/assets/2bcf4d98-3a95-4d43-867b-f4af5fd94948" />
<img width="1280" height="512" alt="image" src="https://github.com/user-attachments/assets/5040cc7d-bd31-44c9-9b94-4382fb59764e" />
<img width="369" height="634" alt="image" src="https://github.com/user-attachments/assets/b6978860-c82e-413a-ab3e-3e29c4776a9a" />
<img width="521" height="737" alt="image" src="https://github.com/user-attachments/assets/e8dfbd1c-87ae-495d-a8bb-cabf714f0878" />
<img width="1042" height="249" alt="image" src="https://github.com/user-attachments/assets/b6d99e78-563e-4572-b094-1ebf36dd440a" />
<img width="525" height="466" alt="image" src="https://github.com/user-attachments/assets/c2a573d2-1af3-42dd-b6c2-76b3eabbe0ea" />
