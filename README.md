# WebSSH

一个基于 Go + WebSocket 的 Web SSH 终端，支持密码和密钥认证，带有炫酷的毛玻璃 UI。

## 一键部署
免费
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/a06342637/webssh2)
付费
[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/github?repo=https://github.com/a06342637/webssh2)

## 功能特性

- 基于 xterm.js 的完整终端模拟
- 多标签 SSH（同时连接多台服务器，标签切换）
- 支持密码和 SSH 密钥两种认证方式
- SOCKS5 代理连接支持
- SFTP 文件管理（浏览/上传/下载）
- 系统信息监控（CPU/内存/磁盘/流量/负载）
- 终端字体大小调节 + 颜色自定义
- 连接书签 + 脚本书签（localStorage 存储）
- 毛玻璃 (Glassmorphism) UI + 粒子动画背景
- 支持 Docker Compose 一键部署
- 移动端 / iPad 响应式适配

## 快速开始

### 1. 一键命令部署（推荐）

```bash
git clone https://github.com/a06342637/webssh2.git && cd webssh2 && docker compose up -d
```

启动成功后，浏览器打开 `http://你的服务器IP:8008` 即可。

### 2. Docker Compose 部署

```bash
# 克隆项目
git clone https://github.com/a06342637/webssh2.git
cd webssh2

# 启动（默认端口 8008）
docker compose up -d

# 自定义端口
PORT=3000 docker compose up -d

# 查看状态 / 日志
docker compose ps
docker compose logs -f

# 停止
docker compose down

# 更新
git pull && docker compose up -d --build
```

#### 启用 Web 页面登录验证

编辑 `docker-compose.yml`，取消 `authInfo` 那行的注释并设置账号密码：

```yaml
environment:
  - authInfo=admin:your_password
```

### 3. 从源码运行

```bash
# 需要 Go 1.22+
go mod tidy
go run .

# 自定义端口
go run . -p 3000

# 启用登录验证
go run . -a admin:password
```

### 4. Railway 部署

点击上方 **Deploy on Railway** 按钮，或手动：

1. Fork 本仓库
2. 在 [Railway](https://railway.app) 新建项目，选择 GitHub 仓库
3. 设置环境变量 `PORT=8008`
4. 部署完成后获取公网 URL

### 5. Render 部署

点击上方 **Deploy to Render** 按钮，或手动：

1. Fork 本仓库
2. 在 [Render](https://render.com) 新建 Web Service，选择 Docker
3. 自动读取 `render.yaml` 配置
4. 部署完成后获取公网 URL

## 使用说明

### 连接 SSH 服务器

1. 打开浏览器访问 WebSSH 页面
2. 填写主机地址、端口、用户名
3. 选择密码或密钥认证
4. 可选：勾选「检测系统信息」、「使用 SOCKS5 代理」
5. 点击 **连接终端**

### 终端功能

| 功能 | 说明 |
|------|------|
| 多标签 | 顶栏标签切换，`+` 新建连接 |
| 字体调节 | 顶栏 🔍-/🔍+ 调整大小 |
| 颜色自定义 | 顶栏调色盘按钮，选择文字/背景/光标色 |
| 脚本书签 | 保存常用命令，点击自动执行 |
| SFTP | 顶栏文件夹按钮，浏览/上传/下载文件 |
| 系统监控 | CPU/内存/磁盘/负载/流量 每分钟刷新 |
| 快捷键 | `Esc` 断开连接返回登录页 |

### Cloudflare Worker 反代

如果需要通过 CF Worker 反代 WebSSH，使用以下代码：

```javascript
export default {
  async fetch(request) {
    const TARGET_IP = "你的服务器IP";
    const TARGET_PORT = "8008";
    const url = new URL(request.url);
    url.hostname = TARGET_IP;
    url.port = TARGET_PORT;
    url.protocol = "http:";
    if (request.headers.get("Upgrade") === "websocket") {
      return fetch(url.toString(), request);
    }
    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: "follow",
    });
  },
};
```

## 配置参数

| 参数 | 环境变量 | 默认值 | 说明 |
|------|----------|--------|------|
| `-p` | `port` | 8008 | 服务端口 |
| `-a` | `authInfo` | 空 | Web 登录验证，格式 `user:pass` |
| `-t` | — | 120 | SSH 连接超时时间（分钟） |
| `-s` | `savePass` | true | 是否保存密码 |

## 技术栈

- **后端**: Go + Gin + gorilla/websocket + golang.org/x/crypto/ssh + golang.org/x/net/proxy
- **前端**: 原生 HTML/CSS/JS + xterm.js
- **部署**: Docker + Docker Compose / Railway / Render
- ## 效果图
<img width="1280" height="675" alt="image" src="https://github.com/user-attachments/assets/f3ef06c5-9479-4123-9c93-9b4ac69f007f" />
<img width="1280" height="415" alt="image" src="https://github.com/user-attachments/assets/2bcf4d98-3a95-4d43-867b-f4af5fd94948" />
<img width="1280" height="512" alt="image" src="https://github.com/user-attachments/assets/5040cc7d-bd31-44c9-9b94-4382fb59764e" />

<img width="369" height="634" alt="image" src="https://github.com/user-attachments/assets/b6978860-c82e-413a-ab3e-3e29c4776a9a" />
<img width="521" height="737" alt="image" src="https://github.com/user-attachments/assets/e8dfbd1c-87ae-495d-a8bb-cabf714f0878" />
<img width="1042" height="249" alt="image" src="https://github.com/user-attachments/assets/b6d99e78-563e-4572-b094-1ebf36dd440a" />
<img width="525" height="466" alt="image" src="https://github.com/user-attachments/assets/c2a573d2-1af3-42dd-b6c2-76b3eabbe0ea" />

<img width="375" height="70" alt="image" src="https://github.com/user-attachments/assets/00048723-2590-4e56-868f-3921228d1127" />
