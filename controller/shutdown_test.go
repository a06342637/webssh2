package controller

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestRuntimeShutdownRejectsLateWork(t *testing.T) {
	runtimeShuttingDown.Store(false)
	t.Cleanup(func() { runtimeShuttingDown.Store(false) })

	var closed atomic.Bool
	BeginRuntimeShutdown()
	unregister, registered := registerRuntimeCloser(func() { closed.Store(true) })
	unregister()
	if registered {
		t.Fatal("runtime closer registered after shutdown began")
	}
	if !closed.Load() {
		t.Fatal("late runtime connection was not closed immediately")
	}

	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodGet, "/file/download", nil)
	if release, ok := acquireDownloadSlot(ctx); ok {
		release()
		t.Fatal("download slot was admitted after shutdown began")
	}
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("shutdown admission status = %d, want %d", recorder.Code, http.StatusServiceUnavailable)
	}
}
