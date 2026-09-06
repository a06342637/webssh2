package controller

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"net/http"
	"sort"
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
	shareMaxLabelLen      = 120
	shareMaxPerOwner      = 50
	shareMinTTL           = int64(60)
	// 分享链接一律最多存活 24 小时，用户选的有效期只能更短不能更长。
	shareMaxTTL = int64(24 * 60 * 60)
	// 记录格式版本。加载时会删掉版本对不上的旧记录，用来在规则变更后
	// 一次性作废此前发出的全部分享链接。
	shareSchemaVersion = 2
)

type StoredShare struct {
	Version    int    `json:"version"`
	Ciphertext string `json:"ciphertext"`
	IV         string `json:"iv"`
	// Owner 为空表示这条是游客创建的，只能靠创建者浏览器里的本地记录管理。
	Owner string `json:"owner,omitempty"`
	// Label 是给分享列表看的说明文字（例如 "RDP 10.0.0.5:3389"），
	// 由浏览器生成并上传。绝不能包含密码——它是明文存储的。
	Label     string `json:"label,omitempty"`
	Kind      string `json:"kind,omitempty"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Burn      bool   `json:"burn,omitempty"`
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

// 过期的、以及格式版本对不上的记录都要清掉。后者用于在分享规则变更后
// 一次性作废此前发出的全部链接——旧记录没有 version 字段，反序列化成 0。
func (s *AccountStore) cleanupExpiredSharesLocked(now int64) {
	for key, share := range s.db.Shares {
		if share.ExpiresAt <= now || share.Version != shareSchemaVersion {
			delete(s.db.Shares, key)
		}
	}
}

// 配额按创建者统计：登录用户按账号名，游客按客户端 IP。
func (s *AccountStore) shareCountForOwnerLocked(owner string) int {
	count := 0
	for _, share := range s.db.Shares {
		if share.Owner == owner {
			count++
		}
	}
	return count
}

// 游客也允许创建分享（否则没有账号就用不了这个功能），但要有配额兜底，
// 免得接口被当成免费的匿名加密存储。游客的配额挂在客户端 IP 上。
func shareOwnerFor(c *gin.Context) (string, bool) {
	if username, ok := currentAccount(c); ok {
		return username, true
	}
	return "", false
}

func shareQuotaKeyFor(c *gin.Context, owner string, loggedIn bool) string {
	if loggedIn {
		return owner
	}
	return "ip:" + requestIP(c)
}

func sanitizeShareLabel(raw string) string {
	label := strings.TrimSpace(raw)
	label = strings.Map(func(r rune) rune {
		// 控制字符会污染列表渲染，直接丢掉。
		if r < 0x20 || r == 0x7f {
			return -1
		}
		return r
	}, label)
	if len(label) > shareMaxLabelLen {
		label = label[:shareMaxLabelLen]
	}
	return label
}

func sanitizeShareKind(raw string) string {
	switch raw {
	case "ssh", "rdp":
		return raw
	default:
		return ""
	}
}

// CreateShare 接收浏览器加密好的密文，存下来并返回一个短 token。
func CreateShare(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "msg": "服务尚未就绪"})
		return
	}
	owner, loggedIn := shareOwnerFor(c)
	quotaKey := shareQuotaKeyFor(c, owner, loggedIn)

	var req struct {
		Ciphertext string `json:"ciphertext"`
		IV         string `json:"iv"`
		Label      string `json:"label"`
		Kind       string `json:"kind"`
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
	if accountStore.shareCountForOwnerLocked(quotaKey) >= shareMaxPerOwner {
		accountStore.mu.Unlock()
		c.JSON(http.StatusTooManyRequests, gin.H{"ok": false, "msg": "未过期的分享链接过多，请先删除一些再试"})
		return
	}
	accountStore.db.Shares[shareStorageKey(token)] = StoredShare{
		Version:    shareSchemaVersion,
		Ciphertext: req.Ciphertext,
		IV:         req.IV,
		Owner:      quotaKey,
		Label:      sanitizeShareLabel(req.Label),
		Kind:       sanitizeShareKind(req.Kind),
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
	// 同时给出存储键：浏览器把它记在本地，之后就能把本地保存的完整链接
	// 和 ListShares 返回的记录对应起来。
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"token":     token,
		"id":        shareStorageKey(token),
		"expiresAt": now + ttl,
	}})
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

// ListShares 返回调用者自己创建的、尚未过期的分享。
// 只回元信息（说明文字、协议、时间、是否阅后即焚），不回密文，
// 更不可能回明文凭据——服务端本来就没有。
//
// 登录用户按账号名归集，所以换设备也能看到并撤销；游客按 IP 归集，
// IP 一变就查不到了，他们主要靠浏览器本地记录来管理。
func ListShares(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "msg": "服务尚未就绪"})
		return
	}
	owner, loggedIn := shareOwnerFor(c)
	quotaKey := shareQuotaKeyFor(c, owner, loggedIn)

	now := time.Now().Unix()
	accountStore.mu.Lock()
	accountStore.ensureMaps()
	accountStore.cleanupExpiredSharesLocked(now)
	items := make([]gin.H, 0, 8)
	for key, share := range accountStore.db.Shares {
		if share.Owner != quotaKey {
			continue
		}
		items = append(items, gin.H{
			// 只给存储键（token 的哈希），不给 token 本身——列表接口不该
			// 能拿回一条可以直接打开的链接。删除时用这个键定位。
			"id":        key,
			"label":     share.Label,
			"kind":      share.Kind,
			"createdAt": share.CreatedAt,
			"expiresAt": share.ExpiresAt,
			"burn":      share.Burn,
		})
	}
	accountStore.mu.Unlock()

	sort.Slice(items, func(i, j int) bool {
		return items[i]["createdAt"].(int64) > items[j]["createdAt"].(int64)
	})
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"items":    items,
		"loggedIn": loggedIn,
		"maxTtl":   shareMaxTTL,
	}})
}

// DeleteShare 撤销一条分享。参数是 ListShares 给出的存储键，
// 也接受原始 token（生成后本地还留着的那一份）。
func DeleteShare(c *gin.Context) {
	if accountStore == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"ok": false, "msg": "服务尚未就绪"})
		return
	}
	owner, loggedIn := shareOwnerFor(c)
	quotaKey := shareQuotaKeyFor(c, owner, loggedIn)

	id := strings.TrimSpace(c.Param("id"))
	if id == "" {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "分享记录不存在"})
		return
	}
	key := id
	if !strings.HasPrefix(id, "sha256:") {
		if !validShareToken(id) {
			c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "分享记录不存在"})
			return
		}
		key = shareStorageKey(id)
	}

	now := time.Now().Unix()
	accountStore.mu.Lock()
	accountStore.ensureMaps()
	accountStore.cleanupExpiredSharesLocked(now)
	share, found := accountStore.db.Shares[key]
	// 只能删自己的。否则拿到别人的存储键就能撤销别人的分享。
	if found && share.Owner != quotaKey {
		found = false
	}
	var saveErr error
	if found {
		delete(accountStore.db.Shares, key)
		saveErr = accountStore.saveLocked()
	}
	accountStore.mu.Unlock()

	if !found {
		c.JSON(http.StatusNotFound, gin.H{"ok": false, "msg": "分享记录不存在或已失效"})
		return
	}
	if saveErr != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"ok": false, "msg": "删除分享失败"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "分享链接已删除"})
}
