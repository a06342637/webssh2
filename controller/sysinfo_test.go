package controller

import (
	"bytes"
	"testing"
)

func TestBoundedSSHOutputCapsData(t *testing.T) {
	output := newBoundedSSHOutput(8)
	if _, err := output.Write([]byte("12345678")); err != nil {
		t.Fatal(err)
	}
	if output.Exceeded() {
		t.Fatal("output exactly at the limit was marked oversized")
	}
	if _, err := output.Write([]byte("9")); err != nil {
		t.Fatal(err)
	}
	if !output.Exceeded() {
		t.Fatal("output beyond the limit was not marked oversized")
	}
	if got := output.Bytes(); !bytes.Equal(got, []byte("12345678")) {
		t.Fatalf("bounded output = %q", got)
	}
}
