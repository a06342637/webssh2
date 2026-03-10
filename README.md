# WebSSH

一个基于 Go + WebSocket 的 Web SSH 终端，支持密码和密钥认证，带有炫酷的毛玻璃 UI。
## 作者 棍勇

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

- **前端**: 原生 HTML/CSS/JS + xterm.js
- **部署**: Docker + Docker Compose

- ## 效果图
<img width="1280" height="675" alt="image" src="https://github.com/user-attachments/assets/f3ef06c5-9479-4123-9c93-9b4ac69f007f" />
<img width="1280" height="415" alt="image" src="https://github.com/user-attachments/assets/2bcf4d98-3a95-4d43-867b-f4af5fd94948" />
<img width="1280" height="512" alt="image" src="https://github.com/user-attachments/assets/5040cc7d-bd31-44c9-9b94-4382fb59764e" />

<img width="369" height="634" alt="image" src="https://github.com/user-attachments/assets/b6978860-c82e-413a-ab3e-3e29c4776a9a" />
<img width="521" height="737" alt="image" src="https://github.com/user-attachments/assets/e8dfbd1c-87ae-495d-a8bb-cabf714f0878" />
<img width="1042" height="249" alt="image" src="https://github.com/user-attachments/assets/b6d99e78-563e-4572-b094-1ebf36dd440a" />
<img width="525" height="466" alt="image" src="https://github.com/user-attachments/assets/c2a573d2-1af3-42dd-b6c2-76b3eabbe0ea" />

<img width="375" height="70" alt="image" src="https://github.com/user-attachments/assets/00048723-2590-4e56-868f-3921228d1127" />


