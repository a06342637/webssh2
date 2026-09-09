package controller

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func installTestShareStore(t *testing.T) string {
	t.Helper()
	original := accountStore
	token := "member-session"
	store := &AccountStore{
		path: filepath.Join(t.TempDir(), "webssh-db.json"),
		db: accountDB{
			Users: map[string]StoredUser{
				"member1": {Username: "member1", PasswordHash: "unused", CreatedAt: 1},
			},
			Sessions: map[string]StoredSession{
				token: {Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()},
			},
			Scripts: map[string]StoredScripts{},
			Shares:  map[string]StoredShare{},
		},
	}
	accountStore = store
	t.Cleanup(func() { accountStore = original })
	return token
}

// 两个「不同浏览器」的游客。值必须能通过 core.NormalizeTrustScope（32 位 hex）。
const (
	testGuestScopeA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	testGuestScopeB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func performShareRequest(t *testing.T, handler gin.HandlerFunc, method, target string, body any, sessionToken string, params gin.Params) *httptest.ResponseRecorder {
	t.Helper()
	return performShareRequestAs(t, handler, method, target, body, sessionToken, params, testGuestScopeA)
}

func performShareRequestAs(t *testing.T, handler gin.HandlerFunc, method, target string, body any, sessionToken string, params gin.Params, guestScope string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(payload)
	} else {
		reader = bytes.NewReader(nil)
	}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, reader)
	request.Header.Set("Content-Type", "application/json")
	if sessionToken != "" {
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: sessionToken})
	}
	if guestScope != "" {
		request.AddCookie(&http.Cookie{Name: trustScopeCookieName, Value: guestScope})
	}
	context.Request = request
	context.Params = params
	handler(context)
	return recorder
}

func decodeShareBody(t *testing.T, recorder *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var parsed map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, recorder.Body.String())
	}
	return parsed
}

func createTestShare(t *testing.T, sessionToken string, body map[string]any) (*httptest.ResponseRecorder, string) {
	t.Helper()
	recorder := performShareRequest(t, CreateShare, http.MethodPost, "/api/share", body, sessionToken, nil)
	if recorder.Code != http.StatusOK {
		return recorder, ""
	}
	parsed := decodeShareBody(t, recorder)
	data, _ := parsed["data"].(map[string]any)
	token, _ := data["token"].(string)
	return recorder, token
}

func TestCreateShareStoresOnlyHashedTokenAndCiphertext(t *testing.T) {
	sessionToken := installTestShareStore(t)
	recorder, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("create share failed: %d %s", recorder.Code, recorder.Body.String())
	}
	if !validShareToken(token) {
		t.Fatalf("returned token is not usable: %q", token)
	}

	accountStore.mu.RLock()
	defer accountStore.mu.RUnlock()
	if _, plaintextKeyed := accountStore.db.Shares[token]; plaintextKeyed {
		t.Fatal("share was stored under the raw token instead of its hash")
	}
	stored, ok := accountStore.db.Shares[shareStorageKey(token)]
	if !ok {
		t.Fatal("share was not stored under its hashed key")
	}
	if stored.Owner != "member1" || stored.Ciphertext != "Y2lwaGVydGV4dA" || stored.IV != "aXYtdmFsdWU" {
		t.Fatalf("unexpected stored share: %#v", stored)
	}
	// 服务端不该、也无法看到明文凭据：它只拿到浏览器加密后的密文。
	raw, err := json.Marshal(accountStore.db)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), token) {
		t.Fatal("database still contains a directly usable share token")
	}
}

func TestCreateShareIsAllowedForGuestsAndScopedByBrowser(t *testing.T) {
	installTestShareStore(t)
	// 没有账号也要能分享，否则这个功能对游客完全不可用。
	// 归属挂在每个浏览器独有的 trust-scope cookie 上，而不是 IP。
	recorder, token := createTestShare(t, "", map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"label":      "SSH root@192.0.2.10:22",
		"kind":       "ssh",
		"expiresIn":  3600,
		"burn":       false,
	})
	if recorder.Code != http.StatusOK {
		t.Fatalf("guest share creation was rejected: %d %s", recorder.Code, recorder.Body.String())
	}
	accountStore.mu.RLock()
	defer accountStore.mu.RUnlock()
	stored := accountStore.db.Shares[shareStorageKey(token)]
	if !strings.HasPrefix(stored.Owner, "scope:") {
		t.Fatalf("guest share was not scoped to the browser cookie: %q", stored.Owner)
	}
	// 落库的必须是哈希，不能让数据库泄漏后直接拿到可用的 cookie 原值。
	if strings.Contains(stored.Owner, testGuestScopeA) {
		t.Fatalf("guest share stored the raw trust-scope cookie: %q", stored.Owner)
	}
	if stored.Label != "SSH root@192.0.2.10:22" || stored.Kind != "ssh" {
		t.Fatalf("share metadata was not stored: %#v", stored)
	}
	if stored.Version != shareSchemaVersion {
		t.Fatalf("share was stored with schema version %d", stored.Version)
	}
}

func TestCreateShareRejectsOversizedAndMalformedPayloads(t *testing.T) {
	sessionToken := installTestShareStore(t)

	oversized, _ := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": strings.Repeat("A", shareMaxCiphertextLen+1),
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	if oversized.Code != http.StatusBadRequest {
		t.Fatalf("oversized ciphertext was accepted: %d", oversized.Code)
	}

	// 密文必须是 base64url；带 + / = 说明不是我们生成的，直接拒绝。
	malformed, _ := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "not+valid/base64url=",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	if malformed.Code != http.StatusBadRequest {
		t.Fatalf("malformed ciphertext was accepted: %d", malformed.Code)
	}

	empty, _ := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "",
		"expiresIn":  3600,
		"burn":       false,
	})
	if empty.Code != http.StatusBadRequest {
		t.Fatalf("empty IV was accepted: %d", empty.Code)
	}
}

func TestCreateShareClampsTTL(t *testing.T) {
	sessionToken := installTestShareStore(t)
	now := time.Now().Unix()

	_, longToken := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  shareMaxTTL * 10,
		"burn":       false,
	})
	_, shortToken := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  1,
		"burn":       false,
	})

	accountStore.mu.RLock()
	defer accountStore.mu.RUnlock()
	long := accountStore.db.Shares[shareStorageKey(longToken)]
	short := accountStore.db.Shares[shareStorageKey(shortToken)]
	if long.ExpiresAt > now+shareMaxTTL+5 {
		t.Fatalf("TTL above the maximum was not clamped: %d", long.ExpiresAt-now)
	}
	if short.ExpiresAt < now+shareMinTTL {
		t.Fatalf("TTL below the minimum was not raised: %d", short.ExpiresAt-now)
	}
}

func TestCreateShareEnforcesPerUserLimit(t *testing.T) {
	sessionToken := installTestShareStore(t)
	for i := 0; i < shareMaxPerOwner; i++ {
		recorder, _ := createTestShare(t, sessionToken, map[string]any{
			"ciphertext": "Y2lwaGVydGV4dA",
			"iv":         "aXYtdmFsdWU",
			"expiresIn":  3600,
			"burn":       false,
		})
		if recorder.Code != http.StatusOK {
			t.Fatalf("share %d rejected early: %d %s", i, recorder.Code, recorder.Body.String())
		}
	}
	overflow, _ := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	if overflow.Code != http.StatusTooManyRequests {
		t.Fatalf("per-user share limit was not enforced: %d", overflow.Code)
	}
}

func TestGetShareIsAnonymousAndReturnsCiphertextOnly(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})

	// 接收方通常没有本站账号，所以读取不带 cookie 也必须成功。
	recorder := performShareRequest(t, GetShare, http.MethodGet, "/api/share/"+token, nil, "", gin.Params{{Key: "token", Value: token}})
	if recorder.Code != http.StatusOK {
		t.Fatalf("anonymous share read failed: %d %s", recorder.Code, recorder.Body.String())
	}
	parsed := decodeShareBody(t, recorder)
	data, _ := parsed["data"].(map[string]any)
	if data["ciphertext"] != "Y2lwaGVydGV4dA" || data["iv"] != "aXYtdmFsdWU" {
		t.Fatalf("unexpected share payload: %#v", data)
	}
	// 响应里不能泄漏创建者，那是站内账号信息。
	if _, leaked := data["owner"]; leaked {
		t.Fatal("share response leaked its owner")
	}
}

func TestGetShareBurnsAfterFirstRead(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       true,
	})

	first := performShareRequest(t, GetShare, http.MethodGet, "/api/share/"+token, nil, "", gin.Params{{Key: "token", Value: token}})
	if first.Code != http.StatusOK {
		t.Fatalf("first burn-after-read fetch failed: %d %s", first.Code, first.Body.String())
	}
	second := performShareRequest(t, GetShare, http.MethodGet, "/api/share/"+token, nil, "", gin.Params{{Key: "token", Value: token}})
	if second.Code != http.StatusNotFound {
		t.Fatalf("burn-after-read link survived a second fetch: %d", second.Code)
	}
}

func TestGetShareRejectsExpiredAndUnknownTokens(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})

	accountStore.mu.Lock()
	stored := accountStore.db.Shares[shareStorageKey(token)]
	stored.ExpiresAt = time.Now().Unix() - 1
	accountStore.db.Shares[shareStorageKey(token)] = stored
	accountStore.mu.Unlock()

	expired := performShareRequest(t, GetShare, http.MethodGet, "/api/share/"+token, nil, "", gin.Params{{Key: "token", Value: token}})
	if expired.Code != http.StatusNotFound {
		t.Fatalf("expired share was still readable: %d", expired.Code)
	}

	accountStore.mu.RLock()
	_, stillStored := accountStore.db.Shares[shareStorageKey(token)]
	accountStore.mu.RUnlock()
	if stillStored {
		t.Fatal("expired share was not purged from the store")
	}

	unknown := performShareRequest(t, GetShare, http.MethodGet, "/api/share/deadbeefdeadbeef", nil, "", gin.Params{{Key: "token", Value: "deadbeefdeadbeef"}})
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown token did not return 404: %d", unknown.Code)
	}

	invalid := performShareRequest(t, GetShare, http.MethodGet, "/api/share/short", nil, "", gin.Params{{Key: "token", Value: "short"}})
	if invalid.Code != http.StatusNotFound {
		t.Fatalf("malformed token did not return 404: %d", invalid.Code)
	}
}

func TestCleanupExpiredSharesLockedDropsOnlyStaleEntries(t *testing.T) {
	installTestShareStore(t)
	now := time.Now().Unix()
	accountStore.mu.Lock()
	accountStore.db.Shares["fresh"] = StoredShare{Version: shareSchemaVersion, Owner: "member1", ExpiresAt: now + 600}
	accountStore.db.Shares["stale"] = StoredShare{Version: shareSchemaVersion, Owner: "member1", ExpiresAt: now - 1}
	accountStore.cleanupExpiredSharesLocked(now)
	_, freshKept := accountStore.db.Shares["fresh"]
	_, staleKept := accountStore.db.Shares["stale"]
	accountStore.mu.Unlock()

	if !freshKept {
		t.Fatal("a share that had not expired was removed")
	}
	if staleKept {
		t.Fatal("an expired share survived cleanup")
	}
}

func TestNewShareTokenIsUniqueAndURLSafe(t *testing.T) {
	seen := make(map[string]bool, 128)
	for i := 0; i < 128; i++ {
		token, err := newShareToken()
		if err != nil {
			t.Fatalf("token generation failed: %v", err)
		}
		if !validShareToken(token) {
			t.Fatalf("generated token is not URL safe: %q", token)
		}
		if seen[token] {
			t.Fatalf("duplicate token generated: %q", token)
		}
		seen[token] = true
	}
}

func TestListSharesReturnsOnlyOwnMetadata(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, mine := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"label":      "RDP 10.0.0.5:3389",
		"kind":       "rdp",
		"expiresIn":  3600,
		"burn":       true,
	})
	// 另一个账号的分享不能出现在列表里。
	accountStore.mu.Lock()
	accountStore.db.Shares[shareStorageKey("someone-elses-token-value")] = StoredShare{
		Version: shareSchemaVersion, Owner: "other", Label: "别人的", ExpiresAt: time.Now().Unix() + 600,
	}
	accountStore.mu.Unlock()

	recorder := performShareRequest(t, ListShares, http.MethodGet, "/api/shares", nil, sessionToken, nil)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list shares failed: %d %s", recorder.Code, recorder.Body.String())
	}
	data, _ := decodeShareBody(t, recorder)["data"].(map[string]any)
	items, _ := data["items"].([]any)
	if len(items) != 1 {
		t.Fatalf("expected exactly one own share, got %d", len(items))
	}
	entry, _ := items[0].(map[string]any)
	if entry["label"] != "RDP 10.0.0.5:3389" || entry["kind"] != "rdp" || entry["burn"] != true {
		t.Fatalf("unexpected list entry: %#v", entry)
	}
	if data["loggedIn"] != true {
		t.Fatal("logged-in flag was not reported")
	}
	// 列表绝不能回密文、更不能回一个可以直接打开的 token。
	body := recorder.Body.String()
	if strings.Contains(body, "Y2lwaGVydGV4dA") || strings.Contains(body, mine) {
		t.Fatalf("list leaked ciphertext or a usable token: %s", body)
	}
	if entry["id"] != shareStorageKey(mine) {
		t.Fatalf("list did not identify the share by its storage key: %#v", entry["id"])
	}
}

func TestDeleteShareRevokesTheLinkAndRejectsOthers(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	key := shareStorageKey(token)

	// 别人的记录删不掉。
	accountStore.mu.Lock()
	foreign := shareStorageKey("foreign-token-value-here")
	accountStore.db.Shares[foreign] = StoredShare{
		Version: shareSchemaVersion, Owner: "other", ExpiresAt: time.Now().Unix() + 600,
	}
	accountStore.mu.Unlock()
	denied := performShareRequest(t, DeleteShare, http.MethodDelete, "/api/shares/"+foreign, nil, sessionToken,
		gin.Params{{Key: "id", Value: foreign}})
	if denied.Code != http.StatusNotFound {
		t.Fatalf("deleting another owner's share was allowed: %d", denied.Code)
	}

	// 自己的可以删，删完链接立刻打不开。
	ok := performShareRequest(t, DeleteShare, http.MethodDelete, "/api/shares/"+key, nil, sessionToken,
		gin.Params{{Key: "id", Value: key}})
	if ok.Code != http.StatusOK {
		t.Fatalf("deleting own share failed: %d %s", ok.Code, ok.Body.String())
	}
	gone := performShareRequest(t, GetShare, http.MethodGet, "/api/share/"+token, nil, "",
		gin.Params{{Key: "token", Value: token}})
	if gone.Code != http.StatusNotFound {
		t.Fatalf("deleted share is still readable: %d", gone.Code)
	}

	// 重复删除返回 404 而不是 500。
	again := performShareRequest(t, DeleteShare, http.MethodDelete, "/api/shares/"+key, nil, sessionToken,
		gin.Params{{Key: "id", Value: key}})
	if again.Code != http.StatusNotFound {
		t.Fatalf("second delete returned %d", again.Code)
	}
}

func TestDeleteShareAlsoAcceptsTheRawToken(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	recorder := performShareRequest(t, DeleteShare, http.MethodDelete, "/api/shares/"+token, nil, sessionToken,
		gin.Params{{Key: "id", Value: token}})
	if recorder.Code != http.StatusOK {
		t.Fatalf("deleting by raw token failed: %d %s", recorder.Code, recorder.Body.String())
	}
}

func TestSharesFromAnOlderSchemaAreInvalidated(t *testing.T) {
	// 分享规则变更后，此前发出的链接必须一次性全部作废。
	installTestShareStore(t)
	now := time.Now().Unix()
	accountStore.mu.Lock()
	accountStore.db.Shares["legacy"] = StoredShare{Owner: "member1", ExpiresAt: now + 86400} // 无 version，即旧记录
	accountStore.db.Shares["current"] = StoredShare{Version: shareSchemaVersion, Owner: "member1", ExpiresAt: now + 600}
	accountStore.cleanupExpiredSharesLocked(now)
	_, legacyKept := accountStore.db.Shares["legacy"]
	_, currentKept := accountStore.db.Shares["current"]
	accountStore.mu.Unlock()

	if legacyKept {
		t.Fatal("a share created under the old rules survived")
	}
	if !currentKept {
		t.Fatal("a share created under the current rules was dropped")
	}
}

func TestShareTTLIsCappedAtTwentyFourHours(t *testing.T) {
	if shareMaxTTL != 24*60*60 {
		t.Fatalf("share links must expire within 24h, got %d seconds", shareMaxTTL)
	}
}

func TestShareLabelIsSanitized(t *testing.T) {
	sessionToken := installTestShareStore(t)
	_, token := createTestShare(t, sessionToken, map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"label":      "  SSH\x00 root@host\n  " + strings.Repeat("x", shareMaxLabelLen),
		"kind":       "bogus",
		"expiresIn":  3600,
		"burn":       false,
	})
	accountStore.mu.RLock()
	defer accountStore.mu.RUnlock()
	stored := accountStore.db.Shares[shareStorageKey(token)]
	if len(stored.Label) > shareMaxLabelLen {
		t.Fatalf("label was not truncated: %d chars", len(stored.Label))
	}
	if strings.ContainsAny(stored.Label, "\x00\n") {
		t.Fatalf("control characters survived sanitising: %q", stored.Label)
	}
	if stored.Kind != "" {
		t.Fatalf("unknown kind should be dropped, got %q", stored.Kind)
	}
}

func TestGuestsBehindTheSameIPCannotSeeOrDeleteEachOthersShares(t *testing.T) {
	// 两个请求都来自 httptest 默认的同一个 RemoteAddr，模拟 NAT 后共用出口 IP。
	// 区分它们的只能是各自浏览器里的 trust-scope cookie。
	installTestShareStore(t)

	created := performShareRequestAs(t, CreateShare, http.MethodPost, "/api/share", map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"label":      "SSH root@203.0.113.9:22",
		"kind":       "ssh",
		"expiresIn":  3600,
		"burn":       false,
	}, "", nil, testGuestScopeA)
	if created.Code != http.StatusOK {
		t.Fatalf("guest A could not create a share: %d %s", created.Code, created.Body.String())
	}
	data, _ := decodeShareBody(t, created)["data"].(map[string]any)
	token, _ := data["token"].(string)
	id, _ := data["id"].(string)

	// 游客 B 的列表里必须是空的。
	listB := performShareRequestAs(t, ListShares, http.MethodGet, "/api/shares", nil, "", nil, testGuestScopeB)
	if listB.Code != http.StatusOK {
		t.Fatalf("guest B list failed: %d", listB.Code)
	}
	dataB, _ := decodeShareBody(t, listB)["data"].(map[string]any)
	if items, _ := dataB["items"].([]any); len(items) != 0 {
		t.Fatalf("guest B can see guest A's shares: %#v", items)
	}

	// 游客 B 也删不掉 A 的分享，无论用存储键还是原始 token。
	for _, target := range []string{id, token} {
		denied := performShareRequestAs(t, DeleteShare, http.MethodDelete, "/api/shares/"+target, nil, "",
			gin.Params{{Key: "id", Value: target}}, testGuestScopeB)
		if denied.Code != http.StatusNotFound {
			t.Fatalf("guest B deleted guest A's share via %q: %d", target, denied.Code)
		}
	}

	// A 自己仍然能看到、能删。
	listA := performShareRequestAs(t, ListShares, http.MethodGet, "/api/shares", nil, "", nil, testGuestScopeA)
	dataA, _ := decodeShareBody(t, listA)["data"].(map[string]any)
	if items, _ := dataA["items"].([]any); len(items) != 1 {
		t.Fatalf("guest A lost sight of their own share: %#v", items)
	}
	ok := performShareRequestAs(t, DeleteShare, http.MethodDelete, "/api/shares/"+id, nil, "",
		gin.Params{{Key: "id", Value: id}}, testGuestScopeA)
	if ok.Code != http.StatusOK {
		t.Fatalf("guest A could not delete their own share: %d %s", ok.Code, ok.Body.String())
	}
}

func TestGuestShareQuotaIsPerBrowserNotPerIP(t *testing.T) {
	// A 把配额用满，不应该影响同 IP 下的 B。
	installTestShareStore(t)
	body := map[string]any{"ciphertext": "Y2lwaGVydGV4dA", "iv": "aXYtdmFsdWU", "expiresIn": 3600, "burn": false}
	for i := 0; i < shareMaxPerOwner; i++ {
		r := performShareRequestAs(t, CreateShare, http.MethodPost, "/api/share", body, "", nil, testGuestScopeA)
		if r.Code != http.StatusOK {
			t.Fatalf("guest A share %d rejected early: %d", i, r.Code)
		}
	}
	full := performShareRequestAs(t, CreateShare, http.MethodPost, "/api/share", body, "", nil, testGuestScopeA)
	if full.Code != http.StatusTooManyRequests {
		t.Fatalf("guest A quota was not enforced: %d", full.Code)
	}
	fresh := performShareRequestAs(t, CreateShare, http.MethodPost, "/api/share", body, "", nil, testGuestScopeB)
	if fresh.Code != http.StatusOK {
		t.Fatalf("guest B was blocked by guest A's quota: %d %s", fresh.Code, fresh.Body.String())
	}
}
