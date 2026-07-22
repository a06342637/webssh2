package core

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/crypto/ssh"
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
	if err := callback("example.test:22", remote, testSSHKey(t)); err == nil {
		t.Fatal("changed host key was accepted")
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
