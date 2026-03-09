package core

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"golang.org/x/crypto/ssh"
	"golang.org/x/net/proxy"
)

func DecodedMsgToSSHClient(sshInfo string) (SSHClient, error) {
	client := NewSSHClient()
	decoded, err := base64.StdEncoding.DecodeString(sshInfo)
	if err != nil {
		return client, err
	}
	err = json.Unmarshal(decoded, &client)
	if err != nil {
		return client, err
	}
	if strings.Contains(client.Hostname, ":") && string(client.Hostname[0]) != "[" {
		client.Hostname = "[" + client.Hostname + "]"
	}
	return client, nil
}

func (sclient *SSHClient) GenerateClient() error {
	var (
		auth         []ssh.AuthMethod
		addr         string
		clientConfig *ssh.ClientConfig
		client       *ssh.Client
		config       ssh.Config
		err          error
	)
	auth = make([]ssh.AuthMethod, 0)

	if sclient.LoginType == 0 {
		auth = append(auth, ssh.Password(sclient.Password))
		auth = append(auth, ssh.KeyboardInteractive(
			func(user, instruction string, questions []string, echos []bool) (answers []string, err error) {
				answers = make([]string, len(questions))
				for i := range questions {
					answers[i] = sclient.Password
				}
				return answers, nil
			},
		))
	} else {
		var signer ssh.Signer
		if sclient.Passphrase != "" {
			signer, err = ssh.ParsePrivateKeyWithPassphrase([]byte(sclient.PrivateKey), []byte(sclient.Passphrase))
			if err != nil {
				return fmt.Errorf("failed to parse private key with passphrase: %v", err)
			}
		} else {
			signer, err = ssh.ParsePrivateKey([]byte(sclient.PrivateKey))
			if err != nil {
				return fmt.Errorf("failed to parse private key: %v", err)
			}
		}
		auth = append(auth, ssh.PublicKeys(signer))
	}

	config = ssh.Config{
		Ciphers: []string{"aes128-ctr", "aes192-ctr", "aes256-ctr", "aes128-gcm@openssh.com", "arcfour256", "arcfour128", "aes128-cbc", "3des-cbc", "aes192-cbc", "aes256-cbc"},
	}
	clientConfig = &ssh.ClientConfig{
		User:    sclient.Username,
		Auth:    auth,
		Timeout: 5 * time.Second,
		Config:  config,
		HostKeyCallback: func(hostname string, remote net.Addr, key ssh.PublicKey) error {
			return nil
		},
	}
	if sclient.Port == 0 {
		sclient.Port = 22
	}
	addr = fmt.Sprintf("%s:%d", sclient.Hostname, sclient.Port)

	if sclient.ProxyHost != "" {
		if sclient.ProxyPort == 0 {
			sclient.ProxyPort = 1080
		}
		proxyAddr := fmt.Sprintf("%s:%d", sclient.ProxyHost, sclient.ProxyPort)
		var proxyAuth *proxy.Auth
		if sclient.ProxyUser != "" {
			proxyAuth = &proxy.Auth{User: sclient.ProxyUser, Password: sclient.ProxyPass}
		}
		dialer, err := proxy.SOCKS5("tcp", proxyAddr, proxyAuth, proxy.Direct)
		if err != nil {
			return fmt.Errorf("failed to create socks5 proxy: %v", err)
		}
		conn, err := dialer.Dial("tcp", addr)
		if err != nil {
			return fmt.Errorf("failed to connect via proxy: %v", err)
		}
		c, chans, reqs, err := ssh.NewClientConn(conn, addr, clientConfig)
		if err != nil {
			conn.Close()
			return fmt.Errorf("failed to ssh handshake via proxy: %v", err)
		}
		sclient.Client = ssh.NewClient(c, chans, reqs)
		return nil
	}

	if client, err = ssh.Dial("tcp", addr, clientConfig); err != nil {
		return fmt.Errorf("failed to connect: %v", err)
	}
	sclient.Client = client
	return nil
}

func (sclient *SSHClient) InitTerminal(ws *websocket.Conn, rows, cols int) *SSHClient {
	sshSession, err := sclient.Client.NewSession()
	if err != nil {
		log.Println(err)
		return nil
	}
	sclient.Session = sshSession
	sclient.StdinPipe, _ = sshSession.StdinPipe()
	wsOutput := new(wsOutput)
	sshSession.Stdout = wsOutput
	sshSession.Stderr = wsOutput
	wsOutput.ws = ws
	modes := ssh.TerminalModes{
		ssh.ECHO:          1,
		ssh.TTY_OP_ISPEED: 14400,
		ssh.TTY_OP_OSPEED: 14400,
	}
	if err := sshSession.RequestPty("xterm", rows, cols, modes); err != nil {
		return nil
	}
	if err := sshSession.Shell(); err != nil {
		return nil
	}
	return sclient
}

func (sclient *SSHClient) Connect(ws *websocket.Conn, timeout time.Duration, closeTip string) {
	stopCh := make(chan struct{})
	go func() {
		for {
			_, p, err := ws.ReadMessage()
			if err != nil {
				close(stopCh)
				return
			}
			if string(p) == "ping" {
				continue
			}
			if strings.Contains(string(p), "resize") {
				resizeSlice := strings.Split(string(p), ":")
				rows, _ := strconv.Atoi(resizeSlice[1])
				cols, _ := strconv.Atoi(resizeSlice[2])
				err := sclient.Session.WindowChange(rows, cols)
				if err != nil {
					log.Println(err)
					close(stopCh)
					return
				}
				continue
			}
			_, err = sclient.StdinPipe.Write(p)
			if err != nil {
				close(stopCh)
				return
			}
		}
	}()

	defer func() {
		ws.Close()
		sclient.Close()
		if err := recover(); err != nil {
			log.Println(err)
		}
	}()

	stopTimer := time.NewTimer(timeout)
	defer stopTimer.Stop()

	for {
		select {
		case <-stopCh:
			return
		case <-stopTimer.C:
			ws.WriteMessage(1, []byte(fmt.Sprintf("\033[33m%s\033[0m", closeTip)))
			return
		}
	}
}
