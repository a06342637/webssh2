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
		`echo "===ARCH==="`,
		`uname -m`,
		`echo "===CPU_MODEL==="`,
		`grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2 | xargs || sysctl -n machdep.cpu.brand_string 2>/dev/null || echo unknown`,
		`echo "===CPU_CORES==="`,
		`nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 1`,
		`echo "===MEM==="`,
		`free -b 2>/dev/null | awk '/^Mem:/{print $2" "$3}' || echo "0 0"`,
		`echo "===DISK==="`,
		`df -B1 / 2>/dev/null | awk 'NR==2{print $2" "$3}' || echo "0 0"`,
		`echo "===LOAD==="`,
		`cat /proc/loadavg 2>/dev/null | awk '{print $1" "$2" "$3}' || uptime | sed 's/.*load average[s]*: //' | tr ',' ' ' | awk '{print $1" "$2" "$3}'`,
		`echo "===UPTIME==="`,
		`uptime -p 2>/dev/null || uptime | sed 's/.*up //' | sed 's/,.*//g'`,
		`echo "===CPU_USAGE==="`,
		`cat /proc/stat 2>/dev/null | awk '/^cpu /{a=$2+$3+$4; t=$2+$3+$4+$5+$6+$7+$8; print a" "t}'; sleep 0.5; cat /proc/stat 2>/dev/null | awk '/^cpu /{a=$2+$3+$4; t=$2+$3+$4+$5+$6+$7+$8; print a" "t}'`,
		`echo "===TRAFFIC==="`,
		`cat /proc/net/dev 2>/dev/null | awk 'NR>2 && $1!~"lo:" {gsub(/:$/,"",$1); rx+=$2; tx+=$10} END{print rx" "tx}' || echo "0 0"`,
		`echo "===END==="`,
	}, "; ")

	out, err := session.CombinedOutput(cmd)
	if err != nil {
		responseBody.Msg = fmt.Sprintf("command error: %v", err)
		return &responseBody
	}

	result := parseSysInfo(string(out))
	responseBody.Data = result
	return &responseBody
}

func parseSysInfo(raw string) map[string]string {
	info := map[string]string{
		"os":        "unknown",
		"arch":      "unknown",
		"cpuModel":  "unknown",
		"cpuCores":  "0",
		"memTotal":  "0",
		"memUsed":   "0",
		"diskTotal": "0",
		"diskUsed":  "0",
		"load":      "0 0 0",
		"uptime":    "unknown",
		"cpuUsage":  "0",
		"rxTotal":   "0",
		"txTotal":   "0",
	}

	sections := map[string]string{}
	multiSections := map[string][]string{}
	currentKey := ""
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		switch line {
		case "===OS===":
			currentKey = "os"
			continue
		case "===ARCH===":
			currentKey = "arch"
			continue
		case "===CPU_MODEL===":
			currentKey = "cpuModel"
			continue
		case "===CPU_CORES===":
			currentKey = "cpuCores"
			continue
		case "===MEM===":
			currentKey = "mem"
			continue
		case "===DISK===":
			currentKey = "disk"
			continue
		case "===LOAD===":
			currentKey = "load"
			continue
		case "===UPTIME===":
			currentKey = "uptime"
			continue
		case "===CPU_USAGE===":
			currentKey = "cpuUsage"
			continue
		case "===TRAFFIC===":
			currentKey = "traffic"
			continue
		case "===END===":
			currentKey = ""
			continue
		}
		if currentKey != "" {
			if sections[currentKey] == "" {
				sections[currentKey] = line
			}
			multiSections[currentKey] = append(multiSections[currentKey], line)
		}
	}

	if v, ok := sections["os"]; ok && v != "" {
		info["os"] = v
	}
	if v, ok := sections["arch"]; ok && v != "" {
		info["arch"] = v
	}
	if v, ok := sections["cpuModel"]; ok && v != "" {
		info["cpuModel"] = v
	}
	if v, ok := sections["cpuCores"]; ok && v != "" {
		info["cpuCores"] = v
	}
	if v, ok := sections["mem"]; ok && v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 2 {
			info["memTotal"] = parts[0]
			info["memUsed"] = parts[1]
		}
	}
	if v, ok := sections["disk"]; ok && v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 2 {
			info["diskTotal"] = parts[0]
			info["diskUsed"] = parts[1]
		}
	}
	if v, ok := sections["load"]; ok && v != "" {
		info["load"] = v
	}
	if v, ok := sections["uptime"]; ok && v != "" {
		info["uptime"] = v
	}
	if lines, ok := multiSections["cpuUsage"]; ok && len(lines) >= 2 {
		info["cpuUsage"] = calcCPUUsage(lines[0], lines[1])
	}
	if v, ok := sections["traffic"]; ok && v != "" {
		parts := strings.Fields(v)
		if len(parts) >= 2 {
			info["rxTotal"] = parts[0]
			info["txTotal"] = parts[1]
		}
	}
	return info
}

func calcCPUUsage(line1, line2 string) string {
	p1 := strings.Fields(line1)
	p2 := strings.Fields(line2)
	if len(p1) < 2 || len(p2) < 2 {
		return "0"
	}
	a1, _ := strconv.ParseFloat(p1[0], 64)
	t1, _ := strconv.ParseFloat(p1[1], 64)
	a2, _ := strconv.ParseFloat(p2[0], 64)
	t2, _ := strconv.ParseFloat(p2[1], 64)
	dt := t2 - t1
	if dt <= 0 {
		return "0"
	}
	usage := (a2 - a1) / dt * 100
	if usage < 0 {
		usage = 0
	}
	if usage > 100 {
		usage = 100
	}
	return fmt.Sprintf("%.1f", usage)
}
