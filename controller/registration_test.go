package controller

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func TestRegistrationDefaultsAndSavedOverride(t *testing.T) {
	for _, tc := range []struct {
		env  string
		want bool
	}{{"", true}, {"true", true}, {"false", false}, {"invalid", false}} {
		t.Run(tc.env, func(t *testing.T) {
			t.Setenv("WEBSSH_ALLOW_REGISTRATION", tc.env)
			installTestAccountStore(t)
			if got := AllowRegistration(); got != tc.want {
				t.Fatalf("default = %v, want %v", got, tc.want)
			}
			for _, override := range []bool{false, true} {
				accountStore.db.AllowRegistration = &override
				if got := AllowRegistration(); got != override {
					t.Fatalf("saved value = %v, want %v", got, override)
				}
			}
		})
	}
}

func TestAdminRegistrationSettingPersistsAndRollsBack(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "true")
	token := installTestAccountStore(t)
	set := func(allow bool) *httptest.ResponseRecorder {
		return performAccountJSON(t, AdminSetRegistration, http.MethodPut, "/api/admin/registration", gin.H{"allowRegistration": allow}, token)
	}
	if res := set(false); res.Code != http.StatusOK {
		t.Fatal(res.Body.String())
	}
	reloaded := &AccountStore{path: accountStore.path}
	if err := reloaded.load(); err != nil {
		t.Fatal(err)
	}
	accountStore = reloaded
	if AllowRegistration() {
		t.Fatal("restart lost disabled registration")
	}
	if res := set(true); res.Code != http.StatusOK {
		t.Fatal(res.Body.String())
	}
	before := cloneAccountDB(accountStore.db)
	makeAccountStorePersistenceFail(t)
	if res := set(false); res.Code != http.StatusInternalServerError {
		t.Fatalf("failed save: %d %s", res.Code, res.Body.String())
	}
	assertAccountDBEqual(t, before)
	if !AllowRegistration() {
		t.Fatal("failed save changed registration setting")
	}
	// Snapshots must not share the optional setting pointer.
	*accountStore.db.AllowRegistration = false
	if !*before.AllowRegistration {
		t.Fatal("snapshot shares registration setting")
	}
}

func TestRegistrationPolicyPublicAndSettingsAdminOnly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "true")
	token := installTestAccountStore(t)
	memberToken := createAccountSessionForTest(t, "member1")
	router := gin.New()
	router.GET("/api/auth/registration", RegistrationPolicy)
	router.PUT("/api/admin/registration", SameOriginOnly(), AdminSetRegistration)
	res := httptest.NewRecorder()
	router.ServeHTTP(res, httptest.NewRequest(http.MethodGet, "/api/auth/registration", nil))
	var policy struct {
		Data struct {
			Allow bool `json:"allowRegistration"`
		} `json:"data"`
	}
	if err := json.Unmarshal(res.Body.Bytes(), &policy); err != nil || !policy.Data.Allow {
		t.Fatalf("guest policy: %s", res.Body.String())
	}
	for _, tc := range []struct {
		name, token, body, origin string
		status                    int
	}{
		{"guest", "", `{"allowRegistration":false}`, "", http.StatusUnauthorized},
		{"member", memberToken, `{"allowRegistration":false}`, "", http.StatusForbidden},
		{"cross-origin", token, `{"allowRegistration":false}`, "https://evil.example", http.StatusForbidden},
		{"missing", token, `{}`, "", http.StatusBadRequest},
		{"null", token, `{"allowRegistration":null}`, "", http.StatusBadRequest},
		{"wrong-type", token, `{"allowRegistration":"false"}`, "", http.StatusBadRequest},
		{"extra", token, `{"allowRegistration":false,"isAdmin":true}`, "", http.StatusBadRequest},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPut, "http://webssh.example/api/admin/registration", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if tc.token != "" {
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tc.token})
			}
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("status %d, want %d: %s", w.Code, tc.status, w.Body.String())
			}
			if !AllowRegistration() {
				t.Fatal("rejected request changed policy")
			}
		})
	}
}

func TestGuestRegistrationCreatesOnlyOrdinaryAccount(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "")
	installTestAccountStore(t)
	for _, tc := range []struct {
		body   string
		status int
	}{
		{`{"username":"guestnew","password":"GuestPass123!","isAdmin":true}`, http.StatusBadRequest},
		{`{"username":"guestnew","password":"GuestPass123!"}`, http.StatusOK},
	} {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/register", strings.NewReader(tc.body))
		c.Request.RemoteAddr = "198.51.100.201:1234"
		c.Request.Header.Set("Content-Type", "application/json")
		AuthRegister(c)
		if w.Code != tc.status {
			t.Fatalf("register = %d: %s", w.Code, w.Body.String())
		}
		if tc.status == http.StatusOK {
			user, exists := accountStore.db.Users["guestnew"]
			if !exists || user.IsAdmin || len(w.Result().Cookies()) == 0 {
				t.Fatal("registration did not create and log in an ordinary account")
			}
		}
	}
}

func TestRegistrationClosureRejectsRequestAlreadyReadingBody(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_REGISTRATION", "true")
	token := installTestAccountStore(t)
	body := &pausedAdminBody{Reader: strings.NewReader(`{"username":"lateuser","password":"GuestPass123!"}`), entered: make(chan struct{}), resume: make(chan struct{})}
	w := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(w)
	c.Request = httptest.NewRequest(http.MethodPost, "/api/auth/register", body)
	c.Request.RemoteAddr = "198.51.100.202:1234"
	c.Request.Header.Set("Content-Type", "application/json")
	done := make(chan struct{})
	go func() { defer close(done); AuthRegister(c) }()
	defer func() { close(body.resume); <-done }()
	select {
	case <-body.entered:
	case <-time.After(5 * time.Second):
		t.Fatal("body not reached")
	}
	res := performAccountJSON(t, AdminSetRegistration, http.MethodPut, "/api/admin/registration", gin.H{"allowRegistration": false}, token)
	if res.Code != http.StatusOK {
		t.Fatal(res.Body.String())
	}
	body.resume <- struct{}{}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("registration did not finish")
	}
	if w.Code != http.StatusForbidden {
		t.Fatalf("stale registration = %d: %s", w.Code, w.Body.String())
	}
	if _, exists := accountStore.db.Users["lateuser"]; exists {
		t.Fatal("closed registration created an account")
	}
	if len(w.Result().Cookies()) != 0 {
		t.Fatal("closed registration issued a session")
	}
}
