package controller

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
	"github.com/pkg/sftp"
)

type File struct {
	Name       string
	Size       string
	ModifyTime string
	IsDir      bool
}

const (
	BYTE = 1 << (10 * iota)
	KILOBYTE
	MEGABYTE
	GIGABYTE
	TERABYTE
	PETABYTE
	EXABYTE
)

func Bytefmt(bytes uint64) string {
	unit := ""
	value := float64(bytes)
	switch {
	case bytes >= EXABYTE:
		unit = "E"
		value = value / EXABYTE
	case bytes >= PETABYTE:
		unit = "P"
		value = value / PETABYTE
	case bytes >= TERABYTE:
		unit = "T"
		value = value / TERABYTE
	case bytes >= GIGABYTE:
		unit = "G"
		value = value / GIGABYTE
	case bytes >= MEGABYTE:
		unit = "M"
		value = value / MEGABYTE
	case bytes >= KILOBYTE:
		unit = "K"
		value = value / KILOBYTE
	case bytes >= BYTE:
		unit = "B"
	case bytes == 0:
		return "0B"
	}
	result := strconv.FormatFloat(value, 'f', 2, 64)
	result = strings.TrimSuffix(result, ".00")
	return result + unit
}

type fileSplice []File

func (f fileSplice) Len() int           { return len(f) }
func (f fileSplice) Swap(i, j int)      { f[i], f[j] = f[j], f[i] }
func (f fileSplice) Less(i, j int) bool { return f[i].IsDir }

func UploadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	sshInfo := c.PostForm("sshInfo")
	id := c.PostForm("id")
	if sshClient, err = core.DecodedMsgToSSHClient(sshInfo); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer file.Close()
	path := strings.TrimSpace(c.DefaultPostForm("path", ""))
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	pathArr := []string{strings.TrimRight(path, "/")}
	if dir := c.DefaultPostForm("dir", ""); "" != dir {
		pathArr = append(pathArr, dir)
		if err := sshClient.Mkdirs(strings.Join(pathArr, "/")); err != nil {
			responseBody.Msg = err.Error()
			return &responseBody
		}
	}
	pathArr = append(pathArr, header.Filename)
	err = sshClient.Upload(file, id, strings.Join(pathArr, "/"))
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
	}
	return &responseBody
}

func DownloadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	path := strings.TrimSpace(c.DefaultQuery("path", ""))
	sshInfo := c.DefaultQuery("sshInfo", "")
	if sshClient, err = core.DecodedMsgToSSHClient(sshInfo); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	if sftpFile, err := sshClient.Download(path); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
	} else {
		defer sftpFile.Close()
		c.Writer.WriteHeader(http.StatusOK)
		fileMeta := strings.Split(path, "/")
		c.Header("Content-Disposition", "attachment; filename="+fileMeta[len(fileMeta)-1])
		_, _ = io.Copy(c.Writer, sftpFile)
	}
	return &responseBody
}

func UploadProgressWs(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	wsConn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	id := c.Query("id")
	var ready, find bool
	for {
		if !ready && core.WcList == nil {
			continue
		}
		for _, v := range core.WcList {
			if v.Id == id {
				wsConn.WriteMessage(1, []byte(strconv.Itoa(v.Total)))
				find = true
				if !ready {
					ready = true
				}
				break
			}
		}
		if ready && !find {
			wsConn.Close()
			break
		}
		if ready {
			time.Sleep(300 * time.Millisecond)
			find = false
		}
	}
	return &responseBody
}

func FileList(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	path := c.DefaultQuery("path", "")
	sshInfo := c.DefaultQuery("sshInfo", "")
	sshClient, err := core.DecodedMsgToSSHClient(sshInfo)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer sshClient.Close()
	home := detectHomeDir(sshClient.Sftp, sshClient.Username)
	if path == "/" && home != "/" && sshClient.Username != "root" {
		path = home
	}
	if path == "" {
		if sshClient.Username == "root" {
			path = "/"
		} else {
			path = home
		}
	}
	files, err := sshClient.Sftp.ReadDir(path)
	if err != nil {
		if strings.Contains(err.Error(), "exist") {
			responseBody.Msg = fmt.Sprintf("Directory %s: no such file or directory", path)
		} else {
			responseBody.Msg = err.Error()
		}
		return &responseBody
	}
	var (
		fileList fileSplice
		fileSize string
	)
	for _, mFile := range files {
		if mFile.IsDir() {
			fileSize = strconv.FormatInt(mFile.Size(), 10)
		} else {
			fileSize = Bytefmt(uint64(mFile.Size()))
		}
		file := File{Name: mFile.Name(), IsDir: mFile.IsDir(), Size: fileSize, ModifyTime: mFile.ModTime().Format("2006-01-02 15:04:05")}
		fileList = append(fileList, file)
	}
	sort.Stable(fileList)
	responseBody.Data = gin.H{
		"list": fileList,
		"home": home,
	}
	return &responseBody
}

func detectHomeDir(sftpClient *sftp.Client, username string) string {
	if wd, err := sftpClient.Getwd(); err == nil && wd != "" {
		return wd
	}
	if username == "root" {
		return "/root"
	}
	potentialHome := fmt.Sprintf("/usr/home/%s", username)
	if _, err := sftpClient.Stat(potentialHome); err == nil {
		return potentialHome
	}
	potentialHome = fmt.Sprintf("/home/%s", username)
	if _, err := sftpClient.Stat(potentialHome); err == nil {
		return potentialHome
	}
	return "/home"
}
