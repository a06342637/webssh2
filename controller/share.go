package controller

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// 隐私分享的服务端存储。
//
// 关键约束：服务端只保管密文，永远拿不到明文凭据。加密和解密都在浏览器里完成
// （AES-GCM，见 public/static/js/share.js），密钥只出现在分享链接的 # 之后，
// 而浏览器按规范不会把 fragment 发给服务器。所以即使这里的数据库整个泄漏，
// 也解不出任何一台服务器的账号密码。
//
// 存储键沿用 sessionStorageKey 的 sha256 模式：数据库里落的是 token 的哈希，
// 不是可以直接拿去用的 token 本身。

const (
	shareTokenBytes       = 18
	shareMaxCiphertextLen = 16 * 1024
	shareMaxIVLen         = 64
	shareMaxPerUser       = 50
	shareMinTTL           = int64(60)
	shareMaxTTL           = int64(7 * 24 * 60 * 60)
)

type StoredShare struct {
	Ciphertext string `json:"ciphertext"`
	IV         string `json:"iv"`
	Owner      string `json:"owner"`
	CreatedAt  int64  `json:"createdAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	Burn       bool   `json:"burn,omitempty"`
}

func shareStorageKey(token string) string {
	digest := sha256.Sum256([]byte(token))
	return "sha256:" + hex.EncodeToString(digest[:])
}

func newShareToken() (string, error) {
	b := make([]byte, shareTokenBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// 分享链接里的密文和 IV 都是 base64url。这里只做长度和字符集校验，
// 不解码内容——服务端本来就不该理解它。
func validShareBase64URL(value string, maxLen int) bool {
	if value == "" || len(value) > maxLen {
		return false
	}
	for i := 0; i < len(value); i++ {
		ch := value[i]
		isAlnum := (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')
		if !isAlnum && ch != '-' && ch != '_' {
			return false
		}
	}
	return true
}

func validShareToken(token string) bool {
	if len(token) < 8 || len(token) > 128 {
		return false
	}
	return validShareBase64URL(token, 128)
}

func (s *AccountStore) cleanupExpiredSharesLocked(now int64) {
	for key, share := range s.db.Shares {
		if share.ExpiresAt <= now {
			delete(s.db.Shares, key)
		}
	}
}

func (s *AccountStore) shareCountForUserLocked(username string) int {
	count := 0
	for _, share := range s.db.Shares {
		if share.Owner == username {
			count++
		}
	}
	return count
}

// CreateShare 接收浏览器加密好的密文，存下来并返回一个短 token。
// 必须登录才能创建，否则这个接口就成了任何人可用的免费加密存储。
func CreateShare(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "msg": "服务尚未就绪"})
		return
	}
	username, ok := currentAccount(c)
	if !ok {
		c.JSON(http.StatusUnauthorized, gin.H{"ok": false, "msg": "请先登录后再创建隐私分享"})
		return
	}

	var req struct {
		Ciphertext string `json:"ciphertext"`
		IV         string `json:"iv"`
		ExpiresIn  int64  `json:"expiresIn"`
		Burn       bool   `json:"burn"`
	}
	if err := bindStrictJSON(c, &req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "请求格式不正确"})
		return
	}
	if !validShareBase64URL(req.Ciphertext, shareMaxCiphertextLen) {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "分享内容格式不正确或过大"})
		return
	}
	if !validShareBase64URL(req.IV, shareMaxIVLen) {
		c.JSON(http.StatusBadRequest, gin.H{"ok": false, "msg": "分享内容格式不正确"})
		return
	}

	ttl := req.ExpiresIn
	if ttl < shareMinTTL {
		ttl = shareMinTTL
	}
	if ttl > shareMaxTTL {
		ttl = shareMaxTTL
	}

	token, err := newShareToken()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "生成分享链接失败"})
		return
	}

	now := time.Now().Unix()
	accountStore.mu.Lock()
	accountStore.ensureMaps()
	accountStore.cleanupExpiredSharesLocked(now)
	if accountStore.shareCountForUserLocked(username) >= shareMaxPerUser {
		accountStore.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{"ok": false, "msg": "未过期的分享链接过多，请稍后再试"})
		return
	}
	accountStore.db.Shares[shareStorageKey(token)] = StoredShare{
		Ciphertext: req.Ciphertext,
		IV:         req.IV,
		Owner:      username,
		CreatedAt:  now,
		ExpiresAt:  now + ttl,
		Burn:       req.Burn,
	}
	saveErr := accountStore.saveLocked()
	accountStore.mu.Unlock()

	if saveErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "保存分享链接失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{"token": token, "expiresAt": now + ttl}})
}

// GetShare 返回密文。刻意不要求登录：分享的接收方通常没有本站账号。
// 拿到密文也没用——解密密钥只在链接的 # 之后，从未到达服务端。
func GetShare(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "msg": "服务尚未就绪"})
		return
	}
	token := strings.TrimSpace(c.Param("token"))
	if !validShareToken(token) {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "分享链接已失效或不存在"})
		return
	}

	now := time.Now().Unix()
	key := shareStorageKey(token)

	accountStore.mu.Lock()
	accountStore.ensureMaps()
	accountStore.cleanupExpiredSharesLocked(now)
	share, found := accountStore.db.Shares[key]
	if found && share.ExpiresAt <= now {
		delete(accountStore.db.Shares, key)
		found = false
	}
	// 阅后即焚：读到就立刻删掉，保证同一条链接只能成功打开一次。
	burned := false
	if found && share.Burn {
		delete(accountStore.db.Shares, key)
		burned = true
	}
	var saveErr error
	if burned {
		saveErr = accountStore.saveLocked()
	}
	accountStore.mu.Unlock()

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "分享链接已失效或不存在"})
		return
	}
	if saveErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "读取分享链接失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"ciphertext": share.Ciphertext,
		"iv":         share.IV,
		"burn":       share.Burn,
	}})
}
