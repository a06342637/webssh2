package controller

import (
	"fmt"
	"net/http"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
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
	sshInfo := c.DefaultQuery("sshInfo", "")
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
