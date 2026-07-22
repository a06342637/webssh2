package controller

import "testing"

func TestFormatRemoteFileSize(t *testing.T) {
	tests := []struct {
		name  string
		size  int64
		isDir bool
		want  string
	}{
		{name: "negative file size", size: -1, want: "0B"},
		{name: "negative directory size", size: -1, isDir: true, want: "0"},
		{name: "file size", size: 1024, want: "1K"},
		{name: "directory size", size: 1024, isDir: true, want: "1024"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := formatRemoteFileSize(test.size, test.isDir); got != test.want {
				t.Fatalf("formatRemoteFileSize(%d, %t) = %q, want %q", test.size, test.isDir, got, test.want)
			}
		})
	}
}
