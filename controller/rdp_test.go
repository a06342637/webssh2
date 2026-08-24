package controller

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func resetRDPCredentialSecretForTest(t *testing.T) {
	t.Helper()
	rdpCredentialSecret.Once = sync.Once{}
	rdpCredentialSecret.key = [32]byte{}
	rdpCredentialSecret.err = nil
}

func TestRDPCredentialRoundTripAndBindings(t *testing.T) {
	resetRDPCredentialSecretForTest(t)
	now := time.Unix(1800000000, 0)
	original := rdpCredential{
		Version:    rdpCredentialVersion,
		Host:       "rdp.example.com",
		Port:       24391,
		Relay:      core.RDPRelay{Kind: core.RelaySocks5, Host: "proxy.example.com", Port: 1080, Username: "proxy-user", Password: "proxy-pass"},
		TrustScope: strings.Repeat("a", 32),
		ClientIP:   "198.51.100.10",
		ExpiresAt:  now.Add(time.Minute).Unix(),
	}
	encoded, err := sealRDPCredential(original)
	if err != nil {
		t.Fatalf("seal credential: %v", err)
	}
	if strings.Contains(encoded, original.Host) || strings.Contains(encoded, original.Relay.Password) {
		t.Fatal("credential exposed plaintext host or relay password")
	}
	opened, err := openRDPCredential(encoded, original.ClientIP, original.TrustScope, now)
	if err != nil {
		t.Fatalf("open credential: %v", err)
	}
	if opened.Host != original.Host || opened.Port != original.Port || opened.Relay.Password != original.Relay.Password {
		t.Fatalf("opened credential = %#v", opened)
	}
	if _, err := openRDPCredential(encoded, "198.51.100.11", original.TrustScope, now); err == nil {
		t.Fatal("credential was accepted from another client IP")
	}
	if _, err := openRDPCredential(encoded, original.ClientIP, strings.Repeat("b", 32), now); err == nil {
		t.Fatal("credential was accepted from another browser scope")
	}
	if _, err := openRDPCredential(encoded, original.ClientIP, original.TrustScope, now.Add(2*time.Minute)); err == nil {
		t.Fatal("expired credential was accepted")
	}
}

func TestRDPCredentialRejectsTampering(t *testing.T) {
	resetRDPCredentialSecretForTest(t)
	now := time.Unix(1800000000, 0)
	credential, err := sealRDPCredential(rdpCredential{Version: rdpCredentialVersion, Host: "host", Port: 3389, TrustScope: strings.Repeat("c", 32), ClientIP: "203.0.113.8", ExpiresAt: now.Add(time.Minute).Unix()})
	if err != nil {
		t.Fatal(err)
	}
	last := credential[len(credential)-1]
	replacement := byte('A')
	if last == replacement {
		replacement = 'B'
	}
	tampered := credential[:len(credential)-1] + string(replacement)
	if _, err := openRDPCredential(tampered, "203.0.113.8", strings.Repeat("c", 32), now); err == nil {
		t.Fatal("tampered credential was accepted")
	}
}

func TestCreateRDPSessionAcceptsAnyValidPortWithoutTicketStore(t *testing.T) {
	resetRDPCredentialSecretForTest(t)
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest(http.MethodPost, "/rdp/session", bytes.NewBufferString(`{"hostname":"rdp.example.com","port":24391,"relay":{"kind":"none"}}`))
	ctx.Request.Header.Set("Content-Type", "application/json")
	ctx.Request.RemoteAddr = "198.51.100.20:12345"
	ctx.Set(trustScopeContextKey, strings.Repeat("d", 32))

	body := CreateRDPSession(ctx)
	if body.Msg != "success" {
		t.Fatalf("CreateRDPSession Msg = %q", body.Msg)
	}
	data, ok := body.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("unexpected data type %T", body.Data)
	}
	if data["destination"] != "rdp.example.com:24391" {
		t.Fatalf("destination = %v", data["destination"])
	}
	encoded, ok := data["credential"].(string)
	if !ok || encoded == "" {
		t.Fatalf("credential = %T %v", data["credential"], data["credential"])
	}
	if _, exists := data["ticket"]; exists {
		t.Fatal("legacy ticket field was returned")
	}
}
