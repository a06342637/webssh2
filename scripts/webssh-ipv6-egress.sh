#!/bin/sh
# Configure IPv6 forwarding/NAT for WebSSH's private Docker IPv6 bridge.
#
# Docker gives the compose network a stable ULA subnet.  A ULA is not routed
# by the provider, so a host with a global IPv6 address needs an explicit
# MASQUERADE rule for containers to reach IPv6-only SSH targets.
set -eu

quiet=false
wait_for_network=false
for option in "$@"; do
    case "$option" in
        --quiet) quiet=true ;;
        --wait) wait_for_network=true ;;
        *)
            printf 'webssh IPv6: unknown option: %s\n' "$option" >&2
            exit 2
            ;;
    esac
done

log() {
    if ! $quiet; then
        printf '%s\n' "$*"
    fi
}

warn() {
    printf 'webssh IPv6: %s\n' "$*" >&2
}

if [ "$(id -u)" -ne 0 ]; then
    warn "root privileges are required to configure IPv6 forwarding/NAT"
    exit 0
fi

command -v docker >/dev/null 2>&1 || exit 0
command -v ip >/dev/null 2>&1 || exit 0

default_iface=""
discover_host_ipv6() {
    default_iface=$(ip -6 route show default 2>/dev/null | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit } }')
    [ -n "$default_iface" ] || return 1
    ip -6 addr show dev "$default_iface" scope global 2>/dev/null | grep -q 'inet6 '
}

configure_network() {
    network=$1
    subnet=$(docker network inspect "$network" --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null | awk '/:/{print; exit}')
    [ -n "$subnet" ] || return 0

    bridge=$(docker network inspect "$network" --format '{{index .Options "com.docker.network.bridge.name"}}' 2>/dev/null || true)
    if [ -z "$bridge" ]; then
        network_id=$(docker network inspect "$network" --format '{{.Id}}' 2>/dev/null || true)
        [ -n "$network_id" ] || return 0
        bridge="br-$(printf '%s' "$network_id" | cut -c 1-12)"
    fi

    sysctl -q -w net.ipv6.conf.all.forwarding=1 >/dev/null 2>&1 || true
    sysctl -q -w "net.ipv6.conf.$bridge.forwarding=1" >/dev/null 2>&1 || true

    if command -v ip6tables >/dev/null 2>&1; then
        rule="-s $subnet -o $default_iface -j MASQUERADE"
        if ! ip6tables -t nat -C POSTROUTING $rule >/dev/null 2>&1; then
            if ! ip6tables -t nat -A POSTROUTING $rule; then
                warn "failed to add the IPv6 NAT rule for $network"
                return 1
            fi
            log "enabled IPv6 NAT for $network ($subnet -> $default_iface)"
        else
            log "IPv6 NAT already enabled for $network"
        fi
        return 0
    fi

    # nftables-only hosts may not ship the ip6tables compatibility command.
    # Keep a dedicated table so the rule is isolated and easy to remove.
    if command -v nft >/dev/null 2>&1; then
        nft list table ip6 webssh_ipv6 >/dev/null 2>&1 || \
            nft add table ip6 webssh_ipv6 || {
                warn "failed to create the WebSSH nftables IPv6 table"
                return 1
            }
        nft list chain ip6 webssh_ipv6 postrouting >/dev/null 2>&1 || \
            nft 'add chain ip6 webssh_ipv6 postrouting { type nat hook postrouting priority srcnat; policy accept; }' || {
                warn "failed to create the WebSSH nftables postrouting chain"
                return 1
            }
        if ! nft list chain ip6 webssh_ipv6 postrouting 2>/dev/null | grep -Fq "ip6 saddr $subnet oifname \"$default_iface\" masquerade"; then
            if ! nft add rule ip6 webssh_ipv6 postrouting ip6 saddr "$subnet" oifname "$default_iface" masquerade; then
                warn "failed to add the nftables IPv6 NAT rule for $network"
                return 1
            fi
            log "enabled nftables IPv6 NAT for $network ($subnet -> $default_iface)"
        else
            log "IPv6 nftables NAT already enabled for $network"
        fi
    else
        warn "neither ip6tables nor nft is available; container IPv6 egress remains unavailable"
        return 1
    fi
}

configure_running_containers() {
    containers=$(docker ps --filter 'label=com.docker.compose.service=webssh' --format '{{.ID}}' 2>/dev/null || true)
    if [ -z "$containers" ]; then
        # Older Compose versions may not expose the service label.  The standard
        # installation uses the stable container name as a safe fallback.
        containers=$(docker ps --filter 'name=^/webssh$' --format '{{.ID}}' 2>/dev/null || true)
    fi

    configured=false
    for container in $containers; do
        networks=$(docker inspect "$container" --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' 2>/dev/null || true)
        for network in $networks; do
            subnet=$(docker network inspect "$network" --format '{{range .IPAM.Config}}{{.Subnet}}{{"\n"}}{{end}}' 2>/dev/null | awk '/:/{print; exit}')
            if [ -n "$subnet" ]; then
                if ! configure_network "$network"; then
                    return 1
                fi
                configured=true
            fi
        done
    done
    $configured
}

attempts=1
if $wait_for_network; then
    # docker.service can be active before restart-policy containers have joined
    # their bridge.  Wait up to two minutes during boot instead of permanently
    # marking the oneshot unit successful without installing a rule.
    attempts=60
fi

while [ "$attempts" -gt 0 ]; do
    if discover_host_ipv6 && configure_running_containers; then
        exit 0
    fi
    attempts=$((attempts - 1))
    if [ "$attempts" -gt 0 ]; then
        sleep 2
    fi
done

log "IPv6 host route/address or a running WebSSH IPv6 bridge was not ready; retry after the network starts"
exit 1
