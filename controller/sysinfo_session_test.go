package controller

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
	"webssh/core"

	"golang.org/x/crypto/ssh"
)

func TestSysInfoSessionReusesConnectionAndReleasesFailedLease(t *testing.T) {
	closeAllSysInfoSessions(context.Background())
	t.Cleanup(func() { closeAllSysInfoSessions(context.Background()) })
	previous := createSysInfoClient
	t.Cleanup(func() { createSysInfoClient = previous })
	creates := 0
	createSysInfoClient = func(ctx context.Context, configuration core.SSHClient) (*core.SSHClient, error) {
		creates++
		return &configuration, nil
	}
	c, _ := memorySFTPTestRequest(t, "/sysinfo", nil)
	configuration := core.NewSSHClient()
	configuration.TrustScope = strings.Repeat("a", 32)
	first, release, err := acquireSysInfoSession(context.Background(), c, "test-config", configuration)
	if err != nil {
		t.Fatal(err)
	}
	release(false)
	second, release, err := acquireSysInfoSession(context.Background(), c, "test-config", configuration)
	if err != nil {
		t.Fatal(err)
	}
	if first != second || creates != 1 {
		t.Fatalf("connection reused: %v %d", first == second, creates)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, _, err := acquireSysInfoSession(ctx, c, "test-config", configuration); err == nil {
		t.Fatal("cancelled request acquired a lease")
	}
	release(true)
	third, release, err := acquireSysInfoSession(context.Background(), c, "test-config", configuration)
	if err != nil {
		t.Fatal(err)
	}
	release(false)
	if third == second || creates != 2 {
		t.Fatal("failed connection was reused")
	}
}

func TestSysInfoSamplingUsesElapsedTimeAndCachedStaticMetadata(t *testing.T) {
	entry := &sysInfoSession{}
	start := time.Unix(100, 0)
	first := applySysInfoSample(entry, "===OS===\nLinux\n===CPU_MODEL===\nCPU-X\n===CPU_TIMES===\n50 0 0 50 0 0 0 0\n===NET_MAIN===\neth0\n===NET2===\neth0 1000 2000\n===END===", start, true)
	if first["cpuSampleReady"] != false {
		t.Fatal("first CPU sample was considered a rate")
	}
	second := applySysInfoSample(entry, "===CPU_TIMES===\n100 0 0 100 0 0 0 0\n===NET_MAIN===\neth0\n===NET2===\neth0 2000 3500\n===END===", start.Add(5*time.Second), false)
	if second["cpuUsage"] != "50.0" || second["cpuModel"] != "CPU-X" || second["os"] != "Linux" {
		t.Fatalf("sample: %v", second)
	}
	if second["rxRate"] != "200" || second["txRate"] != "300" {
		t.Fatalf("elapsed rates: %v/%v", second["rxRate"], second["txRate"])
	}
	parts := []string{`echo "===OS==="`, "get-os", `echo "===CPU_TIMES==="`, "get-cpu-1", `echo "===NET1==="`, "get-net-1", "sleep 1", `echo "===CPU_TIMES==="`, "get-cpu-2", `echo "===NET2==="`, "get-net-2"}
	command := strings.Join(sysInfoCommandParts(parts, true), ";")
	if strings.Contains(command, "sleep") || strings.Contains(command, "get-os") || strings.Contains(command, "get-cpu-1") || !strings.Contains(command, "get-cpu-2") {
		t.Fatal(command)
	}
}

func TestSysInfoEndpointReusesSSHAndSkipsRepeatedStaticCommands(t *testing.T) {
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	configuration := &ssh.ServerConfig{NoClientAuth: true}
	configuration.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var commands []string
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			connection, err := listener.Accept()
			if err != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer connection.Close()
				transport, channels, requests, err := ssh.NewServerConn(connection, configuration)
				if err != nil {
					return
				}
				defer transport.Close()
				go ssh.DiscardRequests(requests)
				for opening := range channels {
					channel, requests, err := opening.Accept()
					if err != nil {
						return
					}
					for request := range requests {
						if request.Type != "exec" {
							_ = request.Reply(false, nil)
							continue
						}
						var command struct{ Command string }
						_ = ssh.Unmarshal(request.Payload, &command)
						mu.Lock()
						commands = append(commands, command.Command)
						count := len(commands)
						mu.Unlock()
						_ = request.Reply(true, nil)
						output := "===CPU_TIMES===\n100 0 0 100 0 0 0 0\n===NET_MAIN===\neth0\n===NET2===\neth0 2000 3000\n===END==="
						if count == 1 {
							output = "===OS===\nTest Linux\n===CPU_MODEL===\nTest CPU\n===CPU_TIMES===\n50 0 0 50 0 0 0 0\n===NET_MAIN===\neth0\n===NET2===\neth0 1000 1000\n===END==="
						}
						_, _ = channel.Write([]byte(output))
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Status uint32 }{0}))
						_ = channel.Close()
						break
					}
				}
			}()
		}
	}()
	previous := createSysInfoClient
	creates := 0
	createSysInfoClient = func(ctx context.Context, config core.SSHClient) (*core.SSHClient, error) {
		creates++
		client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{User: "test", HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second})
		if err != nil {
			return nil, err
		}
		config.Client = client
		return &config, nil
	}
	t.Cleanup(func() {
		closeAllSysInfoSessions(context.Background())
		createSysInfoClient = previous
		_ = listener.Close()
		workers.Wait()
	})
	var result *ResponseBody
	for index := 0; index < 2; index++ {
		ctx, _ := memorySFTPTestRequest(t, "/sysinfo", sshInfoRequest{SSHInfo: sftpSessionTestSSHInfo(t)})
		result = SysInfo(ctx)
		if result.Msg != "success" {
			t.Fatal(result.Msg)
		}
	}
	if creates != 1 {
		t.Fatalf("SSH connections: %d", creates)
	}
	info := result.Data.(map[string]interface{})
	if info["os"] != "Test Linux" || info["cpuUsage"] != "50.0" {
		t.Fatal(info)
	}
	mu.Lock()
	defer mu.Unlock()
	if len(commands) != 2 || !strings.Contains(commands[0], "===OS===") || strings.Contains(commands[1], "===OS===") || strings.Contains(commands[0], "sleep 1") {
		t.Fatal(commands)
	}
}
