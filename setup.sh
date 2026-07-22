#!/bin/sh
# WebSSH 部署向导
set -e
umask 077

echo ""
echo "╔══════════════════════════════════════╗"
echo "║         WebSSH 部署向导              ║"
echo "╚══════════════════════════════════════╝"
echo ""

# 检测宿主机是否同时具有全局 IPv6 地址和默认 IPv6 路由。
# 优先使用 iproute2；精简 Linux 系统则读取 /proc 作为回退。
has_usable_ipv6() {
    if command -v ip >/dev/null 2>&1; then
        if ip -6 addr show scope global 2>/dev/null | grep -q 'inet6 ' && \
           ip -6 route show default 2>/dev/null | grep -q '^default'; then
            return 0
        fi
        return 1
    fi

    if [ -r /proc/net/if_inet6 ] && [ -r /proc/net/ipv6_route ]; then
        if awk '$4 == "00" && $6 != "lo" { found = 1 } END { exit !found }' /proc/net/if_inet6 2>/dev/null && \
           awk '$1 == "00000000000000000000000000000000" && $2 == "00000000" && $10 != "lo" { found = 1 } END { exit !found }' /proc/net/ipv6_route 2>/dev/null; then
            return 0
        fi
    fi

    return 1
}

# 检测已启动容器内是否具有 IPv6 地址和到公网 IPv6 地址的路由。
container_has_usable_ipv6() {
    docker compose exec -T webssh sh -c 'ip -6 addr show scope global 2>/dev/null | grep -q "inet6 " && ip -6 route get 2606:4700:4700::1111 >/dev/null 2>&1'
}

# 统计 UTF-8 码点数量，不依赖宿主机 locale；od 是 POSIX 基础工具。
utf8_char_count() {
    count=0
    for byte in $(printf '%s' "$1" | LC_ALL=C od -An -tu1); do
        if [ "$byte" -lt 128 ] || [ "$byte" -gt 191 ]; then
            count=$((count + 1))
        fi
    done
    printf '%s' "$count"
}

# 使用 Compose .env 的单引号值，避免密码里的 $ 被变量插值。
# Compose dotenv 支持用 \' 表示单引号；其他字符（含反斜杠和双引号）保持原样。
escape_dotenv_value() {
    printf '%s' "$1" | sed "s/'/\\\\'/g"
}

# ── 1. 端口 ──────────────────────────────────────────────────────────────────
while :; do
    printf "服务端口 [默认 8008，直接回车跳过]: "
    IFS= read -r PORT_INPUT
    if [ -z "$PORT_INPUT" ]; then
        PORT_INPUT=8008
        break
    fi
    if printf '%s' "$PORT_INPUT" | grep -Eq '^[1-9][0-9]{0,4}$' && [ "$PORT_INPUT" -le 65535 ]; then
        break
    fi
    echo "  端口必须是 1-65535 之间的整数。"
done

# ── 2. 页脚 ──────────────────────────────────────────────────────────────────
echo ""
printf "是否显示底部版权页脚？([回车]=显示  n=不显示): "
IFS= read -r FOOTER_INPUT
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
IFS= read -r AUTH_INPUT
AUTH_INFO=""
if [ "$AUTH_INPUT" = "y" ] || [ "$AUTH_INPUT" = "Y" ]; then
    while :; do
        printf "  用户名: "
        IFS= read -r AUTH_USER
        case "$AUTH_USER" in
            ""|*:*)
                echo "  用户名不能为空，也不能包含冒号。"
                continue
                ;;
        esac
        printf "  密码: "
        if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
            stty -echo
            IFS= read -r AUTH_PASS
            stty echo
            echo ""
        else
            IFS= read -r AUTH_PASS
        fi
        if [ -z "$AUTH_PASS" ]; then
            echo "  密码不能为空。"
            continue
        fi
        AUTH_INFO="${AUTH_USER}:${AUTH_PASS}"
        break
    done
fi

# ── 4. 脚本书签/账号同步管理员 ────────────────────────────────────────────────
echo ""
echo "  [脚本书签管理员说明]"
echo "  该账号用于登录账号同步、同步脚本书签和 Emoji 分类，"
echo "  并可进入账号管理和页面版本更新。"
echo "  它不是 SSH 服务器账号，也不是可选的 Web 页面登录验证账号。"
echo "  默认用户名是 admin；密码留空会自动随机生成，并只在首次启动的 Docker 日志中打印。"
while :; do
    printf "书签管理员用户名 [默认 admin]: "
    IFS= read -r ADMIN_USER
    if [ -z "$ADMIN_USER" ]; then
        ADMIN_USER=admin
    fi
    if printf "%s" "$ADMIN_USER" | grep -Eq '^[A-Za-z0-9]{5,32}$'; then
        break
    fi
    echo "  书签管理员用户名只能使用 5-32 位字母或数字。"
done

while :; do
    printf "书签管理员密码 [回车=自动随机生成；至少 7 个字符，最多 72 UTF-8 字节]: "
    if [ -t 0 ] && command -v stty >/dev/null 2>&1; then
        stty -echo
        IFS= read -r ADMIN_PASS
        stty echo
        echo ""
    else
        IFS= read -r ADMIN_PASS
    fi
    if [ -z "$ADMIN_PASS" ]; then
        break
    fi
    ADMIN_PASS_CHARS=$(utf8_char_count "$ADMIN_PASS")
    ADMIN_PASS_BYTES=$(printf '%s' "$ADMIN_PASS" | wc -c | tr -d '[:space:]')
    if [ "$ADMIN_PASS_CHARS" -ge 7 ] && [ "$ADMIN_PASS_BYTES" -le 72 ]; then
        break
    fi
    if [ "$ADMIN_PASS_CHARS" -lt 7 ]; then
        echo "  书签管理员密码必须大于 6 位；也可以直接回车自动随机生成。"
    else
        echo "  书签管理员密码不能超过 72 个 UTF-8 字节（bcrypt 安全限制）。"
    fi
done

# ── 5. 页面内更新 ─────────────────────────────────────────────────────────────
echo ""
echo "  [页面内更新说明] 启用后管理员可以在设置里执行 git pull + docker compose up -d --build。"
echo "  该功能需要 Docker Compose 部署，并会挂载当前源码目录和 Docker socket。"
printf "是否启用页面内版本更新？([回车]=启用  n=禁用): "
IFS= read -r UPDATE_INPUT
if [ "$UPDATE_INPUT" = "n" ] || [ "$UPDATE_INPUT" = "N" ]; then
    ENABLE_SELF_UPDATE=false
else
    ENABLE_SELF_UPDATE=true
fi

HOST_PROJECT_DIR=$(pwd -P 2>/dev/null || pwd)

# ── 写入 .env ─────────────────────────────────────────────────────────────────
{
    printf 'PORT=%s\n' "$PORT_INPUT"
    printf 'SHOW_FOOTER=%s\n' "$SHOW_FOOTER"
    printf "WEBSSH_ADMIN_USER='%s'\n" "$(escape_dotenv_value "$ADMIN_USER")"
    printf "WEBSSH_ADMIN_PASSWORD='%s'\n" "$(escape_dotenv_value "$ADMIN_PASS")"
    printf 'WEBSSH_ENABLE_SELF_UPDATE=%s\n' "$ENABLE_SELF_UPDATE"
    printf "WEBSSH_HOST_PROJECT_DIR='%s'\n" "$(escape_dotenv_value "$HOST_PROJECT_DIR")"
    if [ "$ENABLE_SELF_UPDATE" = "true" ]; then
        printf 'COMPOSE_FILE=docker-compose.yml:docker-compose.update.yml\n'
    else
        printf 'COMPOSE_FILE=docker-compose.yml\n'
    fi
    if [ -n "$AUTH_INFO" ]; then
        printf "AUTH_INFO='%s'\n" "$(escape_dotenv_value "$AUTH_INFO")"
    fi
} > .env
chmod 600 .env

echo ""
echo "✅ 配置已写入 .env"
if [ -z "$ADMIN_PASS" ]; then
    echo "🔐 书签管理员密码将自动生成；首次启动后运行下面命令查看："
    echo "   docker compose logs webssh | grep -A8 \"WebSSH 管理员账号\""
else
    echo "🔐 书签管理员账号: ${ADMIN_USER}"
fi
echo ""

# ── IPv6 网络检测 ─────────────────────────────────────────────────────────────
# 有可用 IPv6 时保持安静；只有未检测到 IPv6 时才提示并等待确认。
HOST_IPV6_AVAILABLE=true
if ! has_usable_ipv6; then
    HOST_IPV6_AVAILABLE=false
    echo "⚠️  本机没有检测到可用的 IPv6 网络。"
    echo "   IPv6 服务器将不能通过本机直接连接 SSH。"
    echo "   如果需要支持 IPv6，请更换支持 IPv6 的服务器。"
    printf "按回车继续..."
    IFS= read -r IPV6_CONTINUE
    echo ""
fi

# ── 启动 ──────────────────────────────────────────────────────────────────────
echo "🚀 正在启动 WebSSH..."
docker compose up -d --build

if [ "$HOST_IPV6_AVAILABLE" = "true" ] && ! container_has_usable_ipv6; then
    echo ""
    echo "⚠️  宿主机支持 IPv6，但 WebSSH 容器内没有检测到可用的 IPv6 路由。"
    echo "   IPv6 SSH 暂时无法连接，请检查 Docker daemon 的 IPv6 配置后重建容器。"
    printf "按回车继续..."
    IFS= read -r IPV6_CONTAINER_CONTINUE
fi

echo ""
echo "🌐 启动成功！浏览器打开: http://你的服务器IP:${PORT_INPUT}"
if [ -z "$ADMIN_PASS" ]; then
    echo "🔐 随机书签管理员密码查看命令: docker compose logs webssh | grep -A8 \"WebSSH 管理员账号\""
fi
echo ""
