package controller

import (
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

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
