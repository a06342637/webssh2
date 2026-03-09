package controller

import (
	"fmt"
	"strconv"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func TermWs(c *gin.Context, timeout time.Duration) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)

	cols := c.DefaultQuery("cols", "150")
	rows := c.DefaultQuery("rows", "35")
	closeTip := c.DefaultQuery("closeTip", "Connection timed out!")
	col, _ := strconv.Atoi(cols)
	row, _ := strconv.Atoi(rows)

	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Println("ws upgrade error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}

	_, initMsg, err := wsConn.ReadMessage()
	if err != nil {
		fmt.Println("read init message error:", err)
		wsConn.Close()
		responseBody.Msg = err.Error()
		return &responseBody
	}

	sshInfo := string(initMsg)
	sshClient, err := core.DecodedMsgToSSHClient(sshInfo)
	if err != nil {
		wsConn.WriteMessage(1, []byte("\033[31mSSH info parse error: "+err.Error()+"\033[0m"))
		wsConn.Close()
		fmt.Println("parse sshInfo error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}

	err = sshClient.GenerateClient()
	if err != nil {
		wsConn.WriteMessage(1, []byte("\033[31m"+err.Error()+"\033[0m"))
		wsConn.Close()
		fmt.Println("ssh connect error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}

	sshClient.InitTerminal(wsConn, row, col)
	sshClient.Connect(wsConn, timeout, closeTip)
	return &responseBody
}
