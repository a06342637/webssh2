package core

import (
	"bytes"
	"io"
	"testing"
)

type oneByteReader struct{ data []byte }

func (r *oneByteReader) Read(p []byte) (int, error) {
	if len(r.data) == 0 {
		return 0, io.EOF
	}
	p[0] = r.data[0]
	r.data = r.data[1:]
	return 1, nil
}

func TestReadRDPX224ResponseHandlesFragmentedTCP(t *testing.T) {
	packet := []byte{0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00}
	got, err := readRDPX224Response(&oneByteReader{data: append([]byte(nil), packet...)})
	if err != nil {
		t.Fatalf("read fragmented response: %v", err)
	}
	if !bytes.Equal(got, packet) {
		t.Fatalf("response = %x, want %x", got, packet)
	}
}

func TestReadRDPX224ResponseRejectsMalformedPackets(t *testing.T) {
	tests := [][]byte{
		{0x02, 0x00, 0x00, 0x04},
		{0x03, 0x00, 0x00, 0x03},
		{0x03, 0x00, 0xff, 0xff},
		{0x03, 0x00, 0x00, 0x08, 0x01},
	}
	for _, packet := range tests {
		if _, err := readRDPX224Response(bytes.NewReader(packet)); err == nil {
			t.Fatalf("malformed packet %x was accepted", packet)
		}
	}
}
