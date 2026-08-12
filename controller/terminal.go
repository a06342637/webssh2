package controller

import (
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

const terminalControlPrefix = "__WEBSSH_CONTROL__:"

// clampTermSize 把查询参数里的终端行列数转成合法值，非法或越界时用 fallback。
func clampTermSize(raw string, fallback int) int {
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 || n > 1000 {
		return fallback
	}
	return n
}

type terminalHostKeyMismatchMessage struct {
	Type      string             `json:"type"`
	Host      string             `json:"host"`
	Port      int                `json:"port"`
	Presented core.HostKeyInfo   `json:"presented"`
	Expected  []core.HostKeyInfo `json:"expected"`
	Reason    string             `json:"reason,omitempty"`
}

type terminalControlMessage struct {
	Type string `json:"type"`
}

func writeTerminalControlMessage(sshClient *core.SSHClient, wsConn interface {
	WriteMessage(messageType int, data []byte) error
}, messageType string) error {
	payload, err := json.Marshal(terminalControlMessage{Type: messageType})
	if err != nil {
		return err
	}
	if clientWS, ok := wsConn.(*websocket.Conn); ok {
		return sshClient.WriteWebSocketMessage(clientWS, websocket.TextMessage, append([]byte(terminalControlPrefix), payload...))
	}
	return wsConn.WriteMessage(websocket.TextMessage, append([]byte(terminalControlPrefix), payload...))
}

func writeHostKeyMismatchMessage(wsConn interface {
	WriteMessage(messageType int, data []byte) error
}, sshClient core.SSHClient, mismatch *core.HostKeyMismatchError) error {
	payload, err := json.Marshal(terminalHostKeyMismatchMessage{
		Type:      "host-key-mismatch",
		Host:      sshClient.Hostname,
		Port:      sshClient.Port,
		Presented: mismatch.Presented,
		Expected:  mismatch.Expected,
		Reason:    mismatch.Reason,
	})
	if err != nil {
		return err
	}
	return wsConn.WriteMessage(1, append([]byte(terminalControlPrefix), payload...))
}

func TermWs(c *gin.Context, timeout time.Duration) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()

	cols := c.DefaultQuery("cols", "150")
	rows := c.DefaultQuery("rows", "35")
	closeTip := c.DefaultQuery("closeTip", "Connection timed out!")
	// 解析失败或越界时回落到默认值：用 0 建 pty 会让远端按错误宽度换行，
	// 长命令的回显会叠在同一行上。
	col := clampTermSize(cols, 150)
	row := clampTermSize(rows, 35)

	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Println("ws upgrade error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}

	wsConn.SetReadLimit(websocketInitLimit)
	_ = wsConn.SetReadDeadline(time.Now().Add(websocketInitTimeout))
	_, initMsg, err := wsConn.ReadMessage()
	if err != nil {
		fmt.Println("read init message error:", err)
		wsConn.Close()
		responseBody.Msg = err.Error()
		return &responseBody
	}
	_ = wsConn.SetReadDeadline(time.Time{})
	// The small limit above protects the one-time credential/config payload.
	// Terminal frames have a separate bounded limit so a paste larger than
	// 128 KiB does not inherit the handshake limit and disconnect the session.
	wsConn.SetReadLimit(websocketTerminalInputLimit)

	sshInfo := string(initMsg)
	sshClient, err := decodeSSHClient(c, sshInfo)
	if err != nil {
		wsConn.WriteMessage(1, []byte("\033[31mSSH info parse error: "+err.Error()+"\033[0m"))
		wsConn.Close()
		fmt.Println("parse sshInfo error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	err = sshClient.GenerateClient()
	if err != nil {
		var mismatch *core.HostKeyMismatchError
		if errors.As(err, &mismatch) {
			_ = writeHostKeyMismatchMessage(wsConn, sshClient, mismatch)
		} else {
			wsConn.WriteMessage(1, []byte("\033[31m"+err.Error()+"\033[0m"))
		}
		wsConn.Close()
		fmt.Println("ssh connect error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}

	if sshClient.InitTerminal(wsConn, row, col) == nil {
		wsConn.WriteMessage(1, []byte("\033[31mTerminal initialization failed\033[0m"))
		wsConn.Close()
		sshClient.Close()
		responseBody.Msg = "terminal initialization failed"
		return &responseBody
	}
	if err := writeTerminalControlMessage(&sshClient, wsConn, "connection-ready"); err != nil {
		wsConn.Close()
		sshClient.Close()
		responseBody.Msg = err.Error()
		return &responseBody
	}
	sshClient.Connect(wsConn, timeout, closeTip)
	return &responseBody
}
