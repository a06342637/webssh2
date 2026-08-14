package controller

import (
	"encoding/json"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func validSiteScriptBackup(users ...siteScriptBackupUser) siteScriptBookmarksBackup {
	return siteScriptBookmarksBackup{
		App:        siteScriptBackupApp,
		Type:       siteScriptBackupType,
		Scope:      siteScriptBackupScope,
		Version:    siteScriptBackupVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ExportedBy: "admin",
		Users:      users,
	}
}

func installMemberSession() string {
	const token = "member-session"
	accountStore.db.Sessions[token] = StoredSession{Username: "member1", ExpiresAt: time.Now().Add(time.Hour).Unix()}
	return token
}

func responseCode(t *testing.T, body []byte) string {
	t.Helper()
	var response struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &response); err != nil {
		t.Fatal(err)
	}
	return response.Code
}

func TestAdminExportScriptBookmarksIncludesEveryUserWithoutSecrets(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	accountStore.db.Scripts["admin"] = StoredScripts{
		Items:      []ScriptBookmark{{ID: "script-1", Name: "uptime", Cmd: "uptime"}},
		Categories: []ScriptCategory{{ID: "ops", Emoji: "🛠️", Name: "运维", CreatedAt: 1}},
		UpdatedAt:  10,
		Revision:   3,
	}

	recorder := performAccountJSON(t, AdminExportScriptBookmarks, http.MethodGet, "/api/admin/bookmarks/backup", nil, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("export returned %d: %s", recorder.Code, recorder.Body.String())
	}
	body := recorder.Body.String()
	for _, secretField := range []string{"passwordHash", "sessions", "admin-session", "unused"} {
		if strings.Contains(body, secretField) {
			t.Fatalf("export leaked %q: %s", secretField, body)
		}
	}
	var response struct {
		Data struct {
			Backup        siteScriptBookmarksBackup `json:"backup"`
			UserCount     int                       `json:"userCount"`
			ScriptCount   int                       `json:"scriptCount"`
			CategoryCount int                       `json:"categoryCount"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	backup := response.Data.Backup
	if backup.Type != siteScriptBackupType || backup.Scope != siteScriptBackupScope || backup.Version != siteScriptBackupVersion {
		t.Fatalf("unexpected backup envelope: %#v", backup)
	}
	if response.Data.UserCount != 2 || len(backup.Users) != 2 {
		t.Fatalf("expected every account in export, got %#v", response.Data)
	}
	if backup.Users[0].Username != "admin" || backup.Users[1].Username != "member1" {
		t.Fatalf("users were not deterministically sorted: %#v", backup.Users)
	}
	if backup.Users[1].Scripts == nil || backup.Users[1].Categories == nil {
		t.Fatalf("empty account workspace must export as arrays: %#v", backup.Users[1])
	}
	if response.Data.ScriptCount != 1 || response.Data.CategoryCount != 1 {
		t.Fatalf("unexpected export statistics: %#v", response.Data)
	}
}

func TestSiteScriptBackupEndpointsRequireAdministrator(t *testing.T) {
	gin.SetMode(gin.TestMode)
	installTestAccountStore(t)
	memberToken := installMemberSession()
	backup := validSiteScriptBackup(siteScriptBackupUser{Username: "member1", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}})

	if recorder := performAccountJSON(t, AdminExportScriptBookmarks, http.MethodGet, "/api/admin/bookmarks/backup", nil, memberToken); recorder.Code != http.StatusForbidden {
		t.Fatalf("member export returned %d: %s", recorder.Code, recorder.Body.String())
	}
	if recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, memberToken); recorder.Code != http.StatusForbidden {
		t.Fatalf("member restore returned %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestAdminRestoreScriptBookmarksRejectsPersonalAndMalformedBackups(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)

	tests := []struct {
		name     string
		body     any
		wantCode string
	}{
		{
			name: "personal backup",
			body: map[string]any{
				"app": "webssh2", "type": "script_bookmarks", "scope": "personal", "version": 3,
				"scripts": []any{}, "categories": []any{},
			},
			wantCode: "wrong_backup_scope",
		},
		{
			name: "unknown field",
			body: map[string]any{
				"app": "webssh2", "type": siteScriptBackupType, "scope": "site", "version": 1,
				"exportedAt": time.Now().UTC().Format(time.RFC3339Nano), "exportedBy": "admin",
				"users": []any{}, "passwordHash": "must-not-be-accepted",
			},
			wantCode: "invalid_backup_format",
		},
		{
			name: "duplicate user",
			body: validSiteScriptBackup(
				siteScriptBackupUser{Username: "admin", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}},
				siteScriptBackupUser{Username: "admin", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}},
			),
			wantCode: "duplicate_backup_user",
		},
		{
			name:     "invalid username",
			body:     validSiteScriptBackup(siteScriptBackupUser{Username: "bad", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}}),
			wantCode: "invalid_backup_user",
		},
		{
			name: "unsupported version",
			body: func() siteScriptBookmarksBackup {
				backup := validSiteScriptBackup(siteScriptBackupUser{Username: "admin", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}})
				backup.Version = 99
				return backup
			}(),
			wantCode: "unsupported_backup_version",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			before := cloneAccountDB(accountStore.db)
			recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", test.body, token)
			if recorder.Code != http.StatusBadRequest {
				t.Fatalf("restore returned %d: %s", recorder.Code, recorder.Body.String())
			}
			if got := responseCode(t, recorder.Body.Bytes()); got != test.wantCode {
				t.Fatalf("code = %q, want %q: %s", got, test.wantCode, recorder.Body.String())
			}
			if !reflect.DeepEqual(accountStore.db, before) {
				t.Fatal("invalid backup mutated account database")
			}
		})
	}
}

func TestAdminRestoreScriptBookmarksMatchesUsersAndProtectsRestoreBoundary(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	accountStore.db.Scripts["admin"] = StoredScripts{
		Items:     []ScriptBookmark{{ID: "old-admin", Name: "old", Cmd: "old"}},
		UpdatedAt: 10,
		Revision:  5,
	}
	memberBefore := StoredScripts{
		Items:     []ScriptBookmark{{ID: "member-old", Name: "member", Cmd: "member"}},
		UpdatedAt: 20,
		Revision:  2,
	}
	accountStore.db.Scripts["member1"] = memberBefore
	backup := validSiteScriptBackup(
		siteScriptBackupUser{
			Username:   "admin",
			Scripts:    []ScriptBookmark{{ID: "restored", Name: "restored", Cmd: "echo restored", CategoryID: "ops"}},
			Categories: []ScriptCategory{{ID: "ops", Emoji: "🧰", Name: "恢复分类", CreatedAt: 1}},
			UpdatedAt:  100,
			Revision:   100,
		},
		siteScriptBackupUser{Username: "ghost", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}, UpdatedAt: 0, Revision: 0},
	)

	recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, token)
	if recorder.Code != http.StatusOK {
		t.Fatalf("restore returned %d: %s", recorder.Code, recorder.Body.String())
	}
	restored := accountStore.db.Scripts["admin"]
	if len(restored.Items) != 1 || restored.Items[0].ID != "restored" || len(restored.Categories) != 1 {
		t.Fatalf("admin workspace was not replaced: %#v", restored)
	}
	if restored.Revision != 6 || restored.ResetRevision != 6 {
		t.Fatalf("restore revision boundary = (%d, %d), want (6, 6)", restored.Revision, restored.ResetRevision)
	}
	if !reflect.DeepEqual(accountStore.db.Scripts["member1"], memberBefore) {
		t.Fatalf("user absent from backup was modified: %#v", accountStore.db.Scripts["member1"])
	}
	var response struct {
		Data struct {
			RestoredUsers          int      `json:"restoredUsers"`
			SkippedUsers           int      `json:"skippedUsers"`
			MissingUsers           []string `json:"missingUsers"`
			CurrentAccountRestored bool     `json:"currentAccountRestored"`
		} `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Data.RestoredUsers != 1 || response.Data.SkippedUsers != 1 || len(response.Data.MissingUsers) != 1 || response.Data.MissingUsers[0] != "ghost" || !response.Data.CurrentAccountRestored {
		t.Fatalf("unexpected restore result: %#v", response.Data)
	}

	conflict := performAccountJSON(t, SyncScriptBookmarks, http.MethodPost, "/api/scripts/sync", map[string]any{
		"mode":         "push",
		"account":      "admin",
		"baseRevision": 5,
		"updatedAt":    11,
		"scripts":      []ScriptBookmark{{ID: "old-admin", Name: "old", Cmd: "old"}},
		"categories":   []ScriptCategory{},
	}, token)
	if conflict.Code != http.StatusConflict || responseCode(t, conflict.Body.Bytes()) != "workspace_restored" {
		t.Fatalf("stale client was not stopped at restore boundary: %d %s", conflict.Code, conflict.Body.String())
	}
	if accountStore.db.Scripts["admin"].Items[0].ID != "restored" {
		t.Fatal("stale client overwrote restored bookmarks")
	}
}

func TestAdminRestoreScriptBookmarksCanRestoreEmptyWorkspaceAndRollsBack(t *testing.T) {
	gin.SetMode(gin.TestMode)

	t.Run("empty workspace", func(t *testing.T) {
		token := installTestAccountStore(t)
		accountStore.db.Scripts["admin"] = StoredScripts{Items: []ScriptBookmark{{ID: "old", Name: "old", Cmd: "old"}}, Revision: 1}
		backup := validSiteScriptBackup(siteScriptBackupUser{Username: "admin", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}})
		recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, token)
		if recorder.Code != http.StatusOK {
			t.Fatalf("empty restore returned %d: %s", recorder.Code, recorder.Body.String())
		}
		workspace := accountStore.db.Scripts["admin"]
		if len(workspace.Items) != 0 || len(workspace.Categories) != 0 || workspace.ResetRevision != 2 {
			t.Fatalf("workspace was not restored empty: %#v", workspace)
		}
	})

	t.Run("persistence failure", func(t *testing.T) {
		token := installTestAccountStore(t)
		accountStore.db.Scripts["admin"] = StoredScripts{Items: []ScriptBookmark{{ID: "old", Name: "old", Cmd: "old"}}, Revision: 1}
		before := cloneAccountDB(accountStore.db)
		makeAccountStorePersistenceFail(t)
		backup := validSiteScriptBackup(siteScriptBackupUser{
			Username:   "admin",
			Scripts:    []ScriptBookmark{{ID: "new", Name: "new", Cmd: "new"}},
			Categories: []ScriptCategory{},
		})
		recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, token)
		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("failed restore returned %d: %s", recorder.Code, recorder.Body.String())
		}
		assertAccountDBEqual(t, before)
	})
}

func TestAdminRestoreScriptBookmarksRejectsBackupWithNoMatchingUsers(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	before := cloneAccountDB(accountStore.db)
	backup := validSiteScriptBackup(siteScriptBackupUser{Username: "ghost", Scripts: []ScriptBookmark{}, Categories: []ScriptCategory{}})
	recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, token)
	if recorder.Code != http.StatusConflict || responseCode(t, recorder.Body.Bytes()) != "no_matching_users" {
		t.Fatalf("no-match restore returned %d: %s", recorder.Code, recorder.Body.String())
	}
	assertAccountDBEqual(t, before)
}

func TestAdminRestoreScriptBookmarksRejectsOversizedUserWorkspace(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := installTestAccountStore(t)
	scripts := make([]ScriptBookmark, maxScriptBookmarks)
	command := strings.Repeat("x", 18000)
	for index := range scripts {
		scripts[index] = ScriptBookmark{ID: "script-" + time.UnixMilli(int64(index)).UTC().Format("150405.000") + "-" + string(rune('A'+index%26)), Name: "script", Cmd: command}
	}
	backup := validSiteScriptBackup(siteScriptBackupUser{Username: "admin", Scripts: scripts, Categories: []ScriptCategory{}})
	recorder := performAccountJSON(t, AdminRestoreScriptBookmarks, http.MethodPost, "/api/admin/bookmarks/restore", backup, token)
	if recorder.Code != http.StatusBadRequest || responseCode(t, recorder.Body.Bytes()) != "backup_workspace_too_large" {
		t.Fatalf("oversized restore returned %d: %s", recorder.Code, recorder.Body.String())
	}
}

func TestSiteScriptBackupRequestBodyLimitIsLargerThanPersonalSync(t *testing.T) {
	if got := SiteScriptBackupRequestBodyLimit(); got < 256<<20 {
		t.Fatalf("site backup request limit = %d, want at least 256 MiB", got)
	}
}
