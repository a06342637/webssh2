package main

import (
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
	port     = flag.Int("p", 8888, "服务运行端口")
	v        = flag.Bool("v", false, "显示版本号")
	authInfo = flag.String("a", "", "开启账号密码登录验证, '-a user:pass'的格式传参")
	timeout  int
	savePass bool
	version  = "1.0.0"
	username string
	password string
)

func init() {
	flag.IntVar(&timeout, "t", 120, "ssh连接超时时间(min)")
	flag.BoolVar(&savePass, "s", true, "保存ssh密码")
	if envVal, ok := os.LookupEnv("savePass"); ok {
		if b, err := strconv.ParseBool(envVal); err == nil {
			savePass = b
		}
	}
	if envVal, ok := os.LookupEnv("authInfo"); ok {
		*authInfo = envVal
	}
	if envVal, ok := os.LookupEnv("port"); ok {
		if b, err := strconv.Atoi(envVal); err == nil {
			*port = b
		}
	}
	flag.Parse()
	if *v {
		fmt.Printf("Version: %s\n", version)
		os.Exit(0)
	}
	if *authInfo != "" {
		accountInfo := strings.Split(*authInfo, ":")
		if len(accountInfo) != 2 || accountInfo[0] == "" || accountInfo[1] == "" {
			fmt.Println("请按'user:pass'的格式来传参或设置环境变量, 且账号密码都不能为空!")
			os.Exit(0)
		}
		username, password = accountInfo[0], accountInfo[1]
	}
}

func main() {
	gin.SetMode(gin.ReleaseMode)
	server := gin.New()
	server.Use(gin.Recovery())
	server.SetTrustedProxies(nil)
	server.Use(gzip.Gzip(gzip.DefaultCompression))

	server.GET("/term", func(c *gin.Context) {
		controller.TermWs(c, time.Duration(timeout)*time.Minute)
	})
	server.GET("/check", func(c *gin.Context) {
		responseBody := controller.CheckSSH(c)
		responseBody.Data = map[string]interface{}{
			"savePass": savePass,
		}
		c.JSON(200, responseBody)
	})
	file := server.Group("/file")
	{
		file.GET("/list", func(c *gin.Context) {
			c.JSON(200, controller.FileList(c))
		})
		file.GET("/download", func(c *gin.Context) {
			controller.DownloadFile(c)
		})
		file.POST("/upload", func(c *gin.Context) {
			c.JSON(200, controller.UploadFile(c))
		})
		file.GET("/progress", func(c *gin.Context) {
			controller.UploadProgressWs(c)
		})
	}

	staticFS, _ := fs.Sub(f, "public/static")
	server.StaticFS("/static", http.FS(staticFS))

	server.NoRoute(func(c *gin.Context) {
		if *authInfo != "" {
			user, pass, hasAuth := c.Request.BasicAuth()
			if !hasAuth || user != username || pass != password {
				c.Header("WWW-Authenticate", `Basic realm="Restricted"`)
				c.AbortWithStatus(http.StatusUnauthorized)
				return
			}
		}
		indexHTML, err := f.ReadFile("public/index.html")
		if err != nil {
			c.String(http.StatusInternalServerError, "index.html not found")
			return
		}
		c.Data(http.StatusOK, "text/html; charset=utf-8", indexHTML)
	})

	fmt.Printf("🚀 WebSSH server starting on port %d\n", *port)
	fmt.Printf("🌐 Open http://localhost:%d in your browser\n", *port)
	server.Run(fmt.Sprintf(":%d", *port))
}
