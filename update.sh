#!/bin/sh
# WebSSH Docker Compose 安全更新脚本。
#
# 普通更新：sh update.sh
# 强制更新：sh update.sh --force
set -eu
umask 077

FORCE=false
PROJECT_DIR=""
BRANCH=""
HEALTH_TIMEOUT="${WEBSSH_UPDATE_HEALTH_TIMEOUT:-240}"

log() {
    printf '%s %s\n' "$(date '+%F %T')" "$*"
}

fail() {
    log "ERROR: $*"
    exit 1
}

usage() {
    cat <<'EOF'
用法：sh update.sh [选项]

选项：
  --force              强制与远端分支一致，覆盖受 Git 跟踪的本地修改
  --project-dir DIR    WebSSH 仓库绝对路径（默认使用脚本所在目录）
  --branch NAME        更新分支（默认使用当前分支）
  -h, --help           显示帮助

可选环境变量：
  WEBSSH_UPDATE_HEALTH_TIMEOUT=240  新容器启动后的健康检查超时秒数
EOF
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --force)
            FORCE=true
            shift
            ;;
        --project-dir)
            [ "$#" -ge 2 ] || fail "--project-dir 缺少目录"
            PROJECT_DIR=$2
            shift 2
            ;;
        --branch)
            [ "$#" -ge 2 ] || fail "--branch 缺少分支名"
            BRANCH=$2
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            fail "未知选项：$1（使用 --help 查看帮助）"
            ;;
    esac
done

case "$HEALTH_TIMEOUT" in
    ''|*[!0-9]*) fail "WEBSSH_UPDATE_HEALTH_TIMEOUT 必须是正整数" ;;
esac
[ "$HEALTH_TIMEOUT" -gt 0 ] || fail "WEBSSH_UPDATE_HEALTH_TIMEOUT 必须大于 0"

if [ -z "$PROJECT_DIR" ]; then
    SCRIPT_DIR=$(dirname "$0")
    PROJECT_DIR=$(CDPATH= cd -P "$SCRIPT_DIR" 2>/dev/null && pwd) || fail "无法确定脚本目录"
fi
case "$PROJECT_DIR" in
    /*) ;;
    *) fail "--project-dir 必须是绝对路径" ;;
esac
PROJECT_DIR=$(CDPATH= cd -P "$PROJECT_DIR" 2>/dev/null && pwd) || fail "项目目录不存在：$PROJECT_DIR"
cd "$PROJECT_DIR"

refresh_ipv6_egress_helper() {
    helper_path="$PROJECT_DIR/scripts/webssh-ipv6-egress.sh"
    unit_path="$PROJECT_DIR/scripts/webssh-ipv6-egress.service"
    [ -f "$helper_path" ] && [ -f "$unit_path" ] || return 0
    [ "$(id -u)" -eq 0 ] || return 0

    # Page updates run inside a short-lived helper container. Do not install
    # into that container's private root filesystem; the host copy installed by
    # setup.sh remains active. Command-line updates on a systemd host refresh
    # both files so reboot persistence receives future fixes as well.
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && command -v install >/dev/null 2>&1; then
        install -m 700 "$helper_path" /usr/local/sbin/webssh-ipv6-egress
        install -m 644 "$unit_path" /etc/systemd/system/webssh-ipv6-egress.service
        systemctl daemon-reload >/dev/null 2>&1 || true
        systemctl enable webssh-ipv6-egress.service >/dev/null 2>&1 || true
    elif [ -x /usr/local/sbin/webssh-ipv6-egress ] && command -v install >/dev/null 2>&1; then
        install -m 700 "$helper_path" /usr/local/sbin/webssh-ipv6-egress
    fi
}

[ -d .git ] || fail "$PROJECT_DIR 不是 Git 仓库"
command -v git >/dev/null 2>&1 || fail "未安装 git"
command -v docker >/dev/null 2>&1 || fail "未安装 docker"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 不可用"

git config --global --add safe.directory "$PROJECT_DIR" >/dev/null 2>&1 || true

if [ -z "$BRANCH" ]; then
    BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
    if [ -z "$BRANCH" ]; then
        REMOTE_HEAD=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null || true)
        BRANCH=${REMOTE_HEAD#origin/}
    fi
    [ -n "$BRANCH" ] || BRANCH=main
fi
git check-ref-format --branch "$BRANCH" >/dev/null 2>&1 || fail "无效的分支名：$BRANCH"
REMOTE_REF="refs/remotes/origin/$BRANCH"

# 启用页面更新的部署需要叠加挂载源码和 Docker socket 的 Compose 文件。
# 命令行更新沿用相同配置，避免更新后意外丢失页面更新能力。
if [ -f docker-compose.update.yml ] && [ -f .env ] && grep -Eqi '^WEBSSH_ENABLE_SELF_UPDATE=(true|1|yes)[[:space:]]*$' .env; then
    COMPOSE_FILE=docker-compose.yml:docker-compose.update.yml
    export COMPOSE_FILE
fi
docker compose config >/dev/null 2>&1 || fail "Docker Compose 配置无效"

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP_ROOT="$PROJECT_DIR/.webssh-update-backups"
BACKUP_DIR="$BACKUP_ROOT/$STAMP-$$"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_ROOT" "$BACKUP_DIR"

OLD_COMMIT=$(git rev-parse HEAD) || fail "无法读取当前 Git 提交"
git status --short --branch > "$BACKUP_DIR/git-status.txt" || true
git log --oneline --decorate --all -n 80 > "$BACKUP_DIR/git-log.txt" || true
git diff > "$BACKUP_DIR/git-diff.patch" || true
git diff --cached > "$BACKUP_DIR/git-staged-diff.patch" || true
printf '%s\n' "$OLD_COMMIT" > "$BACKUP_DIR/HEAD.txt"
git bundle create "$BACKUP_DIR/repo-before-update.bundle" --all >/dev/null 2>&1 || true
if [ -f .env ]; then
    cp -p .env "$BACKUP_DIR/.env.backup"
    chmod 600 "$BACKUP_DIR/.env.backup"
fi
find "$BACKUP_DIR" -type f -exec chmod 600 {} +
log "backup saved to $BACKUP_DIR"

# 最多保留 20 份且清理 30 天前的备份。
find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +30 -exec rm -rf {} +
BACKUP_COUNT=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')
while [ "$BACKUP_COUNT" -gt 20 ]; do
    OLDEST=$(find "$BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)
    [ -n "$OLDEST" ] || break
    rm -rf "$OLDEST"
    BACKUP_COUNT=$((BACKUP_COUNT - 1))
done

OLD_CID=$(docker compose ps -q webssh 2>/dev/null || true)
OLD_IMAGE_ID=""
OLD_IMAGE_NAME=""
ROLLBACK_TAG=""
if [ -n "$OLD_CID" ]; then
    OLD_IMAGE_ID=$(docker inspect -f '{{.Image}}' "$OLD_CID" 2>/dev/null || true)
    OLD_IMAGE_NAME=$(docker inspect -f '{{.Config.Image}}' "$OLD_CID" 2>/dev/null || true)
    if [ -n "$OLD_IMAGE_ID" ] && [ -n "$OLD_IMAGE_NAME" ]; then
        ROLLBACK_TAG="webssh-update-rollback:$STAMP-$$"
        docker image tag "$OLD_IMAGE_ID" "$ROLLBACK_TAG" >/dev/null
        log "saved rollback image $ROLLBACK_TAG"
    fi
fi

remove_rollback_tag() {
    if [ -n "$ROLLBACK_TAG" ]; then
        docker image rm "$ROLLBACK_TAG" >/dev/null 2>&1 || true
    fi
}

wait_for_webssh() {
    expected_version=$1
    timeout_seconds=$2
    started=$(date +%s)
    while :; do
        cid=$(docker compose ps -q webssh 2>/dev/null || true)
        if [ -n "$cid" ]; then
            running=$(docker inspect -f '{{.State.Running}}' "$cid" 2>/dev/null || true)
            health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || true)
            if [ "$health" = "unhealthy" ]; then
                log "ERROR: new webssh container is unhealthy"
                return 1
            fi
            if [ "$running" = "true" ] && { [ "$health" = "healthy" ] || [ "$health" = "none" ] || [ -z "$health" ]; }; then
                actual_version=$(docker exec "$cid" /app/webssh -v 2>&1 || true)
                if [ -z "$expected_version" ] || printf '%s\n' "$actual_version" | grep -Fq "Version: $expected_version"; then
                    return 0
                fi
                log "waiting for expected version $expected_version (container reports: $actual_version)"
            fi
        fi
        now=$(date +%s)
        if [ $((now - started)) -ge "$timeout_seconds" ]; then
            log "ERROR: timed out waiting for the new webssh container"
            return 1
        fi
        sleep 3
    done
}

rollback_service() {
    reason=$1
    log "ERROR: $reason"
    if [ -z "$OLD_IMAGE_ID" ] || [ -z "$OLD_IMAGE_NAME" ]; then
        log "no previous container image is available for automatic rollback"
        return 1
    fi
    case "$OLD_IMAGE_NAME" in
        sha256:*|*@*)
            log "previous image name cannot be restored automatically: $OLD_IMAGE_NAME"
            return 1
            ;;
    esac
    log "restoring previous image $OLD_IMAGE_NAME"
    docker image tag "$OLD_IMAGE_ID" "$OLD_IMAGE_NAME" >/dev/null || return 1
    if docker compose up -d --no-deps --no-build --force-recreate webssh; then
        log "previous WebSSH image has been restored; source backup remains at $BACKUP_DIR"
        return 0
    fi
    log "ERROR: automatic rollback also failed"
    return 1
}

log "WebSSH update started (branch: $BRANCH, force: $FORCE)"
log "fetch origin/$BRANCH"
git fetch --prune origin "$BRANCH"
if [ -f .git/shallow ]; then
    log "repository is shallow; deepening history for safer update"
    git fetch --unshallow origin "$BRANCH" || git fetch --deepen=1000 origin "$BRANCH" || true
fi

if $FORCE; then
    log "force update: reset tracked source files to $REMOTE_REF"
    git rev-parse --verify "$REMOTE_REF" >/dev/null
    git reset --hard "$REMOTE_REF"
else
    log "pull origin/$BRANCH (fast-forward only)"
    git pull --ff-only origin "$BRANCH"
fi

refresh_ipv6_egress_helper

NEW_COMMIT=$(git rev-parse HEAD)
EXPECTED_VERSION=$(sed -n '1{s/[[:space:]]//g;p;}' VERSION 2>/dev/null || true)
log "source is now $(git rev-parse --short HEAD), expected version ${EXPECTED_VERSION:-unknown}"

# 先完成镜像构建，旧容器在漫长编译期间继续提供服务。
log "building new image; this can take several minutes on a small server"
if ! docker compose build webssh; then
    remove_rollback_tag
    fail "image build failed; the old container is still running (backup: $BACKUP_DIR)"
fi

log "activating new image"
if $FORCE; then
    if ! docker compose up -d --no-deps --force-recreate webssh; then
        rollback_service "docker compose failed to start the new container" || true
        remove_rollback_tag
        fail "update activation failed (backup: $BACKUP_DIR)"
    fi
else
    if ! docker compose up -d --no-deps webssh; then
        rollback_service "docker compose failed to start the new container" || true
        remove_rollback_tag
        fail "update activation failed (backup: $BACKUP_DIR)"
    fi
fi

# Compose may recreate the bridge with a new name. Reapply the host-side IPv6
# NAT rule after every update so IPv6-only SSH targets keep working.
if [ -x /usr/local/sbin/webssh-ipv6-egress ]; then
    if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1 && [ -f /etc/systemd/system/webssh-ipv6-egress.service ]; then
        systemctl restart webssh-ipv6-egress.service >/dev/null 2>&1 || \
            /usr/local/sbin/webssh-ipv6-egress --quiet || true
    else
        /usr/local/sbin/webssh-ipv6-egress --quiet || true
    fi
fi

log "waiting for container health and version verification"
if ! wait_for_webssh "$EXPECTED_VERSION" "$HEALTH_TIMEOUT"; then
    rollback_service "new container did not pass health/version verification" || true
    remove_rollback_tag
    fail "new release verification failed (backup: $BACKUP_DIR)"
fi

remove_rollback_tag
log "WebSSH update finished: $(printf '%s' "$OLD_COMMIT" | cut -c1-12) -> $(printf '%s' "$NEW_COMMIT" | cut -c1-12), version ${EXPECTED_VERSION:-unknown}"
