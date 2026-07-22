package main

import (
	"crypto/sha256"
	"crypto/subtle"
	"embed"
	"flag"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
	"webssh/controller"

	"github.com/gin-contrib/gzip"
	"github.com/gin-gonic/gin"
)

//go:embed public/*
var f embed.FS

var (
	port       = flag.Int("p", 8008, "服务运行端口")
	v          = flag.Bool("v", false, "显示版本号")
	authInfo   = flag.String("a", "", "开启账号密码登录验证, '-a user:pass'的格式传参")
	timeout    int
	savePass   bool
	showFooter bool
	version    = controller.AppVersion
	username   string
	password   string
)

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

func main() {
	configureRuntime()
	gin.SetMode(gin.ReleaseMode)
	server := gin.New()
	server.Use(gin.Recovery())
	server.SetTrustedProxies(nil)
	server.Use(securityHeaders())
	server.Use(requestBodyLimit(4 << 20))
	server.Use(basicAuthMiddleware())
	server.Use(gzip.Gzip(gzip.DefaultCompression))

	if err := controller.InitAccountStore(""); err != nil {
		fmt.Println("账号数据库初始化失败:", err)
		os.Exit(1)
	}

	server.GET("/healthz", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"status": "ok"})
	})
	server.GET("/config", func(c *gin.Context) {
		c.JSON(200, gin.H{"showFooter": showFooter, "allowRegistration": controller.AllowRegistration()})
	})

	api := server.Group("/api")
	{
		api.GET("/auth/me", controller.AuthMe)
		api.POST("/auth/register", controller.AuthRegister)
		api.POST("/auth/login", controller.AuthLogin)
		api.POST("/auth/change-password", controller.AuthChangePassword)
		api.POST("/auth/logout", controller.AuthLogout)
		api.GET("/scripts", controller.GetScriptBookmarks)
		api.POST("/scripts/sync", controller.SyncScriptBookmarks)
		api.GET("/admin/accounts", controller.AdminListAccounts)
		api.POST("/admin/accounts", controller.AdminCreateAccount)
		api.PUT("/admin/accounts", controller.AdminUpdateAccount)
		api.DELETE("/admin/accounts/:username", controller.AdminDeleteAccount)
		api.GET("/admin/version", controller.AdminVersion)
		api.POST("/admin/update", controller.AdminUpdate)
		api.GET("/admin/update/status", controller.AdminUpdateStatus)
	}

	server.GET("/term", func(c *gin.Context) {
		controller.TermWs(c, time.Duration(timeout)*time.Minute)
	})
	server.POST("/check", func(c *gin.Context) {
		responseBody := controller.CheckSSH(c)
		responseBody.Data = map[string]interface{}{
			"savePass": savePass,
		}
		c.JSON(200, responseBody)
	})
	server.POST("/sysinfo", func(c *gin.Context) {
		c.JSON(200, controller.SysInfo(c))
	})
	server.GET("/sysinfo/net", func(c *gin.Context) {
		controller.SysInfoNetWs(c)
	})
	file := server.Group("/file")
	{
		file.POST("/list", func(c *gin.Context) {
			c.JSON(200, controller.FileList(c))
		})
		file.POST("/download", func(c *gin.Context) {
			controller.DownloadFile(c)
		})
		file.POST("/upload", func(c *gin.Context) {
			c.JSON(200, controller.UploadFile(c))
		})
		file.POST("/remote", func(c *gin.Context) {
			c.JSON(200, controller.RemoteDownloadFile(c))
		})
		file.GET("/progress", func(c *gin.Context) {
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
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})

	fmt.Printf("🚀 WebSSH server starting on port %d\n", *port)
	fmt.Printf("🌐 Open http://localhost:%d in your browser\n", *port)
	httpServer := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           server,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       120 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Println("WebSSH server stopped:", err)
		os.Exit(1)
	}
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
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, limit)
		}
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
			c.Header("WWW-Authenticate", "Basic realm=\"Restricted\"")
			c.AbortWithStatus(http.StatusUnauthorized)
			return
		}
		c.Next()
	}
}
