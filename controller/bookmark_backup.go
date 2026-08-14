package controller

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

const (
	siteScriptBackupApp       = "webssh2"
	siteScriptBackupType      = "site_script_bookmarks_backup"
	siteScriptBackupScope     = "site"
	siteScriptBackupVersion   = 1
	siteScriptBackupBodyLimit = int64(256 << 20)
	maxSiteScriptBackupUsers  = 10000
)

type siteScriptBackupUser struct {
	Username   string           `json:"username"`
	Scripts    []ScriptBookmark `json:"scripts"`
	Categories []ScriptCategory `json:"categories"`
	UpdatedAt  int64            `json:"updatedAt"`
	Revision   int64            `json:"revision"`
}

type siteScriptBookmarksBackup struct {
	App        string                 `json:"app"`
	Type       string                 `json:"type"`
	Scope      string                 `json:"scope"`
	Version    int                    `json:"version"`
	ExportedAt string                 `json:"exportedAt"`
	ExportedBy string                 `json:"exportedBy"`
	Users      []siteScriptBackupUser `json:"users"`
}

type siteScriptBackupStats struct {
	Users      int
	Scripts    int
	Categories int
}

type siteScriptBackupValidationError struct {
	Code string
	Msg  string
}

func SiteScriptBackupRequestBodyLimit() int64 {
	return siteScriptBackupBodyLimit
}

func writeSiteScriptBackupError(c *gin.Context, status int, code, msg string) {
	c.JSON(status, gin.H{"ok": false, "code": code, "msg": msg})
}

func siteScriptBackupStatsFor(backup siteScriptBookmarksBackup) siteScriptBackupStats {
	stats := siteScriptBackupStats{Users: len(backup.Users)}
	for _, user := range backup.Users {
		stats.Scripts += len(user.Scripts)
		stats.Categories += len(user.Categories)
	}
	return stats
}

func AdminExportScriptBookmarks(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}

	accountStore.mu.Lock()
	usernames := make([]string, 0, len(accountStore.db.Users))
	for username := range accountStore.db.Users {
		usernames = append(usernames, username)
	}
	sort.Strings(usernames)
	users := make([]siteScriptBackupUser, 0, len(usernames))
	now := time.Now().UnixMilli()
	for _, username := range usernames {
		workspace := accountStore.db.Scripts[username]
		categories := sanitizeScriptCategories(workspace.Categories)
		scripts := sanitizeScriptCategoryReferences(sanitizeScriptBookmarks(workspace.Items), categories)
		if scripts == nil {
			scripts = []ScriptBookmark{}
		}
		if categories == nil {
			categories = []ScriptCategory{}
		}
		users = append(users, siteScriptBackupUser{
			Username:   username,
			Scripts:    scripts,
			Categories: categories,
			UpdatedAt:  sanitizeScriptUpdatedAt(workspace.UpdatedAt, now),
			Revision:   sanitizeScriptRevision(workspace.Revision),
		})
	}
	accountStore.mu.Unlock()

	backup := siteScriptBookmarksBackup{
		App:        siteScriptBackupApp,
		Type:       siteScriptBackupType,
		Scope:      siteScriptBackupScope,
		Version:    siteScriptBackupVersion,
		ExportedAt: time.Now().UTC().Format(time.RFC3339Nano),
		ExportedBy: adminUsername,
		Users:      users,
	}
	encoded, err := json.Marshal(backup)
	if err != nil {
		writeSiteScriptBackupError(c, http.StatusInternalServerError, "backup_encode_failed", "全站书签备份生成失败")
		return
	}
	if int64(len(encoded)) > SiteScriptBackupRequestBodyLimit() {
		writeSiteScriptBackupError(c, http.StatusRequestEntityTooLarge, "backup_too_large", "全站书签备份超过 256 MiB 上限")
		return
	}
	stats := siteScriptBackupStatsFor(backup)
	c.JSON(http.StatusOK, gin.H{"ok": true, "data": gin.H{
		"backup":        backup,
		"userCount":     stats.Users,
		"scriptCount":   stats.Scripts,
		"categoryCount": stats.Categories,
	}})
}

func decodeSiteScriptBookmarksBackup(c *gin.Context) (siteScriptBookmarksBackup, *siteScriptBackupValidationError) {
	var raw json.RawMessage
	if err := bindStrictJSON(c, &raw); err != nil {
		var maxBytesErr *http.MaxBytesError
		if errors.As(err, &maxBytesErr) {
			return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "backup_too_large", Msg: "全站书签备份超过 256 MiB 上限"}
		}
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "备份文件不是有效的 JSON 数据"}
	}

	var header struct {
		App   string `json:"app"`
		Type  string `json:"type"`
		Scope string `json:"scope"`
	}
	if err := json.Unmarshal(raw, &header); err != nil {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "备份文件不是有效的 JSON 对象"}
	}
	if isPersonalScriptBookmarksBackupType(header.Type) || strings.EqualFold(strings.TrimSpace(header.Scope), "personal") {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "wrong_backup_scope", Msg: "这是个人书签备份，不能用于全站恢复；请使用“导入个人备份”"}
	}
	if header.App != siteScriptBackupApp {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "invalid_backup_app", Msg: "这不是 WebSSH2 生成的全站书签备份"}
	}
	if header.Type != siteScriptBackupType || header.Scope != siteScriptBackupScope {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "wrong_backup_scope", Msg: "备份类型不正确，个人备份和全站备份不能混用"}
	}

	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	var backup siteScriptBookmarksBackup
	if err := decoder.Decode(&backup); err != nil {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "全站书签备份包含未知或无效字段"}
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return siteScriptBookmarksBackup{}, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "全站书签备份包含多余数据"}
	}
	return backup, nil
}

func validateSiteScriptBookmarksBackup(backup siteScriptBookmarksBackup) ([]siteScriptBackupUser, *siteScriptBackupValidationError) {
	if backup.App != siteScriptBackupApp || backup.Type != siteScriptBackupType || backup.Scope != siteScriptBackupScope {
		return nil, &siteScriptBackupValidationError{Code: "wrong_backup_scope", Msg: "备份类型不正确，个人备份和全站备份不能混用"}
	}
	if backup.Version != siteScriptBackupVersion {
		return nil, &siteScriptBackupValidationError{Code: "unsupported_backup_version", Msg: "不支持这个全站书签备份版本"}
	}
	if _, err := time.Parse(time.RFC3339, backup.ExportedAt); err != nil {
		return nil, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "全站书签备份的导出时间无效"}
	}
	exportedBy, msg := normalizeAccountUsername(backup.ExportedBy)
	if msg != "" || exportedBy != backup.ExportedBy {
		return nil, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "全站书签备份的导出管理员无效"}
	}
	if len(backup.Users) == 0 || len(backup.Users) > maxSiteScriptBackupUsers {
		return nil, &siteScriptBackupValidationError{Code: "invalid_backup_format", Msg: "全站书签备份中的用户数量无效"}
	}

	seen := make(map[string]struct{}, len(backup.Users))
	validated := make([]siteScriptBackupUser, 0, len(backup.Users))
	for _, user := range backup.Users {
		username, msg := normalizeAccountUsername(user.Username)
		if msg != "" || username != user.Username {
			return nil, &siteScriptBackupValidationError{Code: "invalid_backup_user", Msg: "全站书签备份包含无效用户名"}
		}
		if _, exists := seen[username]; exists {
			return nil, &siteScriptBackupValidationError{Code: "duplicate_backup_user", Msg: "全站书签备份包含重复用户名：" + username}
		}
		seen[username] = struct{}{}
		if user.UpdatedAt < 0 || user.Revision < 0 {
			return nil, &siteScriptBackupValidationError{Code: "invalid_backup_workspace", Msg: "用户 " + username + " 的书签版本信息无效"}
		}
		for _, category := range user.Categories {
			if category.CreatedAt < 0 {
				return nil, &siteScriptBackupValidationError{Code: "invalid_backup_workspace", Msg: "用户 " + username + " 的分类时间无效"}
			}
		}
		categories := sanitizeScriptCategories(user.Categories)
		scripts := sanitizeScriptCategoryReferences(sanitizeScriptBookmarks(user.Scripts), categories)
		if !scriptCategoriesEqual(categories, user.Categories) || !scriptsEqual(scripts, user.Scripts) {
			return nil, &siteScriptBackupValidationError{Code: "invalid_backup_workspace", Msg: "用户 " + username + " 的书签内容不符合格式要求"}
		}
		if scriptWorkspaceSize(scripts, categories) > maxScriptDataBytes {
			return nil, &siteScriptBackupValidationError{Code: "backup_workspace_too_large", Msg: "用户 " + username + " 的书签超过 8 MiB 上限"}
		}
		validated = append(validated, siteScriptBackupUser{
			Username:   username,
			Scripts:    append([]ScriptBookmark(nil), scripts...),
			Categories: append([]ScriptCategory(nil), categories...),
			UpdatedAt:  user.UpdatedAt,
			Revision:   user.Revision,
		})
	}
	return validated, nil
}

func AdminRestoreScriptBookmarks(c *gin.Context) {
	adminUsername, ok := requireAdmin(c)
	if !ok {
		return
	}
	backup, validationErr := decodeSiteScriptBookmarksBackup(c)
	if validationErr != nil {
		writeSiteScriptBackupError(c, http.StatusBadRequest, validationErr.Code, validationErr.Msg)
		return
	}
	validated, validationErr := validateSiteScriptBookmarksBackup(backup)
	if validationErr != nil {
		writeSiteScriptBackupError(c, http.StatusBadRequest, validationErr.Code, validationErr.Msg)
		return
	}

	accountStore.mu.Lock()
	defer accountStore.mu.Unlock()
	matched := make([]siteScriptBackupUser, 0, len(validated))
	missingUsers := make([]string, 0)
	for _, user := range validated {
		if _, exists := accountStore.db.Users[user.Username]; !exists {
			missingUsers = append(missingUsers, user.Username)
			continue
		}
		matched = append(matched, user)
	}
	if len(matched) == 0 {
		c.JSON(http.StatusConflict, gin.H{"ok": false, "code": "no_matching_users", "msg": "备份中的用户在当前网站均不存在，未修改任何书签", "data": gin.H{
			"restoredUsers": 0,
			"skippedUsers":  len(missingUsers),
			"missingUsers":  missingUsers,
		}})
		return
	}

	before := accountStore.snapshotLocked()
	serverNow := time.Now().UnixMilli()
	restoredScripts := 0
	restoredCategories := 0
	currentAccountRestored := false
	for _, user := range matched {
		cloud := accountStore.db.Scripts[user.Username]
		cloud.UpdatedAt = sanitizeScriptUpdatedAt(cloud.UpdatedAt, serverNow)
		cloud.Revision = sanitizeScriptRevision(cloud.Revision)
		restoredAt := serverNow
		if restoredAt <= cloud.UpdatedAt {
			restoredAt = cloud.UpdatedAt + 1
		}
		revision := cloud.Revision + 1
		accountStore.db.Scripts[user.Username] = StoredScripts{
			Items:         append([]ScriptBookmark(nil), user.Scripts...),
			Categories:    append([]ScriptCategory(nil), user.Categories...),
			UpdatedAt:     restoredAt,
			Revision:      revision,
			ResetRevision: revision,
		}
		restoredScripts += len(user.Scripts)
		restoredCategories += len(user.Categories)
		if user.Username == adminUsername {
			currentAccountRestored = true
		}
	}
	if err := accountStore.saveLocked(); err != nil {
		accountStore.restoreLocked(before)
		writeSiteScriptBackupError(c, http.StatusInternalServerError, "backup_restore_failed", "全站书签恢复失败，原数据未改变")
		return
	}

	sort.Strings(missingUsers)
	c.JSON(http.StatusOK, gin.H{"ok": true, "msg": "全站书签恢复完成", "data": gin.H{
		"restoredUsers":          len(matched),
		"skippedUsers":           len(missingUsers),
		"missingUsers":           missingUsers,
		"scriptCount":            restoredScripts,
		"categoryCount":          restoredCategories,
		"currentAccountRestored": currentAccountRestored,
	}})
}

func isPersonalScriptBookmarksBackupType(value string) bool {
	return strings.EqualFold(strings.TrimSpace(value), "script_bookmarks")
}
