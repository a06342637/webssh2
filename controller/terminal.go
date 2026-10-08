package controller

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

const terminalControlPrefix = "__WEBSSH_CONTROL__:"

const terminalSetupTimeout = 12 * time.Second

type terminalInputFrame struct {
	kind int
	data []byte
}

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
	defer wsConn.Close()
	release, err := acquireTerminalSlot(requestIP(c))
	if err != nil {
		// Browsers cannot read the body of a rejected WebSocket upgrade.
		// Send an explicit control message so the limit is visible to the user.
		payload, _ := json.Marshal(struct {
			Type    string `json:"type"`
			Message string `json:"message"`
		}{Type: "connection-error", Message: err.Error()})
		_ = wsConn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		_ = wsConn.WriteMessage(websocket.TextMessage, append([]byte(terminalControlPrefix), payload...))
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer release()

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
	connectionCtx, cancelConnection := context.WithCancel(c.Request.Context())
	input := make(chan terminalInputFrame, 8)
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(input)
		defer cancelConnection()
		for {
			kind, data, err := wsConn.ReadMessage()
			if err != nil {
				return
			}
			select {
			case input <- terminalInputFrame{kind: kind, data: data}:
			case <-connectionCtx.Done():
				return
			}
		}
	}()
	defer func() {
		cancelConnection()
		_ = wsConn.Close()
		<-readerDone
	}()
	setupDuration := terminalSetupTimeout
	if timeout > 0 && timeout < setupDuration {
		setupDuration = timeout
	}
	setupCtx, cancelSetup := context.WithTimeout(connectionCtx, setupDuration)
	defer cancelSetup()
	unregisterCloser, registered := registerRuntimeCloser(func() {
		cancelConnection()
		_ = wsConn.Close()
	})
	if !registered {
		responseBody.Msg = errRuntimeShuttingDown.Error()
		return &responseBody
	}
	defer unregisterCloser()

	sshInfo := string(initMsg)
	sshClient, err := decodeSSHClient(c, sshInfo)
	if err != nil {
		wsConn.WriteMessage(1, []byte("\033[31mSSH info parse error: "+err.Error()+"\033[0m"))
		wsConn.Close()
		fmt.Println("parse sshInfo error:", err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	err = sshClient.GenerateClientContext(setupCtx)
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
	defer sshClient.Close()
	transport := sshClient.Client
	stopTransport := context.AfterFunc(connectionCtx, func() { _ = transport.Close() })
	defer stopTransport()
	// Bound writes while Shell may already be producing a banner during setup.
	_ = wsConn.SetWriteDeadline(time.Now().Add(setupDuration))
	if err := sshClient.InitTerminalContext(setupCtx, wsConn, row, col); err != nil {
		_ = sshClient.WriteWebSocketMessage(wsConn, websocket.TextMessage, []byte("\033[31mTerminal initialization failed: "+err.Error()+"\033[0m"))
		wsConn.Close()
		responseBody.Msg = "terminal initialization failed: " + err.Error()
		return &responseBody
	}
	if err := writeTerminalControlMessage(&sshClient, wsConn, "connection-ready"); err != nil {
		wsConn.Close()
		sshClient.Close()
		responseBody.Msg = err.Error()
		return &responseBody
	}
	sshClient.SetWebSocketWriteDeadline(wsConn, time.Time{})
	cancelSetup()
	sshClient.ConnectWithReader(wsConn, timeout, closeTip, func() (int, []byte, error) {
		select {
		case frame, ok := <-input:
			if !ok {
				return 0, nil, io.EOF
			}
			return frame.kind, frame.data, nil
		case <-connectionCtx.Done():
			return 0, nil, connectionCtx.Err()
		}
	})
	return &responseBody
}
