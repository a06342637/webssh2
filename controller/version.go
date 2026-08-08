package controller

// AppVersion 的唯一来源是仓库根目录的 VERSION 文件，由 main 包在初始化时注入。
// 这里的兜底值只在 controller 被单独引用（例如只跑本包测试）时生效。
var AppVersion = "0.0.0"
