package controller

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

const defaultRemoteDownloadMaxBytes = int64(1 << 30)

var blockedRemoteCIDRs = mustParseRemoteCIDRs(
	"100.64.0.0/10", // carrier-grade NAT and shared address space
	"192.0.0.0/24",  // IETF protocol assignments
	"192.0.2.0/24",  // documentation
	"198.18.0.0/15", // benchmark networks
	"198.51.100.0/24",
	"203.0.113.0/24",
	"240.0.0.0/4",   // reserved IPv4 space
	"2001:db8::/32", // IPv6 documentation
)

func mustParseRemoteCIDRs(values ...string) []*net.IPNet {
	networks := make([]*net.IPNet, 0, len(values))
	for _, value := range values {
		_, network, err := net.ParseCIDR(value)
		if err != nil {
			panic(err)
		}
		networks = append(networks, network)
	}
	return networks
}

func remoteIPBlocked(ip net.IP) bool {
	if ip == nil || !ip.IsGlobalUnicast() || ip.IsPrivate() {
		return true
	}
	for _, network := range blockedRemoteCIDRs {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func remoteDownloadMaxBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES"))
	if raw == "" {
		return defaultRemoteDownloadMaxBytes
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 1<<20 {
		return defaultRemoteDownloadMaxBytes
	}
	return value
}

func allowPrivateDownloads() bool {
	value, _ := strconv.ParseBool(strings.TrimSpace(os.Getenv("WEBSSH_ALLOW_PRIVATE_DOWNLOADS")))
	return value
}

func validateRemoteURL(ctx context.Context, target *url.URL) error {
	if target == nil || target.Hostname() == "" || (target.Scheme != "http" && target.Scheme != "https") {
		return fmt.Errorf("only http/https url is supported")
	}
	if allowPrivateDownloads() {
		return nil
	}
	_, err := resolvePublicIPs(ctx, target.Hostname())
	return err
}

func resolvePublicIPs(ctx context.Context, hostname string) ([]net.IP, error) {
	addresses, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
	if err != nil {
		return nil, fmt.Errorf("resolve remote host: %w", err)
	}
	if len(addresses) == 0 {
		return nil, fmt.Errorf("remote host has no IP address")
	}
	result := make([]net.IP, 0, len(addresses))
	for _, address := range addresses {
		ip := address.IP
		if remoteIPBlocked(ip) {
			return nil, fmt.Errorf("remote host resolves to blocked address %s", ip)
		}
		result = append(result, ip)
	}
	return result, nil
}

func newRemoteDownloadClient() *http.Client {
	dialer := &net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}
	transport := &http.Transport{
		Proxy:                 nil,
		ForceAttemptHTTP2:     true,
		ResponseHeaderTimeout: 30 * time.Second,
		IdleConnTimeout:       30 * time.Second,
		DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
			host, port, err := net.SplitHostPort(address)
			if err != nil {
				return nil, err
			}
			if allowPrivateDownloads() {
				return dialer.DialContext(ctx, network, address)
			}
			addresses, err := resolvePublicIPs(ctx, host)
			if err != nil {
				return nil, err
			}
			var lastErr error
			for _, ip := range addresses {
				conn, dialErr := dialer.DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
				if dialErr == nil {
					return conn, nil
				}
				lastErr = dialErr
			}
			return nil, lastErr
		},
	}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Minute}
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if len(via) >= 10 {
			return fmt.Errorf("too many redirects")
		}
		return validateRemoteURL(req.Context(), req.URL)
	}
	return client
}
