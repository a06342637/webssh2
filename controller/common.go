package controller

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return websocketOriginAllowed(r)
	},
}

const (
	websocketInitLimit   = 128 << 10
	websocketInitTimeout = 15 * time.Second
)

type sshInfoRequest struct {
	SSHInfo string `json:"sshInfo" binding:"required"`
}

func websocketOriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return false
	}
	if strings.EqualFold(u.Host, r.Host) {
		return true
	}
	for _, allowed := range strings.Split(os.Getenv("WEBSSH_ALLOWED_ORIGINS"), ",") {
		allowed = strings.TrimSpace(strings.TrimRight(allowed, "/"))
		if allowed != "" && strings.EqualFold(allowed, strings.TrimRight(origin, "/")) {
			return true
		}
	}
	return false
}

func bindSSHInfoJSON(c *gin.Context) (string, error) {
	var request sshInfoRequest
	decoder := json.NewDecoder(c.Request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return "", fmt.Errorf("invalid request: %w", err)
	}
	if strings.TrimSpace(request.SSHInfo) == "" {
		return "", fmt.Errorf("missing sshInfo")
	}
	return request.SSHInfo, nil
}

type ResponseBody struct {
	Duration string
	Data     interface{}
	Msg      string
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
	sshClient, err := core.DecodedMsgToSSHClient(sshInfo)
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
