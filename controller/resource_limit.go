package controller

import (
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
)

var sshSlots = struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}{Clients: make(map[string]int)}

var uploadSlots = struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}{Clients: make(map[string]int)}

var downloadSlots = struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}{Clients: make(map[string]int)}

var folderArchiveSlots = struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}{Clients: make(map[string]int)}

var uploadProgressSlots = struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}{Clients: make(map[string]int)}

func acquireClientSlot(c *gin.Context, slots *struct {
	sync.Mutex
	Total   int
	Clients map[string]int
}, globalLimit, clientLimit int, message string) (func(), bool) {
	if runtimeShuttingDown.Load() {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, ResponseBody{Msg: errRuntimeShuttingDown.Error()})
		return nil, false
	}
	client := requestIP(c)
	slots.Lock()
	if slots.Total >= globalLimit || slots.Clients[client] >= clientLimit {
		slots.Unlock()
		c.Header("Retry-After", "5")
		c.AbortWithStatusJSON(http.StatusTooManyRequests, ResponseBody{Msg: message})
		return nil, false
	}
	slots.Total++
	slots.Clients[client]++
	slots.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			slots.Lock()
			slots.Total--
			slots.Clients[client]--
			if slots.Clients[client] <= 0 {
				delete(slots.Clients, client)
			}
			slots.Unlock()
		})
	}, true
}

func acquireSSHSlot(c *gin.Context) (func(), bool) {
	if runtimeShuttingDown.Load() {
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, ResponseBody{Msg: errRuntimeShuttingDown.Error()})
		return nil, false
	}
	globalLimit := envPositiveInt("WEBSSH_MAX_CONCURRENT_SSH", 64)
	clientLimit := envPositiveInt("WEBSSH_MAX_CONCURRENT_SSH_PER_CLIENT", 8)
	client := requestIP(c)

	sshSlots.Lock()
	if sshSlots.Total >= globalLimit || sshSlots.Clients[client] >= clientLimit {
		sshSlots.Unlock()
		c.Header("Retry-After", "5")
		c.AbortWithStatusJSON(http.StatusTooManyRequests, ResponseBody{Msg: "SSH 连接任务过多，请稍后重试"})
		return nil, false
	}
	sshSlots.Total++
	sshSlots.Clients[client]++
	sshSlots.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			sshSlots.Lock()
			sshSlots.Total--
			sshSlots.Clients[client]--
			if sshSlots.Clients[client] <= 0 {
				delete(sshSlots.Clients, client)
			}
			sshSlots.Unlock()
		})
	}, true
}

func acquireUploadSlot(c *gin.Context) (func(), bool) {
	return acquireClientSlot(c, &uploadSlots,
		envPositiveInt("WEBSSH_MAX_CONCURRENT_UPLOADS", 4),
		envPositiveInt("WEBSSH_MAX_CONCURRENT_UPLOADS_PER_CLIENT", 2),
		"上传任务过多，请稍后重试")
}

func acquireDownloadSlot(c *gin.Context) (func(), bool) {
	return acquireClientSlot(c, &downloadSlots,
		envPositiveInt("WEBSSH_MAX_CONCURRENT_DOWNLOADS", 16),
		envPositiveInt("WEBSSH_MAX_CONCURRENT_DOWNLOADS_PER_CLIENT", 3),
		"下载任务过多，请稍后重试")
}

func acquireFolderArchiveSlot(c *gin.Context) (func(), bool) {
	return acquireClientSlot(c, &folderArchiveSlots,
		envPositiveInt("WEBSSH_MAX_CONCURRENT_FOLDER_ARCHIVES", 8),
		envPositiveInt("WEBSSH_MAX_CONCURRENT_FOLDER_ARCHIVES_PER_CLIENT", 2),
		"文件夹压缩任务过多，请稍后重试")
}

func acquireUploadProgressSlot(c *gin.Context) (func(), bool) {
	return acquireClientSlot(c, &uploadProgressSlots,
		envPositiveInt("WEBSSH_MAX_UPLOAD_PROGRESS_CONNECTIONS", 32),
		envPositiveInt("WEBSSH_MAX_UPLOAD_PROGRESS_CONNECTIONS_PER_CLIENT", 4),
		"上传进度连接过多，请稍后重试")
}
