package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

func testSSHKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	_, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	key, err := ssh.NewPublicKey(privateKey.Public())
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func TestTOFUHostKeyPersistenceAndMismatch(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("WEBSSH_DATA_DIR", dataDir)
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "tofu")
	callback, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	remote := &net.TCPAddr{IP: net.ParseIP("203.0.113.10"), Port: 22}
	key := testSSHKey(t)
	if err := callback("example.test:22", remote, key); err != nil {
		t.Fatalf("first-use key rejected: %v", err)
	}
	knownHostsPath := filepath.Join(dataDir, "known_hosts")
	if info, err := os.Stat(knownHostsPath); err != nil {
		t.Fatal(err)
	} else if runtime.GOOS != "windows" && info.Mode().Perm() != 0600 {
		t.Fatalf("known_hosts mode = %o", info.Mode().Perm())
	}
	if err := callback("example.test:22", remote, key); err != nil {
		t.Fatalf("persisted matching key rejected: %v", err)
	}
	changedErr := callback("example.test:22", remote, testSSHKey(t))
	if changedErr == nil {
		t.Fatal("changed host key was accepted")
	}
	var mismatch *HostKeyMismatchError
	if !errors.As(changedErr, &mismatch) {
		t.Fatalf("changed host key error = %T, want HostKeyMismatchError", changedErr)
	}
	if mismatch.Hostname != "example.test:22" || mismatch.Presented.Fingerprint == "" || len(mismatch.Expected) != 1 {
		t.Fatalf("unexpected mismatch details: %#v", mismatch)
	}
}

func TestTOFUHostKeyTrustOnceDoesNotPersist(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("WEBSSH_DATA_DIR", dataDir)
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "tofu")
	remote := &net.TCPAddr{IP: net.ParseIP("203.0.113.11"), Port: 22}
	hostname := "trust-once.test:22"
	oldKey := testSSHKey(t)
	newKey := testSSHKey(t)

	initial, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := initial(hostname, remote, oldKey); err != nil {
		t.Fatal(err)
	}
	oneTime, err := hostKeyCallbackWithDecision(hostKeyActionTrustOnce, ssh.FingerprintSHA256(newKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := oneTime(hostname, remote, newKey); err != nil {
		t.Fatalf("one-time trusted key rejected: %v", err)
	}

	defaultCallback, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := defaultCallback(hostname, remote, newKey); err == nil {
		t.Fatal("one-time trusted key was unexpectedly persisted")
	}
	if err := defaultCallback(hostname, remote, oldKey); err != nil {
		t.Fatalf("original persisted key was replaced: %v", err)
	}
}

func TestTOFUHostKeyReplacePersistsOnlyTarget(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("WEBSSH_DATA_DIR", dataDir)
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "tofu")
	targetRemote := &net.TCPAddr{IP: net.ParseIP("203.0.113.12"), Port: 22}
	otherRemote := &net.TCPAddr{IP: net.ParseIP("203.0.113.13"), Port: 22}
	targetHost := "replace.test:22"
	otherHost := "other.test:22"
	oldKey := testSSHKey(t)
	newKey := testSSHKey(t)
	otherKey := testSSHKey(t)

	initial, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := initial(targetHost, targetRemote, oldKey); err != nil {
		t.Fatal(err)
	}
	if err := initial(otherHost, otherRemote, otherKey); err != nil {
		t.Fatal(err)
	}
	replace, err := hostKeyCallbackWithDecision(hostKeyActionReplace, ssh.FingerprintSHA256(newKey))
	if err != nil {
		t.Fatal(err)
	}
	if err := replace(targetHost, targetRemote, newKey); err != nil {
		t.Fatalf("replacement key rejected: %v", err)
	}

	defaultCallback, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := defaultCallback(targetHost, targetRemote, newKey); err != nil {
		t.Fatalf("replacement key was not persisted: %v", err)
	}
	if err := defaultCallback(otherHost, otherRemote, otherKey); err != nil {
		t.Fatalf("unrelated host key was removed: %v", err)
	}
	content, err := os.ReadFile(filepath.Join(dataDir, "known_hosts"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(content), strings.TrimSpace(string(ssh.MarshalAuthorizedKey(oldKey)))) {
		t.Fatal("old target key remains in known_hosts")
	}
}

func TestTOFUHostKeyReplaceRequiresConfirmedFingerprint(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("WEBSSH_DATA_DIR", dataDir)
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "tofu")
	remote := &net.TCPAddr{IP: net.ParseIP("203.0.113.14"), Port: 22}
	hostname := "fingerprint.test:22"
	oldKey := testSSHKey(t)
	newKey := testSSHKey(t)

	initial, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := initial(hostname, remote, oldKey); err != nil {
		t.Fatal(err)
	}
	replace, err := hostKeyCallbackWithDecision(hostKeyActionReplace, "SHA256:not-the-presented-key")
	if err != nil {
		t.Fatal(err)
	}
	err = replace(hostname, remote, newKey)
	var mismatch *HostKeyMismatchError
	if !errors.As(err, &mismatch) || mismatch.Reason == "" {
		t.Fatalf("replacement with wrong fingerprint error = %#v", err)
	}

	defaultCallback, err := hostKeyCallback()
	if err != nil {
		t.Fatal(err)
	}
	if err := defaultCallback(hostname, remote, oldKey); err != nil {
		t.Fatalf("old key changed after rejected replacement: %v", err)
	}
}

func TestReplaceKnownHostKeyHandlesLegacyIPv6AndPreservesOtherPorts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "known_hosts")
	legacyIPv6 := "2001:db8::10"
	oldIPv6Key := testSSHKey(t)
	newIPv6Key := testSSHKey(t)
	port22Key := testSSHKey(t)
	port2222Key := testSSHKey(t)
	content := strings.Join([]string{
		legacyIPv6 + " " + strings.TrimSpace(string(ssh.MarshalAuthorizedKey(oldIPv6Key))),
		knownhosts.Line([]string{"example.test:22"}, port22Key),
		knownhosts.Line([]string{"example.test:2222"}, port2222Key),
	}, "\n") + "\n"
	if err := os.WriteFile(path, []byte(content), 0600); err != nil {
		t.Fatal(err)
	}
	if err := replaceKnownHostKey(path, "[2001:db8::10]:22", newIPv6Key); err != nil {
		t.Fatal(err)
	}
	if err := replaceKnownHostKey(path, "example.test:2222", newIPv6Key); err != nil {
		t.Fatal(err)
	}
	updated, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	text := string(updated)
	if strings.Contains(text, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(oldIPv6Key)))) || strings.Contains(text, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(port2222Key)))) {
		t.Fatalf("stale target entries remain:\n%s", text)
	}
	if !strings.Contains(text, strings.TrimSpace(string(ssh.MarshalAuthorizedKey(port22Key)))) {
		t.Fatalf("port 22 entry was removed while replacing port 2222:\n%s", text)
	}
	if !strings.Contains(text, knownhosts.Normalize("[2001:db8::10]:22")) {
		t.Fatalf("normalized IPv6 replacement missing:\n%s", text)
	}
}

func TestStrictHostKeyPolicyRequiresKnownHosts(t *testing.T) {
	t.Setenv("WEBSSH_DATA_DIR", t.TempDir())
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "strict")
	if _, err := hostKeyCallback(); err == nil {
		t.Fatal("strict policy accepted a missing known_hosts file")
	}
}

func TestInvalidHostKeyPolicyRejected(t *testing.T) {
	t.Setenv("WEBSSH_DATA_DIR", t.TempDir())
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "typo")
	if _, err := hostKeyCallback(); err == nil {
		t.Fatal("invalid host-key policy was accepted")
	}
}

func TestTOFUTrustScopesAreIsolated(t *testing.T) {
	dataDir := t.TempDir()
	t.Setenv("WEBSSH_DATA_DIR", dataDir)
	t.Setenv("WEBSSH_HOST_KEY_POLICY", "tofu")
	remote := &net.TCPAddr{IP: net.ParseIP("203.0.113.20"), Port: 22}
	hostname := "scoped.test:22"
	firstKey := testSSHKey(t)
	secondKey := testSSHKey(t)

	firstScope, err := hostKeyCallbackForScope(strings.Repeat("a", 32), "", "")
	if err != nil {
		t.Fatal(err)
	}
	secondScope, err := hostKeyCallbackForScope(strings.Repeat("b", 32), "", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := firstScope(hostname, remote, firstKey); err != nil {
		t.Fatal(err)
	}
	if err := secondScope(hostname, remote, secondKey); err != nil {
		t.Fatalf("second trust scope inherited another user's key: %v", err)
	}
	if err := firstScope(hostname, remote, secondKey); err == nil {
		t.Fatal("first trust scope accepted a changed key")
	}
	entries, err := os.ReadDir(filepath.Join(dataDir, "known_hosts.d"))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 {
		t.Fatalf("scoped trust directory contains %d files, want 2", len(entries))
	}
}
