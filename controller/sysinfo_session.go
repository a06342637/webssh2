package controller

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

type sysInfoSession struct {
	key, clientID  string
	mu             sftpSessionMutex
	client         *core.SSHClient
	unregister     func()
	lastUsed       time.Time
	timer          *time.Timer
	closed, pooled bool
	static         map[string]interface{}
	staticAt       time.Time
	cpu            string
	net            *netSnapshot
}

var sysInfoSessions = struct {
	sync.Mutex
	entries map[string]*sysInfoSession
}{entries: make(map[string]*sysInfoSession)}
var createSysInfoClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
	if err := configuration.GenerateClientContext(ctx); err != nil {
		return nil, err
	}
	return &configuration, nil
}

func acquireSysInfoSession(ctx context.Context, c *gin.Context, sshInfo string, configuration core.SSHClient) (*sysInfoSession, func(bool), error) {
	if err := ctx.Err(); err != nil {
		return nil, nil, err
	}
	digest := sha256.Sum256([]byte(sshInfo))
	clientID := requestIP(c)
	key := configuration.TrustScope + "\x00" + clientID + "\x00" + hex.EncodeToString(digest[:])
	sysInfoSessions.Lock()
	if runtimeShuttingDown.Load() {
		sysInfoSessions.Unlock()
		return nil, nil, errRuntimeShuttingDown
	}
	entry := sysInfoSessions.entries[key]
	if entry == nil {
		count := 0
		for _, current := range sysInfoSessions.entries {
			if current.clientID == clientID {
				count++
			}
		}
		entry = &sysInfoSession{key: key, clientID: clientID, pooled: len(sysInfoSessions.entries) < envPositiveInt("WEBSSH_MAX_SYSINFO_SESSIONS", 32) && count < envPositiveInt("WEBSSH_MAX_SYSINFO_SESSIONS_PER_CLIENT", 4)}
		if entry.pooled {
			sysInfoSessions.entries[key] = entry
		}
	}
	sysInfoSessions.Unlock()
	if err := entry.mu.LockContext(ctx); err != nil {
		if entry.mu.TryLock() {
			if entry.client == nil {
				closeSysInfoSession(entry)
			}
			entry.mu.Unlock()
		}
		return nil, nil, err
	}
	if entry.closed {
		entry.mu.Unlock()
		return acquireSysInfoSession(ctx, c, sshInfo, configuration)
	}
	if entry.timer != nil {
		entry.timer.Stop()
		entry.timer = nil
	}
	if entry.client == nil {
		client, err := createSysInfoClient(ctx, cloneSFTPClientConfig(configuration))
		if err != nil {
			closeSysInfoSession(entry)
			entry.mu.Unlock()
			return nil, nil, err
		}
		entry.client = client
		entry.static = nil
		entry.cpu = ""
		entry.net = nil
		unregister, registered := registerRuntimeCloser(client.Close)
		if !registered {
			closeSysInfoSession(entry)
			entry.mu.Unlock()
			return nil, nil, errRuntimeShuttingDown
		}
		entry.unregister = unregister
		scrubSFTPSessionCredentials(client)
	}
	stop := context.AfterFunc(ctx, entry.client.Close)
	var once sync.Once
	release := func(discard bool) {
		once.Do(func() {
			if !stop() || ctx.Err() != nil {
				discard = true
			}
			if discard || !entry.pooled {
				closeSysInfoSession(entry)
			} else {
				entry.lastUsed = time.Now()
				entry.timer = time.AfterFunc(90*time.Second, func() { expireSysInfoSession(entry) })
			}
			entry.mu.Unlock()
		})
	}
	return entry, release, nil
}

// Caller owns entry.mu. The registry never holds its mutex while taking entry.mu.
func closeSysInfoSession(entry *sysInfoSession) {
	entry.closed = true
	if entry.timer != nil {
		entry.timer.Stop()
		entry.timer = nil
	}
	if entry.unregister != nil {
		entry.unregister()
		entry.unregister = nil
	}
	if entry.client != nil {
		entry.client.Close()
		entry.client = nil
	}
	sysInfoSessions.Lock()
	if sysInfoSessions.entries[entry.key] == entry {
		delete(sysInfoSessions.entries, entry.key)
	}
	sysInfoSessions.Unlock()
}

func expireSysInfoSession(entry *sysInfoSession) {
	if !entry.mu.TryLock() {
		time.AfterFunc(time.Second, func() { expireSysInfoSession(entry) })
		return
	}
	defer entry.mu.Unlock()
	if entry.closed {
		return
	}
	if remaining := 90*time.Second - time.Since(entry.lastUsed); remaining > 0 {
		entry.timer = time.AfterFunc(remaining, func() { expireSysInfoSession(entry) })
		return
	}
	closeSysInfoSession(entry)
}

func closeAllSysInfoSessions(ctx context.Context) {
	sysInfoSessions.Lock()
	entries := make([]*sysInfoSession, 0, len(sysInfoSessions.entries))
	for _, entry := range sysInfoSessions.entries {
		entries = append(entries, entry)
	}
	sysInfoSessions.Unlock()
	for _, entry := range entries {
		if entry.mu.LockContext(ctx) != nil {
			return
		}
		closeSysInfoSession(entry)
		entry.mu.Unlock()
	}
}

func sysInfoCommandParts(parts []string, cached bool) []string {
	result := make([]string, 0, len(parts))
	cpu := 0
	for index := 0; index < len(parts); index++ {
		part := parts[index]
		if part == "sleep 1" {
			continue
		}
		key := markerKey(strings.TrimSuffix(strings.TrimPrefix(part, `echo "`), `"`))
		if key == "cpuTimes" {
			cpu++
			if cpu == 1 {
				index++
				continue
			}
		}
		if key == "net1" {
			index++
			continue
		}
		if cached && (key == "os" || key == "kernel" || key == "kernelVersion" || key == "arch" || key == "hostname" || key == "cpuModel" || key == "cpuCores") {
			index++
			continue
		}
		result = append(result, part)
	}
	return result
}

func applySysInfoSample(entry *sysInfoSession, raw string, now time.Time, refreshStatic bool) map[string]interface{} {
	info := parseSysInfo(raw)
	if refreshStatic {
		entry.static = make(map[string]interface{})
		for _, key := range []string{"os", "kernel", "kernelVersion", "arch", "hostname", "cpuModel", "cpuCores"} {
			entry.static[key] = info[key]
		}
		entry.staticAt = now
	}
	for key, value := range entry.static {
		info[key] = value
	}
	mode, cpu := "", ""
	snap := &netSnapshot{at: now, counters: make(map[string][2]float64)}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if key := markerKey(line); key != "" {
			mode = key
			continue
		}
		switch mode {
		case "cpuTimes":
			if line != "" {
				cpu = line
			}
		case "netMain":
			snap.mainIface = line
		case "net2":
			addNetSnapshotLine(snap, line)
		}
	}
	info["cpuSampleReady"] = entry.cpu != "" && cpu != ""
	if entry.cpu != "" && cpu != "" {
		info["cpuUsage"] = calcCPUUsage(entry.cpu, cpu)
		info["cpuBreakdown"] = calcCPUBreakdown(entry.cpu, cpu)
	}
	for key, value := range buildNetSnapshotData(entry.net, snap) {
		info[key] = value
	}
	info["updatedAt"] = now.Format(time.RFC3339)
	entry.cpu, entry.net = cpu, snap
	return info
}
