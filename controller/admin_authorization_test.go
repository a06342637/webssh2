package controller

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

// Pause after admission but before parsing completes, without timing sleeps.
type pausedAdminBody struct {
	io.Reader
	entered chan struct{}
	resume  chan struct{}
	once    sync.Once
}

func (b *pausedAdminBody) Read(p []byte) (int, error) {
	b.once.Do(func() { close(b.entered); <-b.resume })
	return b.Reader.Read(p)
}

func (b *pausedAdminBody) Close() error { return nil }

func TestAdminWritesRejectRevokedAuthorityDuringBodyRead(t *testing.T) {
	gin.SetMode(gin.TestMode)
	operations := []struct {
		name    string
		handler gin.HandlerFunc
		body    any
	}{
		{"create", AdminCreateAccount, gin.H{"username": "newadmin", "password": "NewPass123!", "isAdmin": true}},
		{"update", AdminUpdateAccount, gin.H{"username": "admin", "isAdmin": true, "password": "NewPass123!"}},
		{"restore", AdminRestoreScriptBookmarks, validSiteScriptBackup(siteScriptBackupUser{
			Username: "member1", Scripts: []ScriptBookmark{{ID: "new", Name: "new", Cmd: "whoami"}},
		})},
	}
	revocations := []struct {
		name   string
		status int
		revoke func(string)
	}{
		{"demoted", http.StatusForbidden, func(_ string) {
			user := accountStore.db.Users["admin"]
			user.IsAdmin = false
			accountStore.db.Users["admin"] = user
		}},
		{"logged-out", http.StatusUnauthorized, func(token string) { delete(accountStore.db.Sessions, token) }},
		{"expired", http.StatusUnauthorized, func(token string) {
			session := accountStore.db.Sessions[token]
			session.ExpiresAt = time.Now().Add(-time.Second).Unix()
			accountStore.db.Sessions[token] = session
		}},
		{"deleted", http.StatusUnauthorized, func(_ string) { delete(accountStore.db.Users, "admin") }},
	}
	for _, operation := range operations {
		for _, revocation := range revocations {
			t.Run(operation.name+"/"+revocation.name, func(t *testing.T) {
				token := installTestAccountStore(t)
				accountStore.db.Users["otheradmin"] = StoredUser{Username: "otheradmin", IsAdmin: true}
				encoded, err := json.Marshal(operation.body)
				if err != nil {
					t.Fatal(err)
				}
				body := &pausedAdminBody{Reader: bytes.NewReader(encoded), entered: make(chan struct{}), resume: make(chan struct{})}
				recorder := httptest.NewRecorder()
				ctx, _ := gin.CreateTestContext(recorder)
				ctx.Request = httptest.NewRequest(http.MethodPost, "/", body)
				ctx.Request.Header.Set("Content-Type", "application/json")
				ctx.Request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
				done := make(chan struct{})
				go func() { defer close(done); operation.handler(ctx) }()
				defer func() { close(body.resume); <-done }()
				select {
				case <-body.entered:
				case <-time.After(5 * time.Second):
					t.Fatal("request never reached body read")
				}
				accountStore.mu.Lock()
				revocation.revoke(token)
				before := accountStore.snapshotLocked()
				accountStore.mu.Unlock()
				// Sending releases the read; the deferred close also releases failures.
				body.resume <- struct{}{}
				select {
				case <-done:
				case <-time.After(5 * time.Second):
					t.Fatal("request did not finish")
				}
				if recorder.Code != revocation.status {
					t.Fatalf("stale request returned %d, want %d: %s", recorder.Code, revocation.status, recorder.Body.String())
				}
				accountStore.mu.RLock()
				after := accountStore.snapshotLocked()
				accountStore.mu.RUnlock()
				if !reflect.DeepEqual(before, after) {
					t.Fatal("revoked request changed account data")
				}
			})
		}
	}
}
