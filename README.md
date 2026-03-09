# WebSSH

一个基于 Go + WebSocket 的 Web SSH 终端，支持密码和密钥认证，带有炫酷的毛玻璃 UI。

## 功能特性

- 基于 xterm.js 的完整终端模拟
- 支持密码和 SSH 密钥两种认证方式
- SFTP 文件上传/下载
- 终端窗口自适应大小
- 毛玻璃 (Glassmorphism) UI 设计
- 粒子动画背景
- 动态按钮与过渡效果
- 支持 Docker Compose 一键部署

## 快速开始

### 1. Docker Compose 部署（推荐）

```bash
# 克隆项目
git clone https://github.com/a06342637/webssh2.git
cd webssh2

# 一键启动（默认端口 8008）
docker compose up -d

# 查看运行状态
docker compose ps

# 查看日志
docker compose logs -f
```

启动成功后，浏览器打开 `http://你的服务器IP:8008` 即可。

#### 自定义端口

```bash
PORT=3000 docker compose up -d
```

#### 启用 Web 页面登录验证

编辑 `docker-compose.yml`，取消 `authInfo` 那行的注释并设置账号密码：

```yaml
environment:
  - authInfo=admin:your_password
```

然后重启：

```bash
docker compose up -d
```

#### 停止服务

```bash
docker compose down
```

### 2. 从源码运行

```bash
# 需要 Go 1.22+
go mod tidy
go run .

# 自定义端口
go run . -p 3000

# 启用登录验证
go run . -a admin:password
```

## 使用说明

### 连接 SSH 服务器

1. 打开浏览器访问 `http://你的IP:8008`
2. 在登录页面填写以下信息：
   - **主机地址** — 目标 SSH 服务器的 IP 或域名
   - **端口** — SSH 端口，默认 22
   - **用户名** — SSH 登录用户名
3. 选择认证方式：
   - **密码登录** — 输入 SSH 密码
   - **密钥登录** — 粘贴私钥内容，如有密码保护可填写私钥密码
4. 点击 **「连接终端」** 按钮
5. 连接成功后自动进入全屏终端界面

### 终端操作

- 终端支持所有标准 SSH 操作，和本地终端体验一致
- 窗口大小会自动适应浏览器窗口
- 顶部工具栏按钮：
  - 🔄 **重新连接** — 断开当前连接并重新建立
  - ⏻ **断开连接** — 返回登录页面
- 按 `Esc` 键也可快速断开连接回到登录页

### 键盘快捷键

| 快捷键 | 功能 |
|--------|------|
| `Esc` | 断开连接，返回登录页 |

## 配置参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-p` | `port` | 8008 | 服务端口 |
| `-a` | `authInfo` | 空 | Web 登录验证，格式 `user:pass` |
| `-t` | — | 120 | SSH 连接超时时间（分钟） |
| `-s` | `savePass` | true | 是否保存密码 |

## 技术栈

- **后端**: Go + Gin + gorilla/websocket + golang.org/x/crypto/ssh
- **前端**: 原生 HTML/CSS/JS + xterm.js
- **部署**: Docker + Docker Compose
