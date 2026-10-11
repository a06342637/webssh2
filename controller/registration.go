package controller

import (
	"net/http"
	"os"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

func defaultAllowRegistration() bool {
	value := strings.TrimSpace(os.Getenv("WEBSSH_ALLOW_REGISTRATION"))
	if value == "" {
		return true
	}
	allowed, err := strconv.ParseBool(value)
	return err == nil && allowed
}

// The saved administrator setting overrides the deployment's initial default.
// Caller holds s.mu for reading or writing.
func (s *AccountStore) allowRegistrationLocked() bool {
	if s.db.AllowRegistration != nil {
		return *s.db.AllowRegistration
	}
	return defaultAllowRegistration()
}

func AllowRegistration() bool {
	if accountStore == nil {
		return defaultAllowRegistration()
	}
	accountStore.mu.RLock()
	defer accountStore.mu.RUnlock()
	return accountStore.allowRegistrationLocked()
}

func registrationClosed(c *gin.Context) {
	c.JSON(http.StatusForbidden, gin.H{"ok": false, "code": "registration_closed", "msg": "公开注册已关闭，请联系管理员创建账号"})
}

func RegistrationPolicy(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"allowRegistration": AllowRegistration()}})
}

func AdminSetRegistration(c *gin.Context) {
	username, ok := requireAdmin(c)
	if !ok {
		return
	}
	var req struct {
		AllowRegistration *bool `json:"allowRegistration"`
	}
	if err := bindStrictJSON(c, &req); err != nil || req.AllowRegistration == nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请指定是否允许注册"})
		return
	}
	accountStore.mu.Lock()
	if !requireAdminLocked(c, username) {
		accountStore.mu.Unlock()
		return
	}
	before := accountStore.snapshotLocked()
	accountStore.db.AllowRegistration = req.AllowRegistration
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		accountStore.mu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "注册设置保存失败，原设置未改变"})
		return
	}
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "注册设置已保存", "data": gin.H{"allowRegistration": *req.AllowRegistration}})
}
