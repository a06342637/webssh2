package core

import (
	"io"
	"log"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

var (
	WcMu   sync.Mutex
	WcList []*WriteCounter
)

type WriteCounter struct {
	Total int64
	Id    string
}

func (wc *WriteCounter) Write(p []byte) (int, error) {
	n := len(p)
	atomic.AddInt64(&wc.Total, int64(n))
	return n, nil
}

type wsOutput struct {
	ws *websocket.Conn
	mu *sync.Mutex
}

func (w *wsOutput) Write(p []byte) (int, error) {
	if w.mu != nil {
		w.mu.Lock()
		defer w.mu.Unlock()
	}
	// SSH is a byte stream. Binary WebSocket frames avoid UTF-8 validation,
	// preserve multibyte characters split across reads and reduce output copies.
	err := w.ws.WriteMessage(websocket.BinaryMessage, p)
	return len(p), err
}

type SSHClient struct {
	Username   string `json:"username"`
	Password   string `json:"password"`
	Hostname   string `json:"hostname"`
	Port       int    `json:"port"`
	LoginType  int    `json:"logintype"`
	PrivateKey string `json:"privateKey"`
	Passphrase string `json:"passphrase"`
	ProxyHost  string `json:"proxyHost"`
	ProxyPort  int    `json:"proxyPort"`
	ProxyUser  string `json:"proxyUser"`
	ProxyPass  string `json:"proxyPass"`
	Client     *ssh.Client
	Sftp       *sftp.Client
	StdinPipe  io.WriteCloser
	Session    *ssh.Session
	wsWriteMu  *sync.Mutex
}

func NewSSHClient() SSHClient {
	client := SSHClient{}
	client.Port = 22
	client.wsWriteMu = &sync.Mutex{}
	return client
}

func (sclient *SSHClient) Close() {
	defer func() {
		if err := recover(); err != nil {
			log.Println("SSHClient Close recover from panic: ", err)
		}
	}()
	if sclient.StdinPipe != nil {
		sclient.StdinPipe.Close()
		sclient.StdinPipe = nil
	}
	if sclient.Session != nil {
		sclient.Session.Close()
		sclient.Session = nil
	}
	if sclient.Sftp != nil {
		sclient.Sftp.Close()
		sclient.Sftp = nil
	}
	if sclient.Client != nil {
		sclient.Client.Close()
		sclient.Client = nil
	}
}
