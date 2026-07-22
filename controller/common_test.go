package controller

import (
	"net/http/httptest"
	"testing"
)

func TestWebsocketOriginAllowed(t *testing.T) {
	t.Setenv("WEBSSH_ALLOWED_ORIGINS", "https://allowed.example, http://dev.example:8080/")
	tests := []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{name: "no origin non-browser client", host: "webssh.example", want: true},
		{name: "same host HTTPS", host: "webssh.example", origin: "https://webssh.example", want: true},
		{name: "same host with port", host: "webssh.example:8008", origin: "http://webssh.example:8008", want: true},
		{name: "configured origin", host: "webssh.example", origin: "https://allowed.example", want: true},
		{name: "configured origin trailing slash", host: "webssh.example", origin: "http://dev.example:8080", want: true},
		{name: "foreign origin", host: "webssh.example", origin: "https://evil.example", want: false},
		{name: "invalid origin", host: "webssh.example", origin: "not a url", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "http://"+test.host+"/term", nil)
			req.Host = test.host
			if test.origin != "" {
				req.Header.Set("Origin", test.origin)
			}
			if got := websocketOriginAllowed(req); got != test.want {
				t.Fatalf("websocketOriginAllowed() = %v, want %v", got, test.want)
			}
		})
	}
}
