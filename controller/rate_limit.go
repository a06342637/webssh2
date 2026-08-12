package controller

import (
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
)

const maxAuthRateEntries = 4096

type rateWindow struct {
	Started time.Time
	Count   int
}

var authRateLimiter = struct {
	sync.Mutex
	Entries map[string]rateWindow
}{Entries: make(map[string]rateWindow)}

func envPositiveInt(name string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || value < 1 {
		return fallback
	}
	return value
}

func AllowRegistration() bool {
	value, err := strconv.ParseBool(strings.TrimSpace(os.Getenv("WEBSSH_ALLOW_REGISTRATION")))
	return err == nil && value
}

func maxAccountCount() int   { return envPositiveInt("WEBSSH_MAX_ACCOUNTS", 200) }
func maxActiveSessions() int { return envPositiveInt("WEBSSH_MAX_SESSIONS_PER_USER", 20) }

func parseRequestIP(raw string) net.IP {
	raw = strings.TrimSpace(strings.Trim(raw, `"`))
	if host, _, err := net.SplitHostPort(raw); err == nil {
		raw = host
	}
	raw = strings.Trim(raw, "[]")
	return net.ParseIP(raw)
}

func trustedProxyNetworks() []*net.IPNet {
	var networks []*net.IPNet
	for _, raw := range strings.Split(os.Getenv("WEBSSH_TRUSTED_PROXIES"), ",") {
		raw = strings.TrimSpace(raw)
		if raw == "" {
			continue
		}
		if _, network, err := net.ParseCIDR(raw); err == nil {
			networks = append(networks, network)
			continue
		}
		if ip := net.ParseIP(raw); ip != nil {
			bits := 128
			if ip.To4() != nil {
				ip = ip.To4()
				bits = 32
			}
			networks = append(networks, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
		}
	}
	return networks
}

func trustedProxyIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	for _, network := range trustedProxyNetworks() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}

func forwardedIPs(raw string) ([]net.IP, bool) {
	parts := strings.Split(raw, ",")
	ips := make([]net.IP, 0, len(parts))
	for _, part := range parts {
		ip := parseRequestIP(part)
		if ip == nil {
			return nil, false
		}
		ips = append(ips, ip)
	}
	return ips, len(ips) > 0
}

func requestIP(c *gin.Context) string {
	peer := parseRequestIP(c.Request.RemoteAddr)
	if peer == nil {
		return strings.TrimSpace(c.Request.RemoteAddr)
	}
	if !trustedProxyIP(peer) {
		return peer.String()
	}

	if rawForwarded := strings.TrimSpace(c.GetHeader("X-Forwarded-For")); rawForwarded != "" {
		if chain, ok := forwardedIPs(rawForwarded); ok {
			client := peer
			for i := len(chain) - 1; i >= 0 && trustedProxyIP(client); i-- {
				client = chain[i]
			}
			return client.String()
		}
		// A malformed chain is not partially trusted.
		return peer.String()
	}
	if realIP := parseRequestIP(c.GetHeader("X-Real-IP")); realIP != nil {
		return realIP.String()
	}
	return peer.String()
}

func allowAuthAttempt(c *gin.Context, kind string, limit int, window time.Duration) bool {
	now := time.Now()
	key := kind + ":" + requestIP(c)
	authRateLimiter.Lock()
	defer authRateLimiter.Unlock()
	if _, exists := authRateLimiter.Entries[key]; !exists && len(authRateLimiter.Entries) >= maxAuthRateEntries {
		for itemKey, item := range authRateLimiter.Entries {
			if now.Sub(item.Started) >= time.Hour {
				delete(authRateLimiter.Entries, itemKey)
			}
		}
		if len(authRateLimiter.Entries) >= maxAuthRateEntries {
			oldestKey := ""
			var oldestStarted time.Time
			for itemKey, item := range authRateLimiter.Entries {
				if oldestKey == "" || item.Started.Before(oldestStarted) {
					oldestKey = itemKey
					oldestStarted = item.Started
				}
			}
			delete(authRateLimiter.Entries, oldestKey)
		}
	}
	entry := authRateLimiter.Entries[key]
	if entry.Started.IsZero() || now.Sub(entry.Started) >= window {
		entry = rateWindow{Started: now, Count: 0}
	}
	entry.Count++
	authRateLimiter.Entries[key] = entry
	if entry.Count > limit {
		c.Header("Retry-After", strconv.Itoa(int(time.Until(entry.Started.Add(window)).Seconds())+1))
		c.JSON(http.StatusTooManyRequests, gin.H{"ok": false, "msg": "请求过于频繁，请稍后再试"})
		return false
	}
	return true
}

func AllowBasicAuthAttempt(c *gin.Context) bool {
	if allowAuthAttempt(c, "basic-auth", 30, 5*time.Minute) {
		return true
	}
	c.Abort()
	return false
}
