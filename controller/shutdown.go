package controller

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

var (
	runtimeShuttingDown    atomic.Bool
	errRuntimeShuttingDown = errors.New("WebSSH server is shutting down")
)

var runtimeClosers = struct {
	sync.Mutex
	next  uint64
	items map[uint64]func()
}{items: make(map[uint64]func())}

// BeginRuntimeShutdown closes the admission gate before the shutdown code
// snapshots any background registries. A task that wins the race before this
// store is included in the snapshot; a task that arrives afterwards is
// rejected or closed immediately by its registry.
func BeginRuntimeShutdown() {
	runtimeShuttingDown.Store(true)
}

func registerRuntimeCloser(closeFunc func()) (func(), bool) {
	if closeFunc == nil {
		return func() {}, true
	}
	runtimeClosers.Lock()
	if runtimeShuttingDown.Load() {
		runtimeClosers.Unlock()
		closeFunc()
		return func() {}, false
	}
	runtimeClosers.next++
	id := runtimeClosers.next
	runtimeClosers.items[id] = closeFunc
	runtimeClosers.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			runtimeClosers.Lock()
			delete(runtimeClosers.items, id)
			runtimeClosers.Unlock()
		})
	}, true
}

func closeRuntimeConnections() {
	runtimeClosers.Lock()
	closers := make([]func(), 0, len(runtimeClosers.items))
	for id, closeFunc := range runtimeClosers.items {
		closers = append(closers, closeFunc)
		delete(runtimeClosers.items, id)
	}
	runtimeClosers.Unlock()
	for _, closeFunc := range closers {
		closeFunc()
	}
}

func closeAllSFTPSessions(ctx context.Context) {
	sftpSessionRegistry.Lock()
	entries := make([]*sftpSessionEntry, 0, len(sftpSessionRegistry.entries))
	for _, entry := range sftpSessionRegistry.entries {
		entries = append(entries, entry)
	}
	sftpSessionRegistry.entries = make(map[string]*sftpSessionEntry)
	sftpSessionRegistry.clients = make(map[string]int)
	sftpSessionRegistry.Unlock()

	done := make(chan struct{})
	go func() {
		var wait sync.WaitGroup
		for _, entry := range entries {
			entry := entry
			wait.Add(1)
			go func() {
				defer wait.Done()
				entry.opMu.Lock()
				defer entry.opMu.Unlock()
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
			}()
		}
		wait.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

// ShutdownBackgroundTasks cancels work that is not owned by net/http (async
// archive workers, pooled SFTP sessions and hijacked WebSockets) so
// http.Server.Shutdown can finish deterministically.
func ShutdownBackgroundTasks(ctx context.Context) {
	BeginRuntimeShutdown()
	folderArchiveJobs.RLock()
	jobs := make([]*folderArchiveJob, 0, len(folderArchiveJobs.items))
	for _, job := range folderArchiveJobs.items {
		jobs = append(jobs, job)
	}
	folderArchiveJobs.RUnlock()
	for _, job := range jobs {
		cancelFolderArchiveJob(job)
	}
	expireAllPreviewGrants()
	closeRuntimeConnections()
	closeAllSFTPSessions(ctx)

	for _, job := range jobs {
		if job.workDone == nil {
			continue
		}
		select {
		case <-job.workDone:
		case <-ctx.Done():
			return
		}
	}
}
