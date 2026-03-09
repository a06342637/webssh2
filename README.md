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

### Docker Compose 部署（推荐）

```bash
# 直接启动
docker compose up -d

# 自定义端口
PORT=3000 docker compose up -d

# 启用 Web 登录验证（取消 docker-compose.yml 中的 authInfo 注释）
```

### 从源码运行

```bash
# 需要 Go 1.22+
go mod tidy
go run .

# 自定义端口
go run . -p 3000

# 启用登录验证
go run . -a admin:password
```

## 配置参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-p` | `port` | 8888 | 服务端口 |
| `-a` | `authInfo` | 空 | Web 登录验证，格式 `user:pass` |
| `-t` | - | 120 | SSH 超时时间（分钟） |
| `-s` | `savePass` | true | 是否保存密码 |

## 技术栈

- **后端**: Go + Gin + gorilla/websocket + golang.org/x/crypto/ssh
- **前端**: 原生 HTML/CSS/JS + xterm.js
- **部署**: Docker + Docker Compose
