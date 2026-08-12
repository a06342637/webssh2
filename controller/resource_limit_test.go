package controller

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestSSHSlotLimiterEnforcesAndReleasesLimits(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WEBSSH_MAX_CONCURRENT_SSH", "1")
	t.Setenv("WEBSSH_MAX_CONCURRENT_SSH_PER_CLIENT", "1")
	sshSlots.Lock()
	sshSlots.Total = 0
	sshSlots.Clients = make(map[string]int)
	sshSlots.Unlock()

	newContext := func() (*gin.Context, *httptest.ResponseRecorder) {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Request = httptest.NewRequest(http.MethodPost, "/check", nil)
		ctx.Request.RemoteAddr = "198.51.100.10:1234"
		return ctx, recorder
	}

	first, _ := newContext()
	release, ok := acquireSSHSlot(first)
	if !ok {
		t.Fatal("first SSH slot was unexpectedly rejected")
	}
	second, secondRecorder := newContext()
	if _, ok := acquireSSHSlot(second); ok || secondRecorder.Code != http.StatusTooManyRequests {
		t.Fatalf("second SSH slot result ok=%v status=%d", ok, secondRecorder.Code)
	}
	release()
	third, _ := newContext()
	thirdRelease, ok := acquireSSHSlot(third)
	if !ok {
		t.Fatal("released SSH slot was not reusable")
	}
	thirdRelease()
}

func TestUploadSlotLimiterEnforcesAndReleasesLimits(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WEBSSH_MAX_CONCURRENT_UPLOADS", "1")
	t.Setenv("WEBSSH_MAX_CONCURRENT_UPLOADS_PER_CLIENT", "1")
	uploadSlots.Lock()
	uploadSlots.Total = 0
	uploadSlots.Clients = make(map[string]int)
	uploadSlots.Unlock()

	newContext := func() (*gin.Context, *httptest.ResponseRecorder) {
		recorder := httptest.NewRecorder()
		ctx, _ := gin.CreateTestContext(recorder)
		ctx.Request = httptest.NewRequest(http.MethodPost, "/file/upload", nil)
		ctx.Request.RemoteAddr = "198.51.100.20:1234"
		return ctx, recorder
	}

	first, _ := newContext()
	release, ok := acquireUploadSlot(first)
	if !ok {
		t.Fatal("first upload slot was unexpectedly rejected")
	}
	second, recorder := newContext()
	if _, ok := acquireUploadSlot(second); ok || recorder.Code != http.StatusTooManyRequests {
		t.Fatalf("second upload slot result ok=%v status=%d", ok, recorder.Code)
	}
	release()
	third, _ := newContext()
	thirdRelease, ok := acquireUploadSlot(third)
	if !ok {
		t.Fatal("released upload slot was not reusable")
	}
	thirdRelease()
}
