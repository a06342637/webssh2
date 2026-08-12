package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
)

var knownHostsMu sync.Mutex

var trustScopeRule = regexp.MustCompile(`^[a-fA-F0-9]{32,128}$`)

const (
	hostKeyActionTrustOnce = "once"
	hostKeyActionReplace   = "replace"
)

type HostKeyInfo struct {
	Algorithm   string `json:"algorithm"`
	Fingerprint string `json:"fingerprint"`
}

type HostKeyMismatchError struct {
	Hostname  string        `json:"hostname"`
	Presented HostKeyInfo   `json:"presented"`
	Expected  []HostKeyInfo `json:"expected"`
	Reason    string        `json:"reason,omitempty"`
}

func (e *HostKeyMismatchError) Error() string {
	if e == nil {
		return "SSH host key verification failed"
	}
	message := fmt.Sprintf(
		"SSH host key verification failed for %s: knownhosts: key mismatch (new %s %s)",
		e.Hostname,
		e.Presented.Algorithm,
		e.Presented.Fingerprint,
	)
	if e.Reason != "" {
		message += ": " + e.Reason
	}
	return message
}

func hostKeyCallback() (ssh.HostKeyCallback, error) {
	return hostKeyCallbackWithDecision("", "")
}

func hostKeyCallbackWithDecision(action, confirmedFingerprint string) (ssh.HostKeyCallback, error) {
	return hostKeyCallbackForScope("", action, confirmedFingerprint)
}

func NormalizeTrustScope(scope string) (string, error) {
	scope = strings.ReplaceAll(strings.TrimSpace(scope), "-", "")
	if !trustScopeRule.MatchString(scope) {
		return "", fmt.Errorf("invalid SSH trust scope")
	}
	return strings.ToLower(scope), nil
}

func hostKeyCallbackForScope(scope, action, confirmedFingerprint string) (ssh.HostKeyCallback, error) {
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
	if strings.TrimSpace(scope) != "" {
		normalizedScope, err := NormalizeTrustScope(scope)
		if err != nil {
			return nil, err
		}
		trustDir := filepath.Join(dataDir, "known_hosts.d")
		if err := os.MkdirAll(trustDir, 0700); err != nil {
			return nil, fmt.Errorf("create scoped SSH trust directory: %w", err)
		}
		if err := os.Chmod(trustDir, 0700); err != nil {
			return nil, fmt.Errorf("secure scoped SSH trust directory: %w", err)
		}
		digest := sha256.Sum256([]byte(normalizedScope))
		knownHostsPath = filepath.Join(trustDir, hex.EncodeToString(digest[:])+".known_hosts")
	}
	if err := ensureKnownHostsFile(knownHostsPath, true); err != nil {
		return nil, err
	}
	action = strings.ToLower(strings.TrimSpace(action))
	confirmedFingerprint = strings.TrimSpace(confirmedFingerprint)
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
		if !ok {
			return fmt.Errorf("SSH host key verification failed for %s: %w", hostname, err)
		}
		if len(keyErr.Want) != 0 {
			mismatch := newHostKeyMismatchError(hostname, key, keyErr.Want)
			switch action {
			case "":
				return mismatch
			case hostKeyActionTrustOnce, hostKeyActionReplace:
				if confirmedFingerprint != mismatch.Presented.Fingerprint {
					mismatch.Reason = "the presented fingerprint changed or was not confirmed"
					return mismatch
				}
				if action == hostKeyActionReplace {
					if err := replaceKnownHostKey(knownHostsPath, hostname, key); err != nil {
						return fmt.Errorf("replace SSH host key for %s: %w", hostname, err)
					}
				}
				return nil
			default:
				mismatch.Reason = "invalid host key confirmation action"
				return mismatch
			}
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

func newHostKeyMismatchError(hostname string, presented ssh.PublicKey, expected []knownhosts.KnownKey) *HostKeyMismatchError {
	result := &HostKeyMismatchError{
		Hostname:  hostname,
		Presented: hostKeyInfo(presented),
		Expected:  make([]HostKeyInfo, 0, len(expected)),
	}
	seen := make(map[string]struct{}, len(expected))
	for _, known := range expected {
		info := hostKeyInfo(known.Key)
		key := info.Algorithm + "\x00" + info.Fingerprint
		if _, exists := seen[key]; exists {
			continue
		}
		seen[key] = struct{}{}
		result.Expected = append(result.Expected, info)
	}
	sort.Slice(result.Expected, func(i, j int) bool {
		if result.Expected[i].Algorithm == result.Expected[j].Algorithm {
			return result.Expected[i].Fingerprint < result.Expected[j].Fingerprint
		}
		return result.Expected[i].Algorithm < result.Expected[j].Algorithm
	})
	return result
}

func hostKeyInfo(key ssh.PublicKey) HostKeyInfo {
	return HostKeyInfo{
		Algorithm:   key.Type(),
		Fingerprint: ssh.FingerprintSHA256(key),
	}
}

func replaceKnownHostKey(path, hostname string, key ssh.PublicKey) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	aliases := knownHostAliases(hostname)
	lines := strings.Split(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n")
	for len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	kept := make([]string, 0, len(lines)+1)
	for _, line := range lines {
		if knownHostsLineMatches(line, aliases) {
			continue
		}
		kept = append(kept, line)
	}
	kept = append(kept, knownhosts.Line([]string{knownhosts.Normalize(hostname)}, key))
	updated := strings.Join(kept, "\n") + "\n"

	temp, err := os.CreateTemp(filepath.Dir(path), ".known_hosts-*")
	if err != nil {
		return err
	}
	tempPath := temp.Name()
	defer os.Remove(tempPath)
	if err := temp.Chmod(0600); err != nil {
		temp.Close()
		return err
	}
	if _, err := temp.WriteString(updated); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Sync(); err != nil {
		temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tempPath, path); err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}

func knownHostAliases(hostname string) map[string]struct{} {
	aliases := make(map[string]struct{})
	add := func(value string) {
		value = strings.TrimSpace(value)
		if value != "" {
			aliases[value] = struct{}{}
		}
	}
	add(knownhosts.Normalize(hostname))

	host, port, err := net.SplitHostPort(hostname)
	if err != nil {
		host = strings.Trim(strings.TrimSpace(hostname), "[]")
		port = "22"
	} else {
		host = strings.Trim(strings.TrimSpace(host), "[]")
	}
	if port == "22" {
		add(host)
		if strings.Contains(host, ":") {
			add("[" + host + "]")
		}
	} else {
		add("[" + host + "]:" + port)
	}
	return aliases
}

func knownHostsLineMatches(line string, aliases map[string]struct{}) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" || strings.HasPrefix(trimmed, "#") {
		return false
	}
	fields := strings.Fields(trimmed)
	if len(fields) < 2 {
		return false
	}
	hostField := 0
	if strings.HasPrefix(fields[0], "@") {
		hostField = 1
		if len(fields) < 3 {
			return false
		}
	}
	for _, host := range strings.Split(fields[hostField], ",") {
		if _, ok := aliases[host]; ok {
			return true
		}
	}
	return false
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
