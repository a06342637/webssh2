package core

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

type rdpHandshakeChannelConn struct {
	ssh.Channel
	transport net.Conn
}

func (connection *rdpHandshakeChannelConn) LocalAddr() net.Addr {
	return connection.transport.LocalAddr()
}

func (connection *rdpHandshakeChannelConn) RemoteAddr() net.Addr {
	return connection.transport.RemoteAddr()
}

func (connection *rdpHandshakeChannelConn) SetDeadline(deadline time.Time) error {
	return connection.transport.SetDeadline(deadline)
}

func (connection *rdpHandshakeChannelConn) SetReadDeadline(deadline time.Time) error {
	return connection.transport.SetReadDeadline(deadline)
}

func (connection *rdpHandshakeChannelConn) SetWriteDeadline(deadline time.Time) error {
	return connection.transport.SetWriteDeadline(deadline)
}

func serveRDPHandshakeSSH(ctx context.Context, listener net.Listener, sshConfig *ssh.ServerConfig, tlsConfig *tls.Config, expectedRequest, response []byte, x224Received chan<- struct{}, waitForCancel bool) error {
	transport, err := listener.Accept()
	if err != nil {
		return err
	}
	defer transport.Close()
	stopClose := context.AfterFunc(ctx, func() { _ = transport.Close() })
	defer stopClose()
	deadline, _ := ctx.Deadline()
	if err := transport.SetDeadline(deadline); err != nil {
		return err
	}
	server, channels, globalRequests, err := ssh.NewServerConn(transport, sshConfig)
	if err != nil {
		return err
	}
	defer server.Close()
	globalDone := make(chan struct{})
	go func() {
		defer close(globalDone)
		ssh.DiscardRequests(globalRequests)
	}()
	defer func() {
		_ = transport.Close()
		select {
		case <-globalDone:
		case <-ctx.Done():
		}
	}()

	var pending ssh.NewChannel
	select {
	case pending = <-channels:
		if pending == nil {
			return fmt.Errorf("fake SSH server received no forwarding channel")
		}
	case <-ctx.Done():
		return ctx.Err()
	}
	if pending.ChannelType() != "direct-tcpip" {
		return fmt.Errorf("unexpected channel type %q", pending.ChannelType())
	}
	var destination struct {
		Host       string
		Port       uint32
		OriginHost string
		OriginPort uint32
	}
	if err := ssh.Unmarshal(pending.ExtraData(), &destination); err != nil {
		return err
	}
	if destination.Host != "127.0.0.1" {
		return fmt.Errorf("non-loopback forwarding request %q", destination.Host)
	}
	channel, channelRequests, err := pending.Accept()
	if err != nil {
		return err
	}
	defer channel.Close()
	channelDone := make(chan struct{})
	go func() {
		defer close(channelDone)
		ssh.DiscardRequests(channelRequests)
	}()
	defer func() {
		_ = transport.Close()
		select {
		case <-channelDone:
		case <-ctx.Done():
		}
	}()

	request := make([]byte, len(expectedRequest))
	if _, err := io.ReadFull(channel, request); err != nil {
		return fmt.Errorf("fake RDP X.224 request: %w", err)
	}
	if !bytes.Equal(request, expectedRequest) {
		return fmt.Errorf("unexpected X.224 request %x", request)
	}
	close(x224Received)
	if waitForCancel {
		<-ctx.Done()
		return nil
	}
	if err := writeAll(channel, response); err != nil {
		return err
	}
	tlsConnection := tls.Server(&rdpHandshakeChannelConn{Channel: channel, transport: transport}, tlsConfig)
	defer tlsConnection.Close()
	if err := tlsConnection.HandshakeContext(ctx); err != nil {
		return fmt.Errorf("fake RDP TLS handshake: %w", err)
	}
	payload := make([]byte, 4)
	if _, err := io.ReadFull(tlsConnection, payload); err != nil {
		return err
	}
	if err := writeAll(tlsConnection, payload); err != nil {
		return err
	}
	<-ctx.Done()
	return nil
}

func testRDPHandshakeViaSSH(test *testing.T, cancelBeforeResponse bool) {
	test.Setenv("WEBSSH_HOST_KEY_POLICY", "insecure")
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		test.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(privateKey)
	if err != nil {
		test.Fatal(err)
	}
	sshConfig := &ssh.ServerConfig{NoClientAuth: true}
	sshConfig.AddHostKey(signer)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		IPAddresses:  []net.IP{net.ParseIP("127.0.0.1")},
	}
	certificate, err := x509.CreateCertificate(rand.Reader, template, template, publicKey, privateKey)
	if err != nil {
		test.Fatal(err)
	}
	tlsConfig := &tls.Config{
		Certificates: []tls.Certificate{{Certificate: [][]byte{certificate}, PrivateKey: privateKey}},
		MinVersion:   tls.VersionTLS12,
		MaxVersion:   tls.VersionTLS12,
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		test.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	stopListener := context.AfterFunc(ctx, func() { _ = listener.Close() })
	serverDone := make(chan error, 1)
	test.Cleanup(func() {
		cancel()
		_ = listener.Close()
		stopListener()
		select {
		case serverError := <-serverDone:
			if serverError != nil {
				test.Logf("fake SSH/RDP server stopped: %v", serverError)
			}
		case <-time.After(time.Second):
			test.Error("fake SSH/RDP server did not stop after forced connection cleanup")
		}
	})
	request := []byte{3, 0, 0, 19, 14, 224, 0, 0, 0, 0, 0, 1, 0, 8, 0, 3, 0, 0, 0}
	response := []byte{3, 0, 0, 19, 14, 208, 0, 0, 0, 0, 0, 2, 0, 8, 0, 1, 0, 0, 0}
	x224Received := make(chan struct{})
	go func() {
		serverDone <- serveRDPHandshakeSSH(ctx, listener, sshConfig, tlsConfig, request, response, x224Received, cancelBeforeResponse)
	}()
	host, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		test.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		test.Fatal(err)
	}
	dialer := &RDPDialer{Relay: &RDPRelay{Kind: RelaySSH, Host: host, Port: port, Username: "audit"}}
	if cancelBeforeResponse {
		handshakeContext, cancelHandshake := context.WithCancel(ctx)
		defer cancelHandshake()
		type result struct {
			handshake *RDPHandshake
			err       error
		}
		results := make(chan result, 1)
		finished := make(chan struct{})
		go func() {
			defer close(finished)
			handshake, err := PerformRDPHandshake(handshakeContext, dialer, host, port, request)
			results <- result{handshake: handshake, err: err}
		}()
		test.Cleanup(func() {
			cancelHandshake()
			cancel()
			select {
			case <-finished:
			case <-time.After(time.Second):
				test.Error("RDP handshake did not finish after forced cleanup")
			}
			select {
			case outcome := <-results:
				if outcome.handshake != nil {
					outcome.handshake.Release()
				}
			default:
			}
		})
		select {
		case <-x224Received:
		case <-time.After(time.Second):
			test.Fatal("fake RDP server did not receive X.224")
		}
		cancelHandshake()
		select {
		case outcome := <-results:
			if outcome.handshake != nil {
				test.Cleanup(outcome.handshake.Release)
			}
			if !errors.Is(outcome.err, context.Canceled) {
				test.Fatalf("cancelled RDP handshake returned %v, want context.Canceled", outcome.err)
			}
		case <-time.After(500 * time.Millisecond):
			test.Fatal("RDP handshake did not honor cancellation while awaiting X.224")
		}
		return
	}
	handshake, err := PerformRDPHandshake(ctx, dialer, host, port, request)
	if err != nil {
		test.Fatalf("RDP handshake over a valid local SSH forwarding channel must succeed: %v", err)
	}
	test.Cleanup(handshake.Release)
	if !bytes.Equal(handshake.X224Response, response) {
		test.Errorf("X.224 response = %x, want %x", handshake.X224Response, response)
	}
	if len(handshake.CertChain) != 1 || !bytes.Equal(handshake.CertChain[0], certificate) {
		test.Error("RDP handshake did not return the fake server certificate")
	}
	payload := []byte("echo")
	if err := writeAll(handshake.Conn, payload); err != nil {
		test.Fatalf("write after handshake: %v", err)
	}
	received := make([]byte, len(payload))
	if _, err := io.ReadFull(handshake.Conn, received); err != nil {
		test.Fatalf("read after handshake: %v", err)
	}
	if !bytes.Equal(received, payload) {
		test.Errorf("TLS echo = %q, want %q", received, payload)
	}
}

func TestRDPHandshakeViaSSH(test *testing.T) {
	testRDPHandshakeViaSSH(test, false)
}

func TestRDPHandshakeViaSSHCancellation(test *testing.T) {
	testRDPHandshakeViaSSH(test, true)
}
