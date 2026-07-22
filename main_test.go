package main

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
)

func TestBasicAuthProtectsAllRoutesExceptHealth(t *testing.T) {
	gin.SetMode(gin.TestMode)
	originalAuth, originalUsername, originalPassword := *authInfo, username, password
	*authInfo, username, password = "admin:secret", "admin", "secret"
	t.Cleanup(func() {
		*authInfo, username, password = originalAuth, originalUsername, originalPassword
	})

	router := gin.New()
	router.Use(securityHeaders(), basicAuthMiddleware())
	router.GET("/healthz", func(c *gin.Context) { c.Status(http.StatusOK) })
	router.POST("/api/auth/register", func(c *gin.Context) { c.Status(http.StatusNoContent) })
	router.GET("/", func(c *gin.Context) { c.Status(http.StatusOK) })

	for _, target := range []string{"/", "/api/auth/register"} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		if target != "/" {
			req.Method = http.MethodPost
		}
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, req)
		if recorder.Code != http.StatusUnauthorized {
			t.Fatalf("%s without Basic Auth returned %d", target, recorder.Code)
		}
	}

	health := httptest.NewRecorder()
	router.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health check returned %d", health.Code)
	}
	if got := health.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Fatalf("security header missing: %q", got)
	}

	authorized := httptest.NewRequest(http.MethodGet, "/", nil)
	authorized.SetBasicAuth("admin", "secret")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, authorized)
	if recorder.Code != http.StatusOK {
		t.Fatalf("valid Basic Auth returned %d", recorder.Code)
	}
}
