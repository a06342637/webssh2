package core

import (
	"bytes"
	"strings"
	"testing"
)

// buildTestRequest 按 IronRDP 客户端的编码方式拼一个 RDCleanPath 请求，
// 用来验证解析端能吃下真实报文的结构。
func buildTestRequest(version int, destination, proxyAuth string, x224 []byte, blob string) []byte {
	parts := derContext(0, derEncodeInteger(version))
	if destination != "" {
		parts = append(parts, derContext(2, derWrap(derTagUTF8String, []byte(destination)))...)
	}
	if proxyAuth != "" {
		parts = append(parts, derContext(3, derWrap(derTagUTF8String, []byte(proxyAuth)))...)
	}
	if blob != "" {
		parts = append(parts, derContext(5, derWrap(derTagUTF8String, []byte(blob)))...)
	}
	if len(x224) > 0 {
		parts = append(parts, derContext(6, derWrap(derTagOctetString, x224))...)
	}
	return derWrap(derTagSequence, parts)
}

func TestParseRDCleanPathRequest(t *testing.T) {
	x224 := []byte{0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00}
	raw := buildTestRequest(rdCleanPathVersion, "192.168.1.10:3389", "ticket-abc", x224, "blob")

	request, err := ParseRDCleanPathRequest(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if request.Destination != "192.168.1.10:3389" {
		t.Errorf("destination = %q", request.Destination)
	}
	if request.ProxyAuth != "ticket-abc" {
		t.Errorf("proxyAuth = %q", request.ProxyAuth)
	}
	if request.PreconnectionBlob != "blob" {
		t.Errorf("preconnectionBlob = %q", request.PreconnectionBlob)
	}
	if !bytes.Equal(request.X224ConnectionPDU, x224) {
		t.Errorf("x224 = %v", request.X224ConnectionPDU)
	}
}

// 长度大于 127 的字段要走多字节 DER 长度编码，这是最容易写错的分支。
func TestParseRDCleanPathRequestLongFields(t *testing.T) {
	x224 := bytes.Repeat([]byte{0xab}, 300)
	auth := strings.Repeat("t", 200)
	raw := buildTestRequest(rdCleanPathVersion, "example.internal:3389", auth, x224, "")

	request, err := ParseRDCleanPathRequest(raw)
	if err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if request.ProxyAuth != auth {
		t.Errorf("长 proxyAuth 解析错误，长度 = %d", len(request.ProxyAuth))
	}
	if !bytes.Equal(request.X224ConnectionPDU, x224) {
		t.Errorf("长 x224 解析错误，长度 = %d", len(request.X224ConnectionPDU))
	}
}

func TestParseRDCleanPathRequestRejects(t *testing.T) {
	x224 := []byte{0x03, 0x00}
	cases := []struct {
		name string
		raw  []byte
	}{
		{"空报文", nil},
		{"版本不符", buildTestRequest(1, "h:3389", "t", x224, "")},
		{"缺目标", buildTestRequest(rdCleanPathVersion, "", "t", x224, "")},
		{"缺 x224", buildTestRequest(rdCleanPathVersion, "h:3389", "t", nil, "")},
		{"不是 SEQUENCE", []byte{0x02, 0x01, 0x00}},
		{"长度越界", []byte{0x30, 0x7f, 0x01}},
		{"长度字段自身越界", []byte{0x30, 0x84, 0xff, 0xff, 0xff, 0xff}},
		{"截断", buildTestRequest(rdCleanPathVersion, "h:3389", "t", x224, "")[:6]},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 关键是不能 panic：这条路径处理的是未认证的网络输入。
			if _, err := ParseRDCleanPathRequest(tc.raw); err == nil {
				t.Errorf("应该报错但通过了")
			}
		})
	}
}

func TestBuildRDCleanPathResponse(t *testing.T) {
	x224 := []byte{0x03, 0x00, 0x00, 0x0b, 0x06, 0xd0}
	certs := [][]byte{bytes.Repeat([]byte{0x01}, 800), bytes.Repeat([]byte{0x02}, 40)}
	response := BuildRDCleanPathResponse("10.0.0.1:3389", x224, certs)

	outer, err := derDecodeTLV(response, 0)
	if err != nil {
		t.Fatalf("响应不是合法 DER: %v", err)
	}
	if outer.tag != derTagSequence {
		t.Fatalf("外层 tag = 0x%02x", outer.tag)
	}
	if outer.total != len(response) {
		t.Errorf("外层长度 %d 与报文长度 %d 不一致", outer.total, len(response))
	}

	children, err := derDecodeChildren(outer.value)
	if err != nil {
		t.Fatalf("子元素解析失败: %v", err)
	}
	seen := map[int]bool{}
	for _, child := range children {
		seen[int(child.tag&0x1f)] = true
	}
	for _, want := range []int{0, 6, 7, 9} {
		if !seen[want] {
			t.Errorf("响应缺少字段 [%d]", want)
		}
	}

	// 证书链要能原样取回，顺序也不能乱——WASM 侧靠它做 CredSSP 通道绑定。
	for _, child := range children {
		if child.tag&0x1f != 7 {
			continue
		}
		seq, err := derDecodeTLV(child.value, 0)
		if err != nil {
			t.Fatalf("证书链不是合法 SEQUENCE: %v", err)
		}
		items, err := derDecodeChildren(seq.value)
		if err != nil {
			t.Fatalf("证书项解析失败: %v", err)
		}
		if len(items) != 2 {
			t.Fatalf("证书数量 = %d", len(items))
		}
		if !bytes.Equal(items[0].value, certs[0]) || !bytes.Equal(items[1].value, certs[1]) {
			t.Errorf("证书内容或顺序不匹配")
		}
	}
}

func TestBuildRDCleanPathError(t *testing.T) {
	for _, withStatus := range []int{0, 502} {
		payload := BuildRDCleanPathError(RDCleanPathErrorNegotiation, withStatus)
		outer, err := derDecodeTLV(payload, 0)
		if err != nil || outer.tag != derTagSequence {
			t.Fatalf("错误响应不是合法 DER: %v", err)
		}
		if outer.total != len(payload) {
			t.Errorf("长度不自洽: %d vs %d", outer.total, len(payload))
		}
	}
}

func TestParseRDPDestination(t *testing.T) {
	cases := []struct {
		in       string
		wantHost string
		wantPort int
		wantErr  bool
	}{
		{"192.168.1.5:3389", "192.168.1.5", 3389, false},
		{"192.168.1.5", "192.168.1.5", 3389, false},
		{"host.example.com:13389", "host.example.com", 13389, false},
		{"[2001:db8::1]:3389", "2001:db8::1", 3389, false},
		{"", "", 0, true},
	}
	for _, tc := range cases {
		host, port, err := ParseRDPDestination(tc.in)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%q 应该报错", tc.in)
			}
			continue
		}
		if err != nil {
			t.Errorf("%q 解析失败: %v", tc.in, err)
			continue
		}
		if host != tc.wantHost || port != tc.wantPort {
			t.Errorf("%q => %s:%d，期望 %s:%d", tc.in, host, port, tc.wantHost, tc.wantPort)
		}
	}
}

func TestRDPRelayNormalize(t *testing.T) {
	cases := []struct {
		name     string
		relay    RDPRelay
		wantKind string
		wantPort int
		enabled  bool
	}{
		{"默认直连", RDPRelay{}, RelayNone, 0, false},
		{"socks5 补默认端口", RDPRelay{Kind: "socks5", Host: "127.0.0.1"}, RelaySocks5, 1080, true},
		{"ssh 补默认端口", RDPRelay{Kind: "ssh", Host: "jump.example.com", Username: "root"}, RelaySSH, 22, true},
		{"host 内联端口", RDPRelay{Kind: "ssh", Host: "jump.example.com:2222"}, RelaySSH, 2222, true},
		{"无 host 退回直连", RDPRelay{Kind: "socks5"}, RelayNone, 0, false},
		{"未知类型退回直连", RDPRelay{Kind: "http", Host: "x"}, RelayNone, 0, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			relay := tc.relay
			relay.Normalize()
			if relay.Kind != tc.wantKind {
				t.Errorf("kind = %q，期望 %q", relay.Kind, tc.wantKind)
			}
			if tc.wantPort != 0 && relay.Port != tc.wantPort {
				t.Errorf("port = %d，期望 %d", relay.Port, tc.wantPort)
			}
			if relay.Enabled() != tc.enabled {
				t.Errorf("Enabled() = %v，期望 %v", relay.Enabled(), tc.enabled)
			}
			if relay.Describe() == "" {
				t.Errorf("Describe() 不应为空")
			}
		})
	}
}
