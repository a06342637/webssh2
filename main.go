package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
	"webssh/controller"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

//go:embed public/*
var f embed.FS

// 根目录的 VERSION 是版本号的唯一来源，编译期嵌入。
// 文件缺失会直接编译失败，所以运行时这里一定有值。
//
//go:embed VERSION
var versionFile string

var (
	port                 = flag.Int("p", 8008, "服务运行端口")
	v                    = flag.Bool("v", false, "显示版本号")
	authInfo             = flag.String("a", "", "开启账号密码登录验证, '-a user:pass'的格式传参")
	timeout              int
	savePass             bool
	showFooter           bool
	version              = resolveAppVersion()
	username             string
	password             string
	terminalWebSocketURL string
)

// resolveAppVersion 把嵌入的版本号同步给 controller 包，
// 让页面展示、静态资源版本参数和更新检查用的始终是同一个值。
func resolveAppVersion() string {
	parsed := strings.TrimSpace(versionFile)
	if parsed == "" {
		return controller.AppVersion
	}
	controller.AppVersion = parsed
	return parsed
}

func init() {
	flag.IntVar(&timeout, "t", 120, "ssh连接超时时间(min)")
	flag.BoolVar(&savePass, "s", true, "保存ssh密码")
	showFooter = true
	if envVal, ok := os.LookupEnv("savePass"); ok {
		if b, err := strconv.ParseBool(envVal); err == nil {
			savePass = b
		}
	}
	if envVal, ok := os.LookupEnv("SAVE_PASS"); ok {
		if b, err := strconv.ParseBool(envVal); err == nil {
			savePass = b
		}
	}
	if envVal, ok := os.LookupEnv("showFooter"); ok {
		if b, err := strconv.ParseBool(envVal); err == nil {
			showFooter = b
		}
	}
	if envVal, ok := os.LookupEnv("SHOW_FOOTER"); ok {
		if b, err := strconv.ParseBool(envVal); err == nil {
			showFooter = b
		}
	}
	if envVal, ok := os.LookupEnv("authInfo"); ok {
		*authInfo = envVal
	}
	if envVal, ok := os.LookupEnv("AUTH_INFO"); ok && *authInfo == "" {
		*authInfo = envVal
	}
	if envVal, ok := os.LookupEnv("PORT"); ok {
		if b, err := strconv.Atoi(envVal); err == nil {
			*port = b
		}
	} else if envVal, ok := os.LookupEnv("port"); ok {
		if b, err := strconv.Atoi(envVal); err == nil {
			*port = b
		}
	}
	if envVal, ok := os.LookupEnv("WEBSSH_TERMINAL_WS_URL"); ok {
		normalized, err := normalizeTerminalWebSocketURL(envVal)
		if err != nil {
			fmt.Printf("Warning: ignoring invalid WEBSSH_TERMINAL_WS_URL: %v\n", err)
		} else {
			terminalWebSocketURL = normalized
		}
	}
}

func configureRuntime() {
	flag.Parse()
	if *v {
		fmt.Printf("Version: %s\n", version)
		os.Exit(0)
	}
	if *authInfo != "" {
		accountUsername, accountPassword, ok := strings.Cut(*authInfo, ":")
		if !ok || accountUsername == "" || accountPassword == "" {
			fmt.Println("请按'user:pass'的格式来传参或设置环境变量, 且账号密码都不能为空!")
			os.Exit(0)
		}
		username, password = accountUsername, accountPassword
	}
}

func normalizeTerminalWebSocketURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return "", fmt.Errorf("parse URL: %w", err)
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if (parsed.Scheme != "ws" && parsed.Scheme != "wss") || parsed.Host == "" {
		return "", fmt.Errorf("must be an absolute ws:// or wss:// URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("userinfo, query and fragment are not allowed")
	}
	if parsed.Path == "" || parsed.Path == "/" {
		parsed.Path = "/term"
	}
	return parsed.String(), nil
}

func renderIndexHTML(indexHTML []byte) []byte {
	rendered := strings.ReplaceAll(string(indexHTML), "__APP_VERSION__", version)
	encodedURL, _ := json.Marshal(terminalWebSocketURL)
	rendered = strings.ReplaceAll(rendered, "__TERMINAL_WEBSOCKET_URL__", string(encodedURL))
	rendered = strings.ReplaceAll(rendered, "__TERMINAL_PRECONNECT__", terminalPreconnectHTML())
	return []byte(rendered)
}

// terminalPreconnectHTML emits an early connection hint for the optional
// direct terminal endpoint. It only warms the browser connection; the actual
// WebSocket is still opened by app.js after the user starts a session.
func terminalPreconnectHTML() string {
	if terminalWebSocketURL == "" {
		return ""
	}
	parsed, err := url.Parse(terminalWebSocketURL)
	if err != nil || parsed.Host == "" {
		return ""
	}
	scheme := "https"
	if parsed.Scheme == "ws" {
		scheme = "http"
	}
	origin := (&url.URL{Scheme: scheme, Host: parsed.Host}).String()
	return fmt.Sprintf(
		`<link rel="dns-prefetch" href="//%s"><link rel="preconnect" href="%s" crossorigin>`,
		html.EscapeString(parsed.Host),
		html.EscapeString(origin),
	)
}

func runtimeConfig() gin.H {
	return gin.H{
		"appVersion":            version,
		"showFooter":            showFooter,
		"allowRegistration":     controller.AllowRegistration(),
		"savePass":              savePass,
		"requireAccount":        controller.RequireAccount(),
		"allowLegacyPathLogin":  envBool("WEBSSH_ALLOW_LEGACY_PATH_LOGIN", false),
		"remoteEditorMaxBytes":  controller.RemoteEditorMaxBytes(),
		"remotePreviewMaxBytes": controller.RemotePreviewMaxBytes(),
	}
}

func envBool(name string, fallback bool) bool {
	value, ok := os.LookupEnv(name)
	if !ok {
		return fallback
	}
	parsed, err := strconv.ParseBool(strings.TrimSpace(value))
	if err != nil {
		return fallback
	}
	return parsed
}

func main() {
	configureRuntime()
	gin.SetMode(gin.ReleaseMode)
	server := gin.New()
	server.Use(gin.Recovery())
	server.SetTrustedProxies(nil)
	server.Use(securityHeaders())
	server.Use(controller.EnsureTrustScopeCookie())
	server.Use(requestBodyLimit(4 << 20))
	server.Use(basicAuthMiddleware())
	server.Use(compressionMiddleware())

	if err := controller.InitAccountStore(""); err != nil {
		fmt.Println("账号数据库初始化失败:", err)
		os.Exit(1)
	}

	server.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	server.GET("/config", noStoreResponses(), func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("Pragma", "no-cache")
		c.JSON(http.StatusOK, runtimeConfig())
	})
	gatewayAuth := controller.GatewayAuth()

	api := server.Group("/api")
	api.Use(noStoreResponses())
	{
		api.GET("/auth/me", controller.AuthMe)
		api.GET("/scripts", controller.GetScriptBookmarks)
		api.GET("/admin/accounts", controller.AdminListAccounts)
		api.GET("/admin/bookmarks/backup", controller.AdminExportScriptBookmarks)
		api.GET("/admin/version", controller.AdminVersion)
		api.GET("/admin/update/status", controller.AdminUpdateStatus)
		// 分享链接的接收方通常没有本站账号，所以读取刻意不要求登录。
		// 拿到的只是密文，解密密钥在链接的 # 之后，从不到达服务端。
		api.GET("/share/:token", controller.GetShare)

		accountWrites := api.Group("")
		accountWrites.Use(controller.SameOriginOnly())
		accountWrites.POST("/auth/register", controller.AuthRegister)
		accountWrites.POST("/auth/login", controller.AuthLogin)
		accountWrites.POST("/auth/change-password", controller.AuthChangePassword)
		accountWrites.POST("/auth/logout", controller.AuthLogout)
		accountWrites.POST("/scripts/sync", controller.SyncScriptBookmarks)
		accountWrites.POST("/share", controller.CreateShare)
		accountWrites.POST("/admin/accounts", controller.AdminCreateAccount)
		accountWrites.PUT("/admin/accounts", controller.AdminUpdateAccount)
		accountWrites.DELETE("/admin/accounts/:username", controller.AdminDeleteAccount)
		accountWrites.POST("/admin/bookmarks/restore", controller.AdminRestoreScriptBookmarks)
		accountWrites.POST("/admin/update", controller.AdminUpdate)
	}

	server.GET("/term", func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		controller.TermWs(c, time.Duration(timeout)*time.Minute)
	})
	// RDP 网关。/rdp/session 发放短期无状态凭证，/rdp 才是 IronRDP WASM
	// 客户端连过来的 RDCleanPath 通道。
	server.POST("/rdp/session", controller.SameOriginOnly(), noStoreResponses(), func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		responseBody := controller.CreateRDPSession(c)
		if !c.IsAborted() {
			c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
		}
	})
	server.GET("/rdp", func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		controller.RdpWs(c)
	})
	server.POST("/check", controller.SameOriginOnly(), func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		responseBody := controller.CheckSSH(c)
		if c.IsAborted() {
			return
		}
		responseBody.Data = map[string]interface{}{
			"savePass": savePass,
		}
		c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
	})
	server.POST("/sysinfo", controller.SameOriginOnly(), func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		responseBody := controller.SysInfo(c)
		if !c.IsAborted() {
			c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
		}
	})
	server.GET("/sysinfo/net", func(c *gin.Context) {
		if !gatewayAuth(c) {
			return
		}
		controller.SysInfoNetWs(c)
	})
	file := server.Group("/file")
	file.Use(controller.SameOriginOnly())
	{
		file.POST("/list", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.FileList(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/session/close", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.CloseSFTPSession(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/download", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.DownloadFile(c)
		})
		file.POST("/preview", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.PreviewFile(c)
		})
		file.POST("/preview/authorize", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.AuthorizeFilePreview(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/preview/revoke", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.RevokeFilePreview(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.GET("/preview/stream", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.PreviewFileStream(c)
		})
		file.POST("/archive/prepare", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.PrepareDirectoryArchive(c)
		})
		file.POST("/archive/status", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.DirectoryArchiveStatus(c)
		})
		file.POST("/archive/cancel", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.CancelDirectoryArchive(c)
		})
		file.POST("/archive/download", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.DownloadPreparedDirectoryArchive(c)
		})
		file.POST("/edit/open", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			c.Header("Cache-Control", "no-store")
			responseBody := controller.OpenFileForEdit(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/edit/save", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			c.Header("Cache-Control", "no-store")
			responseBody := controller.SaveEditedFile(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/delete", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			c.Header("Cache-Control", "no-store")
			responseBody := controller.DeleteFile(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/rename", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			c.Header("Cache-Control", "no-store")
			responseBody := controller.RenameFile(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/upload", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.UploadFile(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.POST("/remote", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			responseBody := controller.RemoteDownloadFile(c)
			if !c.IsAborted() {
				c.JSON(controller.ResponseHTTPStatus(responseBody), responseBody)
			}
		})
		file.GET("/progress", func(c *gin.Context) {
			if !gatewayAuth(c) {
				return
			}
			controller.UploadProgressWs(c)
		})
	}

	staticFS, _ := fs.Sub(f, "public/static")
	server.StaticFS("/static", http.FS(staticFS))

	server.NoRoute(func(c *gin.Context) {
		indexHTML, err := f.ReadFile("public/index.html")
		if err != nil {
			c.String(http.StatusInternalServerError, "index.html not found")
			return
		}
		c.Header("Cache-Control", "no-cache, no-store, must-revalidate")
		c.Header("Pragma", "no-cache")
		c.Header("Expires", "0")
		c.Data(http.StatusOK, "text/html; charset=utf-8", renderIndexHTML(indexHTML))
	})

	fmt.Printf("🚀 WebSSH server starting on port %d\n", *port)
	fmt.Printf("🌐 Open http://localhost:%d in your browser\n", *port)
	runtimeCtx, cancelRuntime := context.WithCancel(context.Background())
	defer cancelRuntime()
	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           server,
		BaseContext:       func(net.Listener) context.Context { return runtimeCtx },
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.ListenAndServe() }()
	signalCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()
	select {
	case err := <-serveErr:
		if err != nil && err != http.ErrServerClosed {
			fmt.Println("WebSSH server stopped:", err)
			os.Exit(1)
		}
		return
	case <-signalCtx.Done():
		fmt.Println("WebSSH server is shutting down...")
	}

	controller.BeginRuntimeShutdown()
	// Shutdown does not cancel active request contexts by itself. Cancel the
	// server base context first so blocked SFTP/HTTP operations close their SSH
	// transports and release pooled-session locks before the grace period ends.
	cancelRuntime()
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelShutdown()
	backgroundDone := make(chan struct{})
	go func() {
		controller.ShutdownBackgroundTasks(shutdownCtx)
		close(backgroundDone)
	}()
	if err := httpServer.Shutdown(shutdownCtx); err != nil {
		fmt.Println("WebSSH graceful shutdown timed out:", err)
		_ = httpServer.Close()
	}
	select {
	case <-backgroundDone:
	case <-shutdownCtx.Done():
	}
}

func compressionMiddleware() gin.HandlerFunc {
	// SFTP downloads are already an arbitrary byte stream. Compressing them
	// changes/removes Content-Length and makes the hidden POST target own an
	// extra streaming layer, which can turn interrupted downloads into empty or
	// corrupt files. Keep normal pages/API responses compressed, but pass the
	// attachment response through unchanged.
	return gzip.Gzip(gzip.DefaultCompression, gzip.WithExcludedPaths([]string{"/file/download", "/file/archive/download", "/file/preview", "/file/preview/stream"}))
}

func securityHeaders() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("X-Content-Type-Options", "nosniff")
		c.Header("X-Frame-Options", "SAMEORIGIN")
		c.Header("Referrer-Policy", "no-referrer")
		c.Header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		c.Next()
	}
}

func requestBodyLimit(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.Body != nil && c.Request.URL.Path != "/file/upload" {
			requestLimit := limit
			if c.Request.URL.Path == "/api/scripts/sync" {
				requestLimit = 16 << 20
			} else if c.Request.URL.Path == "/api/admin/bookmarks/restore" {
				requestLimit = controller.SiteScriptBackupRequestBodyLimit()
			} else if c.Request.URL.Path == "/file/edit/save" {
				requestLimit = controller.RemoteEditorRequestBodyLimit()
			}
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, requestLimit)
		}
		c.Next()
	}
}

func noStoreResponses() gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Cache-Control", "no-store")
		c.Header("Pragma", "no-cache")
		c.Next()
	}
}

func basicAuthMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		if *authInfo == "" || c.Request.URL.Path == "/healthz" {
			c.Next()
			return
		}
		user, pass, ok := c.Request.BasicAuth()
		userHash := sha256.Sum256([]byte(user))
		expectedUserHash := sha256.Sum256([]byte(username))
		passHash := sha256.Sum256([]byte(pass))
		expectedPassHash := sha256.Sum256([]byte(password))
		userOK := subtle.ConstantTimeCompare(userHash[:], expectedUserHash[:]) == 1
		passOK := subtle.ConstantTimeCompare(passHash[:], expectedPassHash[:]) == 1
		if !ok || !userOK || !passOK {
			if !controller.AllowBasicAuthAttempt(c) {
				return
			}
			c.Header("WWW-Authenticate", "Basic realm=\"Restricted\"")
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		controller.MarkBasicAuthAuthenticated(c)
		c.Next()
	}
}
