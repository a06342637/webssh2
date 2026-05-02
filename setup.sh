#!/bin/sh
# WebSSH 部署向导
set -e

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         WebSSH 部署向导              ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ── 1. 端口 ──────────────────────────────────────────────────────────────────
printf "服务端口 [默认 8008，直接回车跳过]: "
read PORT_INPUT
if [ -z "$PORT_INPUT" ]; then
    PORT_INPUT=8008
fi

# ── 2. 页脚 ──────────────────────────────────────────────────────────────────
echo ""
printf "是否显示底部版权页脚？([回车]=显示  n=不显示): "
read FOOTER_INPUT
if [ "$FOOTER_INPUT" = "n" ] || [ "$FOOTER_INPUT" = "N" ]; then
    SHOW_FOOTER=false
else
    SHOW_FOOTER=true
fi

# ── 3. Web 登录验证 ───────────────────────────────────────────────────────────
echo ""
echo "  [Web 登录验证说明] 启用后浏览器打开页面时会先弹出账号密码对话框，"
echo "  输入正确才能看到 SSH 登录界面。适合将 WebSSH 暴露在公网时使用。"
echo "  与 SSH 本身的账号密码无关，是两层独立的验证。"
printf "是否启用 Web 登录验证？(y=启用  [回车]=不启用): "
read AUTH_INPUT
AUTH_INFO=""
if [ "$AUTH_INPUT" = "y" ] || [ "$AUTH_INPUT" = "Y" ]; then
    printf "  用户名: "
    read AUTH_USER
    printf "  密码: "
    read AUTH_PASS
    if [ -n "$AUTH_USER" ] && [ -n "$AUTH_PASS" ]; then
        AUTH_INFO="${AUTH_USER}:${AUTH_PASS}"
    fi
fi

# ── 写入 .env ─────────────────────────────────────────────────────────────────
cat > .env <<EOF
PORT=${PORT_INPUT}
SHOW_FOOTER=${SHOW_FOOTER}
EOF

if [ -n "$AUTH_INFO" ]; then
    echo "AUTH_INFO=${AUTH_INFO}" >> .env
fi

echo ""
echo "✅ 配置已写入 .env"
echo ""

# ── 启动 ──────────────────────────────────────────────────────────────────────
echo "🚀 正在启动 WebSSH..."
docker compose up -d --build

echo ""
echo "🌐 启动成功！浏览器打开: http://你的服务器IP:${PORT_INPUT}"
echo ""
