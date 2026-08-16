package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var websocketWriteBufferPool sync.Pool

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4 << 10,
	WriteBufferSize: 32 << 10,
	WriteBufferPool: &websocketWriteBufferPool,
	CheckOrigin: func(r *http.Request) bool {
		return websocketOriginAllowed(r)
	},
}

const (
	websocketInitLimit          = 128 << 10
	websocketTerminalInputLimit = 4 << 20
	websocketInitTimeout        = 15 * time.Second
)

const trustScopeCookieName = "webssh_trust_scope"
const trustScopeContextKey = "webssh.trustScope"

type sshInfoRequest struct {
	SSHInfo string `json:"sshInfo" binding:"required"`
}

func websocketOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, ok := parseHTTPOrigin(origin)
	if !ok {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) && strings.EqualFold(u.Scheme, requestExternalScheme(r)) {
		return true
	}
	return configuredOriginAllowed(u)
}

func parseHTTPOrigin(raw string) (*url.URL, bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return nil, false
	}
	return u, true
}

func normalizedOrigin(u *url.URL) string {
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func configuredOriginAllowed(origin *url.URL) bool {
	want := normalizedOrigin(origin)
	for _, rawAllowed := range strings.Split(os.Getenv("WEBSSH_ALLOWED_ORIGINS"), ",") {
		allowed, ok := parseHTTPOrigin(rawAllowed)
		if ok && normalizedOrigin(allowed) == want {
			return true
		}
	}
	return false
}

func requestExternalScheme(r *http.Request) string {
	if r.TLS != nil {
		return "https"
	}
	if forwarded := strings.ToLower(strings.TrimSpace(strings.Split(r.Header.Get("X-Forwarded-Proto"), ",")[0])); forwarded == "http" || forwarded == "https" {
		return forwarded
	}
	if r.URL != nil && (r.URL.Scheme == "http" || r.URL.Scheme == "https") {
		return r.URL.Scheme
	}
	return "http"
}

func sameOriginValueAllowed(r *http.Request, raw string) bool {
	origin, ok := parseHTTPOrigin(raw)
	if !ok {
		return false
	}
	if strings.EqualFold(origin.Host, r.Host) && strings.EqualFold(origin.Scheme, requestExternalScheme(r)) {
		return true
	}
	return configuredOriginAllowed(origin)
}

func stateChangingOriginAllowed(r *http.Request) bool {
	if origin := strings.TrimSpace(r.Header.Get("Origin")); origin != "" {
		return sameOriginValueAllowed(r, origin)
	}
	if referer := strings.TrimSpace(r.Header.Get("Referer")); referer != "" {
		return sameOriginValueAllowed(r, referer)
	}
	// Keep non-browser/API clients compatible when they send neither header,
	// while still rejecting browser requests that explicitly identify a
	// cross-origin or same-site (different origin) initiator.
	switch strings.ToLower(strings.TrimSpace(r.Header.Get("Sec-Fetch-Site"))) {
	case "cross-site", "same-site":
		return false
	default:
		return true
	}
}

func SameOriginOnly() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !stateChangingOriginAllowed(c.Request) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"ok": false, "msg": "请求来源不受信任"})
			return
		}
		c.Next()
	}
}

func bindStrictJSON(c *gin.Context, target any) error {
	contentType, _, err := mime.ParseMediaType(c.GetHeader("Content-Type"))
	if err != nil || !strings.EqualFold(contentType, "application/json") {
		return fmt.Errorf("content type must be application/json")
	}
	readTimer := time.AfterFunc(30*time.Second, func() { _ = c.Request.Body.Close() })
	defer readTimer.Stop()
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func bindSSHInfoJSON(c *gin.Context) (string, error) {
	var request sshInfoRequest
	if err := bindStrictJSON(c, &request); err != nil {
		return "", fmt.Errorf("invalid request: %w", err)
	}
	if strings.TrimSpace(request.SSHInfo) == "" {
		return "", fmt.Errorf("missing sshInfo")
	}
	return request.SSHInfo, nil
}

func newTrustScope() (string, error) {
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return "", err
	}
	return hex.EncodeToString(random), nil
}

func requestTrustScope(c *gin.Context) (string, error) {
	if value, exists := c.Get(trustScopeContextKey); exists {
		if normalized, err := core.NormalizeTrustScope(fmt.Sprint(value)); err == nil {
			return normalized, nil
		}
	}
	if value, err := c.Cookie(trustScopeCookieName); err == nil {
		if normalized, normalizeErr := core.NormalizeTrustScope(value); normalizeErr == nil {
			return normalized, nil
		}
	}
	return newTrustScope()
}

func EnsureTrustScopeCookie() gin.HandlerFunc {
	return func(c *gin.Context) {
		if value, err := c.Cookie(trustScopeCookieName); err == nil {
			if normalized, normalizeErr := core.NormalizeTrustScope(value); normalizeErr == nil {
				c.Set(trustScopeContextKey, normalized)
				c.Next()
				return
			}
		}
		scope, err := newTrustScope()
		if err == nil {
			c.Set(trustScopeContextKey, scope)
			http.SetCookie(c.Writer, &http.Cookie{Name: trustScopeCookieName, Value: scope, Path: "/", MaxAge: 365 * 24 * 60 * 60, HttpOnly: true, Secure: requestExternalScheme(c.Request) == "https", SameSite: http.SameSiteStrictMode})
		}
		c.Next()
	}
}

func decodeSSHClient(c *gin.Context, sshInfo string) (core.SSHClient, error) {
	client, err := core.DecodedMsgToSSHClient(sshInfo)
	if err != nil {
		return client, err
	}
	if strings.TrimSpace(client.TrustScope) == "" {
		client.TrustScope, err = requestTrustScope(c)
		if err != nil {
			return client, fmt.Errorf("create SSH trust scope: %w", err)
		}
	} else {
		client.TrustScope, err = core.NormalizeTrustScope(client.TrustScope)
		if err != nil {
			return client, err
		}
	}
	return client, nil
}

func closeSSHOnContextDone(ctx context.Context, client *core.SSHClient) func() {
	if ctx == nil || client == nil {
		return func() {}
	}
	stop := context.AfterFunc(ctx, client.Close)
	return func() { stop() }
}

type ResponseBody struct {
	Duration string
	Data     interface{}
	Msg      string
}

func ResponseHTTPStatus(body *ResponseBody) int {
	if body == nil || strings.EqualFold(strings.TrimSpace(body.Msg), "success") {
		return http.StatusOK
	}
	message := strings.ToLower(strings.TrimSpace(body.Msg))
	switch {
	case strings.Contains(message, "shutting down"):
		return http.StatusServiceUnavailable
	case strings.Contains(message, "too many"), strings.Contains(message, "任务过多"):
		return http.StatusTooManyRequests
	case strings.Contains(message, "permission denied"), strings.Contains(message, "没有权限"), strings.Contains(message, "forbidden"):
		return http.StatusForbidden
	case strings.Contains(message, "not found"), strings.Contains(message, "does not exist"), strings.Contains(message, "no such file"):
		return http.StatusNotFound
	case strings.Contains(message, "too large"), strings.Contains(message, "exceeds"), strings.Contains(message, "more than"), strings.Contains(message, "超过"):
		return http.StatusRequestEntityTooLarge
	case strings.Contains(message, "changed"), strings.Contains(message, "already exists"), strings.Contains(message, "conflict"), strings.Contains(message, "已存在"):
		return http.StatusConflict
	case strings.Contains(message, "timeout"), strings.Contains(message, "deadline exceeded"):
		return http.StatusRequestTimeout
	case strings.Contains(message, "failed to connect"), strings.Contains(message, "connection refused"), strings.Contains(message, "network is unreachable"), strings.Contains(message, "no route to host"), strings.Contains(message, "handshake failed"), strings.Contains(message, "remote server returned"):
		return http.StatusBadGateway
	case strings.Contains(message, "missing"), strings.Contains(message, "invalid"), strings.Contains(message, "unknown"), strings.Contains(message, "duplicate"), strings.Contains(message, "unsupported"), strings.Contains(message, "only "), strings.Contains(message, "cannot "), strings.Contains(message, "must "), strings.Contains(message, "不支持"):
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

func TimeCost(start time.Time, body *ResponseBody) {
	body.Duration = time.Since(start).String()
}

func CheckSSH(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	sshInfo, err := bindSSHInfoJSON(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	sshClient, err := decodeSSHClient(c, sshInfo)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	err = sshClient.GenerateClient()
	defer sshClient.Close()
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
	}
	return &responseBody
}
