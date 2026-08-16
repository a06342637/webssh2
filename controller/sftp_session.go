package controller

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

const maxSFTPSessionIDLength = 128

type sftpSessionCloseRequest struct {
	SessionID string `json:"sessionId"`
}

type sftpSessionEntry struct {
	key        string
	clientID   string
	trustScope string
	sessionID  string

	opMu      sync.Mutex
	client    *core.SSHClient
	idleTimer *time.Timer
	lastUsed  time.Time
	closed    bool
}

type sftpSessionLease struct {
	Client       *core.SSHClient
	entry        *sftpSessionEntry
	stopContext  func()
	requestDone  <-chan struct{}
	releaseOnce  sync.Once
	isPersistent bool
}

var sftpSessionRegistry = struct {
	sync.Mutex
	entries map[string]*sftpSessionEntry
	clients map[string]int
}{
	entries: make(map[string]*sftpSessionEntry),
	clients: make(map[string]int),
}

var createSFTPSessionClient = func(client core.SSHClient) (*core.SSHClient, error) {
	if err := client.CreateSftp(); err != nil {
		return nil, err
	}
	return &client, nil
}

// SSHClient contains runtime-only synchronization state. Copying it by value
// also copies the closeOnce pointer, so a connection created after an earlier
// one was closed could inherit an already-fired Close and leak its transports.
// Build every SFTP connection from a fresh client and copy configuration only.
func cloneSFTPClientConfig(source core.SSHClient) core.SSHClient {
	target := core.NewSSHClient()
	target.Username = source.Username
	target.Password = source.Password
	target.Hostname = source.Hostname
	target.Port = source.Port
	target.LoginType = source.LoginType
	target.PrivateKey = source.PrivateKey
	target.Passphrase = source.Passphrase
	target.ProxyHost = source.ProxyHost
	target.ProxyPort = source.ProxyPort
	target.ProxyUser = source.ProxyUser
	target.ProxyPass = source.ProxyPass
	target.HostKeyAction = source.HostKeyAction
	target.HostKeyFingerprint = source.HostKeyFingerprint
	target.TrustScope = source.TrustScope
	return target
}

func normalizeSFTPSessionID(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", nil
	}
	if len(raw) > maxSFTPSessionIDLength {
		return "", fmt.Errorf("invalid SFTP session id")
	}
	for i := 0; i < len(raw); i++ {
		ch := raw[i]
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '-' || ch == '_' || ch == '.' || ch == ':' {
			continue
		}
		return "", fmt.Errorf("invalid SFTP session id")
	}
	return raw, nil
}

func sftpSessionIdleTTL() time.Duration {
	seconds := envPositiveInt("WEBSSH_SFTP_SESSION_IDLE_SECONDS", 120)
	if seconds < 15 {
		seconds = 15
	}
	if seconds > 900 {
		seconds = 900
	}
	return time.Duration(seconds) * time.Second
}

func sftpSessionKey(client core.SSHClient, clientID, sessionID, sshInfo string) string {
	digest := sha256.Sum256([]byte(sshInfo))
	return strings.Join([]string{
		strings.TrimSpace(client.TrustScope),
		strings.TrimSpace(clientID),
		sessionID,
		hex.EncodeToString(digest[:]),
	}, "\x00")
}

func scrubSFTPSessionCredentials(client *core.SSHClient) {
	if client == nil {
		return
	}
	client.Password = ""
	client.PrivateKey = ""
	client.Passphrase = ""
	client.ProxyPass = ""
}

func getOrCreateSFTPSessionEntry(key, clientID, trustScope, sessionID string) (*sftpSessionEntry, bool, error) {
	sftpSessionRegistry.Lock()
	defer sftpSessionRegistry.Unlock()
	if runtimeShuttingDown.Load() {
		return nil, false, errRuntimeShuttingDown
	}
	if entry := sftpSessionRegistry.entries[key]; entry != nil {
		return entry, true, nil
	}
	globalLimit := envPositiveInt("WEBSSH_MAX_SFTP_SESSIONS", 32)
	clientLimit := envPositiveInt("WEBSSH_MAX_SFTP_SESSIONS_PER_CLIENT", 4)
	if len(sftpSessionRegistry.entries) >= globalLimit || sftpSessionRegistry.clients[clientID] >= clientLimit {
		return nil, false, nil
	}
	entry := &sftpSessionEntry{
		key:        key,
		clientID:   clientID,
		trustScope: trustScope,
		sessionID:  sessionID,
		lastUsed:   time.Now(),
	}
	sftpSessionRegistry.entries[key] = entry
	sftpSessionRegistry.clients[clientID]++
	return entry, true, nil
}

func removeSFTPSessionEntry(entry *sftpSessionEntry) bool {
	if entry == nil {
		return false
	}
	sftpSessionRegistry.Lock()
	defer sftpSessionRegistry.Unlock()
	if sftpSessionRegistry.entries[entry.key] != entry {
		return false
	}
	delete(sftpSessionRegistry.entries, entry.key)
	sftpSessionRegistry.clients[entry.clientID]--
	if sftpSessionRegistry.clients[entry.clientID] <= 0 {
		delete(sftpSessionRegistry.clients, entry.clientID)
	}
	return true
}

func expireSFTPSessionEntry(entry *sftpSessionEntry) {
	if entry == nil {
		return
	}
	if !entry.opMu.TryLock() {
		time.AfterFunc(time.Second, func() { expireSFTPSessionEntry(entry) })
		return
	}
	defer entry.opMu.Unlock()
	if entry.closed {
		return
	}
	ttl := sftpSessionIdleTTL()
	if remaining := ttl - time.Since(entry.lastUsed); remaining > 0 {
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
		}
		entry.idleTimer = time.AfterFunc(remaining, func() { expireSFTPSessionEntry(entry) })
		return
	}
	entry.closed = true
	entry.idleTimer = nil
	removeSFTPSessionEntry(entry)
	client := entry.client
	entry.client = nil
	if client != nil {
		client.Close()
	}
}

func newTransientSFTPSessionLease(c *gin.Context, decoded core.SSHClient) (*sftpSessionLease, error) {
	if runtimeShuttingDown.Load() {
		return nil, errRuntimeShuttingDown
	}
	client, err := createSFTPSessionClient(cloneSFTPClientConfig(decoded))
	if err != nil {
		if client != nil {
			client.Close()
		}
		return nil, err
	}
	if runtimeShuttingDown.Load() {
		client.Close()
		return nil, errRuntimeShuttingDown
	}
	return &sftpSessionLease{
		Client:      client,
		stopContext: closeSSHOnContextDone(c.Request.Context(), client),
	}, nil
}

func acquireSFTPSessionLease(c *gin.Context, sessionID, sshInfo string, decoded core.SSHClient) (*sftpSessionLease, error) {
	normalizedID, err := normalizeSFTPSessionID(sessionID)
	if err != nil {
		return nil, err
	}
	if normalizedID == "" {
		return newTransientSFTPSessionLease(c, decoded)
	}
	clientID := requestIP(c)
	key := sftpSessionKey(decoded, clientID, normalizedID, sshInfo)
	for attempt := 0; attempt < 2; attempt++ {
		entry, pooled, registryErr := getOrCreateSFTPSessionEntry(key, clientID, decoded.TrustScope, normalizedID)
		if registryErr != nil {
			return nil, registryErr
		}
		if !pooled {
			return newTransientSFTPSessionLease(c, decoded)
		}
		entry.opMu.Lock()
		if entry.closed {
			entry.opMu.Unlock()
			continue
		}
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
			entry.idleTimer = nil
		}
		if entry.client == nil {
			client, createErr := createSFTPSessionClient(cloneSFTPClientConfig(decoded))
			if createErr != nil {
				entry.closed = true
				removeSFTPSessionEntry(entry)
				if client != nil {
					client.Close()
				}
				entry.opMu.Unlock()
				return nil, createErr
			}
			scrubSFTPSessionCredentials(client)
			entry.client = client
		}
		entry.lastUsed = time.Now()
		return &sftpSessionLease{
			Client:       entry.client,
			entry:        entry,
			stopContext:  closeSSHOnContextDone(c.Request.Context(), entry.client),
			requestDone:  c.Request.Context().Done(),
			isPersistent: true,
		}, nil
	}
	return newTransientSFTPSessionLease(c, decoded)
}

func (lease *sftpSessionLease) Release(discard bool) {
	if lease == nil {
		return
	}
	lease.releaseOnce.Do(func() {
		if lease.stopContext != nil {
			lease.stopContext()
		}
		if !lease.isPersistent || lease.entry == nil {
			if lease.Client != nil {
				lease.Client.Close()
			}
			return
		}
		if lease.requestDone != nil {
			select {
			case <-lease.requestDone:
				discard = true
			default:
			}
		}
		entry := lease.entry
		if discard {
			entry.closed = true
			if entry.idleTimer != nil {
				entry.idleTimer.Stop()
				entry.idleTimer = nil
			}
			removeSFTPSessionEntry(entry)
			client := entry.client
			entry.client = nil
			if client != nil {
				client.Close()
			}
			entry.opMu.Unlock()
			return
		}
		entry.lastUsed = time.Now()
		entry.idleTimer = time.AfterFunc(sftpSessionIdleTTL(), func() { expireSFTPSessionEntry(entry) })
		entry.opMu.Unlock()
	})
}

func sftpSessionConnectionBroken(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.EOF) || errors.Is(err, net.ErrClosed) {
		return true
	}
	message := strings.ToLower(err.Error())
	for _, fragment := range []string{
		"broken pipe",
		"connection reset",
		"connection lost",
		"use of closed network connection",
		"unexpected eof",
		"ssh: disconnect",
	} {
		if strings.Contains(message, fragment) {
			return true
		}
	}
	return false
}

func CloseSFTPSession(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	var request sftpSessionCloseRequest
	if err := bindStrictJSON(c, &request); err != nil {
		responseBody.Msg = fmt.Errorf("invalid request: %w", err).Error()
		return &responseBody
	}
	sessionID, err := normalizeSFTPSessionID(request.SessionID)
	if err != nil || sessionID == "" {
		responseBody.Msg = "invalid SFTP session id"
		return &responseBody
	}
	clientID := requestIP(c)
	var entries []*sftpSessionEntry
	sftpSessionRegistry.Lock()
	for key, entry := range sftpSessionRegistry.entries {
		if entry.clientID != clientID || entry.sessionID != sessionID {
			continue
		}
		delete(sftpSessionRegistry.entries, key)
		sftpSessionRegistry.clients[entry.clientID]--
		if sftpSessionRegistry.clients[entry.clientID] <= 0 {
			delete(sftpSessionRegistry.clients, entry.clientID)
		}
		entries = append(entries, entry)
	}
	sftpSessionRegistry.Unlock()
	for _, entry := range entries {
		entry.opMu.Lock()
		entry.closed = true
		if entry.idleTimer != nil {
			entry.idleTimer.Stop()
			entry.idleTimer = nil
		}
		client := entry.client
		entry.client = nil
		if client != nil {
			client.Close()
		}
		entry.opMu.Unlock()
	}
	responseBody.Data = gin.H{"closed": len(entries)}
	return &responseBody
}
