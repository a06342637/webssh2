package core

import (
	"bytes"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

func TestNormalizeHostPort(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		port     int
		wantHost string
		wantPort int
	}{
		{
			name:     "bare IPv6",
			input:    "2603:c021:8012:ef00:0:dd95:ca1:7387",
			port:     22,
			wantHost: "2603:c021:8012:ef00:0:dd95:ca1:7387",
			wantPort: 22,
		},
		{
			name:     "bracketed IPv6",
			input:    "[2603:c021:8012:ef00:0:dd95:ca1:7387]",
			port:     22,
			wantHost: "2603:c021:8012:ef00:0:dd95:ca1:7387",
			wantPort: 22,
		},
		{
			name:     "bracketed IPv6 with port",
			input:    "[2603:c030:304:8200::1234]:2222",
			port:     22,
			wantHost: "2603:c030:304:8200::1234",
			wantPort: 2222,
		},
		{
			name:     "IPv4 with port",
			input:    "192.168.1.100:2200",
			port:     22,
			wantHost: "192.168.1.100",
			wantPort: 2200,
		},
		{
			name:     "hostname",
			input:    "ssh.example.com",
			port:     2222,
			wantHost: "ssh.example.com",
			wantPort: 2222,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			host, port := normalizeHostPort(tt.input, tt.port, 22)
			if host != tt.wantHost || port != tt.wantPort {
				t.Fatalf("normalizeHostPort(%q, %d) = (%q, %d), want (%q, %d)", tt.input, tt.port, host, port, tt.wantHost, tt.wantPort)
			}
		})
	}
}

func TestIPv6DialAddressUsesBrackets(t *testing.T) {
	host, port := normalizeHostPort("2603:c021:8012:ef00:0:dd95:ca1:7387", 22, 22)
	got := net.JoinHostPort(host, strconv.Itoa(port))
	want := "[2603:c021:8012:ef00:0:dd95:ca1:7387]:22"
	if got != want {
		t.Fatalf("IPv6 dial address = %q, want %q", got, want)
	}
}

func TestSSHClientFromConnHonorsHandshakeDeadline(t *testing.T) {
	clientConn, serverConn := net.Pipe()
	defer serverConn.Close()
	started := time.Now()
	_, err := sshClientFromConn(clientConn, "example.test:22", &ssh.ClientConfig{User: "test"}, 25*time.Millisecond)
	if err == nil {
		t.Fatal("stalled SSH handshake unexpectedly succeeded")
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("SSH handshake deadline was not enforced promptly: %v", elapsed)
	}
}

type chunkWriter struct {
	bytes.Buffer
	max int
}

func (w *chunkWriter) Write(p []byte) (int, error) {
	if len(p) > w.max {
		p = p[:w.max]
	}
	return w.Buffer.Write(p)
}

func TestWriteAllHandlesPartialWrites(t *testing.T) {
	writer := &chunkWriter{max: 3}
	payload := []byte("printf '低延迟 SSH 输出'\n")
	if err := writeAll(writer, payload); err != nil {
		t.Fatalf("writeAll returned an error: %v", err)
	}
	if !bytes.Equal(writer.Bytes(), payload) {
		t.Fatalf("writeAll payload = %q, want %q", writer.Bytes(), payload)
	}
}
