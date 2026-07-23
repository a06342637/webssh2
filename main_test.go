package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestRenderIndexHTMLVersionsMutableAssets(t *testing.T) {
	input := []byte(`<link href="/static/css/style.css?v=__APP_VERSION__"><script src="/static/js/app.js?v=__APP_VERSION__"></script>`)
	got := string(renderIndexHTML(input))
	if strings.Contains(got, "__APP_VERSION__") {
		t.Fatalf("asset version placeholder was not replaced: %s", got)
	}
	if count := strings.Count(got, "v="+version); count != 2 {
		t.Fatalf("expected two versioned asset URLs, got %d in %s", count, got)
	}
}
func TestNormalizeTerminalWebSocketURL(t *testing.T) {
	tests := []struct {
		name    string
		input   string
		want    string
		wantErr bool
	}{
		{name: "disabled", input: "  ", want: ""},
		{name: "default term path", input: "wss://direct.example.com", want: "wss://direct.example.com/term"},
		{name: "custom path", input: "ws://127.0.0.1:8008/terminal", want: "ws://127.0.0.1:8008/terminal"},
		{name: "http rejected", input: "https://direct.example.com/term", wantErr: true},
		{name: "relative rejected", input: "/term", wantErr: true},
		{name: "credentials rejected", input: "wss://user:pass@direct.example.com/term", wantErr: true},
		{name: "query rejected", input: "wss://direct.example.com/term?token=secret", wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeTerminalWebSocketURL(test.input)
			if (err != nil) != test.wantErr {
				t.Fatalf("normalizeTerminalWebSocketURL(%q) error = %v, wantErr %v", test.input, err, test.wantErr)
			}
			if got != test.want {
				t.Fatalf("normalizeTerminalWebSocketURL(%q) = %q, want %q", test.input, got, test.want)
			}
		})
	}
}

func TestRenderIndexHTMLInjectsTerminalWebSocketURL(t *testing.T) {
	original := terminalWebSocketURL
	terminalWebSocketURL = "wss://direct.example.com/term"
	t.Cleanup(func() { terminalWebSocketURL = original })

	got := string(renderIndexHTML([]byte(`<script>window.ws = __TERMINAL_WEBSOCKET_URL__;</script>`)))
	if strings.Contains(got, "__TERMINAL_WEBSOCKET_URL__") {
		t.Fatalf("terminal WebSocket placeholder was not replaced: %s", got)
	}
	if !strings.Contains(got, `window.ws = "wss://direct.example.com/term";`) {
		t.Fatalf("terminal WebSocket URL was not JSON encoded into the page: %s", got)
	}
}
