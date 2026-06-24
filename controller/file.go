package controller

import (
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	pathpkg "path"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
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
func (f fileSplice) Less(i, j int) bool {
	if f[i].IsDir != f[j].IsDir {
		return f[i].IsDir
	}
	return strings.ToLower(f[i].Name) < strings.ToLower(f[j].Name)
}

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
		c.JSON(http.StatusBadRequest, responseBody)
		return &responseBody
	}
	if err := sshClient.CreateSftp(); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
		return &responseBody
	}
	defer sshClient.Close()
	if path == "" {
		path = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	if sftpFile, err := sshClient.Download(path); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		c.JSON(http.StatusInternalServerError, responseBody)
	} else {
		defer sftpFile.Close()
		filename := pathpkg.Base(path)
		if filename == "." || filename == "/" || filename == "" {
			filename = "download"
		}
		c.Header("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
		c.Header("Content-Type", "application/octet-stream")
		c.Status(http.StatusOK)
		_, _ = io.Copy(c.Writer, sftpFile)
	}
	return &responseBody
}

func RemoteDownloadFile(c *gin.Context) *ResponseBody {
	var (
		sshClient core.SSHClient
		err       error
	)
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	sshInfo := c.PostForm("sshInfo")
	rawURL := strings.TrimSpace(c.PostForm("url"))
	dir := strings.TrimSpace(c.DefaultPostForm("path", ""))
	filename := sanitizeRemoteFilename(c.PostForm("filename"))
	if rawURL == "" {
		responseBody.Msg = "missing remote url"
		return &responseBody
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		responseBody.Msg = "only http/https url is supported"
		return &responseBody
	}
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
	if dir == "" {
		dir = detectHomeDir(sshClient.Sftp, sshClient.Username)
	}
	if err := sshClient.Mkdirs(dir); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	httpClient := http.Client{Timeout: 30 * time.Minute}
	req, err := http.NewRequest(http.MethodGet, rawURL, nil)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	req.Header.Set("User-Agent", "webssh-remote-download/1.0")
	resp, err := httpClient.Do(req)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		responseBody.Msg = fmt.Sprintf("remote server returned %s", resp.Status)
		return &responseBody
	}
	if filename == "" {
		filename = filenameFromDisposition(resp.Header.Get("Content-Disposition"))
	}
	if filename == "" {
		urlFilename, _ := url.PathUnescape(pathpkg.Base(parsedURL.EscapedPath()))
		filename = sanitizeRemoteFilename(urlFilename)
	}
	if filename == "" || filename == "." || filename == "/" {
		filename = fmt.Sprintf("download-%d", time.Now().Unix())
	}
	dstPath := pathpkg.Join(dir, filename)
	dstFile, err := sshClient.Sftp.Create(dstPath)
	if err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer dstFile.Close()
	if _, err = io.Copy(dstFile, resp.Body); err != nil {
		fmt.Println(err)
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = gin.H{"path": dstPath, "filename": filename}
	return &responseBody
}

func filenameFromDisposition(value string) string {
	if value == "" {
		return ""
	}
	_, params, err := mime.ParseMediaType(value)
	if err != nil {
		return ""
	}
	if filename := sanitizeRemoteFilename(params["filename*"]); filename != "" {
		return filename
	}
	return sanitizeRemoteFilename(params["filename"])
}

func sanitizeRemoteFilename(filename string) string {
	filename = strings.TrimSpace(filename)
	filename = strings.ReplaceAll(filename, "\\", "/")
	filename = pathpkg.Base(filename)
	if filename == "." || filename == "/" {
		return ""
	}
	return strings.Trim(filename, "\x00\r\n\t ")
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
	defer wsConn.Close()
	id := c.Query("id")
	if strings.TrimSpace(id) == "" {
		responseBody.Msg = "missing upload id"
		return &responseBody
	}
	ticker := time.NewTicker(300 * time.Millisecond)
	defer ticker.Stop()
	waitTimer := time.NewTimer(30 * time.Second)
	defer waitTimer.Stop()
	var ready bool
	for {
		var total int64
		var found bool
		core.WcMu.Lock()
		for _, v := range core.WcList {
			if v != nil && v.Id == id {
				total = atomic.LoadInt64(&v.Total)
				found = true
				break
			}
		}
		core.WcMu.Unlock()
		if found {
			ready = true
			if err := wsConn.WriteMessage(1, []byte(strconv.FormatInt(total, 10))); err != nil {
				responseBody.Msg = err.Error()
				return &responseBody
			}
			if !waitTimer.Stop() {
				select {
				case <-waitTimer.C:
				default:
				}
			}
			waitTimer.Reset(30 * time.Second)
		} else if ready {
			return &responseBody
		}
		select {
		case <-ticker.C:
		case <-waitTimer.C:
			if !ready {
				responseBody.Msg = "upload progress timeout"
			}
			return &responseBody
		}
	}
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
