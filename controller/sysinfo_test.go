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

func TestCPUUsageGuestAccounting(test *testing.T) {
	cases := []struct {
		name        string
		second      string
		activeField string
	}{
		{name: "guest", second: "50 0 0 50 0 0 0 0 50 0", activeField: "user"},
		{name: "guest_nice", second: "0 50 0 50 0 0 0 0 0 50", activeField: "nice"},
		{name: "non_guest_baseline", second: "50 0 0 50 0 0 0 0 0 0", activeField: "user"},
	}
	for _, sample := range cases {
		test.Run(sample.name, func(test *testing.T) {
			first := "0 0 0 0 0 0 0 0 0 0"
			if usage := calcCPUUsage(first, sample.second); usage != "50.0" {
				test.Errorf("CPU usage = %s, want 50.0; guest time must not be counted twice", usage)
			}
			breakdown := calcCPUBreakdown(first, sample.second)
			if breakdown[sample.activeField] != "50.0" || breakdown["idle"] != "50.0" {
				test.Errorf("CPU breakdown = %v, want %s=50.0 and idle=50.0", breakdown, sample.activeField)
			}
		})
	}
}
