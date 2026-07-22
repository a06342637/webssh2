package controller

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"golang.org/x/crypto/bcrypt"
)

func installTestAccountStore(t *testing.T) string {
	t.Helper()
	original := accountStore
	adminToken := "admin-session"
	store := &AccountStore{
		path: filepath.Join(t.TempDir(), "webssh-db.json"),
		db: accountDB{
			Users: map[string]StoredUser{
				"admin":   {Username: "admin", PasswordHash: "unused", CreatedAt: 1, IsAdmin: true},
				"member1": {Username: "member1", PasswordHash: "unused", CreatedAt: 2, IsAdmin: false},
			},
			Sessions: map[string]StoredSession{
				adminToken: {Username: "admin", ExpiresAt: time.Now().Add(time.Hour).Unix()},
			},
			Scripts: map[string]StoredScripts{},
		},
	}
	accountStore = store
	t.Cleanup(func() { accountStore = original })
	return adminToken
}

func performAccountJSON(t *testing.T, handler gin.HandlerFunc, method, target string, body any, token string) *httptest.ResponseRecorder {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	recorder := httptest.NewRecorder()
	context, _ := gin.CreateTestContext(recorder)
	request := httptest.NewRequest(method, target, bytes.NewReader(payload))
	request.Header.Set("Content-Type", "application/json")
	if token != "" {
		request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	}
	context.Request = request
	if strings.HasPrefix(target, "/api/admin/accounts/") {
		context.Params = gin.Params{{Key: "username", Value: strings.TrimPrefix(target, "/api/admin/accounts/")}}
	}
	handler(context)
	return recorder
}

func TestSanitizeScriptCategoriesDeduplicatesAfterTruncation(t *testing.T) {
	prefix := strings.Repeat("a", 80)
	categories := sanitizeScriptCategories([]ScriptCategory{
		{ID: prefix + "x", Name: "first", Emoji: "1️⃣"},
		{ID: prefix + "y", Name: "second", Emoji: "2️⃣"},
	})
	if len(categories) != 1 {
		t.Fatalf("expected one category after truncated ID collision, got %d", len(categories))
	}
	if categories[0].ID != prefix {
		t.Fatalf("unexpected sanitized ID length/value: %q", categories[0].ID)
	}
}

func TestSanitizeScriptReferencesAndFutureTimestamp(t *testing.T) {
	categories := []ScriptCategory{{ID: "valid", Name: "Valid", Emoji: "✅"}}
	items := sanitizeScriptCategoryReferences([]ScriptBookmark{
		{Name: "kept", Cmd: "true", CategoryID: "valid"},
		{Name: "cleaned", Cmd: "false", CategoryID: "missing"},
	}, categories)
	if items[0].CategoryID != "valid" || items[1].CategoryID != "" {
		t.Fatalf("unexpected category reference cleanup: %#v", items)
	}
	now := time.Now().UnixMilli()
	if got := sanitizeScriptUpdatedAt(now+int64(time.Hour/time.Millisecond), now); got != now {
		t.Fatalf("far-future timestamp was not clamped: got %d want %d", got, now)
	}
	if got := sanitizeScriptUpdatedAt(-1, now); got != 0 {
		t.Fatalf("negative timestamp was not clamped to zero: %d", got)
	}
}

func TestSyncScriptBookmarksRejectsInvalidMode(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	recorder := performAccountJSON(t, SyncScriptBookmarks, http.MethodPost, "/api/scripts/sync", map[string]any{
		"mode": "overwrite-everything",
	}, token)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for invalid mode, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if len(accountStore.db.Scripts) != 0 {
		t.Fatalf("invalid mode mutated script storage: %#v", accountStore.db.Scripts)
	}
}

func TestSyncScriptBookmarksCleansOrphansAndFutureClock(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	recorder := performAccountJSON(t, SyncScriptBookmarks, http.MethodPost, "/api/scripts/sync", map[string]any{
		"mode":      "push",
		"updatedAt": time.Now().Add(24 * time.Hour).UnixMilli(),
		"categories": []ScriptCategory{
			{ID: "ops", Name: "Ops", Emoji: "🛠️"},
		},
		"scripts": []ScriptBookmark{
			{Name: "valid", Cmd: "uptime", CategoryID: "ops"},
			{Name: "orphan", Cmd: "whoami", CategoryID: "missing"},
		},
	}, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected successful push, got %d: %s", recorder.Code, recorder.Body.String())
	}
	stored := accountStore.db.Scripts["admin"]
	if len(stored.Items) != 2 {
		t.Fatalf("expected two stored scripts, got %#v", stored.Items)
	}
	if stored.Items[0].CategoryID != "ops" || stored.Items[1].CategoryID != "" {
		t.Fatalf("orphan category was not cleaned: %#v", stored.Items)
	}
	if stored.UpdatedAt > time.Now().Add(time.Second).UnixMilli() {
		t.Fatalf("future timestamp remained in storage: %d", stored.UpdatedAt)
	}
}

func TestEnvironmentAdminResetInvalidatesExistingSessions(t *testing.T) {
	oldHash, err := bcrypt.GenerateFromPassword([]byte("OldPass123!"), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	store := &AccountStore{
		path: filepath.Join(t.TempDir(), "webssh-db.json"),
		db: accountDB{
			Users: map[string]StoredUser{
				"admin": {Username: "admin", PasswordHash: string(oldHash), CreatedAt: 1, IsAdmin: true},
			},
			Sessions: map[string]StoredSession{
				"old-admin-session": {Username: "admin", ExpiresAt: time.Now().Add(time.Hour).Unix()},
			},
			Scripts: map[string]StoredScripts{},
		},
	}
	t.Setenv("WEBSSH_ADMIN_USER", "admin")
	t.Setenv("WEBSSH_ADMIN_PASSWORD", "ResetPass123!")
	t.Setenv("WEBSSH_ADMIN_RESET", "true")

	store.mu.Lock()
	err = store.ensureDefaultAdminLocked()
	store.mu.Unlock()
	if err != nil {
		t.Fatalf("environment reset failed: %v", err)
	}
	if len(store.db.Sessions) != 0 {
		t.Fatalf("old administrator sessions remained after environment reset: %#v", store.db.Sessions)
	}
	admin := store.db.Users["admin"]
	if !admin.IsAdmin {
		t.Fatal("reset account lost administrator privileges")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte("ResetPass123!")); err != nil {
		t.Fatalf("administrator password was not reset: %v", err)
	}
}
func TestAdminPasswordResetInvalidatesUserSessions(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	accountStore.db.Sessions["member-old-session"] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	recorder := performAccountJSON(t, AdminUpdateAccount, http.MethodPut, "/api/admin/accounts", map[string]any{
		"username": "member1",
		"password": "NewPass123!",
	}, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected successful password reset, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if _, ok := accountStore.db.Sessions["member-old-session"]; ok {
		t.Fatal("old member session remained after administrator password reset")
	}
	if _, ok := accountStore.db.Sessions[token]; !ok {
		t.Fatal("administrator session was unexpectedly removed")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(accountStore.db.Users["member1"].PasswordHash), []byte("NewPass123!")); err != nil {
		t.Fatalf("new password hash did not validate: %v", err)
	}
}

func TestAdminCannotDemoteLastAdministrator(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	recorder := performAccountJSON(t, AdminUpdateAccount, http.MethodPut, "/api/admin/accounts", map[string]any{
		"username": "admin",
		"isAdmin":  false,
	}, token)
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 when demoting last admin, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if !accountStore.db.Users["admin"].IsAdmin {
		t.Fatal("last administrator was demoted despite protection")
	}
}

func makeAccountStorePersistenceFail(t *testing.T) {
	t.Helper()
	accountStore.path = filepath.Join(t.TempDir(), "missing-parent", "webssh-db.json")
}

func assertAccountDBEqual(t *testing.T, want accountDB) {
	t.Helper()
	if !reflect.DeepEqual(accountStore.db, want) {
		t.Fatalf("account database changed after failed persistence:\n got: %#v\nwant: %#v", accountStore.db, want)
	}
}

func TestStoredFutureTimestampIsClamped(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	now := time.Now().UnixMilli()
	accountStore.db.Scripts["admin"] = StoredScripts{
		Items:     []ScriptBookmark{{Name: "uptime", Cmd: "uptime"}},
		UpdatedAt: now + int64(24*time.Hour/time.Millisecond),
	}

	recorder := performAccountJSON(t, GetScriptBookmarks, http.MethodGet, "/api/scripts", nil, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected successful script read, got %d: %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Data struct {
			UpdatedAt int64 `json:"updatedAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.UpdatedAt > time.Now().Add(time.Second).UnixMilli() {
		t.Fatalf("GET returned a future cloud timestamp: %d", response.Data.UpdatedAt)
	}

	recorder = performAccountJSON(t, SyncScriptBookmarks, http.MethodPost, "/api/scripts/sync", map[string]any{
		"mode":      "pull",
		"updatedAt": 0,
	}, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected successful pull, got %d: %s", recorder.Code, recorder.Body.String())
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.UpdatedAt > time.Now().Add(time.Second).UnixMilli() {
		t.Fatalf("sync returned a future cloud timestamp: %d", response.Data.UpdatedAt)
	}
}

func TestFailedPersistenceRollsBackMutations(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("register", func(t *testing.T) {
		t.Setenv("WEBSSH_ALLOW_REGISTRATION", "true")
		installTestAccountStore(t)
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AuthRegister, http.MethodPost, "/api/auth/register", map[string]any{
			"username": "newuser",
			"password": "NewPass123!",
		}, "")
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
		if cookies := recorder.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("failed registration unexpectedly issued cookies: %#v", cookies)
		}
	})

	t.Run("login", func(t *testing.T) {
		installTestAccountStore(t)
		hash, err := bcrypt.GenerateFromPassword([]byte("AdminPass123!"), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		admin := accountStore.db.Users["admin"]
		admin.PasswordHash = string(hash)
		accountStore.db.Users["admin"] = admin
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AuthLogin, http.MethodPost, "/api/auth/login", map[string]any{
			"username": "admin",
			"password": "AdminPass123!",
		}, "")
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
		if cookies := recorder.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("failed login unexpectedly issued cookies: %#v", cookies)
		}
	})

	t.Run("change password", func(t *testing.T) {
		installTestAccountStore(t)
		hash, err := bcrypt.GenerateFromPassword([]byte("OldPass123!"), bcrypt.MinCost)
		if err != nil {
			t.Fatal(err)
		}
		member := accountStore.db.Users["member1"]
		member.PasswordHash = string(hash)
		accountStore.db.Users["member1"] = member
		memberToken := "member-session"
		accountStore.db.Sessions[memberToken] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
		accountStore.db.Sessions["member-other"] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AuthChangePassword, http.MethodPost, "/api/auth/password", map[string]any{
			"oldPassword": "OldPass123!",
			"newPassword": "NewPass123!",
		}, memberToken)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})

	t.Run("admin create", func(t *testing.T) {
		token := installTestAccountStore(t)
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AdminCreateAccount, http.MethodPost, "/api/admin/accounts", map[string]any{
			"username": "newmember",
			"password": "NewPass123!",
		}, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})

	t.Run("admin update", func(t *testing.T) {
		token := installTestAccountStore(t)
		accountStore.db.Sessions["member-old"] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AdminUpdateAccount, http.MethodPut, "/api/admin/accounts", map[string]any{
			"username": "member1",
			"password": "NewPass123!",
			"isAdmin":  true,
		}, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})

	t.Run("admin delete", func(t *testing.T) {
		token := installTestAccountStore(t)
		accountStore.db.Sessions["member-old"] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
		accountStore.db.Scripts["member1"] = StoredScripts{Items: []ScriptBookmark{{Name: "test", Cmd: "true"}}, UpdatedAt: 1}
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AdminDeleteAccount, http.MethodDelete, "/api/admin/accounts/member1", map[string]any{}, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})

	t.Run("logout", func(t *testing.T) {
		token := installTestAccountStore(t)
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, AuthLogout, http.MethodPost, "/api/auth/logout", map[string]any{}, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
		if cookies := recorder.Result().Cookies(); len(cookies) != 0 {
			t.Fatalf("failed logout unexpectedly cleared cookies: %#v", cookies)
		}
	})
	t.Run("bookmark sync", func(t *testing.T) {
		token := installTestAccountStore(t)
		accountStore.db.Scripts["admin"] = StoredScripts{Items: []ScriptBookmark{{Name: "old", Cmd: "old"}}, UpdatedAt: 1}
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		recorder := performAccountJSON(t, SyncScriptBookmarks, http.MethodPost, "/api/scripts/sync", map[string]any{
			"mode":      "push",
			"updatedAt": time.Now().UnixMilli(),
			"scripts":   []ScriptBookmark{{Name: "new", Cmd: "new"}},
		}, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("expected 500, got %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})
}

func TestAccountStoreRecoversBackupAndReplacesExistingFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "webssh-db.json")
	backupDB := accountDB{
		Users: map[string]StoredUser{
			"admin": {Username: "admin", PasswordHash: "hash", CreatedAt: 1, IsAdmin: true},
		},
		Sessions: map[string]StoredSession{},
		Scripts:  map[string]StoredScripts{},
	}
	b, err := json.Marshal(backupDB)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path+".bak", b, 0600); err != nil {
		t.Fatal(err)
	}

	store := &AccountStore{path: path}
	if err := store.load(); err != nil {
		t.Fatalf("failed to recover backup: %v", err)
	}
	if _, ok := store.db.Users["admin"]; !ok {
		t.Fatalf("backup user was not recovered: %#v", store.db.Users)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatalf("recovered database file is missing: %v", err)
	}

	store.mu.Lock()
	store.db.Users["member1"] = StoredUser{Username: "member1", PasswordHash: "hash2", CreatedAt: 2}
	if err := store.saveLocked(); err != nil {
		store.mu.Unlock()
		t.Fatalf("failed to replace existing database: %v", err)
	}
	store.mu.Unlock()
	if _, err := os.Stat(path + ".bak"); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("backup should be removed after successful replacement, got: %v", err)
	}

	reloaded := &AccountStore{path: path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	if _, ok := reloaded.db.Users["member1"]; !ok {
		t.Fatalf("replacement data was not persisted: %#v", reloaded.db.Users)
	}
}

func TestRegistrationDisabledByDefault(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "")
	installTestAccountStore(t)
	recorder := performAccountJSON(t, AuthRegister, http.MethodPost, "/api/auth/register", map[string]any{
		"username": "newuser",
		"password": "NewPass123!",
	}, "")
	if recorder.Code != http.StatusForbidden {
		t.Fatalf("disabled registration returned %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestLoginPreservesPasswordWhitespace(t *testing.T) {
	installTestAccountStore(t)
	password := "  Secret7  "
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	user := accountStore.db.Users["member1"]
	user.PasswordHash = string(hash)
	accountStore.db.Users["member1"] = user
	recorder := performAccountJSON(t, AuthLogin, http.MethodPost, "/api/auth/login", map[string]any{
		"username": "member1",
		"password": password,
	}, "")
	if recorder.Code != http.StatusOK {
		t.Fatalf("password containing edge spaces failed: %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestSessionLimitEvictsOldestSession(t *testing.T) {
	t.Setenv("WEBSSH_MAX_SESSIONS_PER_USER", "2")
	installTestAccountStore(t)
	accountStore.db.Sessions = map[string]StoredSession{
		"oldest": {Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()},
		"newer":  {Username: "member1", ExpiresAt: time.Now().Add(2 * time.Hour).Unix()},
	}
	accountStore.mu.Lock()
	_, _, err := createLoginSession("member1")
	accountStore.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if _, exists := accountStore.db.Sessions["oldest"]; exists {
		t.Fatal("oldest session was not evicted")
	}
	count := 0
	for _, session := range accountStore.db.Sessions {
		if session.Username == "member1" {
			count++
		}
	}
	if count != 2 {
		t.Fatalf("active session count = %d, want 2", count)
	}
}

func TestUpdaterContainerNameValidation(t *testing.T) {
	for _, name := range []string{"webssh-updater-1", "webssh-updater-123456789"} {
		if !updaterRule.MatchString(name) {
			t.Fatalf("valid updater name rejected: %q", name)
		}
	}
	for _, name := range []string{"webssh", "webssh-updater-", "webssh-updater-1;rm", "other-updater-1"} {
		if updaterRule.MatchString(name) {
			t.Fatalf("invalid updater name accepted: %q", name)
		}
	}
}

func TestAccountPasswordByteLimit(t *testing.T) {
	tests := []struct {
		name     string
		password string
		wantMsg  string
	}{
		{name: "72 ASCII bytes accepted", password: strings.Repeat("a", 72)},
		{name: "73 ASCII bytes rejected", password: strings.Repeat("a", 73), wantMsg: "密码不能超过 72 个 UTF-8 字节"},
		{name: "72 UTF-8 bytes accepted", password: strings.Repeat("密", 24)},
		{name: "75 UTF-8 bytes rejected", password: strings.Repeat("密", 25), wantMsg: "密码不能超过 72 个 UTF-8 字节"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := validatePassword(test.password); got != test.wantMsg {
				t.Fatalf("validatePassword() = %q, want %q", got, test.wantMsg)
			}
		})
	}
}

func TestRegistrationRejectsPasswordOverBcryptLimit(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "true")
	installTestAccountStore(t)
	recorder := performAccountJSON(t, AuthRegister, http.MethodPost, "/api/auth/register", map[string]any{
		"username": "newuser",
		"password": strings.Repeat("a", 73),
	}, "")
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("oversized password returned %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestDummyPasswordHashIsValid(t *testing.T) {
	if _, err := bcrypt.Cost(dummyPasswordHash); err != nil {
		t.Fatalf("dummy password hash is invalid: %v", err)
	}
}
