package controller

import (
	"bytes"
	"testing"
)

func TestSysInfoProcessCount(t *testing.T) {
	info := parseSysInfo("===CPU_CORES===\n2\n===PROCESS_COUNT===\n89\n===PROCESSES===\n123|root|100|1.0|sshd|/usr/sbin/sshd\n===END===")
	if info["processCount"] != "89" {
		t.Fatalf("process count = %v, want 89", info["processCount"])
	}
	if len(info["processes"].([]map[string]string)) != 1 {
		t.Fatal("total process count must remain independent of the sampled process list")
	}
	if empty := parseSysInfo(""); empty["processCount"] != "0" {
		t.Fatalf("missing process count = %v, want 0", empty["processCount"])
	}
}

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
