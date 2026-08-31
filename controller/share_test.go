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

func performShareRequest(t *testing.T, handler gin.HandlerFunc, method, target string, body any, sessionToken string, params gin.Params) *httptest.ResponseRecorder {
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

func TestCreateShareRequiresLogin(t *testing.T) {
	installTestShareStore(t)
	recorder, _ := createTestShare(t, "", map[string]any{
		"ciphertext": "Y2lwaGVydGV4dA",
		"iv":         "aXYtdmFsdWU",
		"expiresIn":  3600,
		"burn":       false,
	})
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous share creation was allowed: %d %s", recorder.Code, recorder.Body.String())
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
	for i := 0; i < shareMaxPerUser; i++ {
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
	accountStore.db.Shares["fresh"] = StoredShare{Owner: "member1", ExpiresAt: now + 600}
	accountStore.db.Shares["stale"] = StoredShare{Owner: "member1", ExpiresAt: now - 1}
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
