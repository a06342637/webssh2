package controller

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	pathpkg "path"
	"strconv"
	"strings"
	"sync"
	"time"
	"webssh/core"

	"github.com/gin-gonic/gin"
)

const (
	previewGrantTTL           = 30 * time.Minute
	previewGrantMaxCount      = 128
	previewGrantMaxPerOwner   = 16
	previewGrantMaxConcurrent = 4
	previewGrantMaxConfigSize = 512 << 10
)

type previewGrant struct {
	mu sync.Mutex

	token      string
	owner      string
	client     core.SSHClient
	path       string
	targetPath string
	filename   string
	kind       string
	mime       string
	size       int64
	modifiedAt int64
	expiresAt  time.Time
	active     int
	expired    bool
}

type previewGrantRequest struct {
	Token string `json:"token"`
}

var previewGrants = struct {
	sync.Mutex
	items map[string]*previewGrant
}{items: make(map[string]*previewGrant)}

func newPreviewGrantToken() (string, error) {
	bytes := make([]byte, 24)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return hex.EncodeToString(bytes), nil
}

func validPreviewGrantToken(token string) bool {
	if len(token) != 48 {
		return false
	}
	_, err := hex.DecodeString(token)
	return err == nil
}

func scrubPreviewGrant(grant *previewGrant) {
	if grant == nil {
		return
	}
	grant.client.Password = ""
	grant.client.PrivateKey = ""
	grant.client.Passphrase = ""
	grant.client.ProxyPass = ""
}

func expirePreviewGrant(token string, expected *previewGrant) {
	previewGrants.Lock()
	grant := previewGrants.items[token]
	if grant == expected {
		delete(previewGrants.items, token)
	}
	previewGrants.Unlock()
	if grant != expected || grant == nil {
		return
	}
	grant.mu.Lock()
	grant.expired = true
	if grant.active == 0 {
		scrubPreviewGrant(grant)
	}
	grant.mu.Unlock()
}

func revokePreviewGrant(owner, token string) bool {
	previewGrants.Lock()
	grant := previewGrants.items[token]
	if grant == nil || grant.owner != owner {
		previewGrants.Unlock()
		return false
	}
	delete(previewGrants.items, token)
	grant.mu.Lock()
	grant.expired = true
	if grant.active == 0 {
		scrubPreviewGrant(grant)
	}
	grant.mu.Unlock()
	previewGrants.Unlock()
	return true
}

func storePreviewGrant(grant *previewGrant) bool {
	previewGrants.Lock()
	if runtimeShuttingDown.Load() {
		previewGrants.Unlock()
		return false
	}
	ownerCount := 0
	for token, existing := range previewGrants.items {
		if existing.owner != grant.owner {
			continue
		}
		existing.mu.Lock()
		if existing.path == grant.path && existing.active == 0 {
			delete(previewGrants.items, token)
			existing.expired = true
			scrubPreviewGrant(existing)
			existing.mu.Unlock()
			continue
		}
		ownerCount++
		existing.mu.Unlock()
	}
	if len(previewGrants.items) >= previewGrantMaxCount || ownerCount >= previewGrantMaxPerOwner {
		previewGrants.Unlock()
		return false
	}
	previewGrants.items[grant.token] = grant
	previewGrants.Unlock()
	time.AfterFunc(time.Until(grant.expiresAt), func() { expirePreviewGrant(grant.token, grant) })
	return true
}

func previewGrantConfigSize(client core.SSHClient) int {
	return len(client.Username) + len(client.Password) + len(client.Hostname) +
		len(client.PrivateKey) + len(client.Passphrase) + len(client.ProxyHost) +
		len(client.ProxyUser) + len(client.ProxyPass) + len(client.HostKeyFingerprint) +
		len(client.TrustScope)
}

func expireAllPreviewGrants() {
	previewGrants.Lock()
	grants := make([]*previewGrant, 0, len(previewGrants.items))
	for token, grant := range previewGrants.items {
		delete(previewGrants.items, token)
		grants = append(grants, grant)
	}
	previewGrants.Unlock()
	for _, grant := range grants {
		grant.mu.Lock()
		grant.expired = true
		if grant.active == 0 {
			scrubPreviewGrant(grant)
		}
		grant.mu.Unlock()
	}
}

func claimPreviewGrant(owner, token string) (*previewGrant, func(), error) {
	previewGrants.Lock()
	grant := previewGrants.items[token]
	previewGrants.Unlock()
	if grant == nil || grant.owner != owner {
		return nil, nil, fmt.Errorf("preview authorization was not found")
	}
	grant.mu.Lock()
	if grant.expired || time.Now().After(grant.expiresAt) {
		grant.mu.Unlock()
		expirePreviewGrant(token, grant)
		return nil, nil, fmt.Errorf("preview authorization expired")
	}
	if grant.active >= previewGrantMaxConcurrent {
		grant.mu.Unlock()
		return nil, nil, fmt.Errorf("too many preview streams")
	}
	grant.active++
	grant.mu.Unlock()
	var once sync.Once
	release := func() {
		once.Do(func() {
			grant.mu.Lock()
			grant.active--
			if grant.expired && grant.active == 0 {
				scrubPreviewGrant(grant)
			}
			grant.mu.Unlock()
		})
	}
	return grant, release, nil
}

func AuthorizeFilePreview(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	request, err := bindFileRequest(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	release, ok := acquireSSHSlot(c)
	if !ok {
		responseBody.Msg = "SSH 连接任务过多，请稍后重试"
		return &responseBody
	}
	defer release()
	client, err := decodeSSHClient(c, request.SSHInfo)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	if previewGrantConfigSize(client) > previewGrantMaxConfigSize {
		responseBody.Msg = "SSH preview configuration is too large"
		return &responseBody
	}
	if err := client.CreateSftp(); err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	defer client.Close()
	requestedPath := strings.TrimSpace(request.Path)
	info, targetPath, spec, err := resolveRemotePreviewTarget(client.Sftp, requestedPath, remotePreviewMaxBytes())
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	owner, err := requestTrustScope(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	token, err := newPreviewGrantToken()
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	filename := pathpkg.Base(requestedPath)
	if filename == "." || filename == "/" || filename == "" {
		filename = "preview"
	}
	grant := &previewGrant{
		token: token, owner: owner, client: cloneSFTPClientConfig(client),
		path: requestedPath, targetPath: targetPath, filename: filename,
		kind: spec.Kind, mime: spec.MIME, size: info.Size(),
		modifiedAt: info.ModTime().UnixNano(), expiresAt: time.Now().Add(previewGrantTTL),
	}
	if !storePreviewGrant(grant) {
		scrubPreviewGrant(grant)
		if runtimeShuttingDown.Load() {
			responseBody.Msg = errRuntimeShuttingDown.Error()
		} else {
			responseBody.Msg = "too many preview authorizations"
		}
		return &responseBody
	}
	responseBody.Data = gin.H{
		"url":       "/file/preview/stream?token=" + token,
		"token":     token,
		"kind":      spec.Kind,
		"mime":      spec.MIME,
		"size":      info.Size(),
		"expiresAt": grant.expiresAt.UTC().Format(time.RFC3339),
	}
	return &responseBody
}

func RevokeFilePreview(c *gin.Context) *ResponseBody {
	responseBody := ResponseBody{Msg: "success"}
	defer TimeCost(time.Now(), &responseBody)
	var request previewGrantRequest
	if err := bindStrictJSON(c, &request); err != nil {
		responseBody.Msg = fmt.Errorf("invalid request: %w", err).Error()
		return &responseBody
	}
	request.Token = strings.TrimSpace(request.Token)
	if !validPreviewGrantToken(request.Token) {
		responseBody.Msg = "invalid preview token"
		return &responseBody
	}
	owner, err := requestTrustScope(c)
	if err != nil {
		responseBody.Msg = err.Error()
		return &responseBody
	}
	responseBody.Data = gin.H{"revoked": revokePreviewGrant(owner, request.Token)}
	return &responseBody
}

func parsePreviewRange(raw string, size int64) (int64, int64, bool, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return 0, size - 1, false, nil
	}
	if size <= 0 {
		return 0, 0, false, fmt.Errorf("range is outside the file")
	}
	if !strings.HasPrefix(raw, "bytes=") || strings.Contains(raw, ",") {
		return 0, 0, false, fmt.Errorf("unsupported range")
	}
	parts := strings.SplitN(strings.TrimPrefix(raw, "bytes="), "-", 2)
	if len(parts) != 2 {
		return 0, 0, false, fmt.Errorf("invalid range")
	}
	if parts[0] == "" {
		suffix, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false, fmt.Errorf("invalid range")
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size - 1, true, nil
	}
	start, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false, fmt.Errorf("range is outside the file")
	}
	end := size - 1
	if parts[1] != "" {
		end, err = strconv.ParseInt(parts[1], 10, 64)
		if err != nil || end < start {
			return 0, 0, false, fmt.Errorf("invalid range")
		}
		if end >= size {
			end = size - 1
		}
	}
	return start, end, true, nil
}

func PreviewFileStream(c *gin.Context) {
	token := strings.TrimSpace(c.Query("token"))
	if !validPreviewGrantToken(token) {
		c.JSON(http.StatusBadRequest, ResponseBody{Msg: "invalid preview token"})
		return
	}
	owner, err := requestTrustScope(c)
	if err != nil {
		c.JSON(http.StatusInternalServerError, ResponseBody{Msg: err.Error()})
		return
	}
	grant, releaseGrant, err := claimPreviewGrant(owner, token)
	if err != nil {
		status := http.StatusNotFound
		if strings.Contains(err.Error(), "expired") {
			status = http.StatusGone
		} else if strings.Contains(err.Error(), "too many") {
			status = http.StatusTooManyRequests
		}
		c.JSON(status, ResponseBody{Msg: err.Error()})
		return
	}
	defer releaseGrant()
	releaseDownload, ok := acquireDownloadSlot(c)
	if !ok {
		return
	}
	defer releaseDownload()
	releaseSSH, ok := acquireSSHSlot(c)
	if !ok {
		return
	}
	defer releaseSSH()

	client := cloneSFTPClientConfig(grant.client)
	if err := client.CreateSftp(); err != nil {
		c.JSON(http.StatusBadGateway, ResponseBody{Msg: err.Error()})
		return
	}
	defer client.Close()
	stopCancellation := closeSSHOnContextDone(c.Request.Context(), &client)
	defer stopCancellation()
	info, targetPath, spec, err := resolveRemotePreviewTarget(client.Sftp, grant.path, remotePreviewMaxBytes())
	if err != nil || targetPath != grant.targetPath || info.Size() != grant.size || info.ModTime().UnixNano() != grant.modifiedAt || spec.Kind != grant.kind || spec.MIME != grant.mime {
		if err == nil {
			err = fmt.Errorf("preview target changed after authorization")
		}
		c.JSON(http.StatusConflict, ResponseBody{Msg: err.Error()})
		return
	}
	start, end, partial, err := parsePreviewRange(c.GetHeader("Range"), info.Size())
	if err != nil {
		c.Header("Content-Range", fmt.Sprintf("bytes */%d", info.Size()))
		c.JSON(http.StatusRequestedRangeNotSatisfiable, ResponseBody{Msg: err.Error()})
		return
	}
	file, err := client.Sftp.Open(targetPath)
	if err != nil {
		c.JSON(http.StatusBadGateway, ResponseBody{Msg: err.Error()})
		return
	}
	defer file.Close()
	if start > 0 {
		if _, err := file.Seek(start, io.SeekStart); err != nil {
			c.JSON(http.StatusBadGateway, ResponseBody{Msg: err.Error()})
			return
		}
	}
	length := end - start + 1
	c.Header("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": grant.filename}))
	c.Header("Content-Type", grant.mime)
	c.Header("Content-Length", strconv.FormatInt(length, 10))
	c.Header("Cache-Control", "private, no-store")
	c.Header("Cross-Origin-Resource-Policy", "same-origin")
	if strings.EqualFold(grant.mime, "image/svg+xml") {
		// SVG is a document format, not just pixels. Sandboxing keeps a remote SVG
		// from executing script or loading active content under the WebSSH origin.
		c.Header("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'")
	}
	c.Header("Accept-Ranges", "bytes")
	c.Header("X-WebSSH-Preview-Kind", grant.kind)
	c.Header("X-WebSSH-File-Size", strconv.FormatInt(info.Size(), 10))
	c.Header("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, Content-Range, X-WebSSH-Preview-Kind, X-WebSSH-File-Size")
	if partial {
		c.Header("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, info.Size()))
		c.Status(http.StatusPartialContent)
	} else {
		c.Status(http.StatusOK)
	}
	_, copyErr := streamDownloadResponse(c, c.Request.Context(), io.LimitReader(file, length), length)
	if copyErr != nil && !errors.Is(copyErr, context.Canceled) {
		_ = c.Error(copyErr)
		c.Abort()
	}
}
