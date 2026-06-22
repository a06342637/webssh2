package controller

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

func SysInfo(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)

	sshInfo := c.DefaultQuery("sshInfo", "")
	sshClient, err := core.DecodedMsgToSSHClient(sshInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.GenerateClient(); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()

	session, err := sshClient.Client.NewSession()
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer session.Close()

	cmd := strings.Join([]string{
		`echo "===OS==="`,
		`(cat /etc/os-release 2>/dev/null | grep -m1 PRETTY_NAME | cut -d'"' -f2) || uname -s`,
		`echo "===KERNEL==="`,
		`uname -s 2>/dev/null || echo unknown`,
		`echo "===KERNEL_VERSION==="`,
		`uname -r 2>/dev/null || echo unknown`,
		`echo "===ARCH==="`,
		`uname -m 2>/dev/null || echo unknown`,
		`echo "===HOSTNAME==="`,
		`hostname 2>/dev/null || echo unknown`,
		`echo "===CPU_MODEL==="`,
		`grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown`,
		`echo "===CPU_CORES==="`,
		`nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1`,
		`echo "===MEM==="`,
		`free -b 2>/dev/null | awk '/^Mem:/{print $2" "$3" "$4" "$7}' || echo "0 0 0 0"`,
		`echo "===SWAP==="`,
		`free -b 2>/dev/null | awk '/^Swap:/{print $2" "$3" "$4}' || echo "0 0 0"`,
		`echo "===DISK==="`,
		`df -B1 / 2>/dev/null | awk 'NR==2{print $2" "$3" "$4" "$5}' || echo "0 0 0 0%"`,
		`echo "===LOAD==="`,
		`cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}' || uptime | sed 's/.*load average[s]*: //' | tr ',' ' ' | awk '{print $1" "$2" "$3}'`,
		`echo "===UPTIME==="`,
		`cat /proc/uptime 2>/dev/null | awk '{print int($1)}' || echo "0"`,
		`echo "===NET_MAIN==="`,
		`ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}' || echo ""`,
		`echo "===CPU_TIMES==="`,
		`awk '/^cpu /{for(i=2;i<=11;i++) printf $i" "; print ""}' /proc/stat 2>/dev/null; sleep 1; awk '/^cpu /{for(i=2;i<=11;i++) printf $i" "; print ""}' /proc/stat 2>/dev/null`,
		`echo "===NET1==="`,
		`cat /proc/net/dev 2>/dev/null | awk 'NR>2 {gsub(/:$/,"",$1); print $1" "$2" "$10}'`,
		`sleep 1`,
		`echo "===NET2==="`,
		`cat /proc/net/dev 2>/dev/null | awk 'NR>2 {gsub(/:$/,"",$1); print $1" "$2" "$10}'`,
		`echo "===FILESYSTEMS==="`,
		`df -P -B1 2>/dev/null | awk 'NR>1 {print $1"|"$2"|"$3"|"$4"|"$5"|"$6}' | head -n 24`,
		`echo "===PROCESSES==="`,
		`ps -eo pid,user,rss,pcpu,comm,args --no-headers --sort=-pcpu 2>/dev/null | head -n 16 | awk '{pid=$1; user=$2; rss=$3; pcpu=$4; comm=$5; $1=$2=$3=$4=$5=""; sub(/^ +/,""); gsub(/\|/," "); print pid "|" user "|" rss "|" pcpu "|" comm "|" $0}'`,
		`echo "===CONNECTIONS==="`,
		`ss -tunH 2>/dev/null | awk 'BEGIN{tcp=0;udp=0} /^tcp/{tcp++} /^udp/{udp++} END{print tcp" "udp}' || echo "0 0"`,
		`echo "===END==="`,
	}, "; ")

	out, err := session.CombinedOutput(cmd)
	if err != nil {
		responseBody.Msg = fmt.Sprintf("command error: %v", err)
		return &responseBody
	}

	responseBody.Data = parseSysInfo(string(out))
	return &responseBody
}

func parseSysInfo(raw string) map[string]interface{} {
	info := map[string]interface{}{
		"os":            "unknown",
		"kernel":        "unknown",
		"kernelVersion": "unknown",
		"arch":          "unknown",
		"hostname":      "unknown",
		"cpuModel":      "unknown",
		"cpuCores":      "0",
		"memTotal":      "0",
		"memUsed":       "0",
		"memFree":       "0",
		"memAvailable":  "0",
		"swapTotal":     "0",
		"swapUsed":      "0",
		"swapFree":      "0",
		"diskTotal":     "0",
		"diskUsed":      "0",
		"diskFree":      "0",
		"diskPct":       "0%",
		"load":          "0 0 0",
		"uptime":        "0",
		"cpuUsage":      "0",
		"rxTotal":       "0",
		"txTotal":       "0",
		"rxRate":        "0",
		"txRate":        "0",
		"mainIface":     "",
		"tcpCount":      "0",
		"udpCount":      "0",
		"interfaces":    []map[string]string{},
		"filesystems":   []map[string]string{},
		"processes":     []map[string]string{},
		"cpuBreakdown":  map[string]string{},
		"updatedAt":     time.Now().Format(time.RFC3339),
	}

	sections := map[string]string{}
	multiSections := map[string][]string{}
	currentKey := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		key := markerKey(line)
		if key == "end" {
			currentKey = ""
			continue
		}
		if key != "" {
			currentKey = key
			continue
		}
		if currentKey != "" {
			if sections[currentKey] == "" {
				sections[currentKey] = line
			}
			multiSections[currentKey] = append(multiSections[currentKey], line)
		}
	}

	copyString(info, sections, "os")
	copyString(info, sections, "kernel")
	copyString(info, sections, "kernelVersion")
	copyString(info, sections, "arch")
	copyString(info, sections, "hostname")
	copyString(info, sections, "cpuModel")
	copyString(info, sections, "cpuCores")
	copyString(info, sections, "load")
	copyString(info, sections, "uptime")

	if v := sections["mem"]; v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 4 {
			info["memTotal"] = parts[0]
			info["memUsed"] = parts[1]
			info["memFree"] = parts[2]
			info["memAvailable"] = parts[3]
		}
	}
	if v := sections["swap"]; v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 3 {
			info["swapTotal"] = parts[0]
			info["swapUsed"] = parts[1]
			info["swapFree"] = parts[2]
		}
	}
	if v := sections["disk"]; v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 4 {
			info["diskTotal"] = parts[0]
			info["diskUsed"] = parts[1]
			info["diskFree"] = parts[2]
			info["diskPct"] = parts[3]
		}
	}
	if v := strings.TrimSpace(sections["netMain"]); v != "" {
		info["mainIface"] = v
	}
	if lines := multiSections["cpuTimes"]; len(lines) >= 2 {
		info["cpuUsage"] = calcCPUUsage(lines[0], lines[1])
		info["cpuBreakdown"] = calcCPUBreakdown(lines[0], lines[1])
	}
	if v := sections["connections"]; v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 2 {
			info["tcpCount"] = parts[0]
			info["udpCount"] = parts[1]
		}
	}

	ifaces := parseInterfaces(multiSections["net1"], multiSections["net2"], fmt.Sprint(info["mainIface"]))
	if len(ifaces) > 0 {
		info["interfaces"] = ifaces
		mainIface := fmt.Sprint(info["mainIface"])
		if mainIface == "" {
			mainIface = ifaces[0]["name"]
			info["mainIface"] = mainIface
		}
		for _, item := range ifaces {
			if item["name"] == mainIface {
				info["rxTotal"] = item["rxTotal"]
				info["txTotal"] = item["txTotal"]
				info["rxRate"] = item["rxRate"]
				info["txRate"] = item["txRate"]
				break
			}
		}
	}
	info["filesystems"] = parseFileSystems(multiSections["filesystems"])
	info["processes"] = parseProcesses(multiSections["processes"])
	return info
}

func markerKey(line string) string {
	if !strings.HasPrefix(line, "===") || !strings.HasSuffix(line, "===") {
		return ""
	}
	key := strings.Trim(line, "=")
	switch key {
	case "OS":
		return "os"
	case "KERNEL":
		return "kernel"
	case "KERNEL_VERSION":
		return "kernelVersion"
	case "ARCH":
		return "arch"
	case "HOSTNAME":
		return "hostname"
	case "CPU_MODEL":
		return "cpuModel"
	case "CPU_CORES":
		return "cpuCores"
	case "MEM":
		return "mem"
	case "SWAP":
		return "swap"
	case "DISK":
		return "disk"
	case "LOAD":
		return "load"
	case "UPTIME":
		return "uptime"
	case "NET_MAIN":
		return "netMain"
	case "CPU_TIMES":
		return "cpuTimes"
	case "NET1":
		return "net1"
	case "NET2":
		return "net2"
	case "FILESYSTEMS":
		return "filesystems"
	case "PROCESSES":
		return "processes"
	case "CONNECTIONS":
		return "connections"
	case "END":
		return "end"
	}
	return ""
}

func copyString(info map[string]interface{}, sections map[string]string, key string) {
	if v, ok := sections[key]; ok && v != "" {
		info[key] = v
	}
}

func parseInterfaces(first, second []string, mainIface string) []map[string]string {
	start := map[string][2]float64{}
	for _, line := range first {
		parts := strings.Fields(line)
		if len(parts) >= 3 {
			rx, _ := strconv.ParseFloat(parts[1], 64)
			tx, _ := strconv.ParseFloat(parts[2], 64)
			start[parts[0]] = [2]float64{rx, tx}
		}
	}
	out := []map[string]string{}
	for _, line := range second {
		parts := strings.Fields(line)
		if len(parts) < 3 {
			continue
		}
		name := parts[0]
		rx, _ := strconv.ParseFloat(parts[1], 64)
		tx, _ := strconv.ParseFloat(parts[2], 64)
		prev, ok := start[name]
		rxRate := 0.0
		txRate := 0.0
		if ok {
			rxRate = rx - prev[0]
			txRate = tx - prev[1]
		}
		if rxRate < 0 {
			rxRate = 0
		}
		if txRate < 0 {
			txRate = 0
		}
		out = append(out, map[string]string{
			"name":    name,
			"rxTotal": fmt.Sprintf("%.0f", rx),
			"txTotal": fmt.Sprintf("%.0f", tx),
			"rxRate":  fmt.Sprintf("%.0f", rxRate),
			"txRate":  fmt.Sprintf("%.0f", txRate),
			"main":    fmt.Sprintf("%t", name == mainIface),
		})
	}
	return out
}

func parseFileSystems(lines []string) []map[string]string {
	out := []map[string]string{}
	for _, line := range lines {
		parts := strings.Split(line, "|")
		if len(parts) < 6 {
			continue
		}
		out = append(out, map[string]string{
			"name":  parts[0],
			"size":  parts[1],
			"used":  parts[2],
			"avail": parts[3],
			"pct":   parts[4],
			"mount": parts[5],
		})
	}
	return out
}

func parseProcesses(lines []string) []map[string]string {
	out := []map[string]string{}
	for _, line := range lines {
		parts := strings.SplitN(line, "|", 6)
		if len(parts) < 6 {
			continue
		}
		out = append(out, map[string]string{
			"pid":  parts[0],
			"user": parts[1],
			"rss":  parts[2],
			"cpu":  parts[3],
			"name": parts[4],
			"cmd":  parts[5],
		})
	}
	return out
}

func calcCPUUsage(line1, line2 string) string {
	p1 := parseCPUFields(line1)
	p2 := parseCPUFields(line2)
	if len(p1) < 8 || len(p2) < 8 {
		return "0"
	}
	total1, idle1 := cpuTotals(p1)
	total2, idle2 := cpuTotals(p2)
	dt := total2 - total1
	if dt <= 0 {
		return "0"
	}
	usage := (dt - (idle2 - idle1)) / dt * 100
	if usage < 0 {
		usage = 0
	}
	if usage > 100 {
		usage = 100
	}
	return fmt.Sprintf("%.1f", usage)
}

func calcCPUBreakdown(line1, line2 string) map[string]string {
	p1 := parseCPUFields(line1)
	p2 := parseCPUFields(line2)
	out := map[string]string{}
	if len(p1) < 8 || len(p2) < 8 {
		return out
	}
	total1, _ := cpuTotals(p1)
	total2, _ := cpuTotals(p2)
	dt := total2 - total1
	if dt <= 0 {
		return out
	}
	names := []string{"user", "nice", "system", "idle", "iowait", "irq", "softirq", "steal"}
	for i, name := range names {
		value := (p2[i] - p1[i]) / dt * 100
		if value < 0 {
			value = 0
		}
		out[name] = fmt.Sprintf("%.1f", value)
	}
	return out
}

func parseCPUFields(line string) []float64 {
	parts := strings.Fields(line)
	out := make([]float64, 0, len(parts))
	for _, part := range parts {
		v, _ := strconv.ParseFloat(part, 64)
		out = append(out, v)
	}
	return out
}

func cpuTotals(values []float64) (float64, float64) {
	total := 0.0
	for _, value := range values {
		total += value
	}
	idle := values[3]
	if len(values) > 4 {
		idle += values[4]
	}
	return total, idle
}
