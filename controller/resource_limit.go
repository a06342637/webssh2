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

func acquireSSHSlot(c *gin.Context) (func(), bool) {
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
	globalLimit := envPositiveInt("WEBSSH_MAX_CONCURRENT_UPLOADS", 4)
	clientLimit := envPositiveInt("WEBSSH_MAX_CONCURRENT_UPLOADS_PER_CLIENT", 2)
	client := requestIP(c)

	uploadSlots.Lock()
	if uploadSlots.Total >= globalLimit || uploadSlots.Clients[client] >= clientLimit {
		uploadSlots.Unlock()
		c.Header("Retry-After", "5")
		c.AbortWithStatusJSON(http.StatusTooManyRequests, ResponseBody{Msg: "上传任务过多，请稍后重试"})
		return nil, false
	}
	uploadSlots.Total++
	uploadSlots.Clients[client]++
	uploadSlots.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			uploadSlots.Lock()
			uploadSlots.Total--
			uploadSlots.Clients[client]--
			if uploadSlots.Clients[client] <= 0 {
				delete(uploadSlots.Clients, client)
			}
			uploadSlots.Unlock()
		})
	}, true
}
