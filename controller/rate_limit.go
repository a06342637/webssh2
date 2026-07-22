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

func requestIP(c *gin.Context) string {
	host, _, err := net.SplitHostPort(c.Request.RemoteAddr)
	if err == nil {
		return host
	}
	return c.Request.RemoteAddr
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
