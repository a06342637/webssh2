package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

const (
	sessionCookieName   = "webssh_session"
	minPasswordLen      = 7
	maxPasswordBytes    = 72
	maxScriptBookmarks  = 500
	maxScriptCategories = 100
)

var (
	accountStore *AccountStore
	usernameRule = regexp.MustCompile(`^[A-Za-z0-9]{5,32}$`)
	versionRule  = regexp.MustCompile(`^\d+(?:\.\d+){1,3}$`)
	updaterRule  = regexp.MustCompile(`^webssh-updater-[0-9]+$`)
	updateMu     sync.Mutex
	// A real bcrypt hash keeps unknown-user login attempts on the same expensive
	// comparison path as known users, reducing username timing disclosure.
	dummyPasswordHash = []byte("$2a$10$n/xeHI5pTVU2jCXvFHTKEO079VngBOppyqH06LHfVOsKK4YD81JmO")
)

type StoredUser struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
	CreatedAt    int64  `json:"createdAt"`
	IsAdmin      bool   `json:"isAdmin"`
}

type StoredSession struct {
	Username  string `json:"username"`
	ExpiresAt int64  `json:"expiresAt"`
}

type ScriptBookmark struct {
	Name       string `json:"name"`
	Cmd        string `json:"cmd"`
	CategoryID string `json:"categoryId,omitempty"`
	UseCount   int    `json:"useCount,omitempty"`
	LastUsed   int64  `json:"lastUsed,omitempty"`
}

type ScriptCategory struct {
	ID        string `json:"id"`
	Emoji     string `json:"emoji"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt,omitempty"`
}

type StoredScripts struct {
	Items      []ScriptBookmark `json:"items"`
	Categories []ScriptCategory `json:"categories,omitempty"`
	UpdatedAt  int64            `json:"updatedAt"`
}

type accountSummary struct {
	Username     string `json:"username"`
	CreatedAt    int64  `json:"createdAt"`
	IsAdmin      bool   `json:"isAdmin"`
	ScriptCount  int    `json:"scriptCount"`
	SessionCount int    `json:"sessionCount"`
	Current      bool   `json:"current"`
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
	if err := os.Chmod(dataDir, 0700); err != nil {
		return err
	}
	store := &AccountStore{path: filepath.Join(dataDir, "webssh-db.json")}
	store.ensureMaps()
	if err := store.load(); err != nil {
		return err
	}
	store.mu.Lock()
	store.cleanupExpiredSessionsLocked(time.Now().Unix())
	if err := store.ensureDefaultAdminLocked(); err != nil {
		store.mu.Unlock()
		return err
	}
	if err := store.saveLocked(); err != nil {
		store.mu.Unlock()
		return err
	}
	store.mu.Unlock()
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

	// saveLocked 在替换数据库前会保留备份。若进程恰好在替换期间退出，
	// 下次启动优先恢复旧文件，避免把账号数据误判为空。
	backup := s.path + ".bak"
	if _, err := os.Stat(s.path); errors.Is(err, os.ErrNotExist) {
		if _, backupErr := os.Stat(backup); backupErr == nil {
			if restoreErr := os.Rename(backup, s.path); restoreErr != nil {
				return fmt.Errorf("恢复账号数据库备份失败: %w", restoreErr)
			}
		} else if !errors.Is(backupErr, os.ErrNotExist) {
			return backupErr
		}
	} else if err != nil {
		return err
	}

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

func cloneAccountDB(db accountDB) accountDB {
	cloned := accountDB{
		Users:    make(map[string]StoredUser, len(db.Users)),
		Sessions: make(map[string]StoredSession, len(db.Sessions)),
		Scripts:  make(map[string]StoredScripts, len(db.Scripts)),
	}
	for username, user := range db.Users {
		cloned.Users[username] = user
	}
	for token, session := range db.Sessions {
		cloned.Sessions[token] = session
	}
	for username, scripts := range db.Scripts {
		scripts.Items = append([]ScriptBookmark(nil), scripts.Items...)
		scripts.Categories = append([]ScriptCategory(nil), scripts.Categories...)
		cloned.Scripts[username] = scripts
	}
	return cloned
}

func (s *AccountStore) snapshotLocked() accountDB {
	s.ensureMaps()
	return cloneAccountDB(s.db)
}

func (s *AccountStore) restoreLocked(snapshot accountDB) {
	s.db = snapshot
	s.ensureMaps()
}

func (s *AccountStore) saveLocked() error {
	s.ensureMaps()
	b, err := json.MarshalIndent(s.db, "", "  ")
	if err != nil {
		return err
	}

	dir := filepath.Dir(s.path)
	tmpFile, err := os.CreateTemp(dir, filepath.Base(s.path)+".tmp-*")
	if err != nil {
		return err
	}
	tmp := tmpFile.Name()
	defer os.Remove(tmp)
	if err := tmpFile.Chmod(0600); err != nil {
		tmpFile.Close()
		return err
	}
	if _, err := tmpFile.Write(b); err != nil {
		tmpFile.Close()
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		tmpFile.Close()
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}

	if _, err := os.Stat(s.path); errors.Is(err, os.ErrNotExist) {
		return os.Rename(tmp, s.path)
	} else if err != nil {
		return err
	}

	backup := s.path + ".bak"
	if err := os.Remove(backup); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.Rename(s.path, backup); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.path); err != nil {
		if restoreErr := os.Rename(backup, s.path); restoreErr != nil {
			return fmt.Errorf("替换账号数据库失败: %v；恢复旧数据库也失败: %w", err, restoreErr)
		}
		return err
	}
	_ = os.Remove(backup)
	return nil
}

func (s *AccountStore) cleanupExpiredSessionsLocked(now int64) {
	for token, sess := range s.db.Sessions {
		if sess.ExpiresAt <= now {
			delete(s.db.Sessions, token)
		}
	}
}

func randomPassword(length int) (string, error) {
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
	if length < 12 {
		length = 12
	}
	b := make([]byte, length)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b), nil
}

func adminUsernameFromEnv() string {
	username := strings.TrimSpace(os.Getenv("WEBSSH_ADMIN_USER"))
	if username == "" {
		username = "admin"
	}
	username = strings.ToLower(username)
	if !usernameRule.MatchString(username) {
		fmt.Printf("WEBSSH_ADMIN_USER=%q 无效，已回退为 admin。管理员用户名只能使用 5-32 位字母或数字。\n", username)
		return "admin"
	}
	return username
}

func adminResetRequested() bool {
	for _, key := range []string{"WEBSSH_ADMIN_RESET", "WEBSSH_ADMIN_RESET_PASSWORD"} {
		if value := strings.TrimSpace(os.Getenv(key)); value != "" {
			if value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes") {
				return true
			}
		}
	}
	return false
}

func (s *AccountStore) hasAdminLocked() bool {
	for _, user := range s.db.Users {
		if user.IsAdmin {
			return true
		}
	}
	return false
}

func (s *AccountStore) adminCountLocked() int {
	count := 0
	for _, user := range s.db.Users {
		if user.IsAdmin {
			count++
		}
	}
	return count
}

func (s *AccountStore) accountSummariesLocked(currentUsername string) []accountSummary {
	s.ensureMaps()
	now := time.Now().Unix()
	sessionCounts := map[string]int{}
	for _, sess := range s.db.Sessions {
		if sess.ExpiresAt > now {
			sessionCounts[sess.Username]++
		}
	}
	users := make([]accountSummary, 0, len(s.db.Users))
	for _, user := range s.db.Users {
		scripts := s.db.Scripts[user.Username]
		users = append(users, accountSummary{
			Username:     user.Username,
			CreatedAt:    user.CreatedAt,
			IsAdmin:      user.IsAdmin,
			ScriptCount:  len(scripts.Items),
			SessionCount: sessionCounts[user.Username],
			Current:      user.Username == currentUsername,
		})
	}
	sort.Slice(users, func(i, j int) bool {
		if users[i].IsAdmin != users[j].IsAdmin {
			return users[i].IsAdmin
		}
		return users[i].Username < users[j].Username
	})
	return users
}

func (s *AccountStore) deleteUserSessionsLocked(username, exceptToken string) {
	for token, sess := range s.db.Sessions {
		if sess.Username == username && token != exceptToken {
			delete(s.db.Sessions, token)
		}
	}
}

func (s *AccountStore) saveAdminLocked(username, password string, created bool) error {
	if msg := validatePassword(password); msg != "" {
		return fmt.Errorf("invalid administrator password: %s", msg)
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}
	user := s.db.Users[username]
	createdAt := user.CreatedAt
	if created || createdAt == 0 {
		createdAt = time.Now().UnixMilli()
	}
	s.db.Users[username] = StoredUser{
		Username:     username,
		PasswordHash: string(hash),
		CreatedAt:    createdAt,
		IsAdmin:      true,
	}
	return nil
}

func (s *AccountStore) ensureDefaultAdminLocked() error {
	username := adminUsernameFromEnv()
	password := os.Getenv("WEBSSH_ADMIN_PASSWORD")
	if password != "" {
		if msg := validatePassword(password); msg != "" {
			return fmt.Errorf("WEBSSH_ADMIN_PASSWORD %s", msg)
		}
	}
	if adminResetRequested() {
		if password == "" {
			fmt.Println("WEBSSH_ADMIN_RESET=true 但 WEBSSH_ADMIN_PASSWORD 为空，已跳过书签管理员密码重置。")
		} else {
			if err := s.saveAdminLocked(username, password, false); err != nil {
				return err
			}
			// Docker/环境变量重置密码属于管理员恢复操作，旧会话必须全部失效。
			s.deleteUserSessionsLocked(username, "")
			fmt.Println("============================================================")
			fmt.Println("WebSSH 管理员密码（脚本书签/账号同步管理员）已重置")
			fmt.Printf("用户名: %s\n", username)
			fmt.Println("密码: 已设置为 WEBSSH_ADMIN_PASSWORD 环境变量的值")
			fmt.Println("用途: 登录账号同步、同步脚本书签和 Emoji 分类，并管理账号与页面更新")
			fmt.Println("注意: 这不是 SSH 服务器账号，也不是 Web 页面登录验证账号")
			fmt.Println("建议重置完成后移除 WEBSSH_ADMIN_RESET，避免每次重启重复重置。")
			fmt.Println("============================================================")
			return nil
		}
	}
	if s.hasAdminLocked() {
		return nil
	}
	generated := false
	if password == "" {
		var err error
		password, err = randomPassword(16)
		if err != nil {
			return err
		}
		generated = true
	}
	if err := s.saveAdminLocked(username, password, true); err != nil {
		return err
	}
	fmt.Println("============================================================")
	fmt.Println("WebSSH 管理员账号（脚本书签/账号同步管理员）已初始化")
	fmt.Println("用途: 登录账号同步、同步脚本书签和 Emoji 分类，并管理账号与页面更新")
	fmt.Println("注意: 这不是 SSH 服务器账号，也不是 Web 页面登录验证账号")
	fmt.Printf("用户名: %s\n", username)
	if generated {
		fmt.Printf("密码: %s\n", password)
		fmt.Println("该随机密码只会在首次创建时打印到 Docker 日志，请立即保存并登录后修改。")
	} else {
		fmt.Println("密码: 已使用 WEBSSH_ADMIN_PASSWORD 设置，为安全起见不在日志中显示。")
	}
	fmt.Println("============================================================")
	return nil
}

func normalizeAccountUsername(username string) (string, string) {
	username = strings.TrimSpace(username)
	if !usernameRule.MatchString(username) {
		return "", "用户名只能使用 5-32 位字母或数字"
	}
	return strings.ToLower(username), ""
}

func validatePassword(password string) string {
	if utf8.RuneCountInString(password) < minPasswordLen {
		return "密码必须大于 6 位"
	}
	// bcrypt rejects inputs larger than 72 bytes. Validate explicitly so every
	// password-writing endpoint returns a clear 400 instead of a 500 error.
	if len(password) > maxPasswordBytes {
		return "密码不能超过 72 个 UTF-8 字节"
	}
	return ""
}

func validateAccount(username, password string) (string, string, string) {
	username, msg := normalizeAccountUsername(username)
	if msg != "" {
		return "", "", msg
	}
	if msg := validatePassword(password); msg != "" {
		return "", "", msg
	}
	return username, password, ""
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
	if !ok {
		// An arbitrary/forged cookie must not rewrite the whole account database.
		return "", false
	}
	if sess.ExpiresAt <= now {
		before := accountStore.snapshotLocked()
		delete(accountStore.db.Sessions, token)
		if err := accountStore.saveLocked(); err != nil {
			accountStore.restoreLocked(before)
		}
		return "", false
	}
	if _, ok := accountStore.db.Users[sess.Username]; !ok {
		before := accountStore.snapshotLocked()
		delete(accountStore.db.Sessions, token)
		if err := accountStore.saveLocked(); err != nil {
			accountStore.restoreLocked(before)
		}
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

func requireAdmin(c *gin.Context) (string, bool) {
	username, ok := requireAccount(c)
	if !ok {
		return "", false
	}
	accountStore.mu.Lock()
	user := accountStore.db.Users[username]
	accountStore.mu.Unlock()
	if !user.IsAdmin {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "msg": "请登录管理员账号后使用"})
		return "", false
	}
	return username, true
}

func createLoginSession(username string) (string, time.Time, error) {
	accountStore.cleanupExpiredSessionsLocked(time.Now().Unix())
	for {
		count := 0
		oldestToken := ""
		oldestExpiry := int64(1<<63 - 1)
		for existingToken, session := range accountStore.db.Sessions {
			if session.Username == username {
				count++
				if session.ExpiresAt < oldestExpiry {
					oldestExpiry = session.ExpiresAt
					oldestToken = existingToken
				}
			}
		}
		if count < maxActiveSessions() || oldestToken == "" {
			break
		}
		delete(accountStore.db.Sessions, oldestToken)
	}
	token, err := newSessionToken()
	if err != nil {
		return "", time.Time{}, err
	}
	expires := time.Now().Add(30 * 24 * time.Hour)
	accountStore.db.Sessions[token] = StoredSession{Username: username, ExpiresAt: expires.Unix()}
	return token, expires, nil
}

func AuthRegister(c *gin.Context) {
	if !AllowRegistration() {
		c.JSON(http.StatusForbidden, gin.H{"ok": false, "msg": "公开注册已关闭，请联系管理员创建账号"})
		return
	}
	if !allowAuthAttempt(c, "register", 5, time.Hour) {
		return
	}
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
	if len(accountStore.db.Users) >= maxAccountCount() {
		c.JSON(http.StatusConflict, gin.H{"ok": false, "msg": "账号数量已达到上限，请联系管理员"})
		return
	}
	before := accountStore.snapshotLocked()
	accountStore.db.Users[username] = StoredUser{
		Username:     username,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UnixMilli(),
		IsAdmin:      false,
	}
	token, expires, err := createLoginSession(username)
	if err != nil {
		accountStore.restoreLocked(before)
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录会话创建失败"})
		return
	}
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号保存失败"})
		return
	}
	setLoginCookie(c, token, expires)
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "注册成功", "data": gin.H{"username": username, "isAdmin": false}})
}

func AuthLogin(c *gin.Context) {
	if !allowAuthAttempt(c, "login", 30, time.Minute) {
		return
	}
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
	user, exists := accountStore.db.Users[username]
	accountStore.mu.Unlock()
	passwordHash := dummyPasswordHash
	if exists {
		passwordHash = []byte(user.PasswordHash)
	}
	passwordOK := bcrypt.CompareHashAndPassword(passwordHash, []byte(password)) == nil
	if !exists || !passwordOK {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "用户名或密码错误"})
		return
	}

	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	currentUser, stillExists := accountStore.db.Users[username]
	if !stillExists || currentUser.PasswordHash != user.PasswordHash {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "用户名或密码错误"})
		return
	}
	before := accountStore.snapshotLocked()
	token, expires, err := createLoginSession(username)
	if err != nil {
		accountStore.restoreLocked(before)
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录会话创建失败"})
		return
	}
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "登录状态保存失败"})
		return
	}
	setLoginCookie(c, token, expires)
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "登录成功", "data": gin.H{"username": username, "isAdmin": currentUser.IsAdmin}})
}

func AuthChangePassword(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号数据库未初始化"})
		return
	}
	username, ok := requireAccount(c)
	if !ok {
		return
	}
	var req struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	oldPassword := req.OldPassword
	newPassword := req.NewPassword
	if oldPassword == "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请输入当前密码"})
		return
	}
	if msg := validatePassword(newPassword); msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
		return
	}

	accountStore.mu.Lock()
	user, exists := accountStore.db.Users[username]
	accountStore.mu.Unlock()
	if !exists {
		clearLoginCookie(c)
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "账号不存在，请重新登录"})
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(oldPassword)) != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "当前密码错误"})
		return
	}
	verifiedPasswordHash := user.PasswordHash
	hash, err := bcrypt.GenerateFromPassword([]byte(newPassword), bcrypt.DefaultCost)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "密码处理失败"})
		return
	}

	currentToken, _ := c.Cookie(sessionCookieName)
	accountStore.mu.Lock()
	user, exists = accountStore.db.Users[username]
	if !exists {
		accountStore.mu.Unlock()
		clearLoginCookie(c)
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "账号不存在，请重新登录"})
		return
	}
	if user.PasswordHash != verifiedPasswordHash {
		accountStore.mu.Unlock()
		c.JSON(http.StatusConflict, gin.H{"ok": false, "msg": "密码已被其他操作修改，请重新登录后再试"})
		return
	}
	before := accountStore.snapshotLocked()
	user.PasswordHash = string(hash)
	accountStore.db.Users[username] = user
	for token, sess := range accountStore.db.Sessions {
		if sess.Username == username && token != currentToken {
			delete(accountStore.db.Sessions, token)
		}
	}
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		accountStore.mu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "密码保存失败"})
		return
	}
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "密码已修改"})
}

func AuthLogout(c *gin.Context) {
	if accountStore != nil {
		if token, err := c.Cookie(sessionCookieName); err == nil && token != "" {
			accountStore.mu.Lock()
			if _, exists := accountStore.db.Sessions[token]; exists {
				before := accountStore.snapshotLocked()
				delete(accountStore.db.Sessions, token)
				if err := accountStore.saveLocked(); err != nil {
					accountStore.restoreLocked(before)
					accountStore.mu.Unlock()
					c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "退出登录状态保存失败，请重试"})
					return
				}
			}
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
	accountStore.mu.Lock()
	user := accountStore.db.Users[username]
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"loggedIn": true, "username": username, "isAdmin": user.IsAdmin}})
}

func AdminListAccounts(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}
	accountStore.mu.Lock()
	users := accountStore.accountSummariesLocked(adminUsername)
	adminCount := accountStore.adminCountLocked()
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"users": users, "adminCount": adminCount}})
}

func AdminCreateAccount(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		IsAdmin  bool   `json:"isAdmin"`
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
	if _, exists := accountStore.db.Users[username]; exists {
		accountStore.mu.Unlock()
		c.JSON(http.StatusConflict, gin.H{"ok": false, "msg": "用户名已存在"})
		return
	}
	if len(accountStore.db.Users) >= maxAccountCount() {
		accountStore.mu.Unlock()
		c.JSON(http.StatusConflict, gin.H{"ok": false, "msg": "账号数量已达到上限"})
		return
	}
	before := accountStore.snapshotLocked()
	accountStore.db.Users[username] = StoredUser{
		Username:     username,
		PasswordHash: string(hash),
		CreatedAt:    time.Now().UnixMilli(),
		IsAdmin:      req.IsAdmin,
	}
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		accountStore.mu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号保存失败"})
		return
	}
	users := accountStore.accountSummariesLocked(adminUsername)
	adminCount := accountStore.adminCountLocked()
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "账号已创建", "data": gin.H{"users": users, "adminCount": adminCount}})
}

func AdminUpdateAccount(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
		IsAdmin  *bool  `json:"isAdmin"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	username, msg := normalizeAccountUsername(req.Username)
	if msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
		return
	}
	password := req.Password
	if password != "" {
		if msg := validatePassword(password); msg != "" {
			c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
			return
		}
	}
	var hash []byte
	var err error
	if password != "" {
		hash, err = bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "密码处理失败"})
			return
		}
	}
	currentToken, _ := c.Cookie(sessionCookieName)

	accountStore.mu.Lock()
	user, exists := accountStore.db.Users[username]
	if !exists {
		accountStore.mu.Unlock()
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "账号不存在"})
		return
	}
	if req.IsAdmin != nil && user.IsAdmin && !*req.IsAdmin && accountStore.adminCountLocked() <= 1 {
		accountStore.mu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "至少需要保留一个管理员账号"})
		return
	}
	before := accountStore.snapshotLocked()
	if req.IsAdmin != nil {
		user.IsAdmin = *req.IsAdmin
	}
	if password != "" {
		user.PasswordHash = string(hash)
		accountStore.deleteUserSessionsLocked(username, currentToken)
	}
	accountStore.db.Users[username] = user
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		accountStore.mu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号保存失败"})
		return
	}
	users := accountStore.accountSummariesLocked(adminUsername)
	adminCount := accountStore.adminCountLocked()
	accountStore.mu.Unlock()
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "账号已更新", "data": gin.H{"users": users, "adminCount": adminCount}})
}

func AdminDeleteAccount(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}
	username, msg := normalizeAccountUsername(c.Param("username"))
	if msg != "" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": msg})
		return
	}

	accountStore.mu.Lock()
	user, exists := accountStore.db.Users[username]
	if !exists {
		accountStore.mu.Unlock()
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "账号不存在"})
		return
	}
	if user.IsAdmin && accountStore.adminCountLocked() <= 1 {
		accountStore.mu.Unlock()
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "至少需要保留一个管理员账号"})
		return
	}
	before := accountStore.snapshotLocked()
	delete(accountStore.db.Users, username)
	delete(accountStore.db.Scripts, username)
	accountStore.deleteUserSessionsLocked(username, "")
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		accountStore.mu.Unlock()
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "账号删除失败"})
		return
	}
	users := accountStore.accountSummariesLocked(adminUsername)
	adminCount := accountStore.adminCountLocked()
	accountStore.mu.Unlock()
	if username == adminUsername {
		clearLoginCookie(c)
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "账号已删除", "data": gin.H{"users": users, "adminCount": adminCount}})
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
		categoryID := strings.TrimSpace(item.CategoryID)
		if len([]rune(categoryID)) > 80 {
			categoryID = string([]rune(categoryID)[:80])
		}
		useCount := item.UseCount
		if useCount < 0 {
			useCount = 0
		}
		lastUsed := item.LastUsed
		if lastUsed < 0 {
			lastUsed = 0
		}
		out = append(out, ScriptBookmark{Name: name, Cmd: cmd, CategoryID: categoryID, UseCount: useCount, LastUsed: lastUsed})
		if len(out) >= maxScriptBookmarks {
			break
		}
	}
	return out
}

func sanitizeScriptCategories(items []ScriptCategory) []ScriptCategory {
	out := make([]ScriptCategory, 0, len(items))
	seenIDs := make(map[string]bool)
	for _, item := range items {
		id := strings.TrimSpace(item.ID)
		name := strings.TrimSpace(item.Name)
		emoji := strings.TrimSpace(item.Emoji)
		if len([]rune(id)) > 80 {
			id = string([]rune(id)[:80])
		}
		if id == "" || name == "" || seenIDs[id] {
			continue
		}
		if len([]rune(name)) > 40 {
			name = string([]rune(name)[:40])
		}
		if len([]rune(emoji)) > 8 {
			emoji = string([]rune(emoji)[:8])
		}
		if emoji == "" {
			emoji = "📁"
		}
		seenIDs[id] = true
		out = append(out, ScriptCategory{ID: id, Emoji: emoji, Name: name, CreatedAt: item.CreatedAt})
		if len(out) >= maxScriptCategories {
			break
		}
	}
	return out
}

func sanitizeScriptCategoryReferences(items []ScriptBookmark, categories []ScriptCategory) []ScriptBookmark {
	valid := make(map[string]struct{}, len(categories))
	for _, category := range categories {
		valid[category.ID] = struct{}{}
	}
	for i := range items {
		if items[i].CategoryID == "" {
			continue
		}
		if _, ok := valid[items[i].CategoryID]; !ok {
			items[i].CategoryID = ""
		}
	}
	return items
}

func sanitizeScriptUpdatedAt(updatedAt, now int64) int64 {
	if updatedAt < 0 {
		return 0
	}
	// 客户端或旧云端数据只要领先服务端时钟，就可能让后续修改长时间无法推送。
	// 服务端时间是同步仲裁基准，因此统一截断到当前服务端时间。
	if updatedAt > now {
		return now
	}
	return updatedAt
}

func scriptsEqual(a, b []ScriptBookmark) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Name != b[i].Name || a[i].Cmd != b[i].Cmd || a[i].CategoryID != b[i].CategoryID || a[i].UseCount != b[i].UseCount || a[i].LastUsed != b[i].LastUsed {
			return false
		}
	}
	return true
}

func scriptCategoriesEqual(a, b []ScriptCategory) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID || a[i].Emoji != b[i].Emoji || a[i].Name != b[i].Name || a[i].CreatedAt != b[i].CreatedAt {
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
	scripts.Categories = sanitizeScriptCategories(scripts.Categories)
	scripts.Items = sanitizeScriptCategoryReferences(sanitizeScriptBookmarks(scripts.Items), scripts.Categories)
	scripts.UpdatedAt = sanitizeScriptUpdatedAt(scripts.UpdatedAt, time.Now().UnixMilli())
	if scripts.Items == nil {
		scripts.Items = []ScriptBookmark{}
	}
	if scripts.Categories == nil {
		scripts.Categories = []ScriptCategory{}
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"scripts": scripts.Items, "categories": scripts.Categories, "updatedAt": scripts.UpdatedAt}})
}

func SyncScriptBookmarks(c *gin.Context) {
	username, ok := requireAccount(c)
	if !ok {
		return
	}
	var req struct {
		Scripts    []ScriptBookmark `json:"scripts"`
		Categories []ScriptCategory `json:"categories"`
		UpdatedAt  int64            `json:"updatedAt"`
		Mode       string           `json:"mode"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	mode := strings.ToLower(strings.TrimSpace(req.Mode))
	if mode == "" {
		mode = "auto"
	}
	if mode != "auto" && mode != "push" && mode != "pull" {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "同步模式只支持 auto、push 或 pull"})
		return
	}
	localCategories := sanitizeScriptCategories(req.Categories)
	localItems := sanitizeScriptCategoryReferences(sanitizeScriptBookmarks(req.Scripts), localCategories)
	serverNow := time.Now().UnixMilli()
	localUpdatedAt := sanitizeScriptUpdatedAt(req.UpdatedAt, serverNow)

	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()

	cloud := accountStore.db.Scripts[username]
	cloud.Categories = sanitizeScriptCategories(cloud.Categories)
	cloud.Items = sanitizeScriptCategoryReferences(sanitizeScriptBookmarks(cloud.Items), cloud.Categories)
	cloud.UpdatedAt = sanitizeScriptUpdatedAt(cloud.UpdatedAt, serverNow)
	if cloud.Items == nil {
		cloud.Items = []ScriptBookmark{}
	}
	if cloud.Categories == nil {
		cloud.Categories = []ScriptCategory{}
	}
	resultMode := "same"
	result := cloud

	shouldPush := mode == "push" ||
		(mode == "auto" && (localUpdatedAt > cloud.UpdatedAt || (cloud.UpdatedAt == 0 && (len(localItems) > 0 || len(localCategories) > 0))))
	shouldPull := mode == "pull" || (mode == "auto" && cloud.UpdatedAt > localUpdatedAt)

	if shouldPush {
		now := serverNow
		if localUpdatedAt > now {
			now = localUpdatedAt
		}
		result = StoredScripts{Items: localItems, Categories: localCategories, UpdatedAt: now}
		before := accountStore.snapshotLocked()
		accountStore.db.Scripts[username] = result
		if err := accountStore.saveLocked(); err != nil {
			accountStore.restoreLocked(before)
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "云端书签保存失败"})
			return
		}
		resultMode = "push"
	} else if shouldPull {
		resultMode = "pull"
	} else if mode == "auto" && (!scriptsEqual(localItems, cloud.Items) || !scriptCategoriesEqual(localCategories, cloud.Categories)) && localUpdatedAt == cloud.UpdatedAt {
		now := time.Now().UnixMilli()
		result = StoredScripts{Items: localItems, Categories: localCategories, UpdatedAt: now}
		before := accountStore.snapshotLocked()
		accountStore.db.Scripts[username] = result
		if err := accountStore.saveLocked(); err != nil {
			accountStore.restoreLocked(before)
			c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "云端书签保存失败"})
			return
		}
		resultMode = "push"
	}

	if result.Items == nil {
		result.Items = []ScriptBookmark{}
	}
	if result.Categories == nil {
		result.Categories = []ScriptCategory{}
	}
	c.JSON(http.StatusOK, gin.H{
		"ok":  true,
		"msg": "同步完成",
		"data": gin.H{
			"mode":       resultMode,
			"scripts":    result.Items,
			"categories": result.Categories,
			"updatedAt":  result.UpdatedAt,
			"count":      len(result.Items),
		},
	})
}

func sourceDir() string {
	if v := strings.TrimSpace(os.Getenv("WEBSSH_SOURCE_DIR")); v != "" {
		return v
	}
	return "/app/source"
}

func hostProjectDir() string {
	return strings.TrimSpace(os.Getenv("WEBSSH_HOST_PROJECT_DIR"))
}

func validHostProjectDir(dir string) bool {
	return dir != "" && dir != "." && filepath.IsAbs(dir)
}

func cleanAppVersion(value, fallback string) string {
	value = strings.TrimSpace(value)
	if idx := strings.IndexAny(value, "\r\n"); idx >= 0 {
		value = strings.TrimSpace(value[:idx])
	}
	if versionRule.MatchString(value) {
		return value
	}
	fallback = strings.TrimSpace(fallback)
	if versionRule.MatchString(fallback) {
		return fallback
	}
	return "0.0.0"
}

func localAppVersion(dir string) string {
	if dir != "" {
		if data, err := os.ReadFile(filepath.Join(dir, "VERSION")); err == nil {
			return cleanAppVersion(string(data), AppVersion)
		}
	}
	return cleanAppVersion(AppVersion, "0.0.0")
}

func gitRefAppVersion(ctx context.Context, dir, ref, fallback string) string {
	out, err := gitOutput(ctx, dir, "show", ref+":VERSION")
	if err != nil {
		return fallback
	}
	return cleanAppVersion(out, fallback)
}

func versionDisplayInfo(currentVersion, latestVersion string) gin.H {
	currentVersion = cleanAppVersion(currentVersion, AppVersion)
	latestVersion = cleanAppVersion(latestVersion, currentVersion)
	return gin.H{
		"current":        currentVersion,
		"currentShort":   currentVersion,
		"currentVersion": currentVersion,
		"latest":         latestVersion,
		"latestShort":    latestVersion,
		"latestVersion":  latestVersion,
	}
}

func selfUpdateEnabled() bool {
	value := strings.TrimSpace(os.Getenv("WEBSSH_ENABLE_SELF_UPDATE"))
	return value == "1" || strings.EqualFold(value, "true") || strings.EqualFold(value, "yes")
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", "'\"'\"'") + "'"
}

func gitOutput(ctx context.Context, dir string, args ...string) (string, error) {
	cmdArgs := append([]string{"-C", dir}, args...)
	cmd := exec.CommandContext(ctx, "git", cmdArgs...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func dockerOutput(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func currentGitBranch(ctx context.Context, dir string) string {
	branch, err := gitOutput(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
	branch = strings.TrimSpace(branch)
	if err == nil && branch != "" && branch != "HEAD" {
		return branch
	}
	remoteHead, err := gitOutput(ctx, dir, "symbolic-ref", "--short", "refs/remotes/origin/HEAD")
	remoteHead = strings.TrimSpace(remoteHead)
	if err == nil && strings.HasPrefix(remoteHead, "origin/") {
		return strings.TrimPrefix(remoteHead, "origin/")
	}
	return "main"
}

func currentDockerImage(ctx context.Context) (string, error) {
	candidates := []string{}
	if hostname := strings.TrimSpace(os.Getenv("HOSTNAME")); hostname != "" {
		candidates = append(candidates, hostname)
	}
	candidates = append(candidates, "webssh")
	var last string
	for _, name := range candidates {
		out, err := dockerOutput(ctx, "inspect", "-f", "{{.Config.Image}}", name)
		if err == nil && strings.TrimSpace(out) != "" {
			return strings.TrimSpace(out), nil
		}
		last = out
	}
	return "", fmt.Errorf("读取当前 Docker 镜像失败: %s", last)
}

func startUpdateHelper(ctx context.Context, force bool) (gin.H, error) {
	updateMu.Lock()
	defer updateMu.Unlock()
	if running, err := runningUpdateHelper(ctx); err != nil {
		return nil, err
	} else if running != "" {
		return nil, fmt.Errorf("更新任务 %s 正在运行，请等待完成", running)
	}
	cleanupFinishedUpdateHelpers(ctx)
	dir := sourceDir()
	hostDir := hostProjectDir()
	if !validHostProjectDir(hostDir) {
		return nil, errors.New("WEBSSH_HOST_PROJECT_DIR 未设置为宿主机绝对路径，无法安全执行页面更新。请使用 setup.sh 部署，或在 .env 中设置宿主机源码目录")
	}
	image, err := currentDockerImage(ctx)
	if err != nil {
		return nil, err
	}
	branch := currentGitBranch(ctx, dir)
	updaterName := fmt.Sprintf("webssh-updater-%d", time.Now().UnixNano())
	composeCmd := "docker compose up -d --build"
	if force {
		composeCmd += " --force-recreate"
	}
	gitUpdateCmd := strings.Join([]string{
		"log \"pull origin/$BRANCH (fast-forward only)\"",
		"git pull --ff-only origin \"$BRANCH\"",
	}, "\n")
	if force {
		gitUpdateCmd = strings.Join([]string{
			"log \"force update: reset tracked source files to $REMOTE_REF\"",
			"git rev-parse --verify \"$REMOTE_REF\" >/dev/null",
			"git reset --hard \"$REMOTE_REF\"",
		}, "\n")
	}
	script := strings.Join([]string{
		"set -eu",
		"umask 077",
		"log(){ printf '%s %s\\n' \"$(date '+%F %T')\" \"$*\"; }",
		"BRANCH=" + shellQuote(branch),
		"REMOTE_REF=\"refs/remotes/origin/$BRANCH\"",
		"cd " + shellQuote(hostDir),
		"log 'WebSSH update started'",
		"git config --global --add safe.directory " + shellQuote(hostDir) + " >/dev/null 2>&1 || true",
		"BACKUP_DIR=\"$PWD/.webssh-update-backups/$(date +%Y%m%d-%H%M%S)\"",
		"mkdir -p \"$BACKUP_DIR\"",
		"chmod 700 \"$PWD/.webssh-update-backups\" \"$BACKUP_DIR\"",
		"git status --short --branch > \"$BACKUP_DIR/git-status.txt\" || true",
		"git log --oneline --decorate --all -n 80 > \"$BACKUP_DIR/git-log.txt\" || true",
		"git diff > \"$BACKUP_DIR/git-diff.patch\" || true",
		"git diff --cached > \"$BACKUP_DIR/git-staged-diff.patch\" || true",
		"git rev-parse HEAD > \"$BACKUP_DIR/HEAD.txt\" || true",
		"git bundle create \"$BACKUP_DIR/repo-before-update.bundle\" --all >/dev/null 2>&1 || true",
		"if [ -f .env ]; then cp -a .env \"$BACKUP_DIR/.env.backup\"; chmod 600 \"$BACKUP_DIR/.env.backup\"; fi",
		"find \"$BACKUP_DIR\" -type f -exec chmod 600 {} +",
		"log \"backup saved to $BACKUP_DIR\"",
		"log 'checking git repository'",
		"git status --short || true",
		"log 'fetch origin'",
		"git fetch --prune origin \"$BRANCH\"",
		"if [ -f .git/shallow ]; then log 'repository is shallow; deepening history for safer update'; git fetch --unshallow origin \"$BRANCH\" || git fetch --deepen=1000 origin \"$BRANCH\" || true; fi",
		gitUpdateCmd,
		"log \"source is now $(git rev-parse --short HEAD)\"",
		"if [ -f docker-compose.update.yml ] && [ -f .env ] && grep -Eqi '^WEBSSH_ENABLE_SELF_UPDATE=(true|1|yes)$' .env; then export COMPOSE_FILE=docker-compose.yml:docker-compose.update.yml; fi",
		"log 'docker compose version'",
		"docker compose version",
		"log 'docker compose build/up'",
		composeCmd,
		"log 'WebSSH update finished'",
	}, "\n")
	out, err := dockerOutput(ctx,
		"run", "-d",
		"--name", updaterName,
		"--label", "webssh.updater=true",
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-v", hostDir+":"+hostDir,
		"-w", hostDir,
		"-e", "WEBSSH_HOST_PROJECT_DIR="+hostDir,
		"-e", "WEBSSH_SOURCE_DIR="+dir,
		"--entrypoint", "sh",
		image,
		"-lc", script,
	)
	if err != nil {
		return nil, fmt.Errorf("启动更新助手失败: %s", out)
	}
	return gin.H{
		"updater":   updaterName,
		"container": out,
		"sourceDir": dir,
		"hostDir":   hostDir,
		"branch":    branch,
	}, nil
}

func runningUpdateHelper(ctx context.Context) (string, error) {
	out, err := dockerOutput(ctx, "ps", "-a", "--filter", "label=webssh.updater=true", "--filter", "status=running", "--filter", "status=created", "--format", "{{.Names}}")
	if err != nil {
		return "", fmt.Errorf("检查更新任务失败: %s", out)
	}
	for _, name := range strings.Fields(out) {
		if updaterRule.MatchString(name) {
			return name, nil
		}
	}
	return "", nil
}

func cleanupFinishedUpdateHelpers(ctx context.Context) {
	out, err := dockerOutput(ctx, "ps", "-a", "--filter", "label=webssh.updater=true", "--filter", "status=exited", "--format", "{{.Names}}")
	if err != nil {
		return
	}
	for _, name := range strings.Fields(out) {
		if updaterRule.MatchString(name) {
			_, _ = dockerOutput(ctx, "rm", name)
		}
	}
}

func latestUpdateHelper(ctx context.Context) string {
	out, err := dockerOutput(ctx, "ps", "-a", "--filter", "label=webssh.updater=true", "--format", "{{.Names}}")
	if err != nil {
		return ""
	}
	for _, name := range strings.Fields(out) {
		if updaterRule.MatchString(name) {
			return name
		}
	}
	return ""
}

func readUpdateStatus(ctx context.Context, name string) (gin.H, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = latestUpdateHelper(ctx)
	}
	if name == "" {
		return nil, errors.New("暂无更新任务")
	}
	if !updaterRule.MatchString(name) {
		return nil, errors.New("无效的更新任务名称")
	}
	label, err := dockerOutput(ctx, "inspect", "-f", "{{ index .Config.Labels \"webssh.updater\" }}", name)
	if err != nil || strings.TrimSpace(label) != "true" {
		return nil, errors.New("目标容器不是 WebSSH 更新任务")
	}
	state, err := dockerOutput(ctx, "inspect", "-f", "{{.State.Status}}|{{.State.ExitCode}}|{{.State.Error}}|{{.State.FinishedAt}}", name)
	if err != nil {
		return nil, fmt.Errorf("读取更新任务状态失败: %s", state)
	}
	parts := strings.SplitN(state, "|", 4)
	status := ""
	exitCode := ""
	stateErr := ""
	finishedAt := ""
	if len(parts) > 0 {
		status = parts[0]
	}
	if len(parts) > 1 {
		exitCode = parts[1]
	}
	if len(parts) > 2 {
		stateErr = parts[2]
	}
	if len(parts) > 3 {
		finishedAt = parts[3]
	}
	logs, _ := dockerOutput(ctx, "logs", "--tail", "220", name)
	return gin.H{
		"updater":    name,
		"status":     status,
		"exitCode":   exitCode,
		"error":      stateErr,
		"finishedAt": finishedAt,
		"logs":       logs,
		"running":    status == "running" || status == "created",
		"success":    status == "exited" && exitCode == "0",
		"failed":     status == "exited" && exitCode != "0",
	}, nil
}

func readVersionInfo() (gin.H, error) {
	dir := sourceDir()
	currentVersion := localAppVersion(dir)
	if !selfUpdateEnabled() {
		info := versionDisplayInfo(currentVersion, currentVersion)
		info["available"] = false
		info["sourceDir"] = dir
		info["msg"] = "当前部署未启用页面更新。Docker Compose 可开启 WEBSSH_ENABLE_SELF_UPDATE=true；Render/Railway 请使用平台重新部署。"
		return info, nil
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		info := versionDisplayInfo(currentVersion, currentVersion)
		info["available"] = false
		info["sourceDir"] = dir
		info["msg"] = "源代码目录未挂载，无法在线更新"
		return info, nil
	}
	if !validHostProjectDir(hostProjectDir()) {
		info := versionDisplayInfo(currentVersion, currentVersion)
		info["available"] = false
		info["sourceDir"] = dir
		info["msg"] = "WEBSSH_HOST_PROJECT_DIR 未设置为宿主机绝对路径，无法安全执行页面更新。请使用 setup.sh 部署，或在 .env 中设置宿主机源码目录。"
		return info, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()

	currentCommit, err := gitOutput(ctx, dir, "rev-parse", "HEAD")
	if err != nil {
		return nil, fmt.Errorf("读取当前版本失败: %s", currentCommit)
	}
	currentCommitShort, _ := gitOutput(ctx, dir, "rev-parse", "--short", "HEAD")
	branch := currentGitBranch(ctx, dir)
	remoteRef := "refs/heads/" + branch
	remoteURL, _ := gitOutput(ctx, dir, "remote", "get-url", "origin")
	latestLine, err := gitOutput(ctx, dir, "ls-remote", "origin", remoteRef)
	if err != nil {
		return nil, fmt.Errorf("检测远端版本失败: %s", latestLine)
	}
	latestFields := strings.Fields(latestLine)
	latestCommit := ""
	if len(latestFields) > 0 {
		latestCommit = latestFields[0]
	}
	latestCommitShort := latestCommit
	if len(latestCommitShort) > 12 {
		latestCommitShort = latestCommitShort[:12]
	}
	latestVersion := currentVersion
	if latestCommit != "" && latestCommit != currentCommit {
		if _, err := gitOutput(ctx, dir, "fetch", "--no-tags", "origin", remoteRef); err == nil {
			latestVersion = gitRefAppVersion(ctx, dir, "FETCH_HEAD", currentVersion)
		}
	}
	info := versionDisplayInfo(currentVersion, latestVersion)
	info["available"] = true
	info["sourceDir"] = dir
	info["hostDir"] = hostProjectDir()
	info["branch"] = branch
	info["remote"] = remoteURL
	info["currentCommit"] = currentCommit
	info["currentCommitShort"] = currentCommitShort
	info["latestCommit"] = latestCommit
	info["latestCommitShort"] = latestCommitShort
	info["hasUpdate"] = latestCommit != "" && latestCommit != currentCommit
	return info, nil
}

func AdminVersion(c *gin.Context) {
	if _, ok := requireAdmin(c); !ok {
		return
	}
	info, err := readVersionInfo()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": info})
}

func AdminUpdate(c *gin.Context) {
	if _, ok := requireAdmin(c); !ok {
		return
	}
	var req struct {
		Force bool `json:"force"`
	}
	_ = c.ShouldBindJSON(&req)
	info, err := readVersionInfo()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": err.Error()})
		return
	}
	if available, _ := info["available"].(bool); !available {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": info["msg"], "data": info})
		return
	}
	if !req.Force {
		if hasUpdate, _ := info["hasUpdate"].(bool); !hasUpdate {
			c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "当前已经是最新版本", "data": info})
			return
		}
	}
	dir := sourceDir()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	updateData, err := startUpdateHelper(ctx, req.Force)
	if err != nil {
		msg := err.Error()
		if len(msg) > 4000 {
			msg = msg[len(msg)-4000:]
		}
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "更新失败", "data": gin.H{"output": msg}})
		return
	}
	updateData["version"] = info
	updateData["sourceDir"] = dir
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "更新任务已启动，Docker 将自动重新构建并重启", "data": updateData})
}

func AdminUpdateStatus(c *gin.Context) {
	if _, ok := requireAdmin(c); !ok {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	status, err := readUpdateStatus(ctx, c.Query("updater"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": status})
}
