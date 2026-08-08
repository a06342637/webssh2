package controller

import (
	"encoding/json"
	"strings"
	"testing"

	"webssh/core"
)

type terminalMessageRecorder struct {
	messageType int
	data        []byte
}

func (r *terminalMessageRecorder) WriteMessage(messageType int, data []byte) error {
	r.messageType = messageType
	r.data = append([]byte(nil), data...)
	return nil
}

func TestClampTermSize(t *testing.T) {
	// A zero or garbage size must not reach RequestPty: a pty opened with 0
	// columns makes the remote shell wrap at the wrong width, which is what
	// made long command echoes pile up on a single line.
	cases := []struct {
		name     string
		raw      string
		fallback int
		want     int
	}{
		{"valid", "120", 150, 120},
		{"empty falls back", "", 150, 150},
		{"garbage falls back", "undefined", 150, 150},
		{"NaN falls back", "NaN", 35, 35},
		{"zero falls back", "0", 150, 150},
		{"negative falls back", "-10", 35, 35},
		{"float falls back", "80.5", 150, 150},
		{"above ceiling falls back", "1001", 150, 150},
		{"at ceiling kept", "1000", 150, 1000},
		{"one kept", "1", 150, 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := clampTermSize(tc.raw, tc.fallback); got != tc.want {
				t.Fatalf("clampTermSize(%q, %d) = %d, want %d", tc.raw, tc.fallback, got, tc.want)
			}
		})
	}
}

func TestWriteHostKeyMismatchMessage(t *testing.T) {
	recorder := &terminalMessageRecorder{}
	client := core.SSHClient{Hostname: "2001:db8::20", Port: 2222}
	mismatch := &core.HostKeyMismatchError{
		Hostname: "[2001:db8::20]:2222",
		Presented: core.HostKeyInfo{
			Algorithm:   "ssh-ed25519",
			Fingerprint: "SHA256:new",
		},
		Expected: []core.HostKeyInfo{{
			Algorithm:   "ecdsa-sha2-nistp256",
			Fingerprint: "SHA256:old",
		}},
	}
	if err := writeHostKeyMismatchMessage(recorder, client, mismatch); err != nil {
		t.Fatal(err)
	}
	if recorder.messageType != 1 {
		t.Fatalf("message type = %d", recorder.messageType)
	}
	text := string(recorder.data)
	if !strings.HasPrefix(text, terminalControlPrefix) {
		t.Fatalf("missing control prefix: %q", text)
	}
	var message terminalHostKeyMismatchMessage
	if err := json.Unmarshal([]byte(strings.TrimPrefix(text, terminalControlPrefix)), &message); err != nil {
		t.Fatal(err)
	}
	if message.Type != "host-key-mismatch" || message.Host != client.Hostname || message.Port != client.Port {
		t.Fatalf("unexpected message: %#v", message)
	}
	if message.Presented.Fingerprint != "SHA256:new" || len(message.Expected) != 1 {
		t.Fatalf("unexpected fingerprints: %#v", message)
	}
}
