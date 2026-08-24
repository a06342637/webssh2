package core

import (
	"errors"
	"fmt"
)

// RDCleanPath 是 IronRDP 的 Web 客户端与网关之间的握手协议，
// 报文用 ASN.1 DER 编码。标准库的 encoding/asn1 不方便处理这里
// 大量的 context-specific EXPLICIT tag，所以手写一份最小实现。
//
// 请求:
//
//	SEQUENCE {
//	  [0] version            INTEGER            -- 固定 3390
//	  [2] destination        UTF8String         -- "host:port"
//	  [3] proxy_auth         UTF8String         -- 我们用它承载短期加密凭证
//	  [5] preconnection_blob UTF8String OPTIONAL
//	  [6] x224_connection_pdu OCTET STRING
//	}
//
// 响应:
//
//	SEQUENCE {
//	  [0] version            INTEGER
//	  [6] x224_connection_pdu OCTET STRING       -- X.224 Connection Confirm
//	  [7] server_cert_chain  SEQUENCE OF OCTET STRING
//	  [9] server_addr        UTF8String
//	}
const rdCleanPathVersion = 3390

const (
	derTagInteger     = 0x02
	derTagOctetString = 0x04
	derTagUTF8String  = 0x0c
	derTagSequence    = 0x30
)

// rdCleanPathMaxPDU 限制单个握手报文的大小。X.224 Connection Request 只有
// 几十字节，留出的余量足够覆盖 preconnection blob，同时挡住畸形长度字段。
const rdCleanPathMaxPDU = 64 << 10

var errRDCleanPathTruncated = errors.New("rdcleanpath: truncated DER data")

// RDCleanPathRequest 是网关关心的请求字段。
type RDCleanPathRequest struct {
	Destination       string
	ProxyAuth         string
	PreconnectionBlob string
	X224ConnectionPDU []byte
}

func derEncodeLength(length int) []byte {
	if length < 0x80 {
		return []byte{byte(length)}
	}
	var raw []byte
	for temp := length; temp > 0; temp >>= 8 {
		raw = append([]byte{byte(temp & 0xff)}, raw...)
	}
	return append([]byte{0x80 | byte(len(raw))}, raw...)
}

func derWrap(tag byte, content []byte) []byte {
	out := make([]byte, 0, len(content)+8)
	out = append(out, tag)
	out = append(out, derEncodeLength(len(content))...)
	return append(out, content...)
}

// derContext 生成一个 context-specific EXPLICIT tag [n]。
func derContext(tagNum int, content []byte) []byte {
	return derWrap(byte(0xa0+tagNum), content)
}

func derEncodeInteger(value int) []byte {
	if value == 0 {
		return derWrap(derTagInteger, []byte{0})
	}
	var raw []byte
	for temp := value; temp > 0; temp >>= 8 {
		raw = append([]byte{byte(temp & 0xff)}, raw...)
	}
	// 最高位置 1 会被解读成负数，补一个前导零保持无符号语义。
	if raw[0]&0x80 != 0 {
		raw = append([]byte{0}, raw...)
	}
	return derWrap(derTagInteger, raw)
}

type derTLV struct {
	tag   byte
	value []byte
	total int
}

func derDecodeLength(buf []byte, offset int) (length int, read int, err error) {
	if offset >= len(buf) {
		return 0, 0, errRDCleanPathTruncated
	}
	first := buf[offset]
	if first < 0x80 {
		return int(first), 1, nil
	}
	count := int(first & 0x7f)
	// 长度字段本身超过 4 字节的报文在这里没有合法用途，直接拒绝，
	// 免得后面的移位溢出成一个负数长度。
	if count == 0 || count > 4 || offset+1+count > len(buf) {
		return 0, 0, errRDCleanPathTruncated
	}
	for i := 0; i < count; i++ {
		length = (length << 8) | int(buf[offset+1+i])
	}
	if length < 0 || length > rdCleanPathMaxPDU {
		return 0, 0, fmt.Errorf("rdcleanpath: DER length %d out of range", length)
	}
	return length, 1 + count, nil
}

func derDecodeTLV(buf []byte, offset int) (derTLV, error) {
	if offset >= len(buf) {
		return derTLV{}, errRDCleanPathTruncated
	}
	tag := buf[offset]
	length, read, err := derDecodeLength(buf, offset+1)
	if err != nil {
		return derTLV{}, err
	}
	header := 1 + read
	end := offset + header + length
	if end > len(buf) || end < offset {
		return derTLV{}, errRDCleanPathTruncated
	}
	return derTLV{tag: tag, value: buf[offset+header : end], total: header + length}, nil
}

func derDecodeChildren(buf []byte) ([]derTLV, error) {
	children := make([]derTLV, 0, 6)
	for offset := 0; offset < len(buf); {
		tlv, err := derDecodeTLV(buf, offset)
		if err != nil {
			return nil, err
		}
		if tlv.total <= 0 {
			return nil, errRDCleanPathTruncated
		}
		children = append(children, tlv)
		offset += tlv.total
	}
	return children, nil
}

func derDecodeInteger(buf []byte) int {
	value := 0
	for _, b := range buf {
		value = (value << 8) | int(b)
	}
	return value
}

// derInnerValue 取出 EXPLICIT context tag 里包着的那一层 TLV 的内容。
func derInnerValue(child derTLV, wantTag byte) ([]byte, error) {
	inner, err := derDecodeTLV(child.value, 0)
	if err != nil {
		return nil, err
	}
	if wantTag != 0 && inner.tag != wantTag {
		return nil, fmt.Errorf("rdcleanpath: expected tag 0x%02x, got 0x%02x", wantTag, inner.tag)
	}
	return inner.value, nil
}

// ParseRDCleanPathRequest 解析浏览器发来的第一帧。
func ParseRDCleanPathRequest(data []byte) (*RDCleanPathRequest, error) {
	if len(data) == 0 {
		return nil, errors.New("rdcleanpath: empty request")
	}
	if len(data) > rdCleanPathMaxPDU {
		return nil, fmt.Errorf("rdcleanpath: request too large (%d bytes)", len(data))
	}
	outer, err := derDecodeTLV(data, 0)
	if err != nil {
		return nil, err
	}
	if outer.tag != derTagSequence {
		return nil, fmt.Errorf("rdcleanpath: expected SEQUENCE, got 0x%02x", outer.tag)
	}
	children, err := derDecodeChildren(outer.value)
	if err != nil {
		return nil, err
	}

	version := -1
	request := &RDCleanPathRequest{}
	for _, child := range children {
		switch child.tag & 0x1f {
		case 0:
			raw, err := derInnerValue(child, derTagInteger)
			if err != nil {
				return nil, err
			}
			version = derDecodeInteger(raw)
		case 2:
			raw, err := derInnerValue(child, derTagUTF8String)
			if err != nil {
				return nil, err
			}
			request.Destination = string(raw)
		case 3:
			raw, err := derInnerValue(child, derTagUTF8String)
			if err != nil {
				return nil, err
			}
			request.ProxyAuth = string(raw)
		case 5:
			raw, err := derInnerValue(child, derTagUTF8String)
			if err != nil {
				return nil, err
			}
			request.PreconnectionBlob = string(raw)
		case 6:
			raw, err := derInnerValue(child, derTagOctetString)
			if err != nil {
				return nil, err
			}
			request.X224ConnectionPDU = raw
		}
	}

	if version != rdCleanPathVersion {
		return nil, fmt.Errorf("rdcleanpath: unsupported version %d (want %d)", version, rdCleanPathVersion)
	}
	if request.Destination == "" {
		return nil, errors.New("rdcleanpath: missing destination")
	}
	if len(request.X224ConnectionPDU) == 0 {
		return nil, errors.New("rdcleanpath: missing x224 connection pdu")
	}
	return request, nil
}

// BuildRDCleanPathResponse 把 X.224 Connection Confirm 和服务端证书链回给浏览器。
// 证书链是 WASM 侧校验服务端身份用的，顺序为叶子证书在前。
func BuildRDCleanPathResponse(serverAddr string, x224Response []byte, certChain [][]byte) []byte {
	parts := make([]byte, 0, 2048)
	parts = append(parts, derContext(0, derEncodeInteger(rdCleanPathVersion))...)
	parts = append(parts, derContext(6, derWrap(derTagOctetString, x224Response))...)

	certs := make([]byte, 0, 1536)
	for _, cert := range certChain {
		certs = append(certs, derWrap(derTagOctetString, cert)...)
	}
	parts = append(parts, derContext(7, derWrap(derTagSequence, certs))...)
	parts = append(parts, derContext(9, derWrap(derTagUTF8String, []byte(serverAddr)))...)
	return derWrap(derTagSequence, parts)
}

// RDCleanPath 错误码，与 IronRDP 的 IronErrorKind 对应。
const (
	RDCleanPathErrorGeneral     = 1
	RDCleanPathErrorNegotiation = 2
)

// BuildRDCleanPathError 生成一个错误响应。httpStatus 传 0 表示不带该字段。
func BuildRDCleanPathError(errorCode int, httpStatus int) []byte {
	errParts := derContext(0, derEncodeInteger(errorCode))
	if httpStatus > 0 {
		errParts = append(errParts, derContext(1, derEncodeInteger(httpStatus))...)
	}
	parts := derContext(0, derEncodeInteger(rdCleanPathVersion))
	parts = append(parts, derContext(1, derWrap(derTagSequence, errParts))...)
	return derWrap(derTagSequence, parts)
}
