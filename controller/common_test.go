package controller

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func TestWebsocketOriginAllowed(t *testing.T) {
	t.Setenv("WEBSSH_ALLOWED_ORIGINS", "https://allowed.example, http://dev.example:8080/")
	tests := []struct {
		name   string
		host   string
		origin string
		xfp    string
		want   bool
	}{
		{name: "no origin non-browser client", host: "webssh.example", want: true},
		{name: "same host HTTPS", host: "webssh.example", origin: "https://webssh.example", xfp: "https", want: true},
		{name: "same host scheme mismatch", host: "webssh.example", origin: "https://webssh.example", want: false},
		{name: "same host with port", host: "webssh.example:8008", origin: "http://webssh.example:8008", want: true},
		{name: "configured origin", host: "webssh.example", origin: "https://allowed.example", want: true},
		{name: "configured origin trailing slash", host: "webssh.example", origin: "http://dev.example:8080", want: true},
		{name: "foreign origin", host: "webssh.example", origin: "https://evil.example", want: false},
		{name: "invalid origin", host: "webssh.example", origin: "not a url", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://"+test.host+"/term", nil)
			req.Host = test.host
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			if test.xfp != "" {
				req.Header.Set("X-Forwarded-Proto", test.xfp)
			}
			if got := websocketOriginAllowed(req); got != test.want {
				t.Fatalf("websocketOriginAllowed() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestBindStrictJSON(t *testing.T) {
	gin.SetMode(gin.TestMode)
	tests := []struct {
		name        string
		contentType string
		body        string
		wantErr     bool
	}{
		{name: "valid", contentType: "application/json; charset=utf-8", body: `{"value":"ok"}`},
		{name: "plain text rejected", contentType: "text/plain", body: `{"value":"ok"}`, wantErr: true},
		{name: "unknown field rejected", contentType: "application/json", body: `{"value":"ok","extra":true}`, wantErr: true},
		{name: "trailing JSON rejected", contentType: "application/json", body: `{"value":"ok"} {}`, wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			ctx, _ := gin.CreateTestContext(recorder)
			ctx.Request = httptest.NewRequest(http.MethodPost, "/test", strings.NewReader(test.body))
			ctx.Request.Header.Set("Content-Type", test.contentType)
			var target struct {
				Value string `json:"value"`
			}
			err := bindStrictJSON(ctx, &target)
			if (err != nil) != test.wantErr {
				t.Fatalf("bindStrictJSON() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestEnsureTrustScopeCookieCreatesAndReusesScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.Use(EnsureTrustScopeCookie())
	seenScope := ""
	router.GET("/config", func(c *gin.Context) {
		seenScope, _ = requestTrustScope(c)
		c.Status(http.StatusNoContent)
	})

	first := httptest.NewRecorder()
	router.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "https://webssh.example/config", nil))
	response := first.Result()
	cookies := response.Cookies()
	if len(cookies) != 1 || cookies[0].Name != trustScopeCookieName || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("unexpected trust scope cookie: %#v", cookies)
	}
	if _, err := core.NormalizeTrustScope(cookies[0].Value); err != nil {
		t.Fatalf("invalid generated trust scope: %v", err)
	}
	if seenScope != cookies[0].Value {
		t.Fatalf("handler scope %q differs from response cookie %q", seenScope, cookies[0].Value)
	}

	secondRequest := httptest.NewRequest(http.MethodGet, "https://webssh.example/config", nil)
	secondRequest.AddCookie(cookies[0])
	second := httptest.NewRecorder()
	router.ServeHTTP(second, secondRequest)
	if got := second.Header().Values("Set-Cookie"); len(got) != 0 {
		t.Fatalf("valid trust scope cookie was unnecessarily replaced: %v", got)
	}
}

func TestStateChangingOriginAllowed(t *testing.T) {
	t.Setenv("WEBSSH_ALLOWED_ORIGINS", "https://trusted-admin.example")
	tests := []struct {
		name    string
		origin  string
		referer string
		fetch   string
		xfp     string
		want    bool
	}{
		{name: "same origin", origin: "https://webssh.example", xfp: "https", want: true},
		{name: "same origin referer", referer: "https://webssh.example/settings", xfp: "https", want: true},
		{name: "trusted configured origin", origin: "https://trusted-admin.example", xfp: "https", want: true},
		{name: "foreign origin", origin: "https://evil.example", xfp: "https", want: false},
		{name: "scheme mismatch", origin: "http://webssh.example", xfp: "https", want: false},
		{name: "cross site fetch metadata", fetch: "cross-site", xfp: "https", want: false},
		{name: "same site different origin metadata", fetch: "same-site", xfp: "https", want: false},
		{name: "non browser client", xfp: "https", want: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://webssh.example/api/admin/update", nil)
			req.Host = "webssh.example"
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			if test.referer != "" {
				req.Header.Set("Referer", test.referer)
			}
			if test.fetch != "" {
				req.Header.Set("Sec-Fetch-Site", test.fetch)
			}
			if test.xfp != "" {
				req.Header.Set("X-Forwarded-Proto", test.xfp)
			}
			if got := stateChangingOriginAllowed(req); got != test.want {
				t.Fatalf("stateChangingOriginAllowed() = %v, want %v", got, test.want)
			}
		})
	}
}
