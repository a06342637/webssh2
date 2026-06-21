package controller

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

const sessionCookieName = "webssh_session"

var (
	accountStore *AccountStore
	usernameRule = regexp.MustCompile(`^[A-Za-z0-9]{6,32}$`)
)

type StoredUser struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    int64  `json:"createdAt"`
}

type StoredSession struct {
	Username  string `json:"username"`
	ExpiresAt int64  `json:"expiresAt"`
}

type ScriptBookmark struct {
	Name string `json:"name"`
	Cmd  string `json:"cmd"`
}

type StoredScripts struct {
	Items     []ScriptBookmark `json:"items"`
	UpdatedAt int64            `json:"updatedAt"`
}

type accountDB struct {
	Users    map[string]StoredUser    `json:"users"`
	Sessions map[string]StoredSession `json:"sessions"`
	Scripts  map[string]StoredScripts `json:"scripts"`
}

type AccountStore struct {
	mu   sync.Mutex
	path string
	db   accountDB
}

func InitAccountStore(dataDir string) error {
	if dataDir == "" {
		dataDir = os.Getenv("WEBSSH_DATA_DIR")
	}
	if dataDir == "" {
		dataDir = os.Getenv("DATA_DIR")
	}
	if dataDir == "" {
		dataDir = "data"
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return err
	}
	store := &AccountStore{path: filepath.Join(dataDir, "webssh-db.json")}
	store.ensureMaps()
	if err := store.load(); err != nil {
		return err
	}
	store.cleanupExpiredSessionsLocked(time.Now().Unix())
	if err := store.saveLocked(); err != nil {
		return err
	}
	accountStore = store
	return nil
}

func (s *AccountStore) ensureMaps() {
	if s.db.Users == nil {
		s.db.Users = map[string]StoredUser{}
	}
	if s.db.Sessions == nil {
		s.db.Sessions = map[string]StoredSession{}
	}
	if s.db.Scripts == nil {
		s.db.Scripts = map[string]StoredScripts{}
	}
}

func (s *AccountStore) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.ensureMaps()
		return nil
	}
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(string(b))) == 0 {
		s.ensureMaps()
		return nil
	}
	if err := json.Unmarshal(b, &s.db); err != nil {
		return err
	}
	s.ensureMaps()
	return nil
}

func (s *AccountStore) saveLocked() error {
	s.ensureMaps()
	b, err := json.MarshalIndent(s.db, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, b, 0600); err != nil {
		return err
	}
	_ = os.Remove(s.path)
	return os.Rename(tmp, s.path)
}

func (s *AccountStore) cleanupExpiredSessionsLocked(now int64) {
	for token, sess := range s.db.Sessions {
		if sess.ExpiresAt <= now {
			delete(s.db.Sessions, token)
		}
	}
}

func validateAccount(username, password string) (string, string, string) {
	username = strings.TrimSpace(username)
	password = strings.TrimSpace(password)
	if !usernameRule.MatchString(username) {
		return "", "", "用户名只能使用 6-32 位字母或数字"
	}
	if len(password) < 6 {
		return "", "", "密码必须至少 6 位"
	}
	return strings.ToLower(username), password, ""
}

func newSessionToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func setLoginCookie(c *gin.Context, token string, expires time.Time) {
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		Expires:  expires,
		MaxAge:   int(time.Until(expires).Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

func clearLoginCookie(c *gin.Context) {
	secure := c.Request.TLS != nil || strings.EqualFold(c.GetHeader("X-Forwarded-Proto"), "https")
	http.SetCookie(c.Writer, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

func currentAccount(c *gin.Context) (string, bool) {
	if accountStore == nil {
		return "", false
	}
	token, err := c.Cookie(sessionCookieName)
	if err != nil || token == "" {
		return "", false
	}
	now := time.Now().Unix()
	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	sess, ok := accountStore.db.Sessions[token]
	if !ok || sess.ExpiresAt <= now {
		delete(accountStore.db.Sessions, token)
		_ = accountStore.saveLocked()
		return "", false
	}
	if _, ok := accountStore.db.Users[sess.Username]; !ok {
		delete(accountStore.db.Sessions, token)
		_ = accountStore.saveLocked()
		return "", false
	}
	return sess.Username, true
}

func requireAccount(c *gin.Context) (string, bool) {
	username, ok := currentAccount(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "请先登录"})
		return "", false
	}
	return username, true
}

func createLoginSession(c *gin.Context, username string) error {
	token, err := newSessionToken()
	if err != nil {
		return err
	}
	expires := time.Now().Add(30 * 24 * time.Hour)
	accountStore.db.Sessions[token] = StoredSession{Username: username, ExpiresAt: expires.Unix()}
	setLoginCookie(c, token, expires)
	return nil
}

func AuthRegister(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号数据库未初始化"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	username, password, msg := validateAccount(req.Username, req.Password)
	if msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
		return
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "密码处理失败"})
		return
	}
	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	if _, exists := accountStore.db.Users[username]; exists {
		c.JSON(http.StatusConflict, gin.H{"ok": false, "msg": "用户名已存在"})
		return
	}
	accountStore.db.Users[username] = StoredUser{
		Username:     username,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UnixMilli(),
	}
	if err := createLoginSession(c, username); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录会话创建失败"})
		return
	}
	if err := accountStore.saveLocked(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号保存失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "注册成功", "data": gin.H{"username": username}})
}

func AuthLogin(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号数据库未初始化"})
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	username, password, msg := validateAccount(req.Username, req.Password)
	if msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
		return
	}
	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	user, exists := accountStore.db.Users[username]
	if !exists || bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "用户名或密码错误"})
		return
	}
	if err := createLoginSession(c, username); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录会话创建失败"})
		return
	}
	if err := accountStore.saveLocked(); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录状态保存失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "登录成功", "data": gin.H{"username": username}})
}

func AuthLogout(c *gin.Context) {
	if accountStore != nil {
		if token, err := c.Cookie(sessionCookieName); err == nil && token != "" {
			accountStore.mu.Lock()
			delete(accountStore.db.Sessions, token)
			_ = accountStore.saveLocked()
			accountStore.mu.Unlock()
		}
	}
	clearLoginCookie(c)
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "已退出登录"})
}

func AuthMe(c *gin.Context) {
	username, ok := currentAccount(c)
	if !ok {
		c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"loggedIn": false}})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"loggedIn": true, "username": username}})
}

func sanitizeScriptBookmarks(items []ScriptBookmark) []ScriptBookmark {
	out := make([]ScriptBookmark, 0, len(items))
	for _, item := range items {
		name := strings.TrimSpace(item.Name)
		cmd := strings.TrimSpace(item.Cmd)
		if name == "" || cmd == "" {
			continue
		}
		if len([]rune(name)) > 80 {
			name = string([]rune(name)[:80])
		}
		if len([]rune(cmd)) > 20000 {
			cmd = string([]rune(cmd)[:20000])
		}
		out = append(out, ScriptBookmark{Name: name, Cmd: cmd})
		if len(out) >= 500 {
			break
		}
	}
	return out
}

func scriptsEqual(a, b []ScriptBookmark) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name || a[i].Cmd != b[i].Cmd {
			return false
		}
	}
	return true
}

func GetScriptBookmarks(c *gin.Context) {
	username, ok := requireAccount(c)
	if !ok {
		return
	}
	accountStore.mu.Lock()
	scripts := accountStore.db.Scripts[username]
	accountStore.mu.Unlock()
	if scripts.Items == nil {
		scripts.Items = []ScriptBookmark{}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"scripts": scripts.Items, "updatedAt": scripts.UpdatedAt}})
}

func SyncScriptBookmarks(c *gin.Context) {
	username, ok := requireAccount(c)
	if !ok {
		return
	}
	var req struct {
		Scripts   []ScriptBookmark `json:"scripts"`
		UpdatedAt int64            `json:"updatedAt"`
		Mode      string           `json:"mode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "auto"
	}
	localItems := sanitizeScriptBookmarks(req.Scripts)
	localUpdatedAt := req.UpdatedAt

	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()

	cloud := accountStore.db.Scripts[username]
	if cloud.Items == nil {
		cloud.Items = []ScriptBookmark{}
	}
	resultMode := "same"
	result := cloud

	shouldPush := mode == "push" ||
		(mode == "auto" && (localUpdatedAt > cloud.UpdatedAt || (cloud.UpdatedAt == 0 && len(localItems) > 0)))
	shouldPull := mode == "pull" || (mode == "auto" && cloud.UpdatedAt > localUpdatedAt)

	if shouldPush {
		now := time.Now().UnixMilli()
		if localUpdatedAt > now {
			now = localUpdatedAt
		}
		result = StoredScripts{Items: localItems, UpdatedAt: now}
		accountStore.db.Scripts[username] = result
		if err := accountStore.saveLocked(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "云端书签保存失败"})
			return
		}
		resultMode = "push"
	} else if shouldPull {
		resultMode = "pull"
	} else if mode == "auto" && !scriptsEqual(localItems, cloud.Items) && localUpdatedAt == cloud.UpdatedAt {
		now := time.Now().UnixMilli()
		result = StoredScripts{Items: localItems, UpdatedAt: now}
		accountStore.db.Scripts[username] = result
		if err := accountStore.saveLocked(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "云端书签保存失败"})
			return
		}
		resultMode = "push"
	}

	if result.Items == nil {
		result.Items = []ScriptBookmark{}
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":  true,
		"msg": "同步完成",
		"data": gin.H{
			"mode":      resultMode,
			"scripts":   result.Items,
			"updatedAt": result.UpdatedAt,
			"count":     len(result.Items),
		},
	})
}
