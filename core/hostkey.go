package core

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var knownHostsMu sync.Mutex

func hostKeyCallback() (ssh.HostKeyCallback, error) {
	policy := strings.ToLower(strings.TrimSpace(os.Getenv("WEBSSH_HOST_KEY_POLICY")))
	if policy == "" {
		policy = "tofu"
	}
	switch policy {
	case "insecure":
		return ssh.InsecureIgnoreHostKey(), nil
	case "strict", "tofu":
	default:
		return nil, fmt.Errorf("invalid WEBSSH_HOST_KEY_POLICY %q (use tofu, strict, or insecure)", policy)
	}

	dataDir := strings.TrimSpace(os.Getenv("WEBSSH_DATA_DIR"))
	if dataDir == "" {
		dataDir = strings.TrimSpace(os.Getenv("DATA_DIR"))
	}
	if dataDir == "" {
		dataDir = "data"
	}
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("create SSH trust directory: %w", err)
	}
	if err := os.Chmod(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("secure SSH trust directory: %w", err)
	}
	knownHostsPath := filepath.Join(dataDir, "known_hosts")
	if policy == "strict" {
		if err := ensureKnownHostsFile(knownHostsPath, false); err != nil {
			return nil, err
		}
		return knownhosts.New(knownHostsPath)
	}
	if err := ensureKnownHostsFile(knownHostsPath, true); err != nil {
		return nil, err
	}
	return func(hostname string, remote net.Addr, key ssh.PublicKey) error {
		knownHostsMu.Lock()
		defer knownHostsMu.Unlock()

		checker, err := knownhosts.New(knownHostsPath)
		if err != nil {
			return fmt.Errorf("load SSH known_hosts: %w", err)
		}
		err = checker(hostname, remote, key)
		if err == nil {
			return nil
		}
		keyErr, ok := err.(*knownhosts.KeyError)
		if !ok || len(keyErr.Want) != 0 {
			return fmt.Errorf("SSH host key verification failed for %s: %w", hostname, err)
		}
		line := knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key)
		file, openErr := os.OpenFile(knownHostsPath, os.O_WRONLY|os.O_APPEND, 0600)
		if openErr != nil {
			return fmt.Errorf("save SSH host key: %w", openErr)
		}
		_, writeErr := file.WriteString(line + "\n")
		closeErr := file.Close()
		if writeErr != nil {
			return fmt.Errorf("save SSH host key: %w", writeErr)
		}
		if closeErr != nil {
			return fmt.Errorf("save SSH host key: %w", closeErr)
		}
		return nil
	}, nil
}

func ensureKnownHostsFile(path string, create bool) error {
	flags := os.O_RDONLY
	if create {
		flags = os.O_RDONLY | os.O_CREATE
	}
	file, err := os.OpenFile(path, flags, 0600)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("SSH strict host key policy requires %s", path)
		}
		return fmt.Errorf("open SSH known_hosts: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close SSH known_hosts: %w", err)
	}
	if err := os.Chmod(path, 0600); err != nil {
		return fmt.Errorf("secure SSH known_hosts: %w", err)
	}
	return nil
}
