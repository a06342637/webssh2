package controller

import (
	"context"
	"net"
	"net/url"
	"testing"
)

func TestRemoteIPBlocked(t *testing.T) {
	tests := []struct {
		ip      string
		blocked bool
	}{
		{"127.0.0.1", true},
		{"10.0.0.1", true},
		{"169.254.169.254", true},
		{"100.64.0.1", true},
		{"198.18.0.1", true},
		{"224.0.0.1", true},
		{"0.0.0.0", true},
		{"::1", true},
		{"fe80::1", true},
		{"fc00::1", true},
		{"2001:db8::1", true},
		{"8.8.8.8", false},
		{"2606:4700:4700::1111", false},
	}
	for _, test := range tests {
		t.Run(test.ip, func(t *testing.T) {
			if got := remoteIPBlocked(net.ParseIP(test.ip)); got != test.blocked {
				t.Fatalf("remoteIPBlocked(%s) = %v, want %v", test.ip, got, test.blocked)
			}
		})
	}
}

func TestValidateRemoteURLSchemeAndPrivateLiteral(t *testing.T) {
	t.Setenv("WEBSSH_ALLOW_PRIVATE_DOWNLOADS", "false")
	for _, raw := range []string{"file:///etc/passwd", "ftp://example.com/file", "http://127.0.0.1/file", "http://[::1]/file"} {
		target, err := url.Parse(raw)
		if err != nil {
			t.Fatal(err)
		}
		if err := validateRemoteURL(context.Background(), target); err == nil {
			t.Fatalf("validateRemoteURL(%q) unexpectedly allowed URL", raw)
		}
	}
}

func TestRemoteDownloadMaxBytes(t *testing.T) {
	t.Setenv("WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES", "2097152")
	if got := remoteDownloadMaxBytes(); got != 2097152 {
		t.Fatalf("remoteDownloadMaxBytes() = %d", got)
	}
	t.Setenv("WEBSSH_REMOTE_DOWNLOAD_MAX_BYTES", "1")
	if got := remoteDownloadMaxBytes(); got != defaultRemoteDownloadMaxBytes {
		t.Fatalf("invalid size should use default, got %d", got)
	}
}

func TestSanitizeRemoteFilename(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{input: "archive.tar.gz", want: "archive.tar.gz"},
		{input: "../../etc/passwd", want: "passwd"},
		{input: "..\\..\\windows\\file.txt", want: "file.txt"},
		{input: "..", want: ""},
		{input: ".", want: ""},
		{input: " / ", want: ""},
		{input: "\x00\r\n", want: ""},
		{input: "safe\x00-name.txt", want: "safe-name.txt"},
	}
	for _, test := range tests {
		if got := sanitizeRemoteFilename(test.input); got != test.want {
			t.Errorf("sanitizeRemoteFilename(%q) = %q, want %q", test.input, got, test.want)
		}
	}
}
