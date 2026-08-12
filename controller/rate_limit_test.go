package controller

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func requestIPForTest(t *testing.T, remoteAddr, forwardedFor, realIP string) string {
	t.Helper()
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("POST", "/api/auth/login", nil)
	ctx.Request.RemoteAddr = remoteAddr
	if forwardedFor != "" {
		ctx.Request.Header.Set("X-Forwarded-For", forwardedFor)
	}
	if realIP != "" {
		ctx.Request.Header.Set("X-Real-IP", realIP)
	}
	return requestIP(ctx)
}

func TestRequestIPTrustedProxyHandling(t *testing.T) {
	t.Run("direct client ignores spoofed headers", func(t *testing.T) {
		t.Setenv("WEBSSH_TRUSTED_PROXIES", "")
		if got := requestIPForTest(t, "198.51.100.10:1234", "203.0.113.77", "203.0.113.88"); got != "198.51.100.10" {
			t.Fatalf("requestIP = %q, want direct peer", got)
		}
	})

	t.Run("trusted reverse proxy uses forwarded client", func(t *testing.T) {
		t.Setenv("WEBSSH_TRUSTED_PROXIES", "10.0.0.0/8")
		if got := requestIPForTest(t, "10.1.2.3:443", "198.51.100.25", ""); got != "198.51.100.25" {
			t.Fatalf("requestIP = %q, want forwarded client", got)
		}
	})

	t.Run("walks trusted chain from the right", func(t *testing.T) {
		t.Setenv("WEBSSH_TRUSTED_PROXIES", "10.0.0.0/8, 192.168.0.0/16")
		if got := requestIPForTest(t, "10.1.2.3:443", "198.51.100.40, 192.168.1.9", ""); got != "198.51.100.40" {
			t.Fatalf("requestIP = %q, want original client", got)
		}
	})

	t.Run("spoofed left entry stops at first untrusted hop", func(t *testing.T) {
		t.Setenv("WEBSSH_TRUSTED_PROXIES", "10.0.0.0/8")
		if got := requestIPForTest(t, "10.1.2.3:443", "203.0.113.200, 198.51.100.55", ""); got != "198.51.100.55" {
			t.Fatalf("requestIP = %q, want nearest untrusted hop", got)
		}
	})

	t.Run("malformed forwarded chain falls back to proxy", func(t *testing.T) {
		t.Setenv("WEBSSH_TRUSTED_PROXIES", "10.0.0.0/8")
		if got := requestIPForTest(t, "10.1.2.3:443", "not-an-ip, 198.51.100.55", ""); got != "10.1.2.3" {
			t.Fatalf("requestIP = %q, want trusted peer fallback", got)
		}
	})
}

func TestAuthRateLimiterEntryCap(t *testing.T) {
	gin.SetMode(gin.TestMode)
	authRateLimiter.Lock()
	authRateLimiter.Entries = make(map[string]rateWindow)
	authRateLimiter.Unlock()
	t.Cleanup(func() {
		authRateLimiter.Lock()
		authRateLimiter.Entries = make(map[string]rateWindow)
		authRateLimiter.Unlock()
	})

	for i := 0; i < maxAuthRateEntries+128; i++ {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Request = httptest.NewRequest("POST", "/api/auth/login", nil)
		ctx.Request.RemoteAddr = fmt.Sprintf("[2001:db8::%x]:12345", i+1)
		if !allowAuthAttempt(ctx, "cap-test", 100, time.Minute) {
			t.Fatalf("first request for source %d was unexpectedly limited", i)
		}
	}

	authRateLimiter.Lock()
	entryCount := len(authRateLimiter.Entries)
	authRateLimiter.Unlock()
	if entryCount > maxAuthRateEntries {
		t.Fatalf("rate limiter retained %d entries, cap is %d", entryCount, maxAuthRateEntries)
	}
}
