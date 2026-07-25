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
