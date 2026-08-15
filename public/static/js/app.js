/* ============================================================
   WebSSH v5 - Multi-tab, SFTP, Dual Bookmarks
   ============================================================ */

// ==================== State ====================
var sessions = [];
var activeIdx = -1;
var sftpRemoteSessionId = '';
var sftpDirPickerSessionId = '';
// Online remote editors are kept in the page while their SSH tab is alive.
// Each editor carries its session id, so a response can never be applied to
// whichever tab happens to be active when it arrives.
var remoteEditors = [];
var remoteEditorCloseRequest = null;
var remoteEditorZIndex = 40;
var remoteEditorBoundsObserver = null;
var remoteEditorDecorationMaxBytes = 384 * 1024;
var remoteEditorLargeFileMaxLines = 12000;
var sftpDownloadConfirmRequest = null;
var sftpDeleteConfirmRequest = null;
var SFTP_UPLOAD_CONCURRENCY = 2;
var sftpUploadSequence = 0;
var serverInfoModalIdx = -1;
var serverInfoTimer = null;
var serverInfoSelectedIface = {};
var serverInfoDetailType = null;
var TOPBAR_METRICS_KEY = 'webssh_topbar_metrics';
var FIRST_SSH_SUCCESS_KEY = 'webssh_first_ssh_success_seen';
var NET_UNIT_KEY = 'webssh_server_net_unit';
var SERVER_INFO_NET_REFRESH_MS = 1000;
var SERVER_INFO_REFRESH_MS = 5000;
var SERVER_INFO_CHART_MINUTES = 3;
var SERVER_INFO_DETAIL_CHART_MINUTES = 10;
var serverInfoNetUnit = (function () {
    try { return safeStorageGet(NET_UNIT_KEY) === 'bits' ? 'bits' : 'bytes'; } catch (e) { return 'bytes'; }
})();
var serverInfoGuideTimer = null;
var TERMINAL_CONTROL_PREFIX = '__WEBSSH_CONTROL__:';
var TRUST_SCOPE_KEY = 'webssh_trust_scope';
var trustScopeMemory = '';

// ==================== Particles ====================
(function () {
    var c = document.getElementById('particles');
    if (!c) return;
    var x = c.getContext('2d'), ps = [], m = { x: null, y: null };
    var bg = document.querySelector('.bg-animation');
    var frameHandle = 0;
    var effectsEnabled = false;
    function rs() { c.width = innerWidth; c.height = innerHeight; }
    rs(); addEventListener('resize', rs);
    document.addEventListener('mousemove', function (e) { m.x = e.clientX; m.y = e.clientY; });
    function P() { this.r(); }
    P.prototype.r = function () { this.x = Math.random() * c.width; this.y = Math.random() * c.height; this.s = Math.random() * 2 + .5; this.sx = (Math.random() - .5) * .5; this.sy = (Math.random() - .5) * .5; this.o = Math.random() * .5 + .1; this.h = Math.random() * 60 + 180; };
    P.prototype.u = function () { this.x += this.sx; this.y += this.sy; if (m.x !== null) { var dx = m.x - this.x, dy = m.y - this.y, d = Math.sqrt(dx * dx + dy * dy); if (d < 150) { var f = (150 - d) / 150; this.x -= dx * f * .01; this.y -= dy * f * .01; } } if (this.x < 0 || this.x > c.width) this.sx *= -1; if (this.y < 0 || this.y > c.height) this.sy *= -1; };
    P.prototype.d = function () { x.beginPath(); x.arc(this.x, this.y, this.s, 0, Math.PI * 2); x.fillStyle = 'hsla(' + this.h + ',80%,60%,' + this.o + ')'; x.fill(); };
    var n = Math.min(50, Math.floor(innerWidth * innerHeight / 22000));
    for (var i = 0; i < n; i++) ps.push(new P());
    function detectEnabled() {
        if (document.hidden || (document.body && document.body.classList.contains('terminal-active'))) return false;
        if (getComputedStyle(c).display === 'none') return false;
        return !bg || getComputedStyle(bg).display !== 'none';
    }
    function stop() {
        if (frameHandle) {
            cancelAnimationFrame(frameHandle);
            frameHandle = 0;
        }
        x.clearRect(0, 0, c.width, c.height);
    }
    function schedule() {
        if (!frameHandle && effectsEnabled) frameHandle = requestAnimationFrame(frame);
    }
    function frame() {
        frameHandle = 0;
        if (!effectsEnabled) return;
        x.clearRect(0, 0, c.width, c.height);
        for (var i = 0; i < ps.length; i++) { ps[i].u(); ps[i].d(); }
        for (var i = 0; i < ps.length; i++) for (var j = i + 1; j < ps.length; j++) { var dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d = Math.sqrt(dx * dx + dy * dy); if (d < 120) { x.beginPath(); x.moveTo(ps[i].x, ps[i].y); x.lineTo(ps[j].x, ps[j].y); x.strokeStyle = 'rgba(0,212,255,' + ((1 - d / 120) * .15) + ')'; x.lineWidth = .5; x.stroke(); } }
        schedule();
    }
    function sync() {
        effectsEnabled = detectEnabled();
        if (effectsEnabled) schedule(); else stop();
    }
    document.addEventListener('visibilitychange', sync);
    document.addEventListener('webssh:viewchange', sync);
    document.addEventListener('webssh:background-sync', sync);
    sync();
})();

// ==================== Utility ====================
var storageErrorShown = false;
var storageReadFailed = {};
function safeStorageGet(key, fallback) {
    try {
        var value = localStorage.getItem(key);
        delete storageReadFailed[key];
        return value === null || value === undefined ? fallback : value;
    } catch (e) {
        storageReadFailed[key] = true;
        return fallback;
    }
}
function storageReadIsUnavailable(key) { return !!storageReadFailed[key]; }
function safeStorageSet(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        if (!storageErrorShown) {
            storageErrorShown = true;
            setTimeout(function () { showToast('浏览器存储空间不可用，部分设置无法保存', 'error'); }, 0);
        }
        return false;
    }
}
function safeStorageRemove(key) {
    try {
        localStorage.removeItem(key);
        return true;
    } catch (e) {
        return false;
    }
}
function getOrCreateTrustScope() {
    if (/^[a-f0-9]{32,128}$/.test(trustScopeMemory)) return trustScopeMemory;
    var stored = String(safeStorageGet(TRUST_SCOPE_KEY, '') || '').replace(/-/g, '').toLowerCase();
    if (/^[a-f0-9]{32,128}$/.test(stored)) {
        trustScopeMemory = stored;
        return stored;
    }
    if (!window.crypto || typeof window.crypto.getRandomValues !== 'function') return '';
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    trustScopeMemory = Array.prototype.map.call(bytes, function (value) {
        return value.toString(16).padStart(2, '0');
    }).join('');
    safeStorageSet(TRUST_SCOPE_KEY, trustScopeMemory);
    return trustScopeMemory;
}
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function escAttr(s) { return esc(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
function fmtB(b) { b = parseInt(b) || 0; if (!b) return '0B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + u[i]; }
function pct(u, t) { return Math.round((parseInt(u) || 0) / (parseInt(t) || 1) * 100); }
function pillCls(v) { return v >= 90 ? 'danger' : v >= 70 ? 'warn' : ''; }

function showToast(msg, type) {
    type = type || 'info';
    var c = document.getElementById('toastContainer');
    var icons = { success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>', info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' };
    var d = document.createElement('div');
    d.className = 'toast ' + type;
    d.innerHTML = (icons[type] || icons.info) + '<span>' + esc(msg) + '</span>';
    c.appendChild(d);
    setTimeout(function () { d.classList.add('removing'); setTimeout(function () { d.remove(); }, 300); }, 3000);
}

function setStatus(s, t) { var e = document.getElementById('statusIndicator'); e.className = 'status-indicator ' + s; e.querySelector('.status-text').textContent = t; }
function showView(id) {
    document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); });
    document.getElementById(id).classList.add('active');
    if (document.body) {
        document.body.classList.toggle('terminal-active', id === 'terminalView');
        document.dispatchEvent(new Event('webssh:viewchange'));
    }
    var footer = document.querySelector('.global-footer');
    if (footer) {
        if (id === 'terminalView') {
            footer.classList.add('hidden');
        } else {
            footer.classList.remove('hidden');
        }
    }
}

// ==================== Login Form ====================
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(function (t) { t.classList.remove('active'); });
    document.querySelectorAll('.auth-panel').forEach(function (p) { p.classList.remove('active'); });
    document.querySelector('[data-tab="' + tab + '"]').classList.add('active');
    document.getElementById(tab === 'password' ? 'passwordAuth' : 'keyAuth').classList.add('active');
}

function togglePassword() {
    var i = document.getElementById('password');
    i.type = i.type === 'password' ? 'text' : 'password';
}

// Ripple
var btnConnect = document.querySelector('.btn-connect');
if (btnConnect) {
    btnConnect.addEventListener('click', function (e) {
        var r = this.querySelector('.btn-ripple'), b = this.getBoundingClientRect(), s = Math.max(b.width, b.height);
        r.style.width = r.style.height = s + 'px';
        r.style.left = (e.clientX - b.left - s / 2) + 'px';
        r.style.top = (e.clientY - b.top - s / 2) + 'px';
        r.classList.remove('active'); void r.offsetWidth; r.classList.add('active');
    });
}

document.getElementById('loginForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var h = document.getElementById('hostname').value.trim();
    var u = document.getElementById('username').value.trim() || 'root';
    if (!h) { showToast('请输入主机', 'error'); return; }
    document.getElementById('username').value = u;
    connectFromLogin();
});

document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
        var serverInfoDetailModal = document.getElementById('serverInfoDetailModal');
        if (serverInfoDetailModal && serverInfoDetailModal.classList.contains('show')) { hideServerInfoDetailModal(); return; }
        var sshAuthRetryModal = document.getElementById('sshAuthRetryModal');
        if (sshAuthRetryModal && sshAuthRetryModal.classList.contains('show')) { hideSSHAuthRetryModal(true); return; }
        var hostKeyMismatchModal = document.getElementById('hostKeyMismatchModal');
        if (hostKeyMismatchModal && hostKeyMismatchModal.classList.contains('show')) { hideHostKeyMismatchModal(true); return; }
        var runScriptConfirmModal = document.getElementById('runScriptConfirmModal');
        if (runScriptConfirmModal && runScriptConfirmModal.classList.contains('show')) { hideRunScriptConfirmModal(); return; }
        var scriptDeleteModal = document.getElementById('scriptDeleteModal');
        if (scriptDeleteModal && scriptDeleteModal.classList.contains('show')) { hideScriptDeleteModal(); return; }
        var categoryDeleteModal = document.getElementById('categoryDeleteModal');
        if (categoryDeleteModal && categoryDeleteModal.classList.contains('show')) { hideCategoryDeleteModal(); return; }
        var siteBookmarkRestoreModal = document.getElementById('siteBookmarkRestoreModal');
        if (siteBookmarkRestoreModal && siteBookmarkRestoreModal.classList.contains('show')) { hideSiteScriptRestoreConfirm(); return; }
        var scriptManagerModal = document.getElementById('scriptManagerModal');
        if (scriptManagerModal && scriptManagerModal.classList.contains('show')) { hideScriptManager(); return; }
        var authModal = document.getElementById('authModal');
        if (authModal && authModal.classList.contains('show')) { hideAuthModal(); return; }
        var editScriptModal = document.getElementById('editScriptModal');
        if (editScriptModal && editScriptModal.classList.contains('show')) { hideEditScriptModal(); return; }
        var accountEditModal = document.getElementById('accountEditModal');
        if (accountEditModal && accountEditModal.classList.contains('show')) { hideAccountEditModal(); return; }
        var accountAdminModal = document.getElementById('accountAdminModal');
        if (accountAdminModal && accountAdminModal.classList.contains('show')) { hideAccountAdminModal(); return; }
        var serverInfoModal = document.getElementById('serverInfoModal');
        if (serverInfoModal && serverInfoModal.classList.contains('show')) { hideServerInfoModal(); return; }
        var addTabModal = document.getElementById('addTabModal');
        if (addTabModal && addTabModal.classList.contains('show')) { hideAddTab(); return; }
        var remoteEditorCloseModal = document.getElementById('remoteEditorCloseModal');
        if (remoteEditorCloseModal && remoteEditorCloseModal.classList.contains('show')) { cancelRemoteEditorClose(); return; }
        var sftpDownloadConfirmModal = document.getElementById('sftpDownloadConfirmModal');
        if (sftpDownloadConfirmModal && sftpDownloadConfirmModal.classList.contains('show')) { hideSftpDownloadConfirm(); return; }
        var sftpDeleteConfirmModal = document.getElementById('sftpDeleteConfirmModal');
        if (sftpDeleteConfirmModal && sftpDeleteConfirmModal.classList.contains('show')) { hideSftpDeleteConfirm(); return; }
    }
});

document.addEventListener('click', function (e) {
    var serverInfoDetailModal = document.getElementById('serverInfoDetailModal');
    if (serverInfoDetailModal && serverInfoDetailModal.classList.contains('show') && e.target === serverInfoDetailModal) {
        hideServerInfoDetailModal();
    }
    var runScriptConfirmModal = document.getElementById('runScriptConfirmModal');
    if (runScriptConfirmModal && runScriptConfirmModal.classList.contains('show') && e.target === runScriptConfirmModal) {
        hideRunScriptConfirmModal();
    }
    var scriptDeleteModal = document.getElementById('scriptDeleteModal');
    if (scriptDeleteModal && scriptDeleteModal.classList.contains('show') && e.target === scriptDeleteModal) {
        hideScriptDeleteModal();
    }
    var categoryDeleteModal = document.getElementById('categoryDeleteModal');
    if (categoryDeleteModal && categoryDeleteModal.classList.contains('show') && e.target === categoryDeleteModal) {
        hideCategoryDeleteModal();
    }
    var remoteEditorCloseModal = document.getElementById('remoteEditorCloseModal');
    if (remoteEditorCloseModal && remoteEditorCloseModal.classList.contains('show') && e.target === remoteEditorCloseModal) {
        cancelRemoteEditorClose();
    }
});

// ==================== Proxy Config ====================
var PROXY_KEY = 'webssh_proxy';

function toggleProxyPanel() {
    var checked = document.getElementById('enableProxy').checked;
    var panel = document.getElementById('proxyPanel');
    if (checked) { panel.classList.add('show'); }
    else { panel.classList.remove('show'); }
}

function saveProxyConfig() {
    if (document.getElementById('rememberProxy').checked) {
        var cfg = {
            host: document.getElementById('proxyHost').value,
            port: document.getElementById('proxyPort').value,
            user: document.getElementById('proxyUser').value
        };
        if (savePasswords) cfg.pass = document.getElementById('proxyPass').value;
        safeStorageSet(PROXY_KEY, JSON.stringify(cfg));
        showToast('代理配置已保存', 'success');
    } else {
        safeStorageRemove(PROXY_KEY);
    }
}

function loadProxyConfig() {
    try {
        var cfg = JSON.parse(safeStorageGet(PROXY_KEY));
        if (cfg) {
            document.getElementById('proxyHost').value = cfg.host || '';
            document.getElementById('proxyPort').value = cfg.port || '1080';
            document.getElementById('proxyUser').value = cfg.user || '';
            document.getElementById('proxyPass').value = savePasswords ? (cfg.pass || '') : '';
            document.getElementById('enableProxy').checked = true;
            document.getElementById('rememberProxy').checked = true;
        }
    } catch (e) { }
}

function getProxyInfo() {
    if (!document.getElementById('enableProxy').checked) return {};
    var h = document.getElementById('proxyHost').value.trim();
    if (!h) return {};
    return {
        proxyHost: h,
        proxyPort: parseInt(document.getElementById('proxyPort').value) || 1080,
        proxyUser: document.getElementById('proxyUser').value,
        proxyPass: document.getElementById('proxyPass').value
    };
}

function normalizePortValue(port, fallback) {
    var p = parseInt(port, 10);
    if (!p || p < 1 || p > 65535) return fallback || 22;
    return p;
}

function parseHostPortInput(host, port) {
    var out = { host: String(host || '').trim(), port: normalizePortValue(port, 22) };
    if (!out.host) return out;
    var bracket = out.host.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracket) {
        out.host = bracket[1];
        if (bracket[2]) out.port = normalizePortValue(bracket[2], out.port);
        return out;
    }
    var idx = out.host.lastIndexOf(':');
    if (idx > 0 && out.host.indexOf(':') === idx) {
        var maybePort = out.host.slice(idx + 1);
        if (/^\d+$/.test(maybePort)) {
            out.port = normalizePortValue(maybePort, out.port);
            out.host = out.host.slice(0, idx);
        }
    }
    return out;
}

function isIPv6Host(host) {
    return String(host || '').indexOf(':') !== -1;
}

// The form accepts a bare IPv6 literal, while the UI displays the canonical
// bracketed form. The backend keeps the host unbracketed and uses
// net.JoinHostPort, which produces [ipv6]:port for the actual SSH dial.
function formatHostForInput(host) {
    host = String(host || '').trim();
    if (!host || !isIPv6Host(host) || /^\[[^\]]+\]$/.test(host)) return host;
    return '[' + host + ']';
}

function formatHostPort(host, port) {
    return formatHostForInput(host) + ':' + normalizePortValue(port, 22);
}

function safeDecodeURIComponent(value) {
    value = String(value || '');
    try { return decodeURIComponent(value); } catch (e) { return value; }
}

// ==================== Build SSH Info ====================
function buildSSHInfoFromForm() {
    var at = document.querySelector('.auth-tab.active').dataset.tab;
    var hp = parseHostPortInput(document.getElementById('hostname').value, document.getElementById('port').value);
    var info = {
        hostname: hp.host,
        port: hp.port,
        username: document.getElementById('username').value.trim() || 'root',
        logintype: at === 'key' ? 1 : 0
    };
    if (at === 'password') { info.password = document.getElementById('password').value; }
    else { info.privateKey = document.getElementById('privateKey').value; info.passphrase = document.getElementById('passphrase').value; }
    var proxy = getProxyInfo();
    if (proxy.proxyHost) { info.proxyHost = proxy.proxyHost; info.proxyPort = proxy.proxyPort; info.proxyUser = proxy.proxyUser; info.proxyPass = proxy.proxyPass; }
    var trustScope = getOrCreateTrustScope();
    if (trustScope) info.trustScope = trustScope;
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

function buildSSHInfoDirect(host, port, user, pass) {
    var hp = parseHostPortInput(host, port);
    var info = { hostname: hp.host, port: hp.port, username: user || 'root', logintype: 0, password: pass || '' };
    var proxy = getProxyInfo();
    if (proxy.proxyHost) { info.proxyHost = proxy.proxyHost; info.proxyPort = proxy.proxyPort; info.proxyUser = proxy.proxyUser; info.proxyPass = proxy.proxyPass; }
    var trustScope = getOrCreateTrustScope();
    if (trustScope) info.trustScope = trustScope;
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

function stripAnsiText(s) {
    return String(s || '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ').trim();
}

function isPasswordAuthFailure(msg, session) {
    if (session && session.authType === 'key') return false;
    var t = stripAnsiText(msg).toLowerCase();
    if (!t) return false;
    var authLike = t.indexOf('unable to authenticate') >= 0 ||
        t.indexOf('permission denied') >= 0 ||
        t.indexOf('authentication failed') >= 0 ||
        t.indexOf('auth fail') >= 0 ||
        t.indexOf('no supported methods remain') >= 0;
    var passwordLike = t.indexOf('password') >= 0 ||
        t.indexOf('keyboard-interactive') >= 0 ||
        t.indexOf('authenticate') >= 0 ||
        t.indexOf('permission denied') >= 0;
    return authLike && passwordLike;
}

function isSSHPreConnectFailure(msg) {
    var t = stripAnsiText(msg).toLowerCase();
    if (!t) return false;
    return t.indexOf('ssh info parse error') >= 0 ||
        t.indexOf('failed to parse private key') >= 0 ||
        t.indexOf('failed to ssh handshake') >= 0 ||
        t.indexOf('ssh: handshake failed') >= 0 ||
        t.indexOf('failed to connect via proxy') >= 0 ||
        t.indexOf('failed to create socks5 proxy') >= 0 ||
        t.indexOf('socks5 proxy does not support') >= 0 ||
        t.indexOf('host key verification failed') >= 0 ||
        t.indexOf('invalid webssh_host_key_policy') >= 0 ||
        t.indexOf('terminal initialization failed') >= 0 ||
        t.indexOf('connection refused') >= 0 ||
        t.indexOf('i/o timeout') >= 0 ||
        t.indexOf('no route to host') >= 0 ||
        t.indexOf('network is unreachable') >= 0 ||
        t.indexOf('connection timed out') >= 0 ||
        t.indexOf('connect:') >= 0;
}

// ==================== Terminal Size Sync ====================
// 终端尺寸必须同时更新前端 xterm 和远端 pty。只调 fit() 而不通知远端，
// readline 会按旧宽度计算换行和光标回退，长命令的回显就会互相覆盖、叠在同一行。
var _termFontReady = null;

function whenTerminalFontReady(cb) {
    if (!document.fonts || typeof document.fonts.load !== 'function') { cb(); return; }
    if (!_termFontReady) {
        var loading = Promise.all([
            document.fonts.load('400 15px "WebSSH JetBrains Mono"'),
            document.fonts.load('700 15px "WebSSH JetBrains Mono"'),
            document.fonts.ready
        ]).catch(function () { });
        // 字体请求异常时不能一直等，超时后按当前可用字体继续。
        _termFontReady = Promise.race([loading, new Promise(function (r) { setTimeout(r, 1500); })]);
    }
    _termFontReady.then(cb, cb);
}

function syncTermSize(session, force) {
    if (!session || !session.term || !session.fitAddon) return;
    try { session.fitAddon.fit(); } catch (e) { return; }
    var rows = session.term.rows, cols = session.term.cols;
    if (!(rows > 0) || !(cols > 0)) return;
    var ws = session.ws;
    if (!ws || ws.readyState !== 1) return;
    var size = rows + ':' + cols;
    if (!force && session._lastSentSize === size) return;
    session._lastSentSize = size;
    try { ws.send('resize:' + size); } catch (e) { session._lastSentSize = null; }
}

function scheduleTermSizeSync(session, delay) {
    if (!session) return;
    if (session._sizeSyncTimer) clearTimeout(session._sizeSyncTimer);
    session._sizeSyncTimer = setTimeout(function () {
        session._sizeSyncTimer = null;
        syncTermSize(session);
    }, typeof delay === 'number' ? delay : 60);
}

// ==================== Multi-Tab Session Management ====================
// ==================== Terminal IO ====================
// 键盘输入走二进制帧，控制指令（ping / resize:）走文本帧。两者都塞进文本帧时，
// 只要发出去的内容正好是 "ping" 或以 "resize:" 开头，就会被后端当成控制指令吞掉。
var _termEncoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

function sendTerminalInput(session, data) {
    var ws = session && session.ws;
    if (!ws || ws.readyState !== 1 || !data) return false;
    try {
        ws.send(_termEncoder ? _termEncoder.encode(data) : data);
        return true;
    } catch (e) { return false; }
}

// 把一条命令交给远端 shell 执行。多行命令必须用 bracketed paste 包住：
// 否则每个换行都会被 readline 立刻当成一条命令送去执行，中间任意一行启动了
// 交互式程序（vim、top、ssh…），后面的行就会变成那个程序的输入。
function sendCommandToSession(session, cmd) {
    if (!session || typeof cmd !== 'string') return false;
    var normalized = cmd.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    if (!normalized) return false;
    if (normalized.indexOf('\n') < 0) return sendTerminalInput(session, normalized + '\n');
    var bracketed = !!(session.term && session.term.modes && session.term.modes.bracketedPasteMode);
    if (bracketed) return sendTerminalInput(session, '\x1b[200~' + normalized + '\x1b[201~\r');
    return sendTerminalInput(session, normalized + '\n');
}

function commandLineCount(cmd) {
    if (typeof cmd !== 'string') return 0;
    var normalized = cmd.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return normalized ? normalized.split('\n').length : 0;
}

function createSession(hostname, port, username, sshInfo, opts) {
    opts = opts || {};
    var id = Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    var termDiv = document.createElement('div');
    termDiv.className = 'term-instance';
    termDiv.id = 'term_' + id;
    document.getElementById('terminalContainer').appendChild(termDiv);

    var savedFont = getCurrentFontSize();
    var termTheme = buildTerminalTheme(getSavedColors());
    var t = new Terminal({
        cursorBlink: true, cursorStyle: 'bar',
        fontSize: savedFont,
        fontFamily: "'WebSSH JetBrains Mono','JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace",
        theme: termTheme,
        allowTransparency: true, scrollback: 10000
    });
    var fa = new FitAddon.FitAddon();
    t.loadAddon(fa);
    t.loadAddon(new WebLinksAddon.WebLinksAddon());
    t.open(termDiv);

    var session = {
        id: id, hostname: hostname, port: port, username: username,
        sshInfo: sshInfo, ws: null, term: t, fitAddon: fa, termDiv: termDiv,
        heartbeat: null, sysInfoTimer: null, sysInfoStartTimer: null, resizeObs: null,
        _sysInfoGeneration: 0, _sysInfoController: null, _sysInfoFetchPromise: null,
        authType: opts.authType || 'password',
        authRetry: null,
        hostKeyMismatch: null,
        hostKeyDecision: '',
        _connected: false,
        _connectGeneration: 0,
        _dataDisposable: null,
        _selectionDisposable: null,
        _lastSentSize: null,
        _sizeSyncTimer: null,
        sftpPath: '/',
        _sftpListGeneration: 0,
        _sftpListController: null,
        sftpDirPickerPath: '/',
        _sftpDirGeneration: 0,
        _sftpDirController: null,
        _sftpRemoteController: null,
        _sftpDeleteController: null,
        _sftpUploadControllers: [],
        _sftpUploads: [],
        _sftpUploadRefreshTimer: null,
        _sftpDownloads: [],
        _remoteEditorControllers: []
    };

    session.resizeObs = new ResizeObserver(function () { scheduleTermSizeSync(session); });
    session.resizeObs.observe(termDiv);

    sessions.push(session);

    // 字体是 font-display:swap 异步加载的，换上后字符宽度会变，
    // 但容器尺寸不变、ResizeObserver 不会触发，必须主动重算一次列数。
    whenTerminalFontReady(function () {
        if (sessions.indexOf(session) === -1) return;
        syncTermSize(session, true);
    });

    return session;
}

function switchTab(idx, userActivated) {
    if (idx < 0 || idx >= sessions.length) return;
    var prevIdx = activeIdx;
    var previousSession = prevIdx >= 0 ? sessions[prevIdx] : null;
    if (previousSession && previousSession !== sessions[idx]) cancelSessionSftpBrowsing(previousSession);
    if (sftpRemoteSessionId && (!sessions[idx] || sessions[idx].id !== sftpRemoteSessionId)) hideSftpRemoteModal();
    if (sftpDirPickerSessionId && (!sessions[idx] || sessions[idx].id !== sftpDirPickerSessionId)) hideSftpDirPicker();
    activeIdx = idx;
    syncRemoteEditorVisibility();
    sessions.forEach(function (s, i) {
        if (i === idx) { s.termDiv.classList.add('active'); }
        else { s.termDiv.classList.remove('active'); stopTopbarMetricsPolling(s); }
    });
    renderTabs();
    var s = sessions[idx];
    setTimeout(function () { syncTermSize(s); try { s.term.focus(); } catch (e) { } }, 100);
    updateMetricsForActive();
    if (s._connected && (prevIdx !== idx || (!s.sysInfoTimer && !s.sysInfoStartTimer))) startTopbarMetricsPolling(s);
    updateFontSizeLabel();
    if ((prevIdx !== idx || userActivated) && s.authRetry) s.authRetry.dismissed = false;
    updateSSHAuthRetryModalForActive();
    if ((prevIdx !== idx || userActivated) && s.hostKeyMismatch) s.hostKeyMismatch.dismissed = false;
    updateHostKeyMismatchModalForActive();
    var sftpPanel = document.getElementById('sftpPanel');
    if (sftpPanel && sftpPanel.classList.contains('open')) sftpLoad(s.sftpPath || '/', s);
    renderSftpTransfers(s);
}

function renderTabs() {
    var bar = document.getElementById('tabBar');
    var addBtn = '<button class="tab-add-btn" onclick="event.stopPropagation();showAddTab()" title="新建连接">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>';
    bar.innerHTML = sessions.map(function (s, i) {
        var cls = i === activeIdx ? 'ssh-tab active' : 'ssh-tab';
        return '<div class="' + cls + '" onclick="switchTab(' + i + ',true)">' +
            '<span class="tab-main"><span class="tab-ip" ondblclick="event.stopPropagation();copyIP(sessions[' + i + '].hostname)" title="单击切换标签，双击复制 IP">' + esc(formatHostForInput(s.hostname)) + '</span>' +
            '<button class="tab-info" onclick="event.stopPropagation();openServerInfoModal(' + i + ')" title="服务器详情">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="10" x2="12" y2="16"/><circle cx="12" cy="7" r="1"/></svg></button></span>' +
            '<button class="tab-close" onclick="event.stopPropagation();closeTab(' + i + ')">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
    }).join('') + addBtn;
    keepActiveTabVisible();
}

function keepActiveTabVisible() {
    var bar = document.getElementById('tabBar');
    if (!bar) return;
    function align() {
        var active = bar.querySelector('.ssh-tab.active');
        if (!active) return;
        var isColumn = getComputedStyle(bar).flexDirection === 'column';
        if (isColumn) {
            active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            return;
        }
        if (activeIdx === sessions.length - 1) {
            var addBtn = bar.querySelector('.tab-add-btn');
            if (addBtn) addBtn.scrollIntoView({ block: 'nearest', inline: 'end' });
            bar.scrollLeft = Math.max(0, bar.scrollWidth - bar.clientWidth);
        } else {
            active.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    requestAnimationFrame(function () {
        align();
        setTimeout(align, 40);
        setTimeout(align, 140);
    });
}

function isTopbarMetricsEnabled() {
    try { return safeStorageGet(TOPBAR_METRICS_KEY) === 'true'; } catch (e) { return false; }
}

function setTopbarMetricsVisible(show) {
    var el = document.getElementById('topbarMetrics');
    if (!el) return;
    el.classList.toggle('show', !!show);
    if (!show) el.innerHTML = '';
}

function stopTopbarMetricsPolling(session) {
    if (!session) return;
    if (session.sysInfoTimer) {
        clearInterval(session.sysInfoTimer);
        session.sysInfoTimer = null;
    }
    if (session.sysInfoStartTimer) {
        clearTimeout(session.sysInfoStartTimer);
        session.sysInfoStartTimer = null;
    }
    session._sysInfoGeneration = (session._sysInfoGeneration || 0) + 1;
    abortSessionController(session, '_sysInfoController');
}

function startTopbarMetricsPolling(session) {
    stopTopbarMetricsPolling(session);
    if (!session || !isTopbarMetricsEnabled() || !session._connected || sessions[activeIdx] !== session) return;
    // Do not open a second SSH connection while the terminal is still
    // receiving its first prompt. This is only for the optional metrics UI;
    // the terminal WebSocket remains completely independent.
    session.sysInfoStartTimer = setTimeout(function () {
        session.sysInfoStartTimer = null;
        if (session._connected && session.ws && session.ws.readyState === 1 && isTopbarMetricsEnabled() && sessions[activeIdx] === session) {
            fetchSysInfoFor(session);
        }
    }, 1500);
    session.sysInfoTimer = setInterval(function () {
        if (session._connected && session.ws && session.ws.readyState === 1 && isTopbarMetricsEnabled() && sessions[activeIdx] === session) {
            fetchSysInfoFor(session);
        }
    }, getSysInterval() * 1000);
}

function updateMetricsForActive() {
    var el = document.getElementById('topbarMetrics');
    if (!el) return;
    el.innerHTML = '';
    if (!isTopbarMetricsEnabled()) {
        setTopbarMetricsVisible(false);
        return;
    }
    if (activeIdx >= 0 && sessions[activeIdx]) {
        var s = sessions[activeIdx];
        if (s._lastMetrics) renderMetrics(s._lastMetrics);
        else setTopbarMetricsVisible(false);
    } else {
        setTopbarMetricsVisible(false);
    }
}

// ==================== Connect ====================
function decodeSSHInfoPayload(sshInfo) {
    return JSON.parse(decodeURIComponent(escape(atob(sshInfo))));
}

function encodeSSHInfoPayload(info) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

function setHostKeyDecision(session, action, fingerprint) {
    try {
        var info = decodeSSHInfoPayload(session.sshInfo);
        info.hostKeyAction = action;
        info.hostKeyFingerprint = fingerprint;
        session.sshInfo = encodeSSHInfoPayload(info);
        session.hostKeyDecision = action;
        return true;
    } catch (e) {
        return false;
    }
}

function clearHostKeyDecision(session) {
    if (!session || !session.sshInfo) return;
    try {
        var info = decodeSSHInfoPayload(session.sshInfo);
        delete info.hostKeyAction;
        delete info.hostKeyFingerprint;
        session.sshInfo = encodeSSHInfoPayload(info);
    } catch (e) { }
    session.hostKeyDecision = '';
}

function getActiveHostKeyMismatchSession() {
    return activeIdx >= 0 && sessions[activeIdx] ? sessions[activeIdx] : null;
}

function formatHostKeyInfo(info) {
    info = info || {};
    return (info.algorithm || 'unknown') + ' · ' + (info.fingerprint || 'unknown');
}

function showHostKeyMismatchModal(session) {
    if (!session || !session.hostKeyMismatch) return;
    var modal = document.getElementById('hostKeyMismatchModal');
    if (!modal) return;
    var data = session.hostKeyMismatch.data || {};
    var host = data.host || session.hostname || '';
    var port = data.port || session.port || 22;
    var target = document.getElementById('hostKeyTarget');
    var presented = document.getElementById('hostKeyPresented');
    var expected = document.getElementById('hostKeyExpected');
    var reason = document.getElementById('hostKeyMismatchReason');
    if (target) target.textContent = formatHostPort(host, port);
    if (presented) presented.textContent = formatHostKeyInfo(data.presented);
    if (expected) {
        var keys = Array.isArray(data.expected) ? data.expected : [];
        expected.innerHTML = keys.length
            ? keys.map(function (item) { return '<li>' + esc(formatHostKeyInfo(item)) + '</li>'; }).join('')
            : '<li>没有可用的旧指纹</li>';
    }
    if (reason) reason.textContent = data.reason || '服务器可能重装过，也可能存在中间人攻击。请先通过可信渠道核对新指纹。';
    modal.classList.add('show');
}

function hideHostKeyMismatchModal(dismiss) {
    var modal = document.getElementById('hostKeyMismatchModal');
    if (modal) modal.classList.remove('show');
    if (dismiss) {
        var session = getActiveHostKeyMismatchSession();
        if (session && session.hostKeyMismatch) session.hostKeyMismatch.dismissed = true;
    }
}

function updateHostKeyMismatchModalForActive() {
    var session = getActiveHostKeyMismatchSession();
    if (session && session.hostKeyMismatch && !session.hostKeyMismatch.dismissed) {
        showHostKeyMismatchModal(session);
        return;
    }
    hideHostKeyMismatchModal(false);
}

function handleHostKeyMismatch(session, message) {
    session.hostKeyMismatch = { data: message, dismissed: false, ts: Date.now() };
    showToast(session.hostname + ' 主机指纹已变化，请确认', 'error');
    if (sessions[activeIdx] === session) updateHostKeyMismatchModalForActive();
}

function submitHostKeyDecision(action) {
    var session = getActiveHostKeyMismatchSession();
    if (!session || !session.hostKeyMismatch || !session.hostKeyMismatch.data) return;
    var data = session.hostKeyMismatch.data;
    var fingerprint = data.presented && data.presented.fingerprint;
    if (!fingerprint || !setHostKeyDecision(session, action, fingerprint)) {
        showToast('无法准备主机指纹确认，请重新连接', 'error');
        return;
    }
    session.hostKeyMismatch = null;
    invalidateSessionConnection(session);
    if (session.ws && (session.ws.readyState === 0 || session.ws.readyState === 1)) {
        try { session.ws.close(); } catch (e) { }
    }
    session._connected = false;
    hideHostKeyMismatchModal(false);
    showToast(action === 'replace' ? '正在更新指纹并重新连接...' : '正在仅信任本次连接...', 'info');
    startSessionConnection(session);
}

function parseTerminalControlMessage(data) {
    if (typeof data !== 'string' || data.indexOf(TERMINAL_CONTROL_PREFIX) !== 0) return null;
    try {
        return JSON.parse(data.slice(TERMINAL_CONTROL_PREFIX.length));
    } catch (e) {
        return null;
    }
}

function getActiveSSHAuthRetrySession() {
    return activeIdx >= 0 && sessions[activeIdx] ? sessions[activeIdx] : null;
}

function setSSHAuthRetryError(text) {
    var el = document.getElementById('sshAuthRetryError');
    if (!el) return;
    if (text) {
        el.textContent = text;
        el.classList.add('show');
    } else {
        el.textContent = '';
        el.classList.remove('show');
    }
}

function showSSHAuthRetryModal(session) {
    if (!session || !session.authRetry) return;
    var modal = document.getElementById('sshAuthRetryModal');
    if (!modal) return;
    document.getElementById('retryHost').value = formatHostForInput(session.hostname || '');
    document.getElementById('retryPort').value = session.port || 22;
    document.getElementById('retryUser').value = session.username || 'root';
    document.getElementById('retryPass').value = '';
    var hint = document.getElementById('sshAuthRetryHint');
    if (hint) hint.textContent = '密码认证失败，请检查并修改 ' + (session.username || 'root') + '@' + formatHostPort(session.hostname || '-', session.port || 22) + ' 的登录信息。';
    setSSHAuthRetryError(session.authRetry.error || '请修改正确的密码后重新连接。');
    modal.classList.add('show');
    setTimeout(function () {
        var pass = document.getElementById('retryPass');
        if (pass) pass.focus();
    }, 60);
}

function hideSSHAuthRetryModal(dismiss) {
    var modal = document.getElementById('sshAuthRetryModal');
    if (modal) modal.classList.remove('show');
    setSSHAuthRetryError('');
    if (dismiss) {
        var s = getActiveSSHAuthRetrySession();
        if (s && s.authRetry) s.authRetry.dismissed = true;
    }
}

function updateSSHAuthRetryModalForActive() {
    var s = getActiveSSHAuthRetrySession();
    if (s && s.authRetry && !s.authRetry.dismissed) {
        showSSHAuthRetryModal(s);
        return;
    }
    hideSSHAuthRetryModal(false);
}

function handleSSHAuthFailure(session, rawMessage) {
    var msg = stripAnsiText(rawMessage) || '密码认证失败';
    session.authRetry = { error: msg, dismissed: false, ts: Date.now() };
    showToast(session.hostname + ' 密码认证失败，请修改密码', 'error');
    if (sessions[activeIdx] === session) updateSSHAuthRetryModalForActive();
}

function submitSSHAuthRetry() {
    var s = getActiveSSHAuthRetrySession();
    if (!s) return;
    var hp = parseHostPortInput(document.getElementById('retryHost').value, document.getElementById('retryPort').value);
    var host = hp.host;
    var port = hp.port;
    var user = document.getElementById('retryUser').value.trim() || 'root';
    var pass = document.getElementById('retryPass').value;
    if (!host) { setSSHAuthRetryError('请填写主机地址。'); return; }
    if (!pass) { setSSHAuthRetryError('请输入正确的密码。'); return; }
    document.getElementById('retryHost').value = formatHostForInput(host);
    document.getElementById('retryPort').value = port;
    invalidateSessionConnection(s);
    if (s.ws && (s.ws.readyState === 0 || s.ws.readyState === 1)) {
        try { s.ws.close(); } catch (e) { }
    }
    s.hostname = host;
    s.port = port;
    s.username = user;
    s.authType = 'password';
    try {
        var retryInfo = decodeSSHInfoPayload(s.sshInfo);
        retryInfo.hostname = host;
        retryInfo.port = port;
        retryInfo.username = user;
        retryInfo.logintype = 0;
        retryInfo.password = pass;
        delete retryInfo.privateKey;
        delete retryInfo.passphrase;
        delete retryInfo.hostKeyAction;
        delete retryInfo.hostKeyFingerprint;
        s.sshInfo = encodeSSHInfoPayload(retryInfo);
    } catch (e) {
        s.sshInfo = buildSSHInfoDirect(host, port, user, pass);
    }
    s.authRetry = null;
    s.hostKeyMismatch = null;
    s.hostKeyDecision = '';
    s._connected = false;
    hideSSHAuthRetryModal(false);
    renderTabs();
    showToast('正在重新连接 ' + host + '...', 'info');
    startSessionConnection(s);
}

function startSessionConnection(session, afterStart) {
    if (!ensureGatewayAccount()) {
        return false;
    }
    var start = function () {
        try { session.fitAddon.fit(); } catch (e) { }
        session._lastSentSize = null;
        connectSession(session);
        if (typeof afterStart === 'function') afterStart();
    };
    // 不等字体加载完就建连：字体换上后 createSession 里的回调会补一次 resize，
    // 连接成功时还会强制同步一次，没必要为了量宽度推迟连接、让按钮一直转圈。
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') requestAnimationFrame(start);
    else setTimeout(start, 0);
    return true;
}

function buildTerminalWebSocketURL(cols, rows, sameOriginOnly) {
    var fallbackProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var fallback = fallbackProto + '//' + location.host + '/term';
    var configured = !sameOriginOnly && typeof window.__WEBSSH_TERMINAL_WS_URL__ === 'string'
        ? window.__WEBSSH_TERMINAL_WS_URL__.trim()
        : '';
    try {
        var wsUrl = new URL(configured || fallback, location.href);
        if (wsUrl.protocol !== 'ws:' && wsUrl.protocol !== 'wss:') throw new Error('invalid WebSocket protocol');
        wsUrl.searchParams.set('cols', String(cols));
        wsUrl.searchParams.set('rows', String(rows));
        return wsUrl.toString();
    } catch (e) {
        return fallback + '?cols=' + encodeURIComponent(cols) + '&rows=' + encodeURIComponent(rows);
    }
}

var terminalEndpointWarmStarted = false;
function warmTerminalEndpoint() {
    if (terminalEndpointWarmStarted || typeof fetch !== 'function') return;
    var configured = typeof window.__WEBSSH_TERMINAL_WS_URL__ === 'string'
        ? window.__WEBSSH_TERMINAL_WS_URL__.trim()
        : '';
    if (!configured) return;
    var endpoint;
    try {
        endpoint = new URL(configured, location.href);
        if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:') return;
        endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
        endpoint.pathname = '/healthz';
        endpoint.search = '';
        endpoint.hash = '';
    } catch (e) {
        return;
    }
    terminalEndpointWarmStarted = true;
    // A tiny, anonymous request warms DNS/TCP/TLS for the direct WebSocket
    // endpoint without blocking the login flow. Failure is intentionally silent.
    fetch(endpoint.toString(), {
        method: 'GET',
        mode: 'no-cors',
        credentials: 'omit',
        cache: 'no-store',
        priority: 'low'
    }).catch(function () {});
}

function invalidateSessionConnection(session) {
    if (!session) return;
    session._connectGeneration = (session._connectGeneration || 0) + 1;
    stopServerInfoNetStream(session);
    stopTopbarMetricsPolling(session);
}

function connectSession(session) {
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
    stopTopbarMetricsPolling(session);
    if (session._resizeHandler) {
        removeEventListener('resize', session._resizeHandler);
        session._resizeHandler = null;
    }
    if (session._sizeSyncTimer) { clearTimeout(session._sizeSyncTimer); session._sizeSyncTimer = null; }
    session._lastSentSize = null;
    if (session._dataDisposable && typeof session._dataDisposable.dispose === 'function') {
        try { session._dataDisposable.dispose(); } catch (e) { }
        session._dataDisposable = null;
    }
    if (session._selectionDisposable && typeof session._selectionDisposable.dispose === 'function') {
        try { session._selectionDisposable.dispose(); } catch (e) { }
        session._selectionDisposable = null;
    }
    // 容器还没布局完时 fit() 可能量不出尺寸，兜底成和后端一致的默认值，
    // 避免把 0 或 NaN 当作列数带进 pty。
    var cols = session.term.cols > 0 ? session.term.cols : 150;
    var rows = session.term.rows > 0 ? session.term.rows : 35;
    var directWsUrl = buildTerminalWebSocketURL(cols, rows, false);
    var fallbackWsUrl = buildTerminalWebSocketURL(cols, rows, true);
    var canFallback = directWsUrl !== fallbackWsUrl;
    var connectionGeneration = (session._connectGeneration || 0) + 1;
    session._connectGeneration = connectionGeneration;
    session._connected = false;
    var failedBeforeConnect = false;

    function isCurrentConnection() {
        return session._connectGeneration === connectionGeneration && sessions.indexOf(session) !== -1;
    }

    function openSocket(wsUrl, isFallback) {
        var ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (e) {
            if (!isFallback && canFallback) {
                showToast('终端专用直连地址不可用，正在改用当前网站连接…', 'info');
                openSocket(fallbackWsUrl, true);
                return;
            }
            showToast(session.hostname + ' 无法连接', 'error');
            return;
        }
        ws.binaryType = 'arraybuffer';
        session.ws = ws;
        var transportTimer = !isFallback && canFallback ? setTimeout(function () {
            if (!isCurrentConnection() || session.ws !== ws || ws.readyState !== 0) return;
            try { ws.close(); } catch (e) { }
            showToast('终端专用直连地址响应超时，正在改用当前网站连接…', 'info');
            openSocket(fallbackWsUrl, true);
        }, 4000) : null;

        function markConnected() {
            if (session._connected) return;
            session._connected = true;
            // A persisted replacement can be removed from the payload as soon
            // as the terminal handshake succeeds.  A one-time decision must
            // remain available to SFTP/editor/sysinfo connections opened by
            // this live SSH tab, then be consumed when the terminal disconnects
            // or the user explicitly reconnects.
            if (session.hostKeyDecision === 'replace') clearHostKeyDecision(session);
            session.hostKeyMismatch = null;
            session.authRetry = null;
            updateSSHAuthRetryModalForActive();
            updateHostKeyMismatchModalForActive();
            showToast(session.hostname + ' 连接成功', 'success');
            setupAutoCopy(session);
            maybeShowFirstServerInfoGuide(session);
            session.heartbeat = setInterval(function () { if (ws.readyState === 1) ws.send('ping'); }, 30000);
            startTopbarMetricsPolling(session);
            if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session) {
                fetchSysInfoFor(session);
                startServerInfoNetStream(session);
            }
            syncTermSize(session, true);
            handleRemoteEditorsSessionConnected(session);
        }

        ws.onopen = function () {
            if (!isCurrentConnection() || session.ws !== ws) return;
            if (transportTimer) { clearTimeout(transportTimer); transportTimer = null; }
            ws.send(session.sshInfo);
        };

        ws.onmessage = function (e) {
            if (!isCurrentConnection() || session.ws !== ws) return;
            var isText = typeof e.data === 'string';
            var controlMessage = isText ? parseTerminalControlMessage(e.data) : null;
            if (controlMessage && controlMessage.type === 'host-key-mismatch') {
                failedBeforeConnect = true;
                handleHostKeyMismatch(session, controlMessage);
                return;
            }
            if (controlMessage && controlMessage.type === 'connection-ready') {
                markConnected();
                return;
            }
            var terminalData = isText ? e.data : new Uint8Array(e.data);
            if (!session._connected) {
                if (isText && isPasswordAuthFailure(e.data, session)) {
                    failedBeforeConnect = true;
                    session.term.write(terminalData);
                    handleSSHAuthFailure(session, e.data);
                    return;
                }
                if (isText && isSSHPreConnectFailure(e.data)) {
                    failedBeforeConnect = true;
                    session.term.write(terminalData);
                    showToast(session.hostname + ' 连接失败：' + stripAnsiText(e.data), 'error');
                    return;
                }
                markConnected();
            }
            session.term.write(terminalData);
        };

        // Wait for close before showing an error so a temporarily unavailable
        // direct endpoint can fall back to the page's same-origin WebSocket.
        ws.onerror = function () {};
        ws.onclose = function () {
            if (transportTimer) { clearTimeout(transportTimer); transportTimer = null; }
            if (!isCurrentConnection() || session.ws !== ws) return;
            if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
            stopTopbarMetricsPolling(session);
            if (!session._connected && !failedBeforeConnect && !isFallback && canFallback) {
                showToast('终端专用直连地址不可用，正在改用当前网站连接…', 'info');
                openSocket(fallbackWsUrl, true);
                return;
            }
            var wasConnected = session._connected;
            session._connected = false;
            session.ws = null;
            if (wasConnected && session.hostKeyDecision) clearHostKeyDecision(session);
            stopServerInfoNetStream(session);
            cancelSessionSftpRequests(session, false);
            handleRemoteEditorsSessionDisconnected(session);
            if (wasConnected && sessions.indexOf(session) !== -1) {
                showToast(session.hostname + ' 连接已关闭', 'info');
                var sftpPanel = document.getElementById('sftpPanel');
                if (sessions[activeIdx] === session && sftpPanel && sftpPanel.classList.contains('open')) {
                    document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">SSH 连接已关闭</div>';
                }
            }
            if (!wasConnected && !failedBeforeConnect) showToast(session.hostname + ' 无法连接', 'error');
        };
    }

    openSocket(directWsUrl, false);

    session._dataDisposable = session.term.onData(function (data) {
        sendTerminalInput(session, data);
    });

    var resizeHandler = function () { scheduleTermSizeSync(session); };
    addEventListener('resize', resizeHandler);
    session._resizeHandler = resizeHandler;
}

function connectFromLogin() {
    if (!ensureGatewayAccount()) return;
    var btn = document.getElementById('connectBtn');
    btn.classList.add('loading');
    setStatus('connecting', '连接中...');

    var sshInfo = buildSSHInfoFromForm();
    var authType = document.querySelector('.auth-tab.active').dataset.tab;
    var hp = parseHostPortInput(document.getElementById('hostname').value, document.getElementById('port').value);
    var h = hp.host;
    var p = hp.port;
    var u = document.getElementById('username').value.trim() || 'root';
    document.getElementById('hostname').value = formatHostForInput(h);
    document.getElementById('port').value = p;

    var session = createSession(h, p, u, sshInfo, { authType: authType });
    showView('terminalView');
    switchTab(sessions.length - 1);

    startSessionConnection(session, function () {
        btn.classList.remove('loading');
        setStatus('', '就绪');
        renderScriptBookmarks();
    });
}

function maybeShowFirstServerInfoGuide(session) {
    try {
        if (safeStorageGet(FIRST_SSH_SUCCESS_KEY)) return;
        safeStorageSet(FIRST_SSH_SUCCESS_KEY, String(Date.now()));
    } catch (e) {
        return;
    }
    setTimeout(function () {
        var btn = document.querySelector('.ssh-tab.active .tab-info');
        if (!btn) {
            showToast('连接成功：点击标签旁的 ⓘ 可查看服务器详情', 'info');
            return;
        }
        if (serverInfoGuideTimer) {
            clearTimeout(serverInfoGuideTimer);
            serverInfoGuideTimer = null;
        }
        var old = document.querySelector('.server-info-guide');
        if (old) old.remove();
        btn.classList.add('guide-pulse');
        var box = document.createElement('div');
        box.className = 'server-info-guide';
        box.innerHTML = '<b>服务器详情入口</b><span>点击这里可以查看 CPU、内存、磁盘和网络实时曲线。</span>';
        document.body.appendChild(box);
        function placeGuide() {
            if (!document.body.contains(box) || !document.body.contains(btn)) return;
            var r = btn.getBoundingClientRect();
            var left = Math.min(window.innerWidth - box.offsetWidth - 12, Math.max(12, r.left + r.width / 2 - box.offsetWidth / 2));
            var top = Math.min(window.innerHeight - box.offsetHeight - 12, r.bottom + 12);
            box.style.left = left + 'px';
            box.style.top = top + 'px';
        }
        requestAnimationFrame(placeGuide);
        setTimeout(placeGuide, 80);
        serverInfoGuideTimer = setTimeout(function () {
            btn.classList.remove('guide-pulse');
            if (box.parentNode) box.remove();
            serverInfoGuideTimer = null;
        }, 7200);
    }, 520);
}

// ==================== Tab Actions ====================
function closeTab(idx) {
    if (idx < 0 || idx >= sessions.length) return;
    var requestedSession = sessions[idx];
    if (!arguments[1] && requestCloseRemoteEditorsForSession(requestedSession, function () {
        var currentIndex = sessions.indexOf(requestedSession);
        if (currentIndex >= 0) closeTab(currentIndex, true);
    })) return;
    var activeSession = activeIdx >= 0 ? sessions[activeIdx] : null;
    if (serverInfoModalIdx === idx) hideServerInfoModal();
    var s = sessions[idx];
    closeRemoteEditorsForSession(s, true);
    if (sftpRemoteSessionId === s.id) hideSftpRemoteModal();
    if (sftpDirPickerSessionId === s.id) hideSftpDirPicker();
    cancelSessionSftpRequests(s, true);
    invalidateSessionConnection(s);
    if (s.ws) s.ws.close();
    if (s.heartbeat) clearInterval(s.heartbeat);
    stopTopbarMetricsPolling(s);
    if (s.resizeObs) s.resizeObs.disconnect();
    if (s._resizeHandler) removeEventListener('resize', s._resizeHandler);
    if (s._sizeSyncTimer) { clearTimeout(s._sizeSyncTimer); s._sizeSyncTimer = null; }
    if (s._dataDisposable && typeof s._dataDisposable.dispose === 'function') { try { s._dataDisposable.dispose(); } catch (e) { } }
    if (s._selectionDisposable && typeof s._selectionDisposable.dispose === 'function') { try { s._selectionDisposable.dispose(); } catch (e) { } }
    if (s.term) s.term.dispose();
    if (s.termDiv) s.termDiv.remove();
    sessions.splice(idx, 1);

    if (sessions.length === 0) {
        activeIdx = -1;
        document.getElementById('scriptDrawer').classList.remove('open');
        document.getElementById('sftpPanel').classList.remove('open');
        showView('loginView');
        setStatus('', '就绪');
        showToast('已断开', 'info');
    } else {
        if (serverInfoModalIdx > idx) serverInfoModalIdx--;
        if (activeSession && activeSession !== s) {
            activeIdx = sessions.indexOf(activeSession);
            if (activeIdx < 0) activeIdx = Math.min(idx, sessions.length - 1);
        } else {
            activeIdx = Math.min(idx, sessions.length - 1);
        }
        switchTab(activeIdx);
    }
    renderTabs();
}

function closeActiveTab() { if (activeIdx >= 0) closeTab(activeIdx); }

function reconnectTab() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var s = sessions[activeIdx];
    if (sftpRemoteSessionId === s.id) hideSftpRemoteModal();
    if (sftpDirPickerSessionId === s.id) hideSftpDirPicker();
    if (s.hostKeyDecision) clearHostKeyDecision(s);
    cancelSessionSftpRequests(s, false);
    invalidateSessionConnection(s);
    handleRemoteEditorsSessionDisconnected(s);
    if (s.ws) s.ws.close();
    if (s.heartbeat) { clearInterval(s.heartbeat); s.heartbeat = null; }
    stopTopbarMetricsPolling(s);
    showToast('重新连接 ' + s.hostname + '...', 'info');
    startSessionConnection(s);
}

function showAddTab() { document.getElementById('addTabModal').classList.add('show'); document.getElementById('newTabHost').focus(); }
function hideAddTab() { document.getElementById('addTabModal').classList.remove('show'); }

function addNewTab() {
    if (!ensureGatewayAccount()) return;
    var hp = parseHostPortInput(document.getElementById('newTabHost').value, document.getElementById('newTabPort').value);
    var h = hp.host;
    var p = hp.port;
    var u = document.getElementById('newTabUser').value.trim() || 'root';
    var pw = document.getElementById('newTabPass').value;
    if (!h) { showToast('请输入主机地址', 'error'); return; }
    document.getElementById('newTabHost').value = formatHostForInput(h);
    document.getElementById('newTabPort').value = p;
    var sshInfo = buildSSHInfoDirect(h, p, u, pw);
    var session = createSession(h, p, u, sshInfo, { authType: 'password' });
    switchTab(sessions.length - 1);
    hideAddTab();
    startSessionConnection(session);
}

// ==================== System Info ====================
function fetchSysInfoFor(session) {
    if (!session.sshInfo || !session._connected || sessions.indexOf(session) === -1) return;
    if (session._sysInfoFetchPromise) return session._sysInfoFetchPromise;
    var requestGeneration = (session._sysInfoGeneration || 0) + 1;
    session._sysInfoGeneration = requestGeneration;
    var connectionGeneration = session._connectGeneration;
    var sshInfo = session.sshInfo;
    var controller = new AbortController();
    session._sysInfoController = controller;
    var requestPromise = fetch('/sysinfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sshInfo: sshInfo }), signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (sessions.indexOf(session) === -1 || session._sysInfoGeneration !== requestGeneration || session._connectGeneration !== connectionGeneration || session.sshInfo !== sshInfo) return d;
            if (d.Msg === 'success' && d.Data) {
                if (session._lastMetrics && session._lastMetrics.updatedAt && session._serverInfoNetWanted) {
                    ['mainIface', 'rxTotal', 'txTotal', 'rxRate', 'txRate', 'interfaces', 'updatedAt'].forEach(function (key) {
                        if (session._lastMetrics[key] !== undefined) d.Data[key] = session._lastMetrics[key];
                    });
                }
                session._lastMetrics = d.Data;
                recordNetworkSample(session, d.Data);
                recordResourceSample(session, d.Data);
                if (sessions[activeIdx] === session && isTopbarMetricsEnabled()) renderMetrics(d.Data);
                if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session) renderServerInfo(d.Data, session);
            } else if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session) {
                renderServerInfoError(d && d.Msg ? d.Msg : '读取服务器信息失败');
            }
            return d;
        })
        .catch(function (err) {
            if (requestWasAborted(err) || session._sysInfoGeneration !== requestGeneration) return;
            if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session) {
                renderServerInfoError('网络请求失败，请稍后重试');
            }
        })
        .finally(function () {
            if (session._sysInfoController === controller) session._sysInfoController = null;
            if (session._sysInfoFetchPromise === requestPromise) session._sysInfoFetchPromise = null;
        });
    session._sysInfoFetchPromise = requestPromise;
    return requestPromise;
}

function mergeNetworkMetrics(session, data) {
    if (!session || !data) return null;
    if (!session._lastMetrics) return null;
    var base = session._lastMetrics;
    ['mainIface', 'rxTotal', 'txTotal', 'rxRate', 'txRate', 'interfaces', 'updatedAt'].forEach(function (key) {
        if (data[key] !== undefined) base[key] = data[key];
    });
    session._lastMetrics = base;
    return base;
}

function startServerInfoNetStream(session) {
    if (!session || !session.sshInfo || !session._connected || session._serverInfoNetWanted) return;
    session._serverInfoNetWanted = true;

    function connect() {
        if (!session._serverInfoNetWanted) return;
        if (session._serverInfoNetWs && session._serverInfoNetWs.readyState <= 1) return;
        var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        var ws = new WebSocket(proto + '//' + location.host + '/sysinfo/net');
        session._serverInfoNetWs = ws;
        ws.onopen = function () { ws.send(session.sshInfo); };
        ws.onmessage = function (evt) {
            var msg;
            try { msg = JSON.parse(evt.data); } catch (e) { return; }
            if (!msg || msg.Msg !== 'success' || !msg.Data) return;
            var merged = mergeNetworkMetrics(session, msg.Data);
            recordNetworkSample(session, msg.Data);
            if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session && merged) {
                renderServerInfo(merged, session);
            }
        };
        ws.onclose = function () {
            if (session._serverInfoNetWs === ws) session._serverInfoNetWs = null;
            if (session._serverInfoNetWanted) {
                clearTimeout(session._serverInfoNetReconnectTimer);
                session._serverInfoNetReconnectTimer = setTimeout(connect, 1500);
            }
        };
        ws.onerror = function () {
            try { ws.close(); } catch (e) { }
        };
    }

    connect();
}

function stopServerInfoNetStream(session) {
    if (!session) return;
    session._serverInfoNetWanted = false;
    clearTimeout(session._serverInfoNetReconnectTimer);
    session._serverInfoNetReconnectTimer = null;
    if (session._serverInfoNetWs) {
        try { session._serverInfoNetWs.close(); } catch (e) { }
        session._serverInfoNetWs = null;
    }
}

function fmtUptime(secs) {
    secs = parseInt(secs) || 0;
    var d = Math.floor(secs / 86400);
    var h = Math.floor((secs % 86400) / 3600);
    var m = Math.floor((secs % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
}

function renderMetrics(d) {
    if (!isTopbarMetricsEnabled()) {
        setTopbarMetricsVisible(false);
        return;
    }
    var c = document.getElementById('topbarMetrics');
    if (!c) return;
    setTopbarMetricsVisible(true);
    var mp = pct(d.memUsed, d.memTotal), dp = pct(d.diskUsed, d.diskTotal), cv = parseFloat(d.cpuUsage) || 0;
    var pills = [
        { i: 'server', l: d.os || '?' },
        { i: 'cpu', l: d.arch, v: (d.cpuCores || '?') + 'C' },
        { i: 'activity', l: 'CPU', v: cv.toFixed(0) + '%', c: pillCls(cv) },
        { i: 'memory', l: 'MEM', v: fmtB(d.memUsed) + '/' + fmtB(d.memTotal), c: pillCls(mp) },
        { i: 'hdd', l: 'DISK', v: fmtB(d.diskUsed) + '/' + fmtB(d.diskTotal), c: pillCls(dp) },
        { i: 'zap', l: 'Load', v: d.load || '0' },
        { i: 'down', l: '↓', v: fmtBps(d.rxRate) },
        { i: 'up', l: '↑', v: fmtBps(d.txRate) },
        { i: 'clock', l: 'UP', v: fmtUptime(d.uptime) }
    ];
    var sv = { server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>', cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>', activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>', hdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>', zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>', up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>', clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' };
    c.innerHTML = pills.map(function (p) {
        var cls = p.c ? ' ' + p.c : '';
        return '<div class="metric-pill' + cls + '">' + (sv[p.i] || '') + esc(p.l) + (p.v ? ' <span class="metric-value">' + esc(p.v) + '</span>' : '') + '</div>';
    }).join('');
}

function fmtBps(v) {
    return fmtB(v) + '/s';
}

function fmtBitRate(v) {
    var bits = (parseFloat(v) || 0) * 8;
    if (!bits) return '0bps';
    var u = ['bps', 'Kbps', 'Mbps', 'Gbps', 'Tbps'];
    var i = Math.min(u.length - 1, Math.floor(Math.log(bits) / Math.log(1000)));
    var n = bits / Math.pow(1000, i);
    var digits = i === 0 ? 0 : (n >= 100 ? 0 : (n >= 10 ? 1 : 2));
    return n.toFixed(digits) + u[i];
}

function fmtNetRate(v) {
    return serverInfoNetUnit === 'bits' ? fmtBitRate(v) : fmtBps(v);
}

function fmtNetRateAlt(v) {
    return serverInfoNetUnit === 'bits' ? fmtBps(v) : fmtBitRate(v);
}

function changeServerNetUnit(unit) {
    serverInfoNetUnit = unit === 'bits' ? 'bits' : 'bytes';
    try { safeStorageSet(NET_UNIT_KEY, serverInfoNetUnit); } catch (e) { }
    var s = sessions[serverInfoModalIdx];
    if (s && s._lastMetrics) renderServerInfo(s._lastMetrics, s);
}

function recordNetworkSample(session, d) {
    if (!session || !d) return;
    var now = Date.now();
    var ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
    if (!session._netHistory) session._netHistory = {};
    function push(name, rx, tx) {
        name = name || '__main__';
        if (!session._netHistory[name]) session._netHistory[name] = [];
        session._netHistory[name].push({ t: now, rx: Math.max(0, parseFloat(rx) || 0), tx: Math.max(0, parseFloat(tx) || 0) });
        if (session._netHistory[name].length > 1800) session._netHistory[name].shift();
    }
    if (ifaces.length) {
        ifaces.forEach(function (n) { push(n.name, n.rxRate, n.txRate); });
    } else {
        push(d.mainIface || '__main__', d.rxRate, d.txRate);
    }
}

function recordResourceSample(session, d) {
    if (!session || !d) return;
    var now = Date.now();
    var connTotal = (parseInt(d.tcpCount) || 0) + (parseInt(d.udpCount) || 0);
    if (!session._resourceHistory) session._resourceHistory = [];
    session._resourceHistory.push({
        t: now,
        cpu: Math.max(0, parseFloat(d.cpuUsage) || 0),
        mem: percentOf(d.memUsed, d.memTotal),
        disk: percentOf(d.diskUsed, d.diskTotal),
        conn: Math.max(0, connTotal)
    });
    if (session._resourceHistory.length > 600) session._resourceHistory.shift();
}

function getResourceHistory(session) {
    return session && Array.isArray(session._resourceHistory) ? session._resourceHistory : [];
}

function resourcePointX(idx, history, width, pad) {
    var plotW = Math.max(1, width - pad * 2);
    var maxSpan = 179;
    var offsetFromLatest = Math.max(0, history.length - 1 - idx);
    return width - pad - Math.min(1, offsetFromLatest / maxSpan) * plotW;
}

function resourceWavePath(points) {
    if (!points.length) return '';
    var ordered = points.slice().reverse();
    var d = 'M' + ordered[0].x.toFixed(1) + ' ' + ordered[0].y.toFixed(1);
    for (var i = 1; i < ordered.length; i++) {
        var prev = ordered[i - 1], cur = ordered[i];
        var midX = (prev.x + cur.x) / 2;
        d += ' C' + midX.toFixed(1) + ' ' + prev.y.toFixed(1) + ' ' + midX.toFixed(1) + ' ' + cur.y.toFixed(1) + ' ' + cur.x.toFixed(1) + ' ' + cur.y.toFixed(1);
    }
    return d;
}

function resourceSparklineHtml(session, key, fixedMax, cls) {
    var history = getResourceHistory(session).slice(-180);
    if (!history.length) return '<div class="server-summary-sparkline empty"><span>-</span></div>';
    if (history.length === 1) history = [history[0], history[0]];
    var width = 160, height = 42, pad = 4;
    var max = parseFloat(fixedMax) || 0;
    if (!max) {
        history.forEach(function (p) { max = Math.max(max, parseFloat(p[key]) || 0); });
        max = Math.max(1, max);
    }
    var points = history.map(function (p, idx) {
        var value = Math.max(0, parseFloat(p[key]) || 0);
        var x = resourcePointX(idx, history, width, pad);
        var y = height - pad - Math.min(1, value / max) * (height - pad * 2);
        return { x: x, y: y };
    });
    var path = resourceWavePath(points);
    var first = points[points.length - 1];
    var last = points[0];
    var area = path + ' L' + last.x.toFixed(1) + ' ' + (height - pad) + ' L' + first.x.toFixed(1) + ' ' + (height - pad) + ' Z';
    var hover = buildResourceHoverOverlay(history, key, max, width, height, pad);
    return '<div class="server-summary-sparkline ' + esc(cls || key) + '">' +
        '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<line class="summary-spark-base" x1="' + pad + '" y1="' + (height - pad) + '" x2="' + (width - pad) + '" y2="' + (height - pad) + '"/>' +
        '<path class="summary-spark-area" d="' + area + '"/>' +
        '<path class="summary-spark-line" d="' + path + '"/>' +
        hover +
        '</svg></div>';
}

function resourceOverviewHtml(session, items, cls) {
    return '<div class="server-resource-overview ' + esc(cls || '') + '">' + items.map(function (item) {
        return '<div class="resource-overview-tile ' + esc(item.cls || item.key || '') + '">' +
            '<div class="resource-overview-main"><span>' + esc(item.label) + '</span><b>' + esc(item.value) + '</b></div>' +
            (item.detail ? '<small>' + esc(item.detail) + '</small>' : '') +
            resourceSparklineHtml(session, item.key, item.max, item.cls) +
            '</div>';
    }).join('') + '</div>';
}

function formatResourceSparkValue(key, value) {
    value = Math.max(0, parseFloat(value) || 0);
    if (key === 'conn') return Math.round(value) + '';
    return value.toFixed(value >= 10 ? 0 : 1) + '%';
}

function buildResourceHoverOverlay(history, key, max, width, height, pad) {
    if (!history.length) return '';
    var labelMap = { cpu: 'CPU', mem: '内存', disk: '磁盘', conn: '连接' };
    return history.map(function (p, idx) {
        var value = Math.max(0, parseFloat(p[key]) || 0);
        var x = resourcePointX(idx, history, width, pad);
        var prevX = idx > 0 ? resourcePointX(idx - 1, history, width, pad) : pad;
        var nextX = idx < history.length - 1 ? resourcePointX(idx + 1, history, width, pad) : width - pad;
        var hitX = idx === 0 ? 0 : Math.min(prevX, x) + Math.abs(x - prevX) / 2;
        var hitEnd = idx === history.length - 1 ? width : (x + nextX) / 2;
        var hitW = hitEnd - hitX;
        var tipW = 74, tipH = 27;
        var tipX = Math.max(3, Math.min(width - tipW - 3, x + 6));
        var tipY = 3;
        return '<g class="chart-hover summary-hover">' +
            '<rect class="chart-hover-hit" x="' + hitX.toFixed(1) + '" y="0" width="' + Math.max(3, hitW).toFixed(1) + '" height="' + height + '"/>' +
            '<line class="chart-hover-line" x1="' + x.toFixed(1) + '" y1="' + pad + '" x2="' + x.toFixed(1) + '" y2="' + (height - pad) + '"/>' +
            '<g class="chart-hover-tip" transform="translate(' + tipX.toFixed(1) + ' ' + tipY + ')">' +
            '<rect width="' + tipW + '" height="' + tipH + '" rx="5"/>' +
            '<text x="6" y="11">' + esc(formatBeijingMinute(p.t || Date.now())) + '</text>' +
            '<text x="6" y="22">' + esc(labelMap[key] || key) + ' ' + esc(formatResourceSparkValue(key, value)) + '</text>' +
            '</g></g>';
    }).join('');
}

function getNetworkHistory(session, ifaceName) {
    if (!session || !session._netHistory) return [];
    return session._netHistory[ifaceName] || session._netHistory.__main__ || [];
}

function chartPadding(pad) {
    if (typeof pad === 'number') return { top: pad, right: pad, bottom: pad, left: pad };
    pad = pad || {};
    return {
        top: parseFloat(pad.top) || 0,
        right: parseFloat(pad.right) || 0,
        bottom: parseFloat(pad.bottom) || 0,
        left: parseFloat(pad.left) || 0
    };
}

function netPointX(item, idx, items, width, pad, domainStart, domainEnd) {
    var p = chartPadding(pad);
    var plotW = Math.max(1, width - p.left - p.right);
    if (domainEnd > domainStart && item && item.t) {
        var ratio = (item.t - domainStart) / (domainEnd - domainStart);
        ratio = Math.max(0, Math.min(1, ratio));
        return p.left + ratio * plotW;
    }
    var span = Math.max(1, items.length - 1);
    return p.left + (idx / span) * plotW;
}

function buildNetPath(items, key, max, width, height, pad, domainStart, domainEnd) {
    if (!items.length) return '';
    return items.map(function (item, idx) {
        var x = netPointX(item, idx, items, width, pad, domainStart, domainEnd);
        var y = netPointY(item, key, max, height, pad);
        return (idx ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
}

function netPointY(item, key, max, height, pad) {
    var p = chartPadding(pad);
    var plotH = Math.max(1, height - p.top - p.bottom);
    return height - p.bottom - ((parseFloat(item[key]) || 0) / max) * plotH;
}

function buildNetArea(path, items, width, height, pad, domainStart, domainEnd) {
    if (!path || !items.length) return '';
    var p = chartPadding(pad);
    var firstX = netPointX(items[0], 0, items, width, pad, domainStart, domainEnd);
    var lastX = netPointX(items[items.length - 1], items.length - 1, items, width, pad, domainStart, domainEnd);
    return path + ' L' + lastX + ' ' + (height - p.bottom) + ' L' + firstX + ' ' + (height - p.bottom) + ' Z';
}

function buildNetBars(items, max, width, height, pad, domainStart, domainEnd) {
    if (!items.length) return '';
    var p = chartPadding(pad);
    var baseY = height - p.bottom;
    var plotH = Math.max(1, height - p.top - p.bottom);
    return items.map(function (item, idx) {
        var x = netPointX(item, idx, items, width, pad, domainStart, domainEnd);
        var prevX = idx > 0 ? netPointX(items[idx - 1], idx - 1, items, width, pad, domainStart, domainEnd) : p.left;
        var nextX = idx < items.length - 1 ? netPointX(items[idx + 1], idx + 1, items, width, pad, domainStart, domainEnd) : width - p.right;
        var slotW = Math.max(3, Math.min(nextX - prevX, (width - p.left - p.right) / Math.max(1, items.length - 1)));
        var barW = Math.max(2.2, Math.min(9, slotW * 0.72));
        var halfW = Math.max(1.1, barW / 2 - 0.4);
        var rx = Math.max(0, parseFloat(item.rx) || 0);
        var tx = Math.max(0, parseFloat(item.tx) || 0);
        var rxH = Math.max(rx > 0 ? 1 : 0, (rx / max) * plotH);
        var txH = Math.max(tx > 0 ? 1 : 0, (tx / max) * plotH);
        var rxX = x - barW / 2;
        var txX = x + 0.4;
        return '<g class="net-bar-pair">' +
            (rxH ? '<rect class="net-bar rx" x="' + rxX.toFixed(1) + '" y="' + (baseY - rxH).toFixed(1) + '" width="' + halfW.toFixed(1) + '" height="' + rxH.toFixed(1) + '" rx="1.2"/>' : '') +
            (txH ? '<rect class="net-bar tx" x="' + txX.toFixed(1) + '" y="' + (baseY - txH).toFixed(1) + '" width="' + halfW.toFixed(1) + '" height="' + txH.toFixed(1) + '" rx="1.2"/>' : '') +
            '</g>';
    }).join('');
}

function buildNetLabels(items, key, max, width, height, pad, domainStart, domainEnd, cls) {
    if (!items.length) return '';
    var p = chartPadding(pad);
    var seen = {};
    var picked = [];
    function pick(idx, kind) {
        if (idx < 0 || idx >= items.length || seen[idx]) return;
        seen[idx] = true;
        picked.push({ idx: idx, kind: kind });
    }
    var maxIdx = 0, minIdx = 0;
    var maxValue = -Infinity, minValue = Infinity;
    items.forEach(function (item, idx) {
        var value = parseFloat(item[key]) || 0;
        if (value > maxValue) {
            maxValue = value;
            maxIdx = idx;
        }
        if (value < minValue) {
            minValue = value;
            minIdx = idx;
        }
    });
    pick(maxIdx, 'max');
    pick(minIdx, 'min');
    picked.sort(function (a, b) { return a.idx - b.idx; });
    return picked.map(function (marker) {
        var idx = marker.idx;
        var item = items[idx];
        var value = parseFloat(item[key]) || 0;
        var x = netPointX(item, idx, items, width, pad, domainStart, domainEnd);
        var label = (marker.kind === 'min' ? '最小 ' : '最大 ') + fmtNetRate(value);
        var baseY = netPointY(item, key, max, height, pad);
        var y = baseY + (marker.kind === 'min' ? 18 : -14) + (cls === 'rx' ? 5 : -5);
        y = Math.max(p.top + 14, Math.min(height - p.bottom - 10, y));
        var anchor = x < p.left + 44 ? 'start' : (x > width - p.right - 44 ? 'end' : 'middle');
        var labelWidth = Math.max(54, label.length * 7.2 + 12);
        var rectX = anchor === 'start' ? x - 4 : (anchor === 'end' ? x - labelWidth + 4 : x - labelWidth / 2);
        var rectY = y - 12;
        rectX = Math.max(p.left + 2, Math.min(width - labelWidth - 2, rectX));
        rectY = Math.max(2, Math.min(height - 18, rectY));
        return '<g class="net-label-wrap ' + cls + ' ' + marker.kind + '">' +
            '<rect class="net-label-bg ' + cls + '" x="' + rectX.toFixed(1) + '" y="' + rectY.toFixed(1) + '" width="' + labelWidth.toFixed(1) + '" height="16" rx="5"/>' +
            '<text class="net-label ' + cls + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" text-anchor="' + anchor + '">' + esc(label) + '</text>' +
            '</g>';
    }).join('');
}

function formatBeijingMinute(ts) {
    try {
        return new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        }).format(new Date(ts)).replace(/\s/g, '');
    } catch (e) {
        var d = new Date(ts + 8 * 60 * 60 * 1000);
        return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + ':' + String(d.getUTCSeconds()).padStart(2, '0');
    }
}

function networkDomain(history, minutes) {
    var end = history.length && history[history.length - 1].t ? history[history.length - 1].t : Date.now();
    var span = Math.max(30 * 1000, (parseFloat(minutes) || SERVER_INFO_CHART_MINUTES) * 60 * 1000);
    return { start: end - span, end: end, span: span };
}

function networkSpanText(ms) {
    if (ms >= 60 * 1000) return Math.ceil(ms / 60000) + ' 分钟';
    return Math.max(1, Math.ceil(ms / 1000)) + ' 秒';
}

function networkTimeAxisHtml(domain, pad, width) {
    var p = chartPadding(pad || 0);
    var plotLeftPct = width ? (p.left / width) * 100 : 0;
    var plotWidthPct = width ? ((width - p.left - p.right) / width) * 100 : 100;
    var ticks = [domain.start];
    var firstMinute = Math.ceil(domain.start / 60000) * 60000;
    for (var t = firstMinute; t < domain.end; t += 60000) ticks.push(t);
    ticks.push(domain.end);
    if (ticks.length > 5) {
        var step = Math.ceil((ticks.length - 1) / 4);
        var compact = ticks.filter(function (_, i) { return i === 0 || i === ticks.length - 1 || i % step === 0; });
        if (compact[compact.length - 1] !== domain.end) compact.push(domain.end);
        ticks = compact;
    }
    return ticks.map(function (t, i) {
        var left = domain.end > domain.start ? plotLeftPct + ((t - domain.start) / (domain.end - domain.start)) * plotWidthPct : plotLeftPct;
        left = Math.max(0, Math.min(100, left));
        var cls = 'time-tick' + (left <= 1 ? ' left-edge' : '') + (left >= 99 ? ' right-edge' : '');
        return '<span class="' + cls + '" style="left:' + left.toFixed(2) + '%">' + formatBeijingMinute(t) + '</span>';
    }).join('');
}

function buildNetHoverOverlay(items, max, width, height, pad, domainStart, domainEnd) {
    if (!items.length) return '';
    var p = chartPadding(pad);
    var span = Math.max(1, items.length - 1);
    return items.map(function (item, idx) {
        var x = netPointX(item, idx, items, width, pad, domainStart, domainEnd);
        var prevX = idx > 0 ? netPointX(items[idx - 1], idx - 1, items, width, pad, domainStart, domainEnd) : p.left;
        var nextX = idx < items.length - 1 ? netPointX(items[idx + 1], idx + 1, items, width, pad, domainStart, domainEnd) : width - p.right;
        var hitX = idx === 0 ? 0 : (prevX + x) / 2;
        var hitEnd = idx === items.length - 1 ? width : (x + nextX) / 2;
        var hitW = hitEnd - hitX;
        if (span === 1 && items.length === 1) hitW = width;
        var rxValue = parseFloat(item.rx) || 0;
        var txValue = parseFloat(item.tx) || 0;
        var sameValue = Math.abs(rxValue - txValue) < 0.5;
        var tipW = 148, tipH = sameValue ? 45 : 58;
        var tipX = Math.max(4, Math.min(width - tipW - 4, x + 10));
        var tipY = p.top + 6;
        var valueLines = sameValue ?
            '<text class="net-hover-both" x="7" y="32">接收/发送 ' + esc(fmtNetRate(rxValue)) + '</text>' :
            '<text class="net-hover-rx" x="7" y="31">接收 ' + esc(fmtNetRate(rxValue)) + '</text>' +
            '<text class="net-hover-tx" x="7" y="47">发送 ' + esc(fmtNetRate(txValue)) + '</text>';
        return '<g class="chart-hover net-hover">' +
            '<rect class="chart-hover-hit" x="' + hitX.toFixed(1) + '" y="0" width="' + Math.max(3, hitW).toFixed(1) + '" height="' + height + '"/>' +
            '<line class="chart-hover-line" x1="' + x.toFixed(1) + '" y1="' + p.top + '" x2="' + x.toFixed(1) + '" y2="' + (height - p.bottom) + '"/>' +
            '<g class="chart-hover-tip" transform="translate(' + tipX.toFixed(1) + ' ' + tipY + ')">' +
            '<rect width="' + tipW + '" height="' + tipH + '" rx="6"/>' +
            '<text x="7" y="13">' + esc(formatBeijingMinute(item.t || Date.now())) + '</text>' +
            valueLines +
            '</g></g>';
    }).join('');
}

function buildNetYAxis(max, width, height, pad) {
    var p = chartPadding(pad);
    var labels = '';
    for (var i = 0; i <= 4; i++) {
        var y = p.top + i * ((height - p.top - p.bottom) / 4);
        var value = max * (1 - i / 4);
        labels += '<text class="net-axis-label" x="' + (p.left - 9).toFixed(1) + '" y="' + (y + 4).toFixed(1) + '" text-anchor="end">' + esc(fmtNetRate(value)) + '</text>';
    }
    return labels;
}

function networkChartHtml(session, ifaceName, minutes) {
    var history = getNetworkHistory(session, ifaceName).slice(-1800);
    var chartMinutes = minutes || SERVER_INFO_CHART_MINUTES;
    var isDetail = chartMinutes >= SERVER_INFO_DETAIL_CHART_MINUTES;
    var domain = networkDomain(history, chartMinutes);
    history = history.filter(function (p) { return !p.t || (p.t >= domain.start && p.t <= domain.end); });
    var width = isDetail ? 900 : 760;
    var height = isDetail ? 300 : 220;
    var pad = isDetail ? { top: 28, right: 28, bottom: 32, left: 84 } : { top: 24, right: 24, bottom: 26, left: 74 };
    var max = 1;
    var rxPeak = 0, txPeak = 0;
    history.forEach(function (p) {
        var rx = parseFloat(p.rx) || 0;
        var tx = parseFloat(p.tx) || 0;
        rxPeak = Math.max(rxPeak, rx);
        txPeak = Math.max(txPeak, tx);
        max = Math.max(max, rx, tx);
    });
    var netBars = buildNetBars(history, max, width, height, pad, domain.start, domain.end);
    var hoverOverlay = buildNetHoverOverlay(history, max, width, height, pad, domain.start, domain.end);
    var empty = history.length < 2 ? '<div class="server-net-empty">等待下一次刷新后生成实时流量图</div>' : '';
    var grid = '';
    var chartPad = chartPadding(pad);
    for (var gi = 0; gi <= 4; gi++) {
        var y = chartPad.top + gi * ((height - chartPad.top - chartPad.bottom) / 4);
        grid += '<line class="net-grid-h" x1="' + chartPad.left + '" y1="' + y.toFixed(1) + '" x2="' + (width - chartPad.right) + '" y2="' + y.toFixed(1) + '"/>';
    }
    for (var gx = 0; gx <= 6; gx++) {
        var x = chartPad.left + gx * ((width - chartPad.left - chartPad.right) / 6);
        grid += '<line class="net-grid-v" x1="' + x.toFixed(1) + '" y1="' + chartPad.top + '" x2="' + x.toFixed(1) + '" y2="' + (height - chartPad.bottom) + '"/>';
    }
    return '<div class="server-net-chart' + (isDetail ? ' detail-net-chart' : '') + '">' +
        '<div class="server-net-chart-head"><div><b>实时网络流量</b><span>最近 ' + networkSpanText(domain.span) + ' · 北京时间 · 当前单位：' + (serverInfoNetUnit === 'bits' ? 'bits/s' : 'B/s') + '</span></div><div class="server-net-legend"><span class="rx">接收</span><span class="tx">发送</span></div></div>' +
        '<div class="server-net-peaks"><span class="server-net-peak rx"><em>接收峰值</em><b>' + fmtNetRate(rxPeak) + '</b></span><span class="server-net-peak tx"><em>发送峰值</em><b>' + fmtNetRate(txPeak) + '</b></span></div>' +
        '<div class="server-net-canvas">' + empty +
        '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
        grid +
        buildNetYAxis(max, width, height, pad) +
        netBars +
        hoverOverlay +
        '</svg></div>' +
        '<div class="server-net-axis">' + networkTimeAxisHtml(domain, pad, width) + '</div>' +
        '</div>';
}

function closestChartElement(target, selector) {
    return target && target.closest ? target.closest(selector) : null;
}

function clearChartHoverActive(root) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('.chart-hover.active').forEach(function (el) {
        el.classList.remove('active');
    });
}

function chartSvgClientXToViewBox(svg, clientX) {
    if (!svg || !svg.getBoundingClientRect || typeof clientX !== 'number') return null;
    var rect = svg.getBoundingClientRect();
    if (!rect.width) return null;
    var vb = svg.viewBox && svg.viewBox.baseVal ? svg.viewBox.baseVal : null;
    var minX = vb ? vb.x : 0;
    var width = vb && vb.width ? vb.width : rect.width;
    var x = minX + ((clientX - rect.left) / rect.width) * width;
    return Math.max(minX, Math.min(minX + width, x));
}

function moveChartHoverLine(hover, svg, clientX) {
    var x = chartSvgClientXToViewBox(svg, clientX);
    var line = hover && hover.querySelector ? hover.querySelector('.chart-hover-line') : null;
    if (x === null || !line) return;
    line.setAttribute('x1', x.toFixed(1));
    line.setAttribute('x2', x.toFixed(1));
}

function activateChartHover(target, clientX) {
    var hover = closestChartElement(target, '.chart-hover');
    if (!hover) return;
    var svg = closestChartElement(hover, 'svg');
    if (!svg) return;
    clearChartHoverActive(svg);
    moveChartHoverLine(hover, svg, clientX);
    hover.classList.add('active');
}

document.addEventListener('pointermove', function (e) {
    var hit = closestChartElement(e.target, '.chart-hover-hit');
    if (hit) activateChartHover(hit, e.clientX);
}, { passive: true });

document.addEventListener('pointerdown', function (e) {
    var hit = closestChartElement(e.target, '.chart-hover-hit');
    if (hit) activateChartHover(hit, e.clientX);
}, { passive: true });

document.addEventListener('pointerout', function (e) {
    var svg = closestChartElement(e.target, 'svg');
    if (!svg || !svg.querySelector('.chart-hover')) return;
    if (e.relatedTarget && svg.contains(e.relatedTarget)) return;
    clearChartHoverActive(svg);
}, { passive: true });

function fmtKb(kb) {
    return fmtB((parseFloat(kb) || 0) * 1024);
}

function fmtPct(v) {
    v = parseFloat(v) || 0;
    return v.toFixed(v >= 10 ? 0 : 1) + '%';
}

function fmtRemainPct(usedPct) {
    var used = parseFloat(usedPct) || 0;
    var v = 100 - used;
    v = Math.max(0, Math.min(100, v));
    return v.toFixed(Math.abs(used - Math.round(used)) > 0.001 ? 1 : 0) + '%';
}

function fmtUptimeLong(secs) {
    secs = parseInt(secs) || 0;
    var d = Math.floor(secs / 86400);
    var h = Math.floor((secs % 86400) / 3600);
    var m = Math.floor((secs % 3600) / 60);
    var out = [];
    if (d) out.push(d + '天');
    if (h) out.push(h + '小时');
    out.push(m + '分钟');
    return out.join(' ');
}

function percentOf(used, total) {
    return Math.max(0, Math.min(100, pct(used, total)));
}

function meterHtml(label, used, total, color) {
    var p = percentOf(used, total);
    return '<div class="srv-meter"><div class="srv-meter-top"><span>' + esc(label) + '</span><b>' + p + '%</b></div>' +
        '<div class="srv-meter-bar"><i style="width:' + p + '%;background:' + color + '"></i></div></div>';
}

function getSelectedInterface(d) {
    var ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
    var current = serverInfoSelectedIface[(sessions[serverInfoModalIdx] || {}).id] || d.mainIface || '';
    var found = ifaces.find(function (n) { return n.name === current; });
    return found || ifaces.find(function (n) { return n.main === 'true'; }) || ifaces[0] || null;
}

function openServerInfoModal(idx) {
    if (idx < 0 || idx >= sessions.length) return;
    if (serverInfoModalIdx >= 0 && serverInfoModalIdx !== idx && sessions[serverInfoModalIdx]) {
        stopServerInfoNetStream(sessions[serverInfoModalIdx]);
    }
    serverInfoModalIdx = idx;
    var s = sessions[idx];
    var modal = document.getElementById('serverInfoModal');
    var title = document.getElementById('serverInfoTitle');
    var sub = document.getElementById('serverInfoSub');
    var hd = modal ? modal.querySelector('.server-info-hd') : null;
    if (hd) hd.classList.add('server-info-hd-compact');
    if (title) {
        title.textContent = s.hostname;
        title.classList.add('server-info-header-ip');
        title.title = '点击复制 IP';
        title.onclick = function () { copyIP(s.hostname); };
        var titleRow = title.parentNode;
        if (titleRow) {
            var liveBadge = document.getElementById('serverInfoHeaderLive');
            if (!liveBadge) {
                liveBadge = document.createElement('span');
                liveBadge.id = 'serverInfoHeaderLive';
                liveBadge.className = 'server-info-live server-info-live-inline';
                liveBadge.innerHTML = '<span></span>每 ' + getServerInfoRefreshSeconds() + ' 秒刷新';
            }
            titleRow.appendChild(liveBadge);
        }
    }
    if (sub) {
        sub.textContent = '';
        sub.style.display = 'none';
    }
    if (s._lastMetrics) renderServerInfo(s._lastMetrics, s);
    else document.getElementById('serverInfoBody').innerHTML = '<div class="server-info-loading"><span></span>正在读取服务器信息...</div>';
    modal.classList.add('show');
    startServerInfoNetStream(s);
    restartServerInfoTimer();
}

function hideServerInfoModal() {
    var s = sessions[serverInfoModalIdx];
    if (s) stopServerInfoNetStream(s);
    serverInfoModalIdx = -1;
    stopServerInfoTimer();
    hideServerInfoDetailModal();
    var modal = document.getElementById('serverInfoModal');
    if (modal) modal.classList.remove('show');
}

function stopServerInfoTimer() {
    if (serverInfoTimer) {
        clearInterval(serverInfoTimer);
        serverInfoTimer = null;
    }
}

function restartServerInfoTimer() {
    stopServerInfoTimer();
    if (serverInfoModalIdx < 0 || !sessions[serverInfoModalIdx]) return;
    refreshOpenServerInfo();
    serverInfoTimer = setInterval(refreshOpenServerInfo, SERVER_INFO_REFRESH_MS);
}

function refreshOpenServerInfo() {
    if (serverInfoModalIdx < 0 || !sessions[serverInfoModalIdx]) return;
    var s = sessions[serverInfoModalIdx];
    if (s._serverInfoBusy) return;
    s._serverInfoBusy = true;
    var p = fetchSysInfoFor(s);
    if (p && p.finally) {
        p.finally(function () { s._serverInfoBusy = false; });
    } else {
        s._serverInfoBusy = false;
    }
}

function changeServerInfoIface(name) {
    var s = sessions[serverInfoModalIdx];
    if (!s) return;
    serverInfoSelectedIface[s.id] = name;
    if (s._lastMetrics) renderServerInfo(s._lastMetrics, s);
}

function renderServerInfoError(message) {
    var body = document.getElementById('serverInfoBody');
    if (!body) return;
    body.innerHTML = '<div class="server-info-error"><b>读取失败</b><span>' + esc(message || '服务器信息暂时不可用') + '</span></div>';
}

function hideServerInfoDetailModal() {
    serverInfoDetailType = null;
    var modal = document.getElementById('serverInfoDetailModal');
    if (modal) modal.classList.remove('show');
}

function openServerInfoDetailModal(type) {
    var s = sessions[serverInfoModalIdx];
    if (!s || !s._lastMetrics) return;
    serverInfoDetailType = type;
    renderServerInfoDetail(type, s._lastMetrics, s);
    var modal = document.getElementById('serverInfoDetailModal');
    if (modal) modal.classList.add('show');
}

function renderServerInfoDetail(type, d, session) {
    var modal = document.getElementById('serverInfoDetailModal');
    var body = document.getElementById('serverInfoDetailBody');
    var title = document.getElementById('serverInfoDetailTitle');
    if (!body || !title || (modal && !modal.classList.contains('show') && serverInfoDetailType !== type)) return;
    var ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
    var selectedIface = getSelectedInterface(d);
    var ifaceName = selectedIface ? selectedIface.name : (d.mainIface || '-');
    var rxRate = selectedIface ? selectedIface.rxRate : d.rxRate;
    var txRate = selectedIface ? selectedIface.txRate : d.txRate;
    var rxTotal = selectedIface ? selectedIface.rxTotal : d.rxTotal;
    var txTotal = selectedIface ? selectedIface.txTotal : d.txTotal;
    var cpu = parseFloat(d.cpuUsage) || 0;
    var diskPct = percentOf(d.diskUsed, d.diskTotal);
    var memPct = percentOf(d.memUsed, d.memTotal);
    var connTotal = (parseInt(d.tcpCount) || 0) + (parseInt(d.udpCount) || 0);
    var cpuRemainPct = fmtRemainPct(cpu);
    var memRemainPct = fmtRemainPct(memPct);
    var diskRemainPct = fmtRemainPct(diskPct);
    var memAvail = d.memAvailable || d.memFree;
    var cb = d.cpuBreakdown || {};
    var procRows = (Array.isArray(d.processes) ? d.processes : []).map(function (p) {
        return '<tr><td>' + esc(p.pid) + '</td><td>' + esc(p.user) + '</td><td>' + esc(fmtKb(p.rss)) + '</td><td>' + esc(fmtPct(p.cpu)) + '</td><td title="' + escAttr(p.cmd || p.name) + '">' + esc(p.cmd || p.name || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="5">暂无进程数据</td></tr>';
    var fsRows = (Array.isArray(d.filesystems) ? d.filesystems : []).map(function (fs) {
        return '<tr><td title="' + escAttr(fs.name) + '">' + esc(fs.mount || fs.name) + '</td><td>' + esc(fmtB(fs.used)) + ' / ' + esc(fmtB(fs.size)) + '</td><td>' + esc(fmtB(fs.avail)) + '</td><td>' + esc(fs.pct || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="4">暂无文件系统数据</td></tr>';
    var titles = { network: '网络详情', processes: '进程详情', filesystems: '文件系统详情', facts: '基础信息', summary: '资源概览', cpu: 'CPU 详情', memory: '内存详情', disk: '硬盘详情', os: '操作系统详情' };
    title.textContent = titles[type] || '服务器详情';
    if (type === 'network') {
        body.innerHTML = '<div class="server-detail-section">' +
            '<div class="server-detail-kv"><div><span>当前网卡</span><b>' + esc(ifaceName) + '</b></div><div><span>接收速度</span><b>↓ ' + fmtNetRate(rxRate) + '</b><small>' + fmtNetRateAlt(rxRate) + '</small></div><div><span>发送速度</span><b>↑ ' + fmtNetRate(txRate) + '</b><small>' + fmtNetRateAlt(txRate) + '</small></div><div><span>总接收</span><b>' + fmtB(rxTotal) + '</b></div><div><span>总发送</span><b>' + fmtB(txTotal) + '</b></div><div><span>网卡数量</span><b>' + esc(ifaces.length || 1) + '</b></div></div>' +
            networkChartHtml(session, ifaceName, SERVER_INFO_DETAIL_CHART_MINUTES) + '</div>';
    } else if (type === 'processes') {
        body.innerHTML = '<div class="server-table-wrap detail-table"><table class="server-table"><thead><tr><th>PID</th><th>用户</th><th>内存</th><th>CPU</th><th>完整命令</th></tr></thead><tbody>' + procRows + '</tbody></table></div>';
    } else if (type === 'filesystems') {
        body.innerHTML = '<div class="server-table-wrap detail-table"><table class="server-table"><thead><tr><th>挂载点</th><th>已用 / 大小</th><th>可用</th><th>使用率</th></tr></thead><tbody>' + fsRows + '</tbody></table></div>';
    } else if (type === 'cpu') {
        body.innerHTML = '<div class="server-detail-section">' +
            '<div class="server-detail-kv"><div><span>CPU 型号</span><b>' + esc(d.cpuModel || '-') + '</b></div><div><span>CPU 核心</span><b>' + esc(d.cpuCores || '-') + '</b></div>' +
            '<div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div><div><span>当前使用率</span><b>' + cpu.toFixed(1) + '%</b></div>' +
            '<div><span>用户态</span><b>' + esc(cb.user || '0') + '%</b></div><div><span>系统态</span><b>' + esc(cb.system || '0') + '%</b></div>' +
            '<div><span>IO 等待</span><b>' + esc(cb.iowait || '0') + '%</b></div><div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div></div>' +
            '<div class="server-summary-grid detail-summary single-detail-chart"><div><span>CPU 曲线</span><b>' + cpu.toFixed(1) + '%</b><small>用户 ' + esc(cb.user || '0') + '% · 系统 ' + esc(cb.system || '0') + '% · IO ' + esc(cb.iowait || '0') + '%</small>' + resourceSparklineHtml(session, 'cpu', 100, 'cpu') + '</div></div>' +
            '</div>';
    } else if (type === 'memory') {
        body.innerHTML = '<div class="server-detail-section">' +
            '<div class="server-detail-kv"><div><span>内存总量</span><b>' + fmtB(d.memTotal) + '</b></div><div><span>已用内存</span><b>' + fmtB(d.memUsed) + '</b></div>' +
            '<div><span>可用内存</span><b>' + fmtB(d.memAvailable || d.memFree) + '</b></div><div><span>使用率</span><b>' + memPct + '%</b></div>' +
            '<div><span>Swap 总量</span><b>' + fmtB(d.swapTotal) + '</b></div><div><span>Swap 已用</span><b>' + fmtB(d.swapUsed) + '</b></div></div>' +
            '<div class="server-summary-grid detail-summary single-detail-chart"><div><span>内存曲线</span><b>' + memPct + '%</b><small>' + fmtB(d.memUsed) + ' / ' + fmtB(d.memTotal) + '，可用 ' + fmtB(d.memAvailable || d.memFree) + '</small>' + resourceSparklineHtml(session, 'mem', 100, 'mem') + '</div></div>' +
            '</div>';
    } else if (type === 'disk') {
        body.innerHTML = '<div class="server-detail-section">' +
            '<div class="server-detail-kv"><div><span>硬盘总量</span><b>' + fmtB(d.diskTotal) + '</b></div><div><span>已用空间</span><b>' + fmtB(d.diskUsed) + '</b></div>' +
            '<div><span>剩余空间</span><b>' + fmtB(d.diskFree) + '</b></div><div><span>使用率</span><b>' + diskPct + '%</b></div></div>' +
            '<div class="server-summary-grid detail-summary single-detail-chart"><div><span>硬盘曲线</span><b>' + diskPct + '%</b><small>' + fmtB(d.diskUsed) + ' / ' + fmtB(d.diskTotal) + '，剩余 ' + fmtB(d.diskFree) + '</small>' + resourceSparklineHtml(session, 'disk', 100, 'disk') + '</div></div>' +
            '<div class="server-table-wrap detail-table"><table class="server-table"><thead><tr><th>挂载点</th><th>已用 / 大小</th><th>可用</th><th>使用率</th></tr></thead><tbody>' + fsRows + '</tbody></table></div>' +
            '</div>';
    } else if (type === 'os') {
        body.innerHTML = '<div class="server-info-facts detail-facts">' +
            '<div><span>操作系统</span><b>' + esc(d.os || '-') + '</b></div><div><span>内核版本</span><b>' + esc(d.kernelVersion || '-') + '</b></div>' +
            '<div><span>主机名</span><b>' + esc(d.hostname || '-') + '</b></div><div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div>' +
            '<div><span>运行时间</span><b>' + esc(fmtUptimeLong(d.uptime)) + '</b></div><div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div>' +
            '</div>';
    } else if (type === 'facts') {
        body.innerHTML = '<div class="server-info-facts detail-facts">' +
            '<div><span>CPU</span><b>' + esc(d.cpuModel || '-') + '</b><small>' + esc(d.cpuCores || '?') + ' 核 · 剩余 ' + cpuRemainPct + '</small></div>' +
            '<div><span>内存</span><b>' + fmtB(memAvail) + ' / ' + fmtB(d.memTotal) + '</b><small>剩余 ' + memRemainPct + '</small></div>' +
            '<div><span>硬盘</span><b>' + fmtB(d.diskFree) + ' / ' + fmtB(d.diskTotal) + '</b><small>剩余 ' + diskRemainPct + '</small></div>' +
            '<div><span>操作系统</span><b>' + esc(d.os || '-') + '</b></div><div><span>运行时间</span><b>' + esc(fmtUptimeLong(d.uptime)) + '</b></div>' +
            '<div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div><div><span>内核</span><b>' + esc(d.kernelVersion || '-') + '</b></div>' +
            '<div><span>主机名</span><b>' + esc(d.hostname || '-') + '</b></div><div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div>' +
            '</div>';
    } else {
        var detailItems = [
            { label: 'CPU', value: cpu.toFixed(1) + '%', detail: '剩余 ' + cpuRemainPct + ' · ' + (d.cpuCores || '?') + ' 核', key: 'cpu', max: 100, cls: 'cpu' },
            { label: '内存', value: memPct + '%', detail: fmtB(d.memUsed) + ' / ' + fmtB(d.memTotal), key: 'mem', max: 100, cls: 'mem' },
            { label: '磁盘', value: diskPct + '%', detail: fmtB(d.diskUsed) + ' / ' + fmtB(d.diskTotal), key: 'disk', max: 100, cls: 'disk' },
            { label: '连接', value: String(connTotal), detail: 'TCP ' + (d.tcpCount || '0') + ' · UDP ' + (d.udpCount || '0'), key: 'conn', max: 0, cls: 'conn' },
            { label: 'Swap', value: percentOf(d.swapUsed, d.swapTotal) + '%', detail: fmtB(d.swapUsed) + ' / ' + fmtB(d.swapTotal), key: 'mem', max: 100, cls: 'swap' },
            { label: '负载', value: d.load || '0 0 0', detail: '运行 ' + fmtUptimeLong(d.uptime), key: 'cpu', max: 100, cls: 'load' }
        ];
        body.innerHTML = '<div class="server-detail-section resource-detail-section">' + resourceOverviewHtml(session, detailItems, 'detail-resource-overview') + '</div>';
    }
}

function renderServerInfo(d, session) {
    var body = document.getElementById('serverInfoBody');
    if (!body) return;
    if (document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('server-iface-select')) {
        if (serverInfoDetailType) renderServerInfoDetail(serverInfoDetailType, d, session);
        return;
    }
    var diskPct = percentOf(d.diskUsed, d.diskTotal);
    var cpu = parseFloat(d.cpuUsage) || 0;
    var ifaces = Array.isArray(d.interfaces) ? d.interfaces : [];
    var selectedIface = getSelectedInterface(d);
    var ifaceName = selectedIface ? selectedIface.name : (d.mainIface || '-');
    var displayIfaces = ifaces.slice().sort(function (a, b) {
        if (a.name === ifaceName) return -1;
        if (b.name === ifaceName) return 1;
        if (a.name === 'lo') return 1;
        if (b.name === 'lo') return -1;
        return String(a.name || '').localeCompare(String(b.name || ''));
    });
    var ifaceOptions = displayIfaces.map(function (n) {
        return '<option value="' + escAttr(n.name) + '"' + (selectedIface && n.name === selectedIface.name ? ' selected' : '') + '>' + esc(n.name) + (n.main === 'true' ? ' · 主网卡' : '') + '</option>';
    }).join('');
    var procRows = (Array.isArray(d.processes) ? d.processes : []).slice(0, 12).map(function (p) {
        return '<tr><td>' + esc(p.pid) + '</td><td>' + esc(p.user) + '</td><td>' + esc(fmtKb(p.rss)) + '</td><td>' + esc(fmtPct(p.cpu)) + '</td><td title="' + escAttr(p.cmd || p.name) + '">' + esc(p.name || p.cmd || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="5">暂无进程数据</td></tr>';
    var fsRows = (Array.isArray(d.filesystems) ? d.filesystems : []).slice(0, 12).map(function (fs) {
        return '<tr><td title="' + escAttr(fs.name) + '">' + esc(fs.mount || fs.name) + '</td><td>' + esc(fmtB(fs.used)) + '/' + esc(fmtB(fs.size)) + '</td><td>' + esc(fs.pct || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="3">暂无文件系统数据</td></tr>';
    var cb = d.cpuBreakdown || {};
    var rxRate = selectedIface ? selectedIface.rxRate : d.rxRate;
    var txRate = selectedIface ? selectedIface.txRate : d.txRate;
    var rxTotal = selectedIface ? selectedIface.rxTotal : d.rxTotal;
    var txTotal = selectedIface ? selectedIface.txTotal : d.txTotal;
    var memPct = percentOf(d.memUsed, d.memTotal);
    var connTotal = (parseInt(d.tcpCount) || 0) + (parseInt(d.udpCount) || 0);
    var cpuRemainPct = fmtRemainPct(cpu);
    var memRemainPct = fmtRemainPct(memPct);
    var diskRemainPct = fmtRemainPct(diskPct);
    var memAvail = d.memAvailable || d.memFree;
    var netUnitToggle = '<div class="server-net-unit-toggle"><button type="button" class="' + (serverInfoNetUnit === 'bytes' ? 'active' : '') + '" onclick="event.stopPropagation();changeServerNetUnit(\'bytes\')">MB/s</button><button type="button" class="' + (serverInfoNetUnit === 'bits' ? 'active' : '') + '" onclick="event.stopPropagation();changeServerNetUnit(\'bits\')">Mbps</button></div>';
    var summaryItems = [
        { label: 'CPU', value: cpu.toFixed(1) + '%', key: 'cpu', max: 100, cls: 'cpu' },
        { label: '内存', value: memPct + '%', key: 'mem', max: 100, cls: 'mem' },
        { label: '磁盘', value: diskPct + '%', key: 'disk', max: 100, cls: 'disk' },
        { label: '连接', value: String(connTotal), key: 'conn', max: 0, cls: 'conn' }
    ];
    body.innerHTML =
        '<div class="server-info-grid">' +
        '<div class="server-info-card wide server-facts-card server-expandable" onclick="openServerInfoDetailModal(\'facts\')" title="点击放大查看基础信息"><div class="server-card-open">放大</div><h4>基础信息</h4><div class="server-info-facts server-info-facts-main">' +
        '<div><span>CPU</span><b>' + esc(d.cpuModel || '-') + '</b><small>' + esc(d.cpuCores || '?') + ' 核 · 剩余 ' + cpuRemainPct + '</small></div>' +
        '<div><span>内存</span><b>' + fmtB(memAvail) + ' / ' + fmtB(d.memTotal) + '</b><small>剩余 ' + memRemainPct + '</small></div>' +
        '<div><span>硬盘</span><b>' + fmtB(d.diskFree) + ' / ' + fmtB(d.diskTotal) + '</b><small>剩余 ' + diskRemainPct + '</small></div>' +
        '<div><span>操作系统</span><b>' + esc(d.os || '-') + '</b></div>' +
        '<div><span>运行时间</span><b>' + esc(fmtUptimeLong(d.uptime)) + '</b></div>' +
        '<div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div>' +
        '<div><span>内核</span><b>' + esc(d.kernelVersion || '-') + '</b></div>' +
        '<div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div>' +
        '</div></div>' +
        '<div class="server-info-card wide server-summary-card server-expandable" onclick="openServerInfoDetailModal(\'summary\')" title="点击放大查看资源概览"><div class="server-card-open">放大</div><h4>资源概览</h4>' + resourceOverviewHtml(session, summaryItems, 'compact-resource-overview') + '</div>' +
        '<div class="server-info-card wide network-card server-expandable" onclick="openServerInfoDetailModal(\'network\')" title="点击放大查看网络"><div class="server-card-open">放大</div><div class="server-info-card-head network-head"><h4>网络</h4><div class="server-iface-control">' + netUnitToggle + (ifaces.length > 1 ? '<select class="server-iface-select" onclick="event.stopPropagation()" onchange="changeServerInfoIface(this.value)">' + ifaceOptions + '</select>' : '<span class="server-iface-chip">' + esc(ifaceName) + '</span>') + '</div></div>' +
        '<div class="server-net-pair"><div class="net-stat rx"><span>接收速度</span><b>↓ ' + fmtNetRate(rxRate) + '</b><small>' + fmtNetRateAlt(rxRate) + '</small></div><div class="net-stat tx"><span>发送速度</span><b>↑ ' + fmtNetRate(txRate) + '</b><small>' + fmtNetRateAlt(txRate) + '</small></div><div><span>总接收</span><b>' + fmtB(rxTotal) + '</b></div><div><span>总发送</span><b>' + fmtB(txTotal) + '</b></div></div>' + networkChartHtml(session, ifaceName, SERVER_INFO_CHART_MINUTES) + '</div>' +
        '<div class="server-info-card wide server-priority-card server-expandable" onclick="openServerInfoDetailModal(\'processes\')" title="点击放大查看进程"><div class="server-card-open">放大</div><h4>进程</h4><div class="server-table-wrap"><table class="server-table"><thead><tr><th>PID</th><th>用户</th><th>内存</th><th>CPU</th><th>命令</th></tr></thead><tbody>' + procRows + '</tbody></table></div></div>' +
        '<div class="server-info-card wide server-priority-card server-expandable" onclick="openServerInfoDetailModal(\'filesystems\')" title="点击放大查看文件系统"><div class="server-card-open">放大</div><h4>文件系统</h4><div class="server-table-wrap"><table class="server-table"><thead><tr><th>挂载点</th><th>已用/大小</th><th>使用率</th></tr></thead><tbody>' + fsRows + '</tbody></table></div></div>' +
        '</div>';
    if (serverInfoDetailType) renderServerInfoDetail(serverInfoDetailType, d, session);
}

// ==================== Drawers ====================
function toggleConnDrawer() { document.getElementById('connDrawer').classList.toggle('open'); }
function toggleScriptDrawer() {
    var drawer = document.getElementById('scriptDrawer');
    var opening = !drawer.classList.contains('open');
    if (opening) {
        var sftpPanel = document.getElementById('sftpPanel');
        if (sftpPanel) sftpPanel.classList.remove('open');
    }
    drawer.classList.toggle('open');
    remoteEditorLayerWidth();
    setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) syncTermSize(sessions[activeIdx]); }, 350);
}
function toggleSftp() {
    var p = document.getElementById('sftpPanel');
    var wasOpen = p.classList.contains('open');
    if (!wasOpen) {
        var scriptDrawer = document.getElementById('scriptDrawer');
        if (scriptDrawer) scriptDrawer.classList.remove('open');
    }
    p.classList.toggle('open');
    if (!wasOpen && activeIdx >= 0 && sessions[activeIdx]) sftpLoad(sessions[activeIdx].sftpPath || '/', sessions[activeIdx]);
    remoteEditorLayerWidth();
    setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) syncTermSize(sessions[activeIdx]); }, 350);
}

// ==================== Connection Bookmarks ====================
var CBK = 'webssh_conn_bm';
var SBK = 'webssh_script_bm';
var SCAT = 'webssh_script_categories';
var SBK_UPDATED = 'webssh_script_bm_updated_at';
var SBK_REVISION = 'webssh_script_bm_revision';
var SCRIPT_LEGACY_OWNER = 'webssh_script_legacy_owner';
var AUTH_EVENT_KEY = 'webssh_auth_event';
var PRESET_USAGE_KEY = 'webssh_preset_script_usage';
var VERSION_CACHE_KEY = 'webssh_version_check_cache';
var ACTIVE_VERSION_UPDATE_KEY = 'webssh_active_version_update';
var scriptSearchQuery = '';
var activeScriptCategory = '';
var scriptSearchFrame = 0;
var scriptSearchIndex = [];
var MAX_SCRIPT_BOOKMARKS = 500;
var MAX_SCRIPT_CATEGORIES = 100;
var MAX_SCRIPT_COMMAND_CHARS = 20000;
var MAX_SITE_SCRIPT_BACKUP_BYTES = 256 * 1024 * 1024;
var EMOJI_OPTIONS = ['🛠️','⚙️','🔧','🔨','🧰','💻','🖥️','⌨️','🖱️','📦','🐳','☁️','🌐','🛰️','📡','🔐','🛡️','🔑','🚀','⚡','🔥','💡','🧪','🧹','🗄️','💾','📊','📈','🔍','📝','📌','⭐','✅','🚨','🩺','🔄','⬆️','⬇️','🐧','🍎','🤖','👾','🎯','🏠','🏢','🧱','🔌','🕸️','🧭','⏱️','📁','📜','🪄','🎨','🌈','💎','❤️','💚','💙','🟣'];
var currentAccount = null;
var authMode = 'login';
var allowRegistration = false;
var allowLegacyPathLogin = false;
// Guest SSH/SFTP access is the server default. /config can explicitly require
// a bookmark account for deployments that want to disable guest connections.
var requireGatewayAccount = false;
var remoteEditorDefaultMaxBytes = 2 * 1024 * 1024;
var remotePreviewDefaultMaxBytes = 128 * 1024 * 1024;
var urlAutoLoginHandled = false;
// Default to the safer policy until /config explicitly enables password
// persistence. This also prevents a failed config request from leaking a
// password when the server was started with SAVE_PASS=false.
var savePasswords = false;
var accountAutoSynced = '';
var scriptSyncTimer = null;
var scriptSyncTimerAccount = '';
var scriptSyncGeneration = 0;
var authStateGeneration = 0;
var managedAccounts = [];
var managedAdminCount = 0;
var managedAccountPage = 1;
var managedAccountPageSize = 5;
var categoryManagerPage = 1;
var categoryManagerPageSize = 5;
var pendingDeleteCategoryId = '';
var pendingDeleteScriptIndex = -1;
var pendingDeleteScriptId = '';
var scriptManagerPreserveDrawer = false;
var pendingSiteScriptBackup = null;
var siteScriptRestoreInProgress = false;
var editingManagedAccount = null;
var versionUpdatePollTimer = null;
var versionUpdatePollGeneration = 0;
var versionUpdatePollActive = false;
var versionUpdateResumeAccount = '';

function scriptAccountName(account) {
    var username = account && account.username ? String(account.username).trim().toLowerCase() : '';
    return username;
}
function scriptStorageKey(base, accountName) {
    accountName = accountName === undefined ? scriptAccountName(currentAccount) : String(accountName || '').trim().toLowerCase();
    return accountName ? base + '::' + encodeURIComponent(accountName) : base;
}
function isScriptStorageBaseKey(key) { return key === SBK || key === SCAT || key === SBK_UPDATED || key === SBK_REVISION; }
function activeStorageKey(key) { return isScriptStorageBaseKey(key) ? scriptStorageKey(key) : key; }
function scriptStorageGet(key, fallback) { return safeStorageGet(activeStorageKey(key), fallback); }
function scriptStorageSet(key, value) { return safeStorageSet(activeStorageKey(key), value); }
function scriptStorageRemove(key) { return safeStorageRemove(activeStorageKey(key)); }
function loadBM(k) {
    var storageKey = activeStorageKey(k);
    var raw = safeStorageGet(storageKey, null);
    if (storageReadIsUnavailable(storageKey)) {
        if (isScriptStorageBaseKey(k)) markScriptStorageCorrupt(k);
        return [];
    }
    if (raw === null) return [];
    try {
        var parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) {
            if (isScriptStorageBaseKey(k)) markScriptStorageCorrupt(k);
            return [];
        }
        return parsed;
    } catch (e) {
        // A corrupt workspace must never be silently treated as an empty one.
        // The sync layer checks this marker and refuses destructive pushes.
        if (isScriptStorageBaseKey(k)) markScriptStorageCorrupt(k);
        return [];
    }
}
var scriptStorageCorrupt = {};
function markScriptStorageCorrupt(key) { scriptStorageCorrupt[activeStorageKey(key)] = true; }
function isScriptStorageCorrupt() {
    if (typeof scriptStorageCorrupt === 'undefined' || !scriptStorageCorrupt) return false;
    var activePrefix = scriptAccountName(currentAccount);
    return Object.keys(scriptStorageCorrupt).some(function (key) {
        if (!scriptStorageCorrupt[key]) return false;
        if (!activePrefix) return key === SBK || key === SCAT || key === SBK_UPDATED || key === SBK_REVISION;
        return key === scriptStorageKey(SBK, activePrefix) || key === scriptStorageKey(SCAT, activePrefix) ||
            key === scriptStorageKey(SBK_UPDATED, activePrefix) || key === scriptStorageKey(SBK_REVISION, activePrefix);
    });
}
function getScriptUpdatedAt() { return parseInt(scriptStorageGet(SBK_UPDATED)) || 0; }
function getScriptRevision() { return Math.max(0, parseInt(scriptStorageGet(SBK_REVISION), 10) || 0); }
function setScriptRevision(revision) {
    revision = Math.max(0, parseInt(revision, 10) || 0);
    return scriptStorageSet(SBK_REVISION, String(revision)) ? revision : null;
}
function setScriptUpdatedAt(ts) {
    var parsed = parseInt(ts, 10);
    if (!isFinite(parsed) || parsed < 0) parsed = 0;
    return scriptStorageSet(SBK_UPDATED, String(parsed)) ? parsed : null;
}
function touchScriptUpdatedAt(now) {
    var candidate = parseInt(now, 10);
    if (!isFinite(candidate) || candidate < 0) candidate = Date.now();
    // Date.now() can move backwards and an offline browser can be behind the
    // server clock. Every local mutation must still advance the logical clock.
    return setScriptUpdatedAt(Math.max(candidate, getScriptUpdatedAt() + 1));
}
function saveScriptBookmarksData(v, ts, acceptTimestamp) {
    var categories = loadScriptCategories();
    if (isScriptStorageCorrupt()) return false;
    return saveScriptWorkspaceAtomically(v || [], categories, ts, getScriptRevision(), !!acceptTimestamp);
}
function loadScriptCategories() {
    return normalizeScriptCategories(loadBM(SCAT));
}
function saveScriptCategoriesData(v, ts, acceptTimestamp) {
    var scripts = loadBM(SBK);
    if (isScriptStorageCorrupt()) return false;
    return saveScriptWorkspaceAtomically(scripts, v, ts, getScriptRevision(), !!acceptTimestamp);
}
function setScriptUpdatedAtMonotonic(ts) {
    var parsed = parseInt(ts, 10);
    if (!isFinite(parsed) || parsed < 0) parsed = Date.now();
    return setScriptUpdatedAt(Math.max(parsed, getScriptUpdatedAt()));
}
function saveBM(k, v) {
    if (k === SBK) return saveScriptBookmarksData(v);
    return safeStorageSet(activeStorageKey(k), JSON.stringify(v));
}
function ensureScriptBookmarkClock() {
    if (loadBM(SBK).length && !getScriptUpdatedAt()) touchScriptUpdatedAt();
}

function migrateLegacyScriptWorkspace(username) {
    username = String(username || '').trim().toLowerCase();
    if (!username) return;
    var owner = String(safeStorageGet(SCRIPT_LEGACY_OWNER, '') || '').trim().toLowerCase();
    if (owner && owner !== username) return;
    var scopedKeys = [SBK, SCAT, SBK_UPDATED, SBK_REVISION].map(function (key) { return scriptStorageKey(key, username); });
    if (scopedKeys.some(function (key) { return safeStorageGet(key, null) !== null; })) return;
    var legacyScripts = safeStorageGet(SBK, null);
    var legacyCategories = safeStorageGet(SCAT, null);
    var legacyUpdated = safeStorageGet(SBK_UPDATED, null);
    if (legacyScripts === null && legacyCategories === null && legacyUpdated === null) return;
    var writes = [
        safeStorageSet(scopedKeys[0], legacyScripts === null ? '[]' : legacyScripts),
        safeStorageSet(scopedKeys[1], legacyCategories === null ? '[]' : legacyCategories),
        safeStorageSet(scopedKeys[2], legacyUpdated === null ? '0' : legacyUpdated),
        safeStorageSet(scopedKeys[3], '0')
    ];
    if (writes.every(Boolean)) safeStorageSet(SCRIPT_LEGACY_OWNER, username);
}

function saveScriptWorkspaceAtomically(scripts, categories, updatedAt, revision, acceptTimestamp) {
    var keys = [activeStorageKey(SBK), activeStorageKey(SCAT), activeStorageKey(SBK_UPDATED), activeStorageKey(SBK_REVISION)];
    var oldValues = keys.map(function (key) { return safeStorageGet(key, null); });
    if (keys.some(function (key) { return storageReadIsUnavailable(key); })) return false;
    var nextTimestamp = parseInt(updatedAt, 10);
    if (!isFinite(nextTimestamp) || nextTimestamp < 0) nextTimestamp = Date.now();
    nextTimestamp = acceptTimestamp ? Math.max(nextTimestamp, getScriptUpdatedAt()) : Math.max(nextTimestamp, getScriptUpdatedAt() + 1);
    var values = [
        JSON.stringify(Array.isArray(scripts) ? scripts : []),
        JSON.stringify(normalizeScriptCategories(categories)),
        String(nextTimestamp),
        String(Math.max(0, parseInt(revision, 10) || 0))
    ];
    for (var i = 0; i < keys.length; i++) {
        if (safeStorageSet(keys[i], values[i])) continue;
        for (var j = 0; j < i; j++) {
            if (oldValues[j] === null) safeStorageRemove(keys[j]);
            else safeStorageSet(keys[j], oldValues[j]);
        }
        return false;
    }
    return true;
}

function createScriptCategoryId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return 'cat_' + window.crypto.randomUUID();
    return 'cat_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
}

function normalizeScriptCategories(items) {
    var out = [], seen = {};
    (Array.isArray(items) ? items : []).forEach(function (item) {
        if (!item || typeof item !== 'object') return;
        var id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : '';
        var emoji = typeof item.emoji === 'string' ? Array.from(item.emoji.trim()).slice(0, 8).join('') : '';
        var name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : '';
        if (!name) return;
        if (!id || seen[id]) id = createScriptCategoryId();
        seen[id] = true;
        out.push({ id: id, emoji: emoji || '📁', name: name, createdAt: parseInt(item.createdAt, 10) || Date.now() });
    });
    return out.slice(0, MAX_SCRIPT_CATEGORIES);
}

function cleanScriptCategoryReferences(items, categories) {
    var valid = {};
    (Array.isArray(categories) ? categories : []).forEach(function (cat) { if (cat && cat.id) valid[cat.id] = true; });
    var cleaned = 0;
    (Array.isArray(items) ? items : []).forEach(function (item) {
        if (item && item.categoryId && !valid[item.categoryId]) {
            delete item.categoryId;
            cleaned++;
        }
    });
    return cleaned;
}

function getScriptCategory(id, categories) {
    id = typeof id === 'string' ? id.trim() : '';
    if (!id) return null;
    categories = categories || loadScriptCategories();
    for (var i = 0; i < categories.length; i++) if (categories[i].id === id) return categories[i];
    return null;
}

function downloadScriptBackupJSON(data, filename) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.dataset.keepScriptDrawer = '1';
    a.style.display = 'none';
    a.href = url;
    a.download = filename;
    preserveScriptDrawerAfterCategoryChange();
    document.body.appendChild(a);
    a.click();
    a.remove();
    preserveScriptDrawerAfterCategoryChange();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
}

function exportScriptBookmarks() {
    var scripts = loadBM(SBK);
    var categories = loadScriptCategories();
    if (!scripts.length && !categories.length) { showToast('暂无脚本或分类可导出', 'info'); return; }
    var data = {
        app: 'webssh2',
        type: 'script_bookmarks',
        scope: 'personal',
        version: 3,
        account: scriptAccountName(currentAccount),
        exportedAt: new Date().toISOString(),
        origin: location.origin,
        updatedAt: getScriptUpdatedAt(),
        categories: categories,
        scripts: scripts
    };
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadScriptBackupJSON(data, 'webssh-personal-bookmarks-' + stamp + '.json');
    showToast('导出成功：' + scripts.length + ' 个脚本，' + categories.length + ' 个分类', 'success');
}

function triggerScriptImport() {
    var input = document.getElementById('scriptImportFile');
    if (!input) { showToast('导入控件未找到', 'error'); return; }
    preserveScriptDrawerAfterCategoryChange();
    input.value = '';
    input.click();
    preserveScriptDrawerAfterCategoryChange();
}

function classifyScriptBookmarkBackup(data) {
    if (Array.isArray(data)) return 'personal';
    if (!data || typeof data !== 'object') return 'unknown';
    var type = typeof data.type === 'string' ? data.type.trim().toLowerCase() : '';
    var scope = typeof data.scope === 'string' ? data.scope.trim().toLowerCase() : '';
    if (type === 'site_script_bookmarks_backup' || scope === 'site') return 'site';
    if (Array.isArray(data.users) && data.users.some(function (user) {
        return user && typeof user === 'object' && (Array.isArray(user.scripts) || Array.isArray(user.categories));
    })) return 'site';
    if (type === 'script_bookmarks' || scope === 'personal') return 'personal';
    if (Array.isArray(data.scripts) || Array.isArray(data[SBK])) return 'personal';
    if (data.storage && (Array.isArray(data.storage[SBK]) || Array.isArray(data.storage[SCAT]))) return 'personal';
    if (data.bookmarks && (Array.isArray(data.bookmarks.scripts) || Array.isArray(data.bookmarks.categories))) return 'personal';
    return 'unknown';
}

function extractImportedScripts(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.scripts)) return data.scripts;
    if (data && data.storage && Array.isArray(data.storage[SBK])) return data.storage[SBK];
    if (data && data.bookmarks && Array.isArray(data.bookmarks.scripts)) return data.bookmarks.scripts;
    if (data && Array.isArray(data[SBK])) return data[SBK];
    return [];
}

function extractImportedCategories(data) {
    if (data && Array.isArray(data.categories)) return data.categories;
    if (data && data.bookmarks && Array.isArray(data.bookmarks.categories)) return data.bookmarks.categories;
    if (data && data.storage && Array.isArray(data.storage[SCAT])) return data.storage[SCAT];
    if (data && Array.isArray(data[SCAT])) return data[SCAT];
    return [];
}

function normalizeImportedScripts(items) {
    var out = [], seenIds = Object.create(null);
    (Array.isArray(items) ? items : []).forEach(function (item, idx) {
        if (!item || typeof item !== 'object') return;
        var name = typeof item.name === 'string' ? item.name.trim() : '';
        var cmd = '';
        if (typeof item.cmd === 'string') cmd = item.cmd;
        else if (typeof item.command === 'string') cmd = item.command;
        else if (typeof item.content === 'string') cmd = item.content;
        cmd = cmd.trim();
        if (!cmd) return;
        cmd = Array.from(cmd).slice(0, MAX_SCRIPT_COMMAND_CHARS).join('');
        if (!name) name = '导入脚本 ' + (idx + 1);
        var id = typeof item.id === 'string' ? item.id.trim().slice(0, 80) : '';
        if (!id) id = legacyScriptBookmarkId(name, cmd);
        var baseId = id;
        if (seenIds[baseId]) {
            var suffix = 2;
            do {
                var suffixText = '_' + suffix;
                id = Array.from(baseId).slice(0, Math.max(1, 80 - Array.from(suffixText).length)).join('') + suffixText;
                suffix++;
            } while (seenIds[id]);
        }
        seenIds[id] = true;
        var normalized = { id: id, name: name.slice(0, 80), cmd: cmd };
        var categoryId = typeof item.categoryId === 'string' ? item.categoryId.trim().slice(0, 80) : '';
        if (categoryId) normalized.categoryId = categoryId;
        var useCount = parseScriptUseCount(item);
        var lastUsed = parseScriptLastUsed(item);
        if (useCount > 0) normalized.useCount = useCount;
        if (lastUsed > 0) normalized.lastUsed = lastUsed;
        out.push(normalized);
    });
    return out.slice(0, MAX_SCRIPT_BOOKMARKS);
}

function importedScriptBookmarkMatches(current, incoming) {
    if (!current || !incoming) return false;
    return String(current.id || '').trim() === String(incoming.id || '').trim() &&
        String(current.name || '').trim() === String(incoming.name || '').trim() &&
        String(current.cmd || '').trim() === String(incoming.cmd || '').trim() &&
        String(current.categoryId || '').trim() === String(incoming.categoryId || '').trim() &&
        parseScriptUseCount(current) === parseScriptUseCount(incoming) &&
        parseScriptLastUsed(current) === parseScriptLastUsed(incoming);
}

function mergeImportedScriptCategories(incoming) {
    var current = loadScriptCategories();
    var byId = Object.create(null), bySignature = Object.create(null), idMap = Object.create(null);
    var added = 0, updated = 0, skipped = 0, capacitySkipped = 0;
    current.forEach(function (cat) {
        byId[cat.id] = cat;
        bySignature[cat.emoji + '\n' + cat.name.toLowerCase()] = cat;
    });
    var normalizedIncoming = normalizeScriptCategories(incoming);
    normalizedIncoming.forEach(function (cat) {
        var sig = cat.emoji + '\n' + cat.name.toLowerCase();
        if (bySignature[sig]) {
            idMap[cat.id] = bySignature[sig].id;
            skipped++;
            return;
        }
        var originalId = cat.id;
        if (byId[originalId]) {
            var existing = byId[originalId];
            var previousSignature = existing.emoji + '\n' + existing.name.toLowerCase();
            existing.emoji = cat.emoji;
            existing.name = cat.name;
            if (bySignature[previousSignature] === existing) delete bySignature[previousSignature];
            bySignature[sig] = existing;
            idMap[originalId] = existing.id;
            updated++;
            return;
        }
        if (current.length >= MAX_SCRIPT_CATEGORIES) {
            idMap[originalId] = '';
            capacitySkipped++;
            return;
        }
        idMap[originalId] = cat.id;
        current.push(cat);
        byId[cat.id] = cat;
        bySignature[sig] = cat;
        added++;
    });
    return {
        categories: current,
        idMap: idMap,
        added: added,
        updated: updated,
        skipped: skipped,
        capacitySkipped: capacitySkipped,
        sourceCount: normalizedIncoming.length
    };
}

function buildImportedScriptWorkspace(data) {
    if (isScriptStorageCorrupt()) return null;
    var categoryMerge = mergeImportedScriptCategories(extractImportedCategories(data));
    if (isScriptStorageCorrupt()) return null;
    var validCategoryIds = {};
    categoryMerge.categories.forEach(function (cat) { validCategoryIds[cat.id] = true; });
    var incoming = normalizeImportedScripts(extractImportedScripts(data));
    incoming.forEach(function (script) {
        if (!script.categoryId) return;
        script.categoryId = categoryMerge.idMap[script.categoryId] || script.categoryId;
        if (!validCategoryIds[script.categoryId]) delete script.categoryId;
    });
    var current = loadSortedScriptBookmarks();
    var byId = Object.create(null);
    current.forEach(function (b, index) {
        var id = b && typeof b.id === 'string' ? b.id.trim() : '';
        if (id && !Object.prototype.hasOwnProperty.call(byId, id)) byId[id] = index;
    });
    var added = 0, updated = 0, skipped = 0, capacitySkipped = 0;
    incoming.forEach(function (b) {
        var id = b && typeof b.id === 'string' ? b.id.trim() : '';
        if (id && Object.prototype.hasOwnProperty.call(byId, id)) {
            var existingIndex = byId[id];
            if (importedScriptBookmarkMatches(current[existingIndex], b)) { skipped++; return; }
            current[existingIndex] = b;
            updated++;
            return;
        }
        if (current.length >= MAX_SCRIPT_BOOKMARKS) { capacitySkipped++; return; }
        var nextIndex = current.length;
        current.push(b);
        if (id) byId[id] = nextIndex;
        added++;
    });
    var cleaned = cleanScriptCategoryReferences(current, categoryMerge.categories);
    sortScriptBookmarks(current);
    return {
        scripts: current,
        categories: categoryMerge.categories,
        added: added,
        updated: updated,
        skipped: skipped,
        cleaned: cleaned,
        capacitySkipped: capacitySkipped,
        categoryAdded: categoryMerge.added,
        categoryUpdated: categoryMerge.updated,
        categorySkipped: categoryMerge.skipped,
        categoryCapacitySkipped: categoryMerge.capacitySkipped,
        sourceScriptCount: incoming.length,
        sourceCategoryCount: categoryMerge.sourceCount
    };
}

function importScriptBookmarks(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        try {
            var data = JSON.parse(reader.result);
            var backupScope = classifyScriptBookmarkBackup(data);
            if (backupScope === 'site') {
                showToast('这是全站书签备份，不能导入到个人书签。请使用管理员区域的“恢复全站备份”', 'error');
                return;
            }
            if (backupScope !== 'personal') {
                showToast('导入失败：文件不是有效的个人书签备份', 'error');
                return;
            }
            var result = buildImportedScriptWorkspace(data);
            if (!result) { showToast('本地书签数据损坏，导入已停止以避免覆盖原数据', 'error'); return; }
            if (!result.sourceScriptCount && !result.sourceCategoryCount) {
                showToast('未找到可导入的脚本书签或分类', 'error');
                return;
            }
            var changed = result.added || result.updated || result.categoryAdded || result.categoryUpdated;
            if (!changed) {
                if (result.capacitySkipped || result.categoryCapacitySkipped) {
                    showToast('未导入新内容：容量已满，跳过 ' + result.capacitySkipped + ' 个脚本、' + result.categoryCapacitySkipped + ' 个分类', 'warn');
                } else {
                    showToast('备份中的 ' + result.sourceScriptCount + ' 个脚本、' + result.sourceCategoryCount + ' 个分类已全部存在，无需重复导入', 'info');
                }
                return;
            }
            if (!saveScriptWorkspaceAtomically(result.scripts, result.categories, Date.now(), getScriptRevision(), false)) {
                showToast('浏览器存储失败，导入内容未保存', 'error');
                return;
            }
            renderScriptBookmarks();
            renderCategoryManager();
            updateScriptManagerSummary();
            syncLocalScriptsIfLogged();
            var message = '个人备份已导入：新增 ' + result.added + ' 个脚本、' + result.categoryAdded + ' 个分类';
            if (result.updated || result.categoryUpdated) {
                message += '；恢复更新 ' + result.updated + ' 个脚本、' + result.categoryUpdated + ' 个分类';
            }
            if (result.capacitySkipped || result.categoryCapacitySkipped) {
                message += '；容量已满，另跳过 ' + result.capacitySkipped + ' 个脚本、' + result.categoryCapacitySkipped + ' 个分类';
            }
            showToast(message, 'success');
        } catch (e) {
            showToast('导入失败：JSON 文件无效', 'error');
        } finally {
            input.value = '';
            preserveScriptDrawerAfterCategoryChange();
        }
    };
    reader.onerror = function () {
        input.value = '';
        preserveScriptDrawerAfterCategoryChange();
        showToast('导入失败：无法读取文件', 'error');
    };
    reader.readAsText(file, 'utf-8');
}

function summarizeSiteScriptBackup(data) {
    var users = data && Array.isArray(data.users) ? data.users : [];
    var summary = { users: users.length, scripts: 0, categories: 0, exportedAt: '' };
    users.forEach(function (user) {
        summary.scripts += user && Array.isArray(user.scripts) ? user.scripts.length : 0;
        summary.categories += user && Array.isArray(user.categories) ? user.categories.length : 0;
    });
    if (data && typeof data.exportedAt === 'string') {
        var exportedAt = new Date(data.exportedAt);
        summary.exportedAt = isNaN(exportedAt.getTime()) ? data.exportedAt : exportedAt.toLocaleString();
    }
    return summary;
}

function exportSiteScriptBookmarks() {
    if (!requireAdminAccountAccess()) return;
    var button = document.getElementById('siteBookmarkExportBtn');
    if (button) button.disabled = true;
    apiJSON('/api/admin/bookmarks/backup')
        .then(function (res) {
            var data = res.data || {};
            var backup = data.backup;
            if (classifyScriptBookmarkBackup(backup) !== 'site') {
                throw { msg: '服务器返回的全站书签备份格式不正确' };
            }
            var stamp = new Date().toISOString().replace(/[:.]/g, '-');
            downloadScriptBackupJSON(backup, 'webssh-site-bookmarks-' + stamp + '.json');
            showToast('全站备份已导出：' + (data.userCount || 0) + ' 个用户，' + (data.scriptCount || 0) + ' 个脚本', 'success');
        })
        .catch(function (err) { showToast(err.msg || '全站书签备份导出失败', 'error'); })
        .finally(function () { if (button) button.disabled = false; });
}

function triggerSiteScriptImport() {
    if (!requireAdminAccountAccess()) return;
    var input = document.getElementById('siteBookmarkImportFile');
    if (!input) { showToast('全站备份导入控件未找到', 'error'); return; }
    input.value = '';
    input.click();
}

function importSiteScriptBookmarks(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    if (file.size > MAX_SITE_SCRIPT_BACKUP_BYTES) {
        input.value = '';
        showToast('全站书签备份超过 256 MiB 上限，无法导入', 'error');
        return;
    }
    var reader = new FileReader();
    reader.onload = function () {
        try {
            var data = JSON.parse(reader.result);
            var kind = classifyScriptBookmarkBackup(data);
            if (kind === 'personal') {
                showToast('这是个人书签备份，不能用于全站恢复。请使用“导入个人备份”', 'error');
                return;
            }
            if (kind !== 'site' || data.app !== 'webssh2' || data.type !== 'site_script_bookmarks_backup' || data.scope !== 'site') {
                showToast('文件不是有效的 WebSSH2 全站书签备份', 'error');
                return;
            }
            if (parseInt(data.version, 10) !== 1 || !Array.isArray(data.users)) {
                showToast('不支持这个全站书签备份版本或文件内容不完整', 'error');
                return;
            }
            pendingSiteScriptBackup = data;
            showSiteScriptRestoreConfirm(data);
        } catch (e) {
            showToast('导入失败：JSON 文件无效', 'error');
        } finally {
            input.value = '';
        }
    };
    reader.onerror = function () {
        input.value = '';
        showToast('导入失败：无法读取全站备份文件', 'error');
    };
    reader.readAsText(file, 'utf-8');
}

function showSiteScriptRestoreConfirm(data) {
    var modal = document.getElementById('siteBookmarkRestoreModal');
    if (!modal) return;
    var summary = summarizeSiteScriptBackup(data);
    var users = document.getElementById('siteRestoreUserCount');
    var scripts = document.getElementById('siteRestoreScriptCount');
    var categories = document.getElementById('siteRestoreCategoryCount');
    var exportedAt = document.getElementById('siteRestoreExportedAt');
    if (users) users.textContent = String(summary.users);
    if (scripts) scripts.textContent = String(summary.scripts);
    if (categories) categories.textContent = String(summary.categories);
    if (exportedAt) exportedAt.textContent = summary.exportedAt || '未提供';
    modal.classList.add('show');
}

function hideSiteScriptRestoreConfirm() {
    if (siteScriptRestoreInProgress) return;
    var modal = document.getElementById('siteBookmarkRestoreModal');
    if (modal) modal.classList.remove('show');
    pendingSiteScriptBackup = null;
}

function confirmSiteScriptRestore() {
    if (siteScriptRestoreInProgress || !pendingSiteScriptBackup) return;
    if (!requireAdminAccountAccess()) return;
    var backup = pendingSiteScriptBackup;
    var button = document.getElementById('siteBookmarkRestoreConfirmBtn');
    siteScriptRestoreInProgress = true;
    if (button) {
        button.disabled = true;
        button.textContent = '正在恢复...';
    }
    cancelPendingScriptSync();
    apiJSON('/api/admin/bookmarks/restore', { method: 'POST', body: backup })
        .then(function (res) {
            var data = res.data || {};
            siteScriptRestoreInProgress = false;
            hideSiteScriptRestoreConfirm();
            var message = '已恢复 ' + (data.restoredUsers || 0) + ' 个用户的书签（' + (data.scriptCount || 0) + ' 个脚本、' + (data.categoryCount || 0) + ' 个分类）';
            if (data.skippedUsers) message += '；跳过 ' + data.skippedUsers + ' 个当前网站不存在的用户';
            showToast(message, 'success');
            if (data.currentAccountRestored) syncScriptBookmarks('pull', true);
        })
        .catch(function (err) {
            siteScriptRestoreInProgress = false;
            showToast(err.msg || '全站书签恢复失败，原数据未改变', 'error');
        })
        .finally(function () {
            if (button) {
                button.disabled = false;
                button.textContent = '确认恢复对应用户';
            }
        });
}

var _cloudStatusTimer = null;
function hideCloudStatus() {
    if (_cloudStatusTimer) {
        clearTimeout(_cloudStatusTimer);
        _cloudStatusTimer = null;
    }
    var el = document.getElementById('scriptCloudStatus');
    if (!el) return;
    el.className = 'script-cloud-status';
    el.textContent = '';
}

function setCloudStatus(text, cls, autoHideMs) {
    var el = document.getElementById('scriptCloudStatus');
    if (!el) return;
    if (_cloudStatusTimer) {
        clearTimeout(_cloudStatusTimer);
        _cloudStatusTimer = null;
    }
    el.className = 'script-cloud-status show' + (cls ? ' ' + cls : '');
    el.textContent = text;
    if (autoHideMs) {
        _cloudStatusTimer = setTimeout(hideCloudStatus, autoHideMs);
    }
}

function updateAccountUI() {
    var isAdminAccount = !!(currentAccount && currentAccount.isAdmin);
    var btn = document.getElementById('scriptAccountBtn');
    if (btn) {
        if (currentAccount && currentAccount.username) {
            btn.textContent = (currentAccount.isAdmin ? '♛ ' : '☁ ') + currentAccount.username;
            btn.classList.add('logged-in');
        } else {
            btn.textContent = '登录/注册';
            btn.classList.remove('logged-in');
        }
    }
    var adminBtn = document.getElementById('accountAdminBtn');
    if (adminBtn) {
        adminBtn.classList.toggle('show', isAdminAccount);
    }
    var siteBackupSection = document.getElementById('siteBookmarkBackupSection');
    if (siteBackupSection) siteBackupSection.hidden = !isAdminAccount;
    if (!isAdminAccount && !siteScriptRestoreInProgress) hideSiteScriptRestoreConfirm();
    var loggedIn = document.getElementById('authLoggedIn');
    var loggedOut = document.getElementById('authLoggedOut');
    var name = document.getElementById('authUserName');
    if (currentAccount && currentAccount.username) {
        if (loggedIn) loggedIn.style.display = '';
        if (loggedOut) loggedOut.style.display = 'none';
        if (name) name.textContent = currentAccount.username + (currentAccount.isAdmin ? '（管理员）' : '');
        hideCloudStatus();
    } else {
        if (loggedIn) loggedIn.style.display = 'none';
        if (loggedOut) loggedOut.style.display = '';
        hideCloudStatus();
    }
    updateScriptManagerSummary();
}

function clearPasswordChangeForm() {
    ['oldPassword', 'newPassword', 'confirmNewPassword'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
}

function apiJSON(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    options.headers = options.headers || {};
    if (options.body && typeof options.body !== 'string') {
        options.headers['Content-Type'] = 'application/json';
        options.body = JSON.stringify(options.body);
    }
    return fetch(url, options).then(function (r) {
        return r.text().then(function (txt) {
            var data = {};
            try { data = txt ? JSON.parse(txt) : {}; } catch (e) { data = { ok: false, msg: txt || '请求失败' }; }
            if (!r.ok || data.ok === false) {
                data.status = r.status;
                throw data;
            }
            return data;
        });
    });
}

function openAuthModal(mode) {
    if (mode) switchAuthMode(mode);
    updateAccountUI();
    document.getElementById('authModal').classList.add('show');
    setTimeout(function () {
        var u = document.getElementById('authUsername');
        if (u && (!currentAccount || !currentAccount.username)) u.focus();
    }, 60);
}

function hideAuthModal() {
    document.getElementById('authModal').classList.remove('show');
    clearPasswordChangeForm();
    setForgotPasswordHelp(false);
}

function switchAuthMode(mode) {
    authMode = mode === 'register' && allowRegistration ? 'register' : 'login';
    var loginTab = document.getElementById('authLoginTab');
    var registerTab = document.getElementById('authRegisterTab');
    var submit = document.querySelector('.auth-submit-btn');
    var hint = document.getElementById('authHint');
    var forgotToggle = document.getElementById('forgotPasswordToggle');
    if (loginTab) loginTab.classList.toggle('active', authMode === 'login');
    if (registerTab) registerTab.classList.toggle('active', authMode === 'register');
    if (submit) submit.textContent = authMode === 'register' ? '注册并登录' : '登录';
    if (hint) hint.textContent = authMode === 'register' ? '用户名只能用字母或数字，用户名大于 4 位；密码至少 7 个字符且不超过 72 个 UTF-8 字节。' : '登录后会自动同步脚本书签；未登录时仍保存在本地浏览器。';
    if (forgotToggle) forgotToggle.style.display = authMode === 'login' ? '' : 'none';
    if (authMode !== 'login') setForgotPasswordHelp(false);
}

function getAdminResetCommand() {
    var input = document.getElementById('authUsername');
    var username = input ? input.value.trim().toLowerCase() : '';
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) username = 'admin';
    return "WEBSSH_ADMIN_USER=" + username + " WEBSSH_ADMIN_PASSWORD='请替换为新密码' WEBSSH_ADMIN_RESET=true docker compose up -d --force-recreate";
}

function updateAdminResetCommand() {
    var command = getAdminResetCommand();
    var el = document.getElementById('adminResetCommand');
    if (el) el.textContent = command;
    return command;
}

function setForgotPasswordHelp(show) {
    var help = document.getElementById('forgotPasswordHelp');
    var toggle = document.getElementById('forgotPasswordToggle');
    if (help) help.classList.toggle('show', !!show);
    if (toggle) {
        toggle.setAttribute('aria-expanded', show ? 'true' : 'false');
        toggle.textContent = show ? '收起密码帮助' : '忘记密码？';
    }
    if (show) updateAdminResetCommand();
}

function toggleForgotPasswordHelp() {
    var help = document.getElementById('forgotPasswordHelp');
    setForgotPasswordHelp(!(help && help.classList.contains('show')));
}

function copyAdminResetCommand() {
    var command = updateAdminResetCommand();
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(command).then(showCopyToast).catch(function () { fallbackCopy(command); });
    } else {
        fallbackCopy(command);
    }
}

function utf8ByteLength(value) {
    value = String(value || '');
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
    return unescape(encodeURIComponent(value)).length;
}

function validateAccountPasswordInput(password, label) {
    label = label || '密码';
    if (Array.from(password).length < 7) {
        showToast(label + '必须大于 6 位', 'error');
        return false;
    }
    if (utf8ByteLength(password) > 72) {
        showToast(label + '不能超过 72 个 UTF-8 字节', 'error');
        return false;
    }
    return true;
}

function createScriptBookmarkId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return 'scr_' + window.crypto.randomUUID();
    return 'scr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 12);
}

function legacyScriptBookmarkId(name, cmd) {
    var hash = 2166136261;
    Array.from(String(name) + '\u0000' + String(cmd)).forEach(function (ch) {
        hash ^= ch.codePointAt(0);
        hash = Math.imul(hash, 16777619);
    });
    return 'scr_legacy_' + (hash >>> 0).toString(16).padStart(8, '0');
}

function cancelPendingScriptSync() {
    if (scriptSyncTimer) clearTimeout(scriptSyncTimer);
    scriptSyncTimer = null;
    scriptSyncTimerAccount = '';
    scriptSyncGeneration++;
}

function refreshActiveScriptWorkspaceUI() {
    ensureScriptBookmarkClock();
    renderScriptBookmarks();
    renderCategoryManager();
    updateScriptManagerSummary();
}

function applyCurrentAccount(account) {
    var next = account && account.username ? {
        username: String(account.username).trim().toLowerCase(),
        isAdmin: !!account.isAdmin
    } : null;
    var previousName = scriptAccountName(currentAccount);
    var nextName = scriptAccountName(next);
    currentAccount = next;
    if (previousName !== nextName) {
        cancelPendingScriptSync();
        accountAutoSynced = '';
        if (nextName) migrateLegacyScriptWorkspace(nextName);
        refreshActiveScriptWorkspaceUI();
    }
    updateAccountUI();
    if (currentAccount && currentAccount.isAdmin) {
        resumeVersionUpdateIfNeeded();
    } else {
        versionUpdateResumeAccount = '';
        stopVersionUpdatePolling();
    }
}

function ensureGatewayAccount() {
    if (!requireGatewayAccount || (currentAccount && currentAccount.username)) return true;
    openAuthModal('login');
    showToast('请先登录 WebSSH 书签账号再建立 SSH/SFTP 连接', 'info');
    return false;
}

var authBroadcastChannel = null;
try {
    if (typeof BroadcastChannel === 'function') {
        authBroadcastChannel = new BroadcastChannel('webssh-auth-state');
        authBroadcastChannel.onmessage = function () {
            authStateGeneration++;
            cancelPendingScriptSync();
            refreshAccountState();
        };
    }
} catch (e) { authBroadcastChannel = null; }

function broadcastAuthStateChange() {
    var value = Date.now() + ':' + Math.random();
    try { localStorage.setItem(AUTH_EVENT_KEY, value); } catch (e) { }
    try { if (authBroadcastChannel) authBroadcastChannel.postMessage(value); } catch (e) { }
}

window.addEventListener('storage', function (event) {
    if (event.key === AUTH_EVENT_KEY) {
        authStateGeneration++;
        cancelPendingScriptSync();
        refreshAccountState();
        return;
    }
    var username = scriptAccountName(currentAccount);
    if (!username) return;
    var activeKeys = [SBK, SCAT, SBK_UPDATED, SBK_REVISION].map(function (key) { return scriptStorageKey(key, username); });
    if (activeKeys.indexOf(event.key) >= 0) {
        scriptSyncGeneration++;
        refreshActiveScriptWorkspaceUI();
    }
});

function submitAuthForm() {
    var username = document.getElementById('authUsername').value.trim();
    var password = document.getElementById('authPassword').value;
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) { showToast('用户名只能使用 5-32 位字母或数字', 'error'); return; }
    if (!validateAccountPasswordInput(password, '密码')) return;
    var path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    apiJSON(path, { method: 'POST', body: { username: username, password: password } })
        .then(function (res) {
            authStateGeneration++;
            applyCurrentAccount({
                username: res.data && res.data.username ? res.data.username : username.toLowerCase(),
                isAdmin: !!(res.data && res.data.isAdmin)
            });
            accountAutoSynced = currentAccount.username;
            broadcastAuthStateChange();
            hideAuthModal();
            showToast((authMode === 'register' ? '注册成功' : '登录成功') + '，正在同步书签...', 'success');
            syncScriptBookmarks('auto');
        })
        .catch(function (err) { showToast(err.msg || '登录失败', 'error'); });
}

function logoutAccount() {
    cancelPendingScriptSync();
    apiJSON('/api/auth/logout', { method: 'POST' })
        .then(function () {
            authStateGeneration++;
            applyCurrentAccount(null);
            broadcastAuthStateChange();
            clearPasswordChangeForm();
            hideAuthModal();
            showToast('已退出登录，本地书签仍保留在浏览器', 'info');
        })
        .catch(function (err) { showToast(err.msg || '退出失败', 'error'); });
}

function changeAccountPassword() {
    if (!currentAccount || !currentAccount.username) {
        openAuthModal('login');
        showToast('请先登录后再修改密码', 'info');
        return;
    }
    var oldPassword = document.getElementById('oldPassword').value;
    var newPassword = document.getElementById('newPassword').value;
    var confirmPassword = document.getElementById('confirmNewPassword').value;
    if (!oldPassword) { showToast('请输入当前密码', 'error'); return; }
    if (!validateAccountPasswordInput(newPassword, '新密码')) return;
    if (newPassword !== confirmPassword) { showToast('两次输入的新密码不一致', 'error'); return; }
    apiJSON('/api/auth/change-password', {
        method: 'POST',
        body: { oldPassword: oldPassword, newPassword: newPassword }
    })
        .then(function (res) {
            clearPasswordChangeForm();
            showToast(res.msg || '密码已修改', 'success');
        })
        .catch(function (err) { showToast(err.msg || '密码修改失败', 'error'); });
}

function requireAdminAccountAccess() {
    if (!currentAccount || !currentAccount.username) {
        openAuthModal('login');
        showToast('请先登录管理员账号', 'info');
        return false;
    }
    if (!currentAccount.isAdmin) {
        showToast('只有管理员可以管理服务器账号', 'error');
        return false;
    }
    return true;
}

function openAccountAdminModal() {
    if (!requireAdminAccountAccess()) return;
    hideAuthModal();
    managedAccountPage = 1;
    var pageSize = document.getElementById('accountPageSize');
    if (pageSize) pageSize.value = String(managedAccountPageSize);
    var modal = document.getElementById('accountAdminModal');
    if (modal) modal.classList.add('show');
    loadManagedAccounts();
}

function hideAccountAdminModal() {
    var modal = document.getElementById('accountAdminModal');
    if (modal) modal.classList.remove('show');
    clearManagedAccountCreateForm();
}

function clearManagedAccountCreateForm() {
    ['managedNewUsername', 'managedNewPassword'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var admin = document.getElementById('managedNewIsAdmin');
    if (admin) admin.checked = false;
}

function formatAccountTime(ts) {
    ts = parseInt(ts) || 0;
    if (!ts) return '未知时间';
    if (ts < 100000000000) ts *= 1000;
    try {
        return new Date(ts).toLocaleString('zh-CN', { hour12: false });
    } catch (e) {
        return '未知时间';
    }
}

function updateManagedAccounts(data, focusUsername) {
    data = data || {};
    managedAccounts = Array.isArray(data.users) ? data.users : [];
    managedAdminCount = parseInt(data.adminCount) || 0;
    if (focusUsername) {
        var focusIndex = managedAccounts.findIndex(function (item) { return item.username === focusUsername; });
        if (focusIndex >= 0) managedAccountPage = Math.floor(focusIndex / managedAccountPageSize) + 1;
    }
    var stats = document.getElementById('managedAccountStats');
    if (stats) stats.textContent = '（' + managedAccounts.length + ' 个账号 / ' + managedAdminCount + ' 个管理员）';
    renderManagedAccounts();
}

function loadManagedAccounts() {
    if (!requireAdminAccountAccess()) return;
    var list = document.getElementById('managedAccountList');
    if (list) list.innerHTML = '<div class="auth-hint">正在读取账号列表...</div>';
    apiJSON('/api/admin/accounts')
        .then(function (res) { updateManagedAccounts(res.data || {}); })
        .catch(function (err) {
            if (list) list.innerHTML = '<div class="account-empty">读取失败：' + esc(err.msg || '请求失败') + '</div>';
            showToast(err.msg || '账号列表读取失败', 'error');
            refreshAccountState();
        });
}

function renderManagedAccounts() {
    var list = document.getElementById('managedAccountList');
    if (!list) return;
    var totalPages = Math.max(1, Math.ceil(managedAccounts.length / managedAccountPageSize));
    managedAccountPage = Math.max(1, Math.min(managedAccountPage, totalPages));
    updateManagedAccountPagination(totalPages);
    if (!managedAccounts.length) {
        list.innerHTML = '<div class="account-empty">暂无账号</div>';
        return;
    }
    var start = (managedAccountPage - 1) * managedAccountPageSize;
    var pageItems = managedAccounts.slice(start, start + managedAccountPageSize);
    list.innerHTML = pageItems.map(function (u) {
        var username = u.username || '';
        var badges = '';
        if (u.isAdmin) badges += '<span class="account-badge admin">管理员</span>';
        if (u.current) badges += '<span class="account-badge current">当前</span>';
        var meta = '创建：' + formatAccountTime(u.createdAt) +
            ' · 脚本 ' + (parseInt(u.scriptCount) || 0) + ' 个' +
            ' · 登录会话 ' + (parseInt(u.sessionCount) || 0) + ' 个';
        return '<div class="account-row">' +
            '<div class="account-row-main">' +
            '<div class="account-row-title"><span class="account-row-name">' + esc(username) + '</span>' + badges + '</div>' +
            '<div class="account-row-meta">' + esc(meta) + '</div>' +
            '</div>' +
            '<div class="account-row-actions">' +
            '<button class="script-tool-btn" type="button" data-username="' + escAttr(username) + '" onclick="openAccountEdit(this.dataset.username)">改密 / 编辑</button>' +
            '<button class="script-tool-btn danger-inline" type="button" data-username="' + escAttr(username) + '" onclick="deleteManagedAccount(this.dataset.username)">删除</button>' +
            '</div>' +
            '</div>';
    }).join('');
}

function updateManagedAccountPagination(totalPages) {
    var select = document.getElementById('accountPageSize');
    var info = document.getElementById('accountPageInfo');
    var prev = document.getElementById('accountPagePrev');
    var next = document.getElementById('accountPageNext');
    if (select) select.value = String(managedAccountPageSize);
    if (info) info.textContent = managedAccountPage + ' / ' + totalPages;
    if (prev) prev.disabled = managedAccountPage <= 1;
    if (next) next.disabled = managedAccountPage >= totalPages;
}

function setManagedAccountPageSize(value) {
    value = parseInt(value, 10);
    if ([5, 10, 15].indexOf(value) < 0) value = 5;
    managedAccountPageSize = value;
    managedAccountPage = 1;
    renderManagedAccounts();
}

function changeManagedAccountPage(delta) {
    var totalPages = Math.max(1, Math.ceil(managedAccounts.length / managedAccountPageSize));
    managedAccountPage = Math.max(1, Math.min(totalPages, managedAccountPage + (parseInt(delta, 10) || 0)));
    renderManagedAccounts();
}
function createManagedAccount() {
    if (!requireAdminAccountAccess()) return;
    var username = document.getElementById('managedNewUsername').value.trim();
    var password = document.getElementById('managedNewPassword').value;
    var isAdmin = document.getElementById('managedNewIsAdmin').checked;
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) { showToast('用户名只能使用 5-32 位字母或数字', 'error'); return; }
    if (!validateAccountPasswordInput(password, '密码')) return;
    apiJSON('/api/admin/accounts', {
        method: 'POST',
        body: { username: username, password: password, isAdmin: isAdmin }
    })
        .then(function (res) {
            clearManagedAccountCreateForm();
            updateManagedAccounts(res.data || {}, username);
            showToast(res.msg || '账号已创建', 'success');
        })
        .catch(function (err) { showToast(err.msg || '账号创建失败', 'error'); });
}

function findManagedAccount(username) {
    username = String(username || '').toLowerCase();
    for (var i = 0; i < managedAccounts.length; i++) {
        if ((managedAccounts[i].username || '').toLowerCase() === username) return managedAccounts[i];
    }
    return null;
}

function openAccountEdit(username) {
    if (!requireAdminAccountAccess()) return;
    var acc = findManagedAccount(username);
    if (!acc) { showToast('账号不存在，请刷新列表', 'error'); return; }
    editingManagedAccount = acc.username;
    document.getElementById('managedEditUsername').value = acc.username;
    document.getElementById('managedEditPassword').value = '';
    document.getElementById('managedEditIsAdmin').checked = !!acc.isAdmin;
    document.getElementById('accountEditModal').classList.add('show');
}

function hideAccountEditModal() {
    editingManagedAccount = null;
    var modal = document.getElementById('accountEditModal');
    if (modal) modal.classList.remove('show');
    var pwd = document.getElementById('managedEditPassword');
    if (pwd) pwd.value = '';
}

function saveManagedAccount() {
    if (!requireAdminAccountAccess()) return;
    var username = (editingManagedAccount || document.getElementById('managedEditUsername').value || '').trim();
    var password = document.getElementById('managedEditPassword').value;
    var isAdmin = document.getElementById('managedEditIsAdmin').checked;
    if (!username) { showToast('账号不能为空', 'error'); return; }
    if (password && !validateAccountPasswordInput(password, '新密码')) return;
    apiJSON('/api/admin/accounts', {
        method: 'PUT',
        body: { username: username, password: password, isAdmin: isAdmin }
    })
        .then(function (res) {
            updateManagedAccounts(res.data || {});
            hideAccountEditModal();
            if (currentAccount && currentAccount.username === username) refreshAccountState();
            showToast(res.msg || '账号已更新', 'success');
        })
        .catch(function (err) { showToast(err.msg || '账号更新失败', 'error'); });
}

function deleteManagedAccount(username) {
    if (!requireAdminAccountAccess()) return;
    var acc = findManagedAccount(username);
    if (!acc) { showToast('账号不存在，请刷新列表', 'error'); return; }
    var tips = acc.current ? '这是当前登录账号，删除后会退出登录。' : '该账号的云端脚本和登录会话也会删除。';
    if (!confirm('确定删除账号 ' + acc.username + ' 吗？\n' + tips)) return;
    apiJSON('/api/admin/accounts/' + encodeURIComponent(acc.username), { method: 'DELETE' })
        .then(function (res) {
            updateManagedAccounts(res.data || {});
            if (currentAccount && currentAccount.username === acc.username) {
                authStateGeneration++;
                applyCurrentAccount(null);
                broadcastAuthStateChange();
                hideAccountEditModal();
                hideAccountAdminModal();
            } else {
                refreshAccountState();
            }
            showToast(res.msg || '账号已删除', 'success');
        })
        .catch(function (err) { showToast(err.msg || '账号删除失败', 'error'); });
}

function refreshAccountState() {
    var requestGeneration = ++authStateGeneration;
    apiJSON('/api/auth/me')
        .then(function (res) {
            if (requestGeneration !== authStateGeneration) return;
            var d = res.data || {};
            applyCurrentAccount(d.loggedIn ? { username: d.username, isAdmin: !!d.isAdmin } : null);
            if (currentAccount && accountAutoSynced !== currentAccount.username) {
                accountAutoSynced = currentAccount.username;
                syncScriptBookmarks('auto', true);
            }
        })
        .catch(function (err) {
            if (requestGeneration !== authStateGeneration) return;
            if (err && err.status === 401) applyCurrentAccount(null);
        });
}

function normalizeCloudScripts(items) {
    return normalizeImportedScripts(Array.isArray(items) ? items : []);
}

function captureScriptSyncSnapshot() {
    var scripts = loadSortedScriptBookmarks();
    var categories = loadScriptCategories();
    return {
        account: scriptAccountName(currentAccount),
        updatedAt: getScriptUpdatedAt(),
        revision: getScriptRevision(),
        scripts: scripts,
        categories: categories,
        scriptsStorage: scriptStorageGet(SBK, ''),
        categoriesStorage: scriptStorageGet(SCAT, '')
    };
}

function scriptSyncSnapshotIsCurrent(snapshot) {
    if (!snapshot || scriptAccountName(currentAccount) !== snapshot.account) return false;
    if (getScriptUpdatedAt() !== snapshot.updatedAt || getScriptRevision() !== snapshot.revision) return false;
    return scriptStorageGet(SBK, '') === snapshot.scriptsStorage &&
        scriptStorageGet(SCAT, '') === snapshot.categoriesStorage;
}

function reconcileCloudScriptConflict(data) {
    data = data || {};
    if (!Array.isArray(data.scripts) || !Array.isArray(data.categories)) return false;
    var cloudCategories = normalizeScriptCategories(data.categories);
    var categoryMerge = mergeImportedScriptCategories(cloudCategories);
    var categories = categoryMerge.categories;
    var validCategoryIds = {};
    categories.forEach(function (category) { validCategoryIds[category.id] = true; });
    var cloudScripts = normalizeCloudScripts(data.scripts);
    cloudScripts.forEach(function (script) {
        if (!script.categoryId) return;
        script.categoryId = categoryMerge.idMap[script.categoryId] || script.categoryId;
        if (!validCategoryIds[script.categoryId]) delete script.categoryId;
    });
    var current = loadSortedScriptBookmarks();
    if (isScriptStorageCorrupt()) return false;
    if (categoryMerge.capacitySkipped) {
        showToast('分类容量已满，无法安全合并云端分类；请先导出并清理本地分类', 'error');
        return false;
    }
    var seen = {};
    current.forEach(function (script) { seen[scriptBookmarkKey(script)] = true; });
    var skippedForCapacity = 0;
    cloudScripts.forEach(function (script) {
        var key = scriptBookmarkKey(script);
        if (!key.trim() || seen[key]) return;
        if (current.length >= MAX_SCRIPT_BOOKMARKS) { skippedForCapacity++; return; }
        current.push(script);
        seen[key] = true;
    });
    if (skippedForCapacity) {
        showToast('脚本容量已满，无法安全合并全部云端脚本；请先导出并清理本地脚本', 'error');
        return false;
    }
    cleanScriptCategoryReferences(current, categories);
    sortScriptBookmarks(current);
    var cloudUpdatedAt = Math.max(0, parseInt(data.updatedAt, 10) || 0);
    var revision = Math.max(0, parseInt(data.revision, 10) || 0);
    if (!saveScriptWorkspaceAtomically(current, categories, Math.max(Date.now(), cloudUpdatedAt), revision, false)) return false;
    refreshActiveScriptWorkspaceUI();
    return true;
}

function syncScriptBookmarks(mode, silent, retryCount, conflictMerged) {
    mode = mode || 'auto';
    retryCount = Math.max(0, parseInt(retryCount, 10) || 0);
    if (!currentAccount || !currentAccount.username) {
        openAuthModal('login');
        showToast('请先登录账号再同步云端书签', 'info');
        return;
    }
    if (!silent) setCloudStatus('正在同步书签...', '');
    var accountUsername = currentAccount.username;
    var requestGeneration = ++scriptSyncGeneration;
    var snapshot = captureScriptSyncSnapshot();
    var payload = {
        mode: mode,
        account: accountUsername,
        baseRevision: snapshot.revision,
        updatedAt: snapshot.updatedAt
    };
    if (mode !== 'pull') {
        payload.scripts = snapshot.scripts;
        payload.categories = snapshot.categories;
    }
    apiJSON('/api/scripts/sync', { method: 'POST', body: payload })
        .then(function (res) {
            // A response from an older request, another account, or a request
            // whose local snapshot changed must never write into localStorage.
            if (requestGeneration !== scriptSyncGeneration || !currentAccount || currentAccount.username !== accountUsername) return;
            if (!scriptSyncSnapshotIsCurrent(snapshot)) {
                setCloudStatus('检测到本地新修改，正在重新同步...', 'warn');
                syncLocalScriptsIfLogged(0);
                return;
            }
            var d = res.data || {};
            if (d.username && d.username !== accountUsername) {
                cancelPendingScriptSync();
                refreshAccountState();
                return;
            }
            if (!Array.isArray(d.scripts) || !Array.isArray(d.categories)) {
                throw { status: 502, msg: '云端同步响应格式不正确，本地数据未改动' };
            }
            var syncedAt = parseInt(d.updatedAt, 10);
            if (!isFinite(syncedAt) || syncedAt < 0) {
                throw { status: 502, msg: '云端同步时间无效，本地数据未改动' };
            }
            var scripts = normalizeCloudScripts(d.scripts);
            var categories = normalizeScriptCategories(d.categories);
            if (typeof isScriptStorageCorrupt === 'function' && isScriptStorageCorrupt()) {
                setCloudStatus('本地书签数据损坏，已停止同步以避免覆盖云端', 'warn', 6000);
                if (!silent) showToast('本地书签数据损坏，请先导出或清理后再同步', 'error');
                return;
            }
            cleanScriptCategoryReferences(scripts, categories);
            if (!saveScriptWorkspaceAtomically(scripts, categories, syncedAt, d.revision, true)) {
                setCloudStatus('浏览器存储失败，未更新同步版本', 'warn', 5000);
                if (!silent) showToast('浏览器存储空间不足，云端数据未写入本地', 'error');
                return;
            }
            var merged = { scripts: scripts, added: 0 };
            refreshActiveScriptWorkspaceUI();
            updateAccountUI();
            var msg = '书签已是最新';
            if (d.mode === 'push') msg = '本地书签已同步到云端';
            else if (d.mode === 'pull') msg = '云端书签已同步到本地';
            if (conflictMerged) msg = '并发修改已合并并同步';
            var categoryCount = categories.length;
            var detail = merged.scripts.length + ' 个脚本 · ' + categoryCount + ' 个分类';
            if (!silent) setCloudStatus(msg + ' · ' + detail, 'synced', 3500);
            if (!silent) showToast(msg + '（' + detail + '）', 'success');
        })
        .catch(function (err) {
            if (requestGeneration !== scriptSyncGeneration || !currentAccount || currentAccount.username !== accountUsername) return;
            if (err && err.code === 'account_changed') {
                cancelPendingScriptSync();
                refreshAccountState();
                return;
            }
            if (err && err.code === 'workspace_restored') {
                if (!scriptSyncSnapshotIsCurrent(snapshot)) {
                    syncLocalScriptsIfLogged(0);
                    return;
                }
                var restored = err.data || {};
                var restoredAt = parseInt(restored.updatedAt, 10);
                if (!Array.isArray(restored.scripts) || !Array.isArray(restored.categories) || !isFinite(restoredAt) || restoredAt < 0) {
                    showToast('管理员恢复后的云端书签响应无效，本地数据未改动', 'error');
                    return;
                }
                if (typeof isScriptStorageCorrupt === 'function' && isScriptStorageCorrupt()) {
                    showToast('本地书签数据损坏，无法安全采用管理员恢复的云端副本', 'error');
                    return;
                }
                var restoredScripts = normalizeCloudScripts(restored.scripts);
                var restoredCategories = normalizeScriptCategories(restored.categories);
                cleanScriptCategoryReferences(restoredScripts, restoredCategories);
                if (!saveScriptWorkspaceAtomically(restoredScripts, restoredCategories, restoredAt, restored.revision, true)) {
                    showToast('浏览器存储失败，尚未采用管理员恢复的云端书签', 'error');
                    return;
                }
                refreshActiveScriptWorkspaceUI();
                updateAccountUI();
                setCloudStatus('已采用管理员恢复的云端书签', 'synced', 5000);
                showToast('管理员已恢复全站书签，本标签页已切换到恢复后的云端副本', 'info');
                return;
            }
            if (err && err.code === 'revision_conflict' && retryCount < 2 && scriptSyncSnapshotIsCurrent(snapshot)) {
                if (!reconcileCloudScriptConflict(err.data || {})) {
                    if (!silent) showToast('并发数据合并失败：浏览器存储不可用', 'error');
                    return;
                }
                syncScriptBookmarks('push', silent, retryCount + 1, true);
                return;
            }
            if (!scriptSyncSnapshotIsCurrent(snapshot)) {
                syncLocalScriptsIfLogged(0);
                return;
            }
            if (!silent) setCloudStatus('同步失败：' + (err.msg || '请稍后重试'), 'warn', 5000);
            if (!silent) showToast(err.msg || '同步失败', 'error');
        });
}

function syncLocalScriptsIfLogged(delay) {
    if (!currentAccount || !currentAccount.username) return;
    if (scriptSyncTimer) clearTimeout(scriptSyncTimer);
    scriptSyncTimerAccount = currentAccount.username;
    delay = typeof delay === 'number' && delay >= 0 ? delay : 350;
    scriptSyncTimer = setTimeout(function () {
        scriptSyncTimer = null;
        var timerAccount = scriptSyncTimerAccount;
        scriptSyncTimerAccount = '';
        if (!currentAccount || currentAccount.username !== timerAccount) return;
        syncScriptBookmarks('push', true);
    }, delay);
}

function setVersionStatus(text, cls) {
    var el = document.getElementById('updateVersionStatus');
    if (!el) return;
    el.className = 'update-version-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
}

function compareAppVersions(a, b) {
    var left = String(a == null ? '' : a).trim().split('.');
    var right = String(b == null ? '' : b).trim().split('.');
    var length = Math.max(left.length, right.length);
    for (var i = 0; i < length; i++) {
        var leftPart = parseInt(left[i] || '0', 10) || 0;
        var rightPart = parseInt(right[i] || '0', 10) || 0;
        if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1;
    }
    return 0;
}

function setVersionLabels(data) {
    data = data || {};
    var cur = document.getElementById('currentVersionLabel');
    var remote = document.getElementById('remoteVersionLabel');
    function clean(v, fallback) {
        v = (v == null ? '' : String(v)).trim();
        return /^\d+(?:\.\d+){1,3}$/.test(v) ? v : fallback;
    }
    var embedded = clean(window.__WEBSSH_APP_VERSION__, '0.0.0');
    var current = clean(data.currentVersion || data.current || data.appVersion, embedded);
    var latest = clean(data.latestVersion || data.latest, current);
    // A cached remote version can come from the release that was running
    // before an update. Never let it make the settings page claim that the
    // remote release is older than the binary serving this page.
    if (compareAppVersions(latest, current) < 0) latest = current;
    if (cur) cur.textContent = current;
    if (remote) remote.textContent = latest;
}

function loadVersionCache() {
    var embedded = String(window.__WEBSSH_APP_VERSION__ || '').trim();
    var cached = null;
    try { cached = JSON.parse(safeStorageGet(VERSION_CACHE_KEY, 'null')); } catch (e) { cached = null; }
    if (!cached || typeof cached !== 'object') cached = {};
    setVersionLabels({
        currentVersion: embedded || cached.currentVersion,
        latestVersion: cached.latestVersion || embedded || cached.currentVersion
    });
    var cachedLatest = String(cached.latestVersion || '').trim();
    var currentVersion = String(embedded || cached.currentVersion || '').trim();
    if (cached.checkedAt && cachedLatest && compareAppVersions(cachedLatest, currentVersion) >= 0) {
        setVersionStatus('上次检测：' + new Date(cached.checkedAt).toLocaleString() + ' · 远端 ' + cachedLatest, '');
    }
}

function applyRunningAppVersion(version) {
    version = String(version || '').trim();
    if (!version) return;
    window.__WEBSSH_APP_VERSION__ = version;
    var cached = null;
    try { cached = JSON.parse(safeStorageGet(VERSION_CACHE_KEY, 'null')); } catch (e) { cached = null; }
    setVersionLabels({
        currentVersion: version,
        latestVersion: cached && cached.latestVersion ? cached.latestVersion : version
    });
}

function saveVersionCache(data) {
    data = data || {};
    var cache = {
        currentVersion: String(data.currentVersion || data.current || window.__WEBSSH_APP_VERSION__ || '').trim(),
        latestVersion: String(data.latestVersion || data.latest || data.currentVersion || data.current || window.__WEBSSH_APP_VERSION__ || '').trim(),
        checkedAt: Date.now()
    };
    safeStorageSet(VERSION_CACHE_KEY, JSON.stringify(cache));
    return cache;
}

function requireAdminForUpdate() {
    if (!currentAccount || !currentAccount.username) {
        openAuthModal('login');
        showToast('请登录管理员账号后使用', 'info');
        return false;
    }
    if (!currentAccount.isAdmin) {
        showToast('请登录管理员账号后使用', 'error');
        return false;
    }
    return true;
}

function checkVersionUpdate() {
    if (!requireAdminForUpdate()) return;
    var activeTask = loadActiveVersionUpdate();
    if (activeTask) {
        setVersionStatus('更新任务仍在运行，正在恢复进度...', 'warn');
        pollVersionUpdateStatus(activeTask.updater, activeTask);
        return;
    }
    setVersionStatus('正在检测远端版本...', '');
    apiJSON('/api/admin/version')
        .then(function (res) {
            var data = res.data || {};
            setVersionLabels(data);
            saveVersionCache(data);
            if (data.available === false) {
                setVersionStatus(data.msg || '当前部署不支持页面更新', 'warn');
            } else if (data.hasUpdate) {
                setVersionStatus('检测到新版本，可以更新。', 'warn');
            } else {
                setVersionStatus('当前已经是最新版本。', 'ok');
            }
            showToast('版本检测完成', 'success');
        })
        .catch(function (err) {
            setVersionStatus(err.msg || '版本检测失败', 'err');
            showToast(err.msg || '版本检测失败', 'error');
        });
}

function compactUpdateLog(logs) {
    logs = String(logs || '').trim();
    if (!logs) return '';
    var lines = logs.split(/\r?\n/).filter(Boolean);
    return lines.slice(-4).join(' / ').slice(-260);
}

function normalizeActiveVersionUpdate(task) {
    if (!task || typeof task !== 'object') return null;
    var updater = String(task.updater || '').trim();
    if (updater && !/^webssh-updater-[0-9]+$/.test(updater)) return null;
    var startedAt = parseInt(task.startedAt, 10) || 0;
    if (!startedAt) return null;
    return {
        updater: updater,
        startedAt: startedAt,
        targetVersion: String(task.targetVersion || '').trim(),
        force: !!task.force
    };
}

function loadActiveVersionUpdate() {
    var task = null;
    try { task = JSON.parse(safeStorageGet(ACTIVE_VERSION_UPDATE_KEY, 'null')); } catch (e) { task = null; }
    return normalizeActiveVersionUpdate(task);
}

function saveActiveVersionUpdate(task) {
    task = normalizeActiveVersionUpdate(task);
    if (!task) return null;
    safeStorageSet(ACTIVE_VERSION_UPDATE_KEY, JSON.stringify(task));
    return task;
}

function clearActiveVersionUpdate() {
    safeStorageRemove(ACTIVE_VERSION_UPDATE_KEY);
}

function stopVersionUpdatePolling() {
    if (versionUpdatePollTimer) {
        clearTimeout(versionUpdatePollTimer);
        versionUpdatePollTimer = null;
    }
    versionUpdatePollActive = false;
    versionUpdatePollGeneration++;
}

function resumeVersionUpdateIfNeeded() {
    if (!currentAccount || !currentAccount.isAdmin) return;
    var task = loadActiveVersionUpdate();
    if (!task) return;
    // A task older than one day cannot reasonably still be a normal image build.
    // Remove only the browser marker; the updater container and its logs remain on
    // the server for manual inspection.
    if (Date.now() - task.startedAt > 24 * 60 * 60 * 1000) {
        clearActiveVersionUpdate();
        return;
    }
    if (versionUpdatePollActive && versionUpdateResumeAccount === currentAccount.username) return;
    versionUpdateResumeAccount = currentAccount.username;
    setVersionStatus('检测到未完成的更新任务，正在恢复进度...', 'warn');
    pollVersionUpdateStatus(task.updater, task);
}

function pollVersionUpdateStatus(updater, options) {
    stopVersionUpdatePolling();
    options = options || {};
    var task = loadActiveVersionUpdate() || {};
    if (typeof updater === 'string') task.updater = updater.trim();
    task.startedAt = parseInt(options.startedAt || task.startedAt, 10) || Date.now();
    task.targetVersion = String(options.targetVersion || task.targetVersion || '').trim();
    task.force = options.force === undefined ? !!task.force : !!options.force;
    task = saveActiveVersionUpdate(task) || task;
    var generation = versionUpdatePollGeneration;
    versionUpdatePollActive = true;

    function schedule(delay) {
        if (!versionUpdatePollActive || generation !== versionUpdatePollGeneration) return;
        versionUpdatePollTimer = setTimeout(tick, delay);
    }

    function finishSuccess(data, logs) {
        stopVersionUpdatePolling();
        clearActiveVersionUpdate();
        setVersionStatus('更新完成，健康检查已通过，正在刷新页面...' + (logs ? ' · ' + logs : ''), 'ok');
        showToast('更新完成，正在刷新页面', 'success');
        apiJSON('/api/admin/version')
            .then(function (res) {
                var versionData = res.data || {};
                setVersionLabels(versionData);
                saveVersionCache(versionData);
            })
            .catch(function () {
                if (task.targetVersion) applyRunningAppVersion(task.targetVersion);
            })
            .finally(function () {
                setTimeout(function () { location.reload(); }, 2500);
            });
    }

    function tick() {
        if (!versionUpdatePollActive || generation !== versionUpdatePollGeneration) return;
        versionUpdatePollTimer = null;
        var statusURL = '/api/admin/update/status';
        if (task.updater) statusURL += '?updater=' + encodeURIComponent(task.updater);
        apiJSON(statusURL)
            .then(function (res) {
                if (!versionUpdatePollActive || generation !== versionUpdatePollGeneration) return;
                var data = res.data || {};
                var logs = compactUpdateLog(data.logs);
                if (!task.updater && data.updater) {
                    var createdAt = (parseInt(data.createdAt, 10) || 0) * 1000;
                    if (createdAt && createdAt + 10000 < task.startedAt) {
                        setVersionStatus('更新请求已发出，正在等待本次任务启动...', 'warn');
                        schedule(5000);
                        return;
                    }
                    task.updater = String(data.updater || '').trim();
                    saveActiveVersionUpdate(task);
                }
                if (data.success) {
                    finishSuccess(data, logs);
                    return;
                }
                if (data.failed) {
                    stopVersionUpdatePolling();
                    clearActiveVersionUpdate();
                    setVersionStatus('更新失败：' + (logs || data.error || '请查看 Docker 日志'), 'err');
                    showToast('更新失败，已显示日志末尾', 'error');
                    return;
                }
                setVersionStatus('更新进行中...' + (logs ? ' · ' + logs : ''), 'warn');
                schedule(5000);
            })
            .catch(function (err) {
                if (!versionUpdatePollActive || generation !== versionUpdatePollGeneration) return;
                if (err && (err.status === 401 || err.status === 403)) {
                    stopVersionUpdatePolling();
                    setVersionStatus('更新任务仍在后台运行；请重新登录管理员账号后继续查看。', 'warn');
                    return;
                }
                if (Date.now() - task.startedAt > 90 * 60 * 1000) {
                    stopVersionUpdatePolling();
                    setVersionStatus('更新任务跟踪已暂停，但没有判定失败；刷新页面后可继续读取任务状态。', 'warn');
                    return;
                }
                setVersionStatus('更新中，构建可能较慢或服务正在重启；连接恢复后会自动继续...', 'warn');
                schedule(5000);
            });
    }
    tick();
}

function runVersionUpdate() {
    if (!requireAdminForUpdate()) return;
    var force = !!document.getElementById('forceUpdateVersion').checked;
    var remoteLabel = document.getElementById('remoteVersionLabel');
    var task = saveActiveVersionUpdate({
        updater: '',
        startedAt: Date.now(),
        targetVersion: remoteLabel ? remoteLabel.textContent : '',
        force: force
    });
    stopVersionUpdatePolling();
    setVersionStatus(force ? '正在启动强制更新任务，请稍候...' : '正在启动更新任务，请稍候...', 'warn');
    apiJSON('/api/admin/update', { method: 'POST', body: { force: force } })
        .then(function (res) {
            var updater = res.data && res.data.updater ? res.data.updater : '';
            if (!updater) {
                clearActiveVersionUpdate();
                if (res.data) {
                    setVersionLabels(res.data);
                    saveVersionCache(res.data);
                }
                setVersionStatus(res.msg || '当前已经是最新版本。', 'ok');
                showToast(res.msg || '当前已经是最新版本', 'success');
                return;
            }
            task = task || { startedAt: Date.now(), force: force };
            task.updater = updater;
            if (res.data && res.data.version) {
                task.targetVersion = String(res.data.version.latestVersion || res.data.version.latest || task.targetVersion || '').trim();
            }
            saveActiveVersionUpdate(task);
            setVersionStatus((res.msg || '更新任务已启动') + '。正在跟踪构建日志...', 'warn');
            showToast(res.msg || '更新任务已启动', 'success');
            pollVersionUpdateStatus(updater, task);
        })
        .catch(function (err) {
            if (!err || !err.msg) {
                setVersionStatus('更新请求可能已发出，正在自动查找并跟踪任务...', 'warn');
                showToast('连接暂时中断，正在继续确认更新状态', 'info');
                pollVersionUpdateStatus('', task || { startedAt: Date.now(), force: force });
                return;
            }
            clearActiveVersionUpdate();
            var output = err.data && err.data.output ? ('：' + err.data.output.slice(-160)) : '';
            setVersionStatus((err.msg || '更新失败') + output, 'err');
            showToast(err.msg || '更新失败', 'error');
        });
}

function renderConnBookmarks() {
    var l = document.getElementById('connBookmarkList'), bms = loadBM(CBK);
    if (!bms.length) { l.innerHTML = '<div class="bm-empty">暂无书签</div>'; return; }
    l.innerHTML = bms.map(function (b, i) {
        return '<div class="bm-item" onclick="applyConn(' + i + ')"><div class="bm-item-info"><div class="bm-item-name">' + esc(b.username + '@' + b.hostname) + '</div><div class="bm-item-host">:' + (b.port || 22) + '</div></div><button class="bm-item-del" onclick="event.stopPropagation();delConn(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
    }).join('');
}

function saveConnBookmark() {
    var hp = parseHostPortInput(document.getElementById('hostname').value, document.getElementById('port').value);
    var h = hp.host, p = hp.port, u = document.getElementById('username').value.trim() || 'root';
    if (!h) { showToast('请先填写主机', 'error'); return; }
    document.getElementById('hostname').value = formatHostForInput(h);
    document.getElementById('port').value = p;
    var at = document.querySelector('.auth-tab.active').dataset.tab;
    var bm = { hostname: h, port: p, username: u, authType: at };
    if (savePasswords && at === 'password') bm.password = document.getElementById('password').value;
    var bms = loadBM(CBK), idx = bms.findIndex(function (b) { return b.hostname === h && b.port === p && b.username === u; });
    if (idx >= 0) bms[idx] = bm; else bms.push(bm);
    if (!saveBM(CBK, bms)) { showToast('浏览器存储失败，连接书签未保存', 'error'); return; }
    renderConnBookmarks(); showToast('已保存', 'success');
}

function applyConn(i) {
    var b = loadBM(CBK)[i]; if (!b) return;
    var hp = parseHostPortInput(b.hostname, b.port);
    document.getElementById('hostname').value = formatHostForInput(hp.host);
    document.getElementById('port').value = hp.port;
    document.getElementById('username').value = b.username || 'root';
    document.getElementById('password').value = '';
    document.getElementById('privateKey').value = '';
    document.getElementById('passphrase').value = '';
    if (b.authType === 'key') switchAuthTab('key');
    else {
        switchAuthTab('password');
        document.getElementById('password').value = savePasswords && b.password ? b.password : '';
    }
    showToast('已填入', 'info');
}

function delConn(i) { var bms = loadBM(CBK); bms.splice(i, 1); if (!saveBM(CBK, bms)) { showToast('浏览器存储失败，连接书签未删除', 'error'); return; } renderConnBookmarks(); showToast('已删除', 'info'); }

// ==================== Preset Scripts ====================
var PRESET_SCRIPTS = [
    { name: '切换到 root', cmd: 'sudo -i' },
    { name: '重新启动', cmd: 'reboot' },
    { name: '关机', cmd: 'shutdown -h now' },
    { name: '修改 root 密码', cmd: 'passwd root' },
    { name: '查看系统信息', cmd: 'uname -a' },
    { name: '查看系统时间', cmd: 'date && timedatectl 2>/dev/null' },
    { name: '查看磁盘使用', cmd: 'df -h' },
    { name: '查看内存使用', cmd: 'free -h' },
    { name: '查看 CPU 信息', cmd: 'lscpu | head -20' },
    { name: '查看网络接口', cmd: 'ip addr show' },
    { name: '查看端口监听', cmd: 'ss -tlnp' },
    { name: '查看进程列表', cmd: 'ps aux --sort=-%mem | head -20' },
    { name: '查看登录记录', cmd: 'last -20' },
    { name: '查看系统日志', cmd: 'journalctl -xe --no-pager | tail -50' },
    { name: 'Debian 切换阿里云源', cmd: "sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list && apt update" },
    { name: 'Ubuntu 切换阿里云源', cmd: "sed -i 's|archive.ubuntu.com|mirrors.aliyun.com|g' /etc/apt/sources.list && apt update" },
    { name: 'CentOS 切换阿里云源', cmd: "sed -i 's|mirror.centos.org|mirrors.aliyun.com|g' /etc/yum.repos.d/CentOS-*.repo && yum makecache" },
    { name: 'Debian/Ubuntu 安装常用工具', cmd: 'apt update && apt install -y sudo wget curl vim net-tools' },
    { name: 'CentOS 安装常用工具', cmd: 'yum install -y sudo wget curl vim net-tools' },
    { name: '安装 Docker', cmd: 'curl -fsSL https://get.docker.com | sh' },
    { name: '启动 Docker', cmd: 'systemctl enable docker && systemctl start docker' },
    { name: '查看 Docker 容器', cmd: 'docker ps -a' },
    { name: '查看 Docker 镜像', cmd: 'docker images' },
    { name: '安装 Docker Compose', cmd: 'curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose && chmod +x /usr/local/bin/docker-compose' },
    { name: '开启 BBR 加速', cmd: 'echo "net.core.default_qdisc=fq" >> /etc/sysctl.conf && echo "net.ipv4.tcp_congestion_control=bbr" >> /etc/sysctl.conf && sysctl -p' },
    { name: '查看 BBR 状态', cmd: 'sysctl net.ipv4.tcp_congestion_control && lsmod | grep bbr' },
    { name: '防火墙关闭 (Debian)', cmd: 'systemctl stop ufw 2>/dev/null; iptables -F; echo "防火墙已关闭"' },
    { name: '防火墙关闭 (CentOS)', cmd: 'systemctl stop firewalld && systemctl disable firewalld && echo "防火墙已关闭"' },
    { name: '修改 SSH 端口', cmd: 'read -p "输入新端口: " p && sed -i "s/^#*Port .*/Port $p/" /etc/ssh/sshd_config && systemctl restart sshd && echo "SSH端口已改为 $p"' },
    { name: '允许 root SSH 登录', cmd: 'sed -i "s/^#*PermitRootLogin.*/PermitRootLogin yes/" /etc/ssh/sshd_config && systemctl restart sshd && echo "已允许root登录"' },
    { name: '测速 (speedtest)', cmd: 'curl -sL https://raw.githubusercontent.com/sivel/speedtest-cli/master/speedtest.py | python3' },
    { name: '查看公网 IP', cmd: 'curl -s ip.sb && echo ""' },
    { name: '清理系统日志', cmd: 'journalctl --vacuum-size=50M && echo "日志已清理"' },
    { name: '更新系统 (Debian/Ubuntu)', cmd: 'apt update && apt upgrade -y' },
    { name: '更新系统 (CentOS)', cmd: 'yum update -y' },
    { name: '查看定时任务', cmd: 'crontab -l 2>/dev/null; echo "---系统级---"; cat /etc/crontab' }
];
var showPresets = false;

function presetScriptKey(preset) {
    return String(preset && preset.name || '') + '\n' + String(preset && preset.cmd || '');
}

function loadPresetUsage() {
    try {
        var usage = JSON.parse(safeStorageGet(scriptStorageKey(PRESET_USAGE_KEY), '{}'));
        return usage && typeof usage === 'object' && !Array.isArray(usage) ? usage : {};
    } catch (e) { return {}; }
}

function sortedPresetScripts() {
    var usage = loadPresetUsage();
    return PRESET_SCRIPTS.map(function (preset, sourceIndex) {
        var stats = usage[presetScriptKey(preset)] || {};
        return { preset: preset, sourceIndex: sourceIndex, useCount: parseInt(stats.useCount, 10) || 0, lastUsed: parseInt(stats.lastUsed, 10) || 0 };
    }).sort(function (a, b) {
        if (b.lastUsed !== a.lastUsed) return b.lastUsed - a.lastUsed;
        if (b.useCount !== a.useCount) return b.useCount - a.useCount;
        return a.sourceIndex - b.sourceIndex;
    });
}

function recordPresetUsage(preset) {
    var usage = loadPresetUsage();
    var key = presetScriptKey(preset);
    var current = usage[key] || {};
    usage[key] = { useCount: (parseInt(current.useCount, 10) || 0) + 1, lastUsed: Date.now() };
    return safeStorageSet(scriptStorageKey(PRESET_USAGE_KEY), JSON.stringify(usage));
}

function scriptBookmarkKey(b) {
    if (b && typeof b.id === 'string' && b.id.trim()) return 'id:' + b.id.trim();
    return ((b && b.name ? b.name : '').trim()) + '\n' + ((b && b.cmd ? b.cmd : '').trim());
}

function normalizeScriptSearchText(value) {
    return String(value == null ? '' : value).toLocaleLowerCase().replace(/\s+/g, ' ').trim();
}

function parseScriptUseCount(b) {
    if (!b) return 0;
    var v = parseInt(b.useCount != null ? b.useCount : (b.usageCount != null ? b.usageCount : b.count), 10);
    return isFinite(v) && v > 0 ? v : 0;
}

function parseScriptLastUsed(b) {
    if (!b) return 0;
    var raw = b.lastUsed != null ? b.lastUsed : (b.lastRunAt != null ? b.lastRunAt : b.usedAt);
    var v = parseInt(raw, 10);
    if (!(isFinite(v) && v > 0) && typeof raw === 'string') v = Date.parse(raw);
    return isFinite(v) && v > 0 ? v : 0;
}

function sortScriptBookmarks(bms) {
    if (!Array.isArray(bms) || bms.length < 2) return false;
    var before = bms.map(function (b) { return scriptBookmarkKey(b) + '\u0000' + parseScriptUseCount(b) + '\u0000' + parseScriptLastUsed(b); }).join('\u0001');
    bms.forEach(function (b, i) { if (b) b.__scriptSortIndex = i; });
    bms.sort(function (a, b) {
        var at = parseScriptLastUsed(a), bt = parseScriptLastUsed(b);
        if (bt !== at) return bt - at;
        var au = parseScriptUseCount(a), bu = parseScriptUseCount(b);
        if (bu !== au) return bu - au;
        return (a.__scriptSortIndex || 0) - (b.__scriptSortIndex || 0);
    });
    bms.forEach(function (b) { if (b) delete b.__scriptSortIndex; });
    var after = bms.map(function (b) { return scriptBookmarkKey(b) + '\u0000' + parseScriptUseCount(b) + '\u0000' + parseScriptLastUsed(b); }).join('\u0001');
    return before !== after;
}

function loadSortedScriptBookmarks() {
    var bms = normalizeImportedScripts(loadBM(SBK));
    if (sortScriptBookmarks(bms) && !scriptStorageSet(SBK, JSON.stringify(bms))) return [];
    return bms;
}

function categoryMapFromList(categories) {
    var map = {};
    categories.forEach(function (cat) { map[cat.id] = cat; });
    return map;
}

function scriptCategoryBadgeHtml(b, categoryMap) {
    var cat = b.categoryId ? categoryMap[b.categoryId] : null;
    if (cat) return '<button class="script-category-badge" type="button" data-category-id="' + escAttr(cat.id) + '" onclick="event.stopPropagation();setScriptCategoryFilter(this.dataset.categoryId)" title="分类：' + escAttr(cat.name) + '">' + esc(cat.emoji) + '</button>';
    return '<button class="script-category-badge uncategorized" type="button" data-category-id="__uncategorized__" onclick="event.stopPropagation();setScriptCategoryFilter(this.dataset.categoryId)" title="未分类">▫️</button>';
}

function scriptBookmarkItemHtml(b, i, categoryMap) {
    var name = b.name || '';
    var cmd = b.cmd || '';
    return '<div class="bm-item" data-script-row="1" data-script-index="' + i + '" onclick="event.stopPropagation();runScript(' + i + ')" title="' + escAttr(cmd) + '">' + scriptCategoryBadgeHtml(b, categoryMap || categoryMapFromList(loadScriptCategories())) + '<div class="bm-item-info"><div class="bm-item-name">' + esc(name) + '</div><div class="bm-item-host">' + esc(cmd.substring(0, 52)) + '</div></div><div class="bm-item-actions"><span class="bm-item-run">▶</span><button class="bm-item-icon-btn bm-item-edit" title="编辑脚本" onclick="event.stopPropagation();openEditScriptModal(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg></button><button class="bm-item-del" title="删除脚本" onclick="event.stopPropagation();delScript(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>';
}

function presetScriptItemHtml(p, i) {
    return '<div class="bm-item preset-script-item" onclick="event.stopPropagation();runPresetScript(' + i + ')" title="' + escAttr(p.cmd) + '"><span class="script-category-badge preset-badge" title="推荐脚本">📦</span><div class="bm-item-info"><div class="bm-item-name">' + esc(p.name) + '</div><div class="bm-item-host">' + esc(p.cmd.substring(0, 52)) + '</div></div><span class="bm-item-run">▶</span></div>';
}

function rebuildScriptSearchIndex(bms) {
    scriptSearchIndex = [];
    sortedPresetScripts().forEach(function (entry) {
        var p = entry.preset;
        scriptSearchIndex.push({ type: 'preset', index: entry.sourceIndex, search: normalizeScriptSearchText((p.name || '') + ' ' + (p.cmd || '')) });
    });
    bms.forEach(function (b, i) {
        scriptSearchIndex.push({ type: 'bookmark', index: i, categoryId: b.categoryId || '', search: normalizeScriptSearchText((b.name || '') + ' ' + (b.cmd || '')) });
    });
}

function scheduleScriptSearch(value) {
    scriptSearchQuery = normalizeScriptSearchText(value);
    var clear = document.getElementById('scriptSearchClear');
    if (clear) clear.classList.toggle('show', !!scriptSearchQuery);
    if (scriptSearchFrame) cancelAnimationFrame(scriptSearchFrame);
    scriptSearchFrame = requestAnimationFrame(function () {
        scriptSearchFrame = 0;
        renderScriptBookmarks(true);
    });
}

function clearScriptSearch() {
    var input = document.getElementById('scriptSearchInput');
    if (input) { input.value = ''; input.focus(); }
    scheduleScriptSearch('');
}

function setScriptCategoryFilter(categoryId) {
    activeScriptCategory = categoryId || '';
    showPresets = false;
    renderScriptBookmarks();
}

function renderScriptCategoryFilters(categories, bms) {
    var wrap = document.getElementById('scriptCategoryFilters');
    if (!wrap) return;
    var counts = {};
    bms.forEach(function (b) {
        if (b.categoryId) counts[b.categoryId] = (counts[b.categoryId] || 0) + 1;
    });
    if (activeScriptCategory && !getScriptCategory(activeScriptCategory, categories)) activeScriptCategory = '';
    var html = '<button type="button" class="script-category-filter' + (!activeScriptCategory ? ' active' : '') + '" data-category-id="" onclick="event.stopPropagation();setScriptCategoryFilter(this.dataset.categoryId)" title="全部脚本">📚<small>全部</small></button>';
    categories.forEach(function (cat) {
        html += '<button type="button" class="script-category-filter' + (activeScriptCategory === cat.id ? ' active' : '') + '" data-category-id="' + escAttr(cat.id) + '" onclick="event.stopPropagation();setScriptCategoryFilter(this.dataset.categoryId)" title="' + escAttr(cat.name) + '（' + (counts[cat.id] || 0) + '）">' + esc(cat.emoji) + '</button>';
    });
    html += '<button type="button" class="script-category-filter category-add-shortcut" onclick="event.stopPropagation();openScriptManager(&quot;categories&quot;)" title="管理分类">＋</button>';
    wrap.innerHTML = html;
}
function bookmarkMatchesActiveCategory(b) {
    if (!activeScriptCategory) return true;
    if (activeScriptCategory === '__uncategorized__') return !b.categoryId;
    return b.categoryId === activeScriptCategory;
}

function replaceScriptBookmarkListHtml(list, html) {
    var previousScrollTop = list.scrollTop;
    list.innerHTML = html;
    var maxScrollTop = Math.max(0, list.scrollHeight - list.clientHeight);
    list.scrollTop = Math.min(previousScrollTop, maxScrollTop);
}

function renderScriptBookmarks(searchOnly) {
    var l = document.getElementById('scriptBookmarkList');
    if (!l) return;
    var bms = loadSortedScriptBookmarks();
    var categories = loadScriptCategories();
    var categoryMap = categoryMapFromList(categories);
    renderScriptCategoryFilters(categories, bms);
    if (!searchOnly || !scriptSearchIndex.length) rebuildScriptSearchIndex(bms);
    var html = '';

    if (scriptSearchQuery) {
        var matches = scriptSearchIndex.filter(function (entry) {
            if (entry.search.indexOf(scriptSearchQuery) < 0) return false;
            if (entry.type === 'preset') return !activeScriptCategory;
            return bookmarkMatchesActiveCategory(bms[entry.index] || {});
        });
        var presetMatches = matches.filter(function (entry) { return entry.type === 'preset'; });
        var bookmarkMatches = matches.filter(function (entry) { return entry.type === 'bookmark'; });
        if (presetMatches.length) {
            html += '<div class="script-list-section"><span>📦 推荐脚本</span><small>' + presetMatches.length + '</small></div>';
            html += presetMatches.map(function (entry) { return presetScriptItemHtml(PRESET_SCRIPTS[entry.index], entry.index); }).join('');
        }
        if (bookmarkMatches.length) {
            html += '<div class="script-list-section"><span>⭐ 我的脚本</span><small>' + bookmarkMatches.length + '</small></div>';
            html += bookmarkMatches.map(function (entry) { return scriptBookmarkItemHtml(bms[entry.index], entry.index, categoryMap); }).join('');
        }
        if (!matches.length) html = '<div class="bm-empty script-search-empty"><b>🔍</b><span>没有找到匹配脚本</span><small>可搜索名称、完整命令或命令片段</small></div>';
        replaceScriptBookmarkListHtml(l, html);
        return;
    }

    if (showPresets && !activeScriptCategory) {
        html = '<div class="bm-item preset-back" onclick="event.stopPropagation();showPresets=false;renderScriptBookmarks()"><div class="bm-item-info"><div class="bm-item-name" style="color:var(--c1)">‹ 返回我的脚本</div></div></div>';
        html += sortedPresetScripts().map(function (entry) { return presetScriptItemHtml(entry.preset, entry.sourceIndex); }).join('');
        replaceScriptBookmarkListHtml(l, html);
        return;
    }

    if (!activeScriptCategory) html += '<div class="bm-item preset-entry" onclick="event.stopPropagation();showPresets=true;renderScriptBookmarks()"><span class="script-category-badge preset-badge">📦</span><div class="bm-item-info"><div class="bm-item-name" style="color:var(--c1)">推荐脚本</div><div class="bm-item-host">点击查看常用命令，也可在上方直接搜索</div></div><span class="bm-item-run" style="color:var(--c1)">›</span></div>';
    var visible = bms.map(function (b, i) { return { bookmark: b, index: i }; }).filter(function (entry) { return bookmarkMatchesActiveCategory(entry.bookmark); });
    if (visible.length) html += visible.map(function (entry) { return scriptBookmarkItemHtml(entry.bookmark, entry.index, categoryMap); }).join('');
    else html += '<div class="bm-empty">' + (activeScriptCategory ? '此分类暂无脚本' : '暂无自定义脚本') + '</div>';
    replaceScriptBookmarkListHtml(l, html);
}

function mergeScriptBookmarksIncremental(incoming, updatedAt, replaceExisting) {
    incoming = normalizeCloudScripts(incoming);
    if (replaceExisting) {
        sortScriptBookmarks(incoming);
        if (!saveScriptBookmarksData(incoming, updatedAt, true)) return { scripts: incoming, added: 0, capacitySkipped: 0, storageError: true };
        rebuildScriptSearchIndex(incoming);
        return { scripts: incoming, added: 0, capacitySkipped: 0 };
    }
    var current = loadSortedScriptBookmarks();
    var seen = {};
    current.forEach(function (b) { seen[scriptBookmarkKey(b)] = true; });
    var added = [], capacitySkipped = 0;
    incoming.forEach(function (b) {
        var key = scriptBookmarkKey(b);
        if (!key.trim() || seen[key]) return;
        if (current.length >= MAX_SCRIPT_BOOKMARKS) { capacitySkipped++; return; }
        current.push(b);
        added.push(b);
        seen[key] = true;
    });
    if (added.length || updatedAt) {
        sortScriptBookmarks(current);
        if (!saveScriptBookmarksData(current, updatedAt, true)) return { scripts: current, added: added.length, capacitySkipped: capacitySkipped, storageError: true };
    }
    rebuildScriptSearchIndex(current);
    return { scripts: current, added: added.length, capacitySkipped: capacitySkipped };
}

function runPresetScript(i) {
    var preset = PRESET_SCRIPTS[i];
    if (!preset) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    confirmRunCommand(preset.name, preset.cmd, function () {
        if (activeIdx < 0 || !sessions[activeIdx]) { showToast('无活动连接', 'error'); return; }
        if (!sendCommandToSession(sessions[activeIdx], preset.cmd)) { showToast('无活动连接', 'error'); return; }
        showToast('已执行: ' + preset.name, 'success');
        sessions[activeIdx].term.focus();
        if (!recordPresetUsage(preset)) showToast('浏览器存储失败，推荐脚本排序未保存', 'error');
        renderScriptBookmarks();
    });
}

function renderEditScriptCategoryOptions(selected) {
    var wrap = document.getElementById('editScriptCategoryOptions');
    if (!wrap) return;
    var categories = loadScriptCategories();
    var html = '<button type="button" class="' + (!selected ? 'active' : '') + '" data-category-id="" onclick="selectEditScriptCategory(this.dataset.categoryId)">▫️ 未分类</button>';
    categories.forEach(function (cat) {
        html += '<button type="button" class="' + (selected === cat.id ? 'active' : '') + '" data-category-id="' + escAttr(cat.id) + '" onclick="selectEditScriptCategory(this.dataset.categoryId)" title="' + escAttr(cat.name) + '">' + esc(cat.emoji) + ' ' + esc(cat.name) + '</button>';
    });
    wrap.innerHTML = html;
}

function selectEditScriptCategory(categoryId) {
    var hidden = document.getElementById('editScriptCategory');
    if (hidden) hidden.value = categoryId || '';
    renderEditScriptCategoryOptions(categoryId || '');
}

function openAddScriptModal() {
    openScriptModal(-1, null);
}

function openEditScriptModal(i) {
    var b = loadSortedScriptBookmarks()[i];
    if (!b) return;
    openScriptModal(i, b);
}

function openScriptModal(i, bookmark) {
    var editing = i >= 0 && bookmark;
    document.getElementById('editScriptIndex').value = editing ? i : -1;
    document.getElementById('editScriptId').value = editing ? (bookmark.id || '') : '';
    document.getElementById('editScriptName').value = editing ? (bookmark.name || '') : '';
    document.getElementById('editScriptContent').value = editing ? (bookmark.cmd || '') : '';
    document.getElementById('editScriptCategory').value = editing ? (bookmark.categoryId || '') : (activeScriptCategory && activeScriptCategory !== '__uncategorized__' ? activeScriptCategory : '');
    var title = document.getElementById('editScriptModalTitle');
    if (title) title.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg>' + (editing ? '编辑脚本' : '添加脚本');
    var saveBtn = document.getElementById('editScriptSaveBtn');
    if (saveBtn) saveBtn.textContent = editing ? '保存修改' : '添加脚本';
    renderEditScriptCategoryOptions(document.getElementById('editScriptCategory').value);
    document.getElementById('editScriptModal').classList.add('show');
    setTimeout(function () { var input = document.getElementById('editScriptName'); if (input) input.focus(); }, 60);
}

function hideEditScriptModal() {
    var modal = document.getElementById('editScriptModal');
    if (modal) modal.classList.remove('show');
    ['editScriptIndex','editScriptId','editScriptName','editScriptContent','editScriptCategory'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = id === 'editScriptIndex' ? '-1' : '';
    });
}

function saveEditedScriptBookmark() {
    var idx = parseInt(document.getElementById('editScriptIndex').value, 10);
    var targetId = document.getElementById('editScriptId').value.trim();
    var name = document.getElementById('editScriptName').value.trim();
    var cmd = document.getElementById('editScriptContent').value.trim();
    var categoryId = document.getElementById('editScriptCategory').value.trim();
    if (!name || !cmd) { showToast('名称和命令不能为空', 'error'); return; }
    if (categoryId && !getScriptCategory(categoryId)) categoryId = '';
    var bms = loadSortedScriptBookmarks();
    var item = { name: name.slice(0, 80), cmd: cmd };
    if (categoryId) item.categoryId = categoryId;
    var editing = idx >= 0 && isFinite(idx);
    if (editing) {
        if (!bms[idx] || (targetId && bms[idx].id !== targetId)) {
            var targetIndex = bms.findIndex(function (entry) { return entry && entry.id === targetId; });
            if (targetIndex < 0) { hideEditScriptModal(); showToast('脚本已被其他标签页修改，请重新打开', 'warn'); return; }
            idx = targetIndex;
        }
        item = Object.assign({}, bms[idx], item);
        if (!categoryId) delete item.categoryId;
        bms[idx] = item;
    } else {
        if (bms.length >= MAX_SCRIPT_BOOKMARKS) { showToast('脚本数量已达到 ' + MAX_SCRIPT_BOOKMARKS + ' 个上限', 'error'); return; }
        item.id = createScriptBookmarkId();
        bms.push(item);
    }
    sortScriptBookmarks(bms);
    if (!saveBM(SBK, bms)) { showToast('浏览器存储失败，脚本未保存', 'error'); return; }
    hideEditScriptModal();
    renderScriptBookmarks();
    updateScriptManagerSummary();
    syncLocalScriptsIfLogged();
    showToast(editing ? '脚本已更新' : '脚本已添加', 'success');
}

function saveScriptBookmark() {
    openAddScriptModal();
}

var pendingRunCommand = null;

// 多行脚本一旦发出就会被逐行执行，没有中途反悔的机会，所以先把完整内容摊开让用户确认。
// 单行命令仍然点一下就跑，不打断日常操作。
function confirmRunCommand(name, cmd, onConfirm) {
    var dangerous = /(^|[;&|\n])\s*(reboot|shutdown|poweroff|halt|init\s+[06])\b|\b(iptables|ufw|firewalld|sshd|systemctl\s+(restart|stop|disable)|passwd\s+root)\b/i.test(cmd || '');
    if (commandLineCount(cmd) <= 1 && !dangerous) { onConfirm(); return; }
    var modal = document.getElementById('runScriptConfirmModal');
    if (!modal) { onConfirm(); return; }
    pendingRunCommand = onConfirm;
    var title = document.getElementById('runScriptConfirmTitle');
    var desc = document.getElementById('runScriptConfirmDescription');
    var preview = document.getElementById('runScriptConfirmCommand');
    if (title) title.textContent = '确定运行脚本“' + (name || '未命名脚本') + '”吗？';
    if (desc) desc.textContent = (dangerous ? '这是可能中断连接或修改系统安全设置的高风险命令。' : '这个脚本共 ' + commandLineCount(cmd) + ' 行。') + '确认后会在当前会话中执行。';
    if (preview) preview.textContent = cmd.replace(/\r\n?/g, '\n');
    modal.classList.add('show');
}

function hideRunScriptConfirmModal() {
    var modal = document.getElementById('runScriptConfirmModal');
    if (modal) modal.classList.remove('show');
    pendingRunCommand = null;
}

function confirmRunScript() {
    var run = pendingRunCommand;
    hideRunScriptConfirmModal();
    if (typeof run === 'function') run();
}

function runScript(i) {
    var bms = loadSortedScriptBookmarks();
    var b = bms[i]; if (!b) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    var name = b.name, cmd = b.cmd, targetId = b.id;
    confirmRunCommand(name, cmd, function () {
        if (activeIdx < 0 || !sessions[activeIdx]) { showToast('无活动连接', 'error'); return; }
        if (!sendCommandToSession(sessions[activeIdx], cmd)) { showToast('无活动连接', 'error'); return; }
        showToast('已执行: ' + name, 'success');
        sessions[activeIdx].term.focus();
        // 确认框是异步的，期间列表可能已被改动，索引对不上就不再改动排序数据。
        var list = loadSortedScriptBookmarks();
        var targetIndex = list.findIndex(function (entry) { return entry && entry.id === targetId; });
        var target = targetIndex >= 0 ? list[targetIndex] : null;
        if (!target || target.cmd !== cmd) return;
        list.splice(targetIndex, 1);
        list.unshift(Object.assign({}, target, { useCount: parseScriptUseCount(target) + 1, lastUsed: Date.now() }));
        if (!saveBM(SBK, list)) { showToast('浏览器存储失败，使用次数未保存', 'error'); return; }
        renderScriptBookmarks();
        syncLocalScriptsIfLogged();
    });
}

function delScript(i) {
    var bms = loadSortedScriptBookmarks();
    var bookmark = bms[i];
    if (!bookmark) return;
    pendingDeleteScriptIndex = i;
    pendingDeleteScriptId = bookmark.id || '';
    var title = document.getElementById('scriptDeleteTitle');
    var description = document.getElementById('scriptDeleteDescription');
    if (title) title.textContent = '确定删除脚本“' + (bookmark.name || '未命名脚本') + '”吗？';
    if (description) description.textContent = '删除后无法恢复，脚本命令也会一并移除。';
    var modal = document.getElementById('scriptDeleteModal');
    if (modal) modal.classList.add('show');
}

function hideScriptDeleteModal() {
    var modal = document.getElementById('scriptDeleteModal');
    if (modal) modal.classList.remove('show');
    pendingDeleteScriptIndex = -1;
    pendingDeleteScriptId = '';
}

function confirmDelScript() {
    var i = pendingDeleteScriptIndex;
    if (i < 0) return;
    var bms = loadSortedScriptBookmarks();
    var targetIndex = pendingDeleteScriptId ? bms.findIndex(function (entry) { return entry && entry.id === pendingDeleteScriptId; }) : i;
    if (targetIndex < 0 || !bms[targetIndex]) { hideScriptDeleteModal(); showToast('脚本已被其他标签页修改，请重新打开', 'warn'); return; }
    bms.splice(targetIndex, 1);
    if (!saveBM(SBK, bms)) { showToast('浏览器存储失败，脚本未删除', 'error'); return; }
    hideScriptDeleteModal();
    renderScriptBookmarks();
    updateScriptManagerSummary();
    syncLocalScriptsIfLogged();
    showToast('脚本已删除', 'info');
}

function openScriptManager(tab) {
    var modal = document.getElementById('scriptManagerModal');
    if (!modal) return;
    var drawer = document.getElementById('scriptDrawer');
    scriptManagerPreserveDrawer = !!(drawer && drawer.classList.contains('open'));
    var pageSize = document.getElementById('categoryPageSize');
    if (pageSize) pageSize.value = String(categoryManagerPageSize);
    renderEmojiPicker();
    renderCategoryManager();
    updateAccountUI();
    updateScriptManagerSummary();
    switchScriptManagerTab(tab || 'bookmarks');
    modal.classList.add('show');
}

function hideScriptManager() {
    var modal = document.getElementById('scriptManagerModal');
    if (modal) modal.classList.remove('show');
    resetCategoryEditor();
}

function switchScriptManagerTab(tab) {
    var categories = tab === 'categories';
    var bookmarkPanel = document.getElementById('scriptManagerBookmarks');
    var categoryPanel = document.getElementById('scriptManagerCategories');
    var title = document.getElementById('scriptManagerTitleText');
    if (bookmarkPanel) bookmarkPanel.style.display = categories ? 'none' : '';
    if (categoryPanel) categoryPanel.style.display = categories ? '' : 'none';
    if (title) title.textContent = categories ? '分类管理' : '书签管理';
    if (categories) renderCategoryManager();
}

function updateScriptManagerSummary(scriptCount, categoryCount) {
    var el = document.getElementById('scriptManagerSummary');
    if (!el) return;
    if (typeof scriptCount !== 'number') scriptCount = loadBM(SBK).length;
    if (typeof categoryCount !== 'number') categoryCount = loadScriptCategories().length;
    var accountName = currentAccount ? esc(currentAccount.username) : '未登录';
    var accountLabel = currentAccount ? (currentAccount.isAdmin ? '当前账号 · 管理员' : '当前账号') : '仅保存在本机';
    el.innerHTML = '<div class="script-manager-stat"><b>' + scriptCount + '</b><span>我的脚本</span></div>' +
        '<div class="script-manager-stat"><b>' + categoryCount + '</b><span>我的分类</span></div>' +
        '<div class="script-manager-stat account"><b>' + accountName + '</b><span>' + accountLabel + '</span></div>';
}

function renderEmojiPicker() {
    var wrap = document.getElementById('categoryEmojiPicker');
    if (!wrap || wrap.dataset.ready === '1') return;
    wrap.innerHTML = EMOJI_OPTIONS.map(function (emoji) {
        return '<button type="button" data-emoji="' + escAttr(emoji) + '" onclick="selectCategoryEmoji(this.dataset.emoji)" title="选择 ' + escAttr(emoji) + '">' + esc(emoji) + '</button>';
    }).join('');
    wrap.dataset.ready = '1';
    selectCategoryEmoji(document.getElementById('categoryEmoji').value || '🛠️');
}

function selectCategoryEmoji(emoji) {
    var hidden = document.getElementById('categoryEmoji');
    if (hidden) hidden.value = emoji || '📁';
    document.querySelectorAll('#categoryEmojiPicker button').forEach(function (btn) { btn.classList.toggle('active', btn.dataset.emoji === (emoji || '📁')); });
}

function resetCategoryEditor() {
    var id = document.getElementById('categoryEditId');
    var name = document.getElementById('categoryName');
    var save = document.getElementById('categorySaveBtn');
    if (id) id.value = '';
    if (name) name.value = '';
    if (save) save.textContent = '添加分类';
    selectCategoryEmoji('🛠️');
}

function preserveScriptDrawerAfterCategoryChange() {
    if (!scriptManagerPreserveDrawer) return;
    var drawer = document.getElementById('scriptDrawer');
    if (drawer) {
        var sftpPanel = document.getElementById('sftpPanel');
        if (sftpPanel) sftpPanel.classList.remove('open');
        drawer.classList.add('open');
    }
}

function updateVisibleScriptCategoryBadges(categoryId, category) {
    document.querySelectorAll('#scriptBookmarkList .script-category-badge').forEach(function (badge) {
        if (badge.dataset.categoryId !== categoryId) return;
        if (category) {
            badge.textContent = category.emoji;
            badge.title = '分类：' + category.name;
            return;
        }
        badge.dataset.categoryId = '__uncategorized__';
        badge.classList.add('uncategorized');
        badge.textContent = '▫️';
        badge.title = '未分类';
    });
    preserveScriptDrawerAfterCategoryChange();
}

function saveScriptCategory() {
    var id = document.getElementById('categoryEditId').value.trim();
    var name = document.getElementById('categoryName').value.trim();
    var emoji = document.getElementById('categoryEmoji').value || '📁';
    if (!name) { showToast('请填写分类名称', 'error'); return; }
    var categories = loadScriptCategories();
    var duplicate = categories.some(function (cat) { return cat.name.toLowerCase() === name.toLowerCase() && cat.id !== id; });
    if (duplicate) { showToast('分类名称已存在', 'error'); return; }
    var editing = false;
    categories = categories.map(function (cat) {
        if (cat.id !== id) return cat;
        editing = true;
        return Object.assign({}, cat, { name: name.slice(0, 40), emoji: emoji });
    });
    if (!editing) {
        if (categories.length >= MAX_SCRIPT_CATEGORIES) { showToast('分类数量已达到 ' + MAX_SCRIPT_CATEGORIES + ' 个上限', 'error'); return; }
        categories.push({ id: createScriptCategoryId(), name: name.slice(0, 40), emoji: emoji, createdAt: Date.now() });
        categoryManagerPage = Math.max(1, Math.ceil(categories.length / categoryManagerPageSize));
    }
    var bms = loadSortedScriptBookmarks();
    if (!saveScriptCategoriesData(categories)) { showToast('浏览器存储失败，分类未保存', 'error'); return; }
    resetCategoryEditor();
    renderCategoryManager(categories, bms);
    renderScriptCategoryFilters(categories, bms);
    updateScriptManagerSummary(bms.length, categories.length);
    if (editing) updateVisibleScriptCategoryBadges(id, getScriptCategory(id, categories));
    else preserveScriptDrawerAfterCategoryChange();
    syncLocalScriptsIfLogged();
    showToast(editing ? '分类已更新' : '分类已添加', 'success');
}

function editScriptCategory(id) {
    var cat = getScriptCategory(id);
    if (!cat) return;
    document.getElementById('categoryEditId').value = cat.id;
    document.getElementById('categoryName').value = cat.name;
    document.getElementById('categorySaveBtn').textContent = '保存分类';
    selectCategoryEmoji(cat.emoji);
    document.getElementById('categoryName').focus();
}

function deleteScriptCategory(id) {
    var categories = loadScriptCategories();
    var cat = getScriptCategory(id, categories);
    if (!cat) return;
    var bms = loadSortedScriptBookmarks();
    var count = bms.filter(function (b) { return b.categoryId === id; }).length;
    if (!count) {
        performDeleteScriptCategory(id, 'move');
        return;
    }
    pendingDeleteCategoryId = id;
    var title = document.getElementById('categoryDeleteTitle');
    var description = document.getElementById('categoryDeleteDescription');
    if (title) title.textContent = '分类“' + cat.name + '”下有 ' + count + ' 个脚本';
    if (description) description.textContent = '请选择将这些脚本移到“全部”，或者连同脚本一起删除。此操作需要确认。';
    var modal = document.getElementById('categoryDeleteModal');
    if (modal) modal.classList.add('show');
    preserveScriptDrawerAfterCategoryChange();
}

function hideCategoryDeleteModal() {
    var modal = document.getElementById('categoryDeleteModal');
    if (modal) modal.classList.remove('show');
    pendingDeleteCategoryId = '';
    preserveScriptDrawerAfterCategoryChange();
}

function confirmDeleteScriptCategory(action) {
    var id = pendingDeleteCategoryId;
    if (!id || (action !== 'move' && action !== 'delete')) return;
    performDeleteScriptCategory(id, action);
}

function performDeleteScriptCategory(id, action) {
    var categories = loadScriptCategories();
    var cat = getScriptCategory(id, categories);
    if (!cat) { hideCategoryDeleteModal(); return; }
    var bms = loadSortedScriptBookmarks();
    var affected = bms.filter(function (b) { return b.categoryId === id; }).length;
    var wasActive = activeScriptCategory === id;
    categories = categories.filter(function (item) { return item.id !== id; });
    if (action === 'delete') {
        bms = bms.filter(function (b) { return b.categoryId !== id; });
    } else if (affected) {
        bms.forEach(function (b) { if (b.categoryId === id) delete b.categoryId; });
    }
    if (!saveScriptWorkspaceAtomically(bms, categories, Date.now(), getScriptRevision(), false)) {
        showToast('浏览器存储失败，分类或脚本未保存', 'error');
        return;
    }
    if (wasActive) activeScriptCategory = '';
    hideCategoryDeleteModal();
    resetCategoryEditor();
    renderCategoryManager(categories, bms);
    renderScriptCategoryFilters(categories, bms);
    updateScriptManagerSummary(bms.length, categories.length);
    if (affected && (action === 'delete' || wasActive)) renderScriptBookmarks();
    else if (affected) updateVisibleScriptCategoryBadges(id, null);
    else preserveScriptDrawerAfterCategoryChange();
    syncLocalScriptsIfLogged();
    if (!affected) showToast('分类已删除', 'success');
    else if (action === 'delete') showToast('分类及其 ' + affected + ' 个脚本已删除', 'success');
    else showToast('分类已删除，' + affected + ' 个脚本已移到全部', 'success');
}

function updateCategoryPagination(totalPages) {
    var select = document.getElementById('categoryPageSize');
    var info = document.getElementById('categoryPageInfo');
    var prev = document.getElementById('categoryPagePrev');
    var next = document.getElementById('categoryPageNext');
    if (select) select.value = String(categoryManagerPageSize);
    if (info) info.textContent = categoryManagerPage + ' / ' + totalPages;
    if (prev) prev.disabled = categoryManagerPage <= 1;
    if (next) next.disabled = categoryManagerPage >= totalPages;
}

function setCategoryPageSize(value) {
    value = parseInt(value, 10);
    if ([5, 10, 15].indexOf(value) < 0) value = 5;
    categoryManagerPageSize = value;
    categoryManagerPage = 1;
    renderCategoryManager();
}

function changeCategoryPage(delta) {
    var total = loadScriptCategories().length;
    var totalPages = Math.max(1, Math.ceil(total / categoryManagerPageSize));
    categoryManagerPage = Math.max(1, Math.min(totalPages, categoryManagerPage + (parseInt(delta, 10) || 0)));
    renderCategoryManager();
}

function renderCategoryManager(categories, bms) {
    var list = document.getElementById('categoryManageList');
    var label = document.getElementById('categoryCountLabel');
    if (!list) return;
    categories = Array.isArray(categories) ? categories : loadScriptCategories();
    bms = Array.isArray(bms) ? bms : loadSortedScriptBookmarks();
    var counts = {};
    bms.forEach(function (b) { if (b.categoryId) counts[b.categoryId] = (counts[b.categoryId] || 0) + 1; });
    if (label) label.textContent = categories.length + ' 个';
    var totalPages = Math.max(1, Math.ceil(categories.length / categoryManagerPageSize));
    categoryManagerPage = Math.max(1, Math.min(categoryManagerPage, totalPages));
    updateCategoryPagination(totalPages);
    if (!categories.length) {
        list.innerHTML = '<div class="category-empty"><b>🎨</b><span>还没有分类</span><small>从上方选择 Emoji 并填写名称即可添加</small></div>';
        return;
    }
    var start = (categoryManagerPage - 1) * categoryManagerPageSize;
    var pageCategories = categories.slice(start, start + categoryManagerPageSize);
    list.innerHTML = pageCategories.map(function (cat) {
        return '<div class="category-manage-item"><button type="button" class="category-manage-emoji" data-category-id="' + escAttr(cat.id) + '" onclick="hideScriptManager();setScriptCategoryFilter(this.dataset.categoryId)" title="筛选 ' + escAttr(cat.name) + '">' + esc(cat.emoji) + '</button><div><b>' + esc(cat.name) + '</b><small>' + (counts[cat.id] || 0) + ' 个脚本</small></div><button type="button" class="category-row-action" data-category-id="' + escAttr(cat.id) + '" onclick="editScriptCategory(this.dataset.categoryId)" title="编辑分类">编辑</button><button type="button" class="category-row-action danger" data-category-id="' + escAttr(cat.id) + '" onclick="deleteScriptCategory(this.dataset.categoryId)" title="删除分类">删除</button></div>';
    }).join('');
}

// ==================== SFTP ====================
function getSessionById(id) {
    for (var i = 0; i < sessions.length; i++) if (sessions[i] && sessions[i].id === id) return sessions[i];
    return null;
}

function getActiveSession() {
    return activeIdx >= 0 && sessions[activeIdx] ? sessions[activeIdx] : null;
}

function abortSessionController(session, field) {
    if (!session || !session[field]) return;
    try { session[field].abort(); } catch (e) { }
    session[field] = null;
}

function cancelSessionSftpBrowsing(session) {
    if (!session) return;
    session._sftpListGeneration = (session._sftpListGeneration || 0) + 1;
    session._sftpDirGeneration = (session._sftpDirGeneration || 0) + 1;
    abortSessionController(session, '_sftpListController');
    abortSessionController(session, '_sftpDirController');
}

function cancelSessionSftpRequests(session, cancelDownloads) {
    if (!session) return;
    cancelSessionSftpBrowsing(session);
    if (session._sftpUploadRefreshTimer) {
        clearTimeout(session._sftpUploadRefreshTimer);
        session._sftpUploadRefreshTimer = null;
    }
    abortSessionController(session, '_sftpRemoteController');
    abortSessionController(session, '_sftpDeleteController');
    if (sftpDeleteConfirmRequest && sftpDeleteConfirmRequest.sessionId === session.id) {
        if (sftpDeleteConfirmRequest.editor) setRemoteEditorDeletePending(sftpDeleteConfirmRequest.editor, false, '删除请求已取消', 'warn');
        sftpDeleteConfirmRequest.deleting = false;
        hideSftpDeleteConfirm(true);
    }
    (session._remoteEditorControllers || []).forEach(function (controller) {
        try { controller.abort(); } catch (e) { }
    });
    session._remoteEditorControllers = [];
    (session._sftpUploads || []).forEach(function (upload) {
        if (upload.status === 'queued' || upload.status === 'running' || upload.status === 'processing') {
            upload.abortReason = 'SSH 连接已中断，上传已停止';
            upload.status = 'error';
            upload.error = upload.abortReason;
            upload.finishedAt = Date.now();
        }
    });
    (session._sftpUploadControllers || []).forEach(function (controller) {
        try { controller.abort(); } catch (e) { }
    });
    session._sftpUploadControllers = [];
    if (cancelDownloads) {
        (session._sftpDownloads || []).slice().forEach(cancelSftpDownload);
    }
}

function requestWasAborted(err) {
    return !!(err && err.name === 'AbortError');
}

function sftpLoad(path, session) {
    session = session || getActiveSession();
    if (!session || sessions.indexOf(session) === -1) return;
    if (!session._connected) {
        if (getActiveSession() === session) document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">SSH 连接尚未就绪</div>';
        return;
    }
    path = normalizeSftpDir(path);
    session.sftpPath = path;
    session._sftpListGeneration = (session._sftpListGeneration || 0) + 1;
    var generation = session._sftpListGeneration;
    abortSessionController(session, '_sftpListController');
    var controller = new AbortController();
    session._sftpListController = controller;
    if (getActiveSession() === session) {
        document.getElementById('sftpPath').value = path;
        document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">加载中...</div>';
    }
    fetch('/file/list', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sshInfo: session.sshInfo, path: path }),
        signal: controller.signal
    })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (sessions.indexOf(session) === -1 || session._sftpListGeneration !== generation || getActiveSession() !== session) return;
            session._sftpListController = null;
            if (d.Msg !== 'success') { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">' + esc(d.Msg) + '</div>'; return; }
            var actualPath = normalizeSftpDir(d.Data && d.Data.path ? d.Data.path : path);
            session.sftpPath = actualPath;
            document.getElementById('sftpPath').value = actualPath;
            var list = (d.Data && d.Data.list) || [];
            if (!list.length) { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">空目录</div>'; return; }
            document.getElementById('sftpBody').innerHTML = list.map(function (f) {
                var isDir = f.IsDir;
                var fp = (actualPath === '/' ? '/' : actualPath + '/') + f.Name;
                var fpArg = escAttr(JSON.stringify(fp));
                var mediaKind = f.PreviewKind === 'video' ? 'video' : (f.PreviewKind === 'image' ? 'image' : '');
                var icon = isDir ? '<svg class="sftp-icon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : '<svg class="sftp-icon file ' + mediaKind + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
                var sizeBytes = Math.max(0, parseInt(f.SizeBytes, 10) || 0);
                var downloadable = !!f.Downloadable;
                var previewKindArg = escAttr(JSON.stringify(f.PreviewKind || ''));
                var previewMimeArg = escAttr(JSON.stringify(f.PreviewMime || ''));
                var click = isDir ? 'onclick="sftpLoad(' + fpArg + ')"' : (f.Previewable ? 'onclick="openRemotePreview(' + fpArg + ',' + previewKindArg + ',' + previewMimeArg + ')"' : (downloadable ? 'onclick="sftpDownload(' + fpArg + ',' + sizeBytes + ')"' : ''));
                var previewTitle = f.Previewable ? (f.PreviewKind === 'video' ? '在线视频预览' : '在线图片预览') : (f.PreviewReason || '');
                var preview = isDir || (!f.Previewable && !f.PreviewReason) ? '' : '<button class="sftp-preview' + (f.Previewable ? '' : ' disabled') + '" ' + (f.Previewable ? 'onclick="event.stopPropagation();openRemotePreview(' + fpArg + ',' + previewKindArg + ',' + previewMimeArg + ')"' : 'data-message="' + escAttr(previewTitle) + '" onclick="event.stopPropagation();showSftpFileActionMessage(event)"') + ' title="' + escAttr(previewTitle) + '" aria-label="' + escAttr(previewTitle + ' ' + f.Name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="12" height="12"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.8"/></svg></button>';
                var editTitle = f.Editable ? '在线编辑' : (f.EditReason || '此文件不支持在线编辑');
                var edit = isDir ? '' : '<button class="sftp-edit' + (f.Editable ? '' : ' disabled') + '" ' + (f.Editable ? 'onclick="event.stopPropagation();openRemoteEditor(' + fpArg + ')"' : 'data-message="' + escAttr(editTitle) + '" onclick="event.stopPropagation();showSftpFileActionMessage(event)"') + ' title="' + escAttr(editTitle) + '" aria-label="' + escAttr(editTitle + ' ' + f.Name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1-1 1 1-4z"/></svg></button>';
                var dlTitle = downloadable ? (isDir ? '压缩并下载文件夹' : '下载') : (f.DownloadReason || '此项目不支持下载');
                var dl = '<button class="sftp-dl' + (isDir ? ' directory' : '') + (downloadable ? '' : ' disabled') + '" ' + (downloadable ? 'onclick="event.stopPropagation();sftpDownload(' + fpArg + ',' + (isDir ? 0 : sizeBytes) + ',' + (isDir ? 'true' : 'false') + ')"' : 'data-message="' + escAttr(dlTitle) + '" onclick="event.stopPropagation();showSftpFileActionMessage(event)"') + ' title="' + escAttr(dlTitle) + '" aria-label="' + escAttr(dlTitle + ' ' + f.Name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>';
                var del = isDir ? '' : '<button class="sftp-delete" onclick="event.stopPropagation();requestSftpDelete(' + fpArg + ')" title="删除" aria-label="' + escAttr('删除 ' + f.Name) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
                var linkMark = f.IsSymlink ? '<span class="sftp-link-mark" title="符号链接"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg></span>' : '';
                return '<div class="sftp-row" ' + click + '>' + icon + '<span class="sftp-name">' + esc(f.Name) + '</span>' + linkMark + '<span class="sftp-meta">' + esc(f.Size) + '</span>' + preview + edit + dl + del + '</div>';
            }).join('');
        })
        .catch(function (err) {
            if (session._sftpListGeneration !== generation || requestWasAborted(err) || getActiveSession() !== session) return;
            session._sftpListController = null;
            document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">加载失败</div>';
        });
}

function sftpGo() {
    var session = getActiveSession();
    if (session) sftpLoad(document.getElementById('sftpPath').value.trim() || '/', session);
}
function sftpUp() {
    var session = getActiveSession();
    if (!session) return;
    var p = normalizeSftpDir(session.sftpPath).replace(/\/$/, '');
    var i = p.lastIndexOf('/');
    sftpLoad(i <= 0 ? '/' : p.substring(0, i), session);
}

function sftpDownload(path, sizeBytes, isDirectory) {
    var session = getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    path = normalizeRemoteFilePath(path);
    if (!path) { showToast('文件路径无效', 'error'); return; }
    var sourceName = path.split('/').pop() || 'download';
    isDirectory = !!isDirectory;
    sftpDownloadConfirmRequest = { sessionId: session.id, path: path, size: isDirectory ? 0 : Math.max(0, parseInt(sizeBytes, 10) || 0), name: isDirectory ? sourceName + '.tar.gz' : sourceName, sourceName: sourceName, isDirectory: isDirectory, fileHandle: null };
    var title = document.getElementById('sftpDownloadConfirmTitle');
    var description = document.getElementById('sftpDownloadConfirmDescription');
    var sizeLabel = document.getElementById('sftpDownloadConfirmSizeLabel');
    if (title) title.textContent = isDirectory ? '确认压缩并下载文件夹' : '确认下载文件';
    if (description) description.textContent = isDirectory ? '确认后先在远端服务器生成临时压缩包，再下载到本地。' : '确认后开始从远端服务器下载此文件。';
    if (sizeLabel) sizeLabel.textContent = isDirectory ? '压缩包大小' : '文件大小';
    document.getElementById('sftpDownloadConfirmName').textContent = sftpDownloadConfirmRequest.name;
    document.getElementById('sftpDownloadConfirmPath').textContent = path;
    document.getElementById('sftpDownloadConfirmSize').textContent = isDirectory ? '压缩完成后确定' : (sftpDownloadConfirmRequest.size ? fmtB(sftpDownloadConfirmRequest.size) : '读取响应后确定');
    updateSftpDownloadConfirmHint(sftpDownloadConfirmRequest);
    var confirmButton = document.getElementById('sftpDownloadConfirmButton');
    if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = '确认下载'; }
    document.getElementById('sftpDownloadConfirmModal').classList.add('show');
}

function showSftpFileActionMessage(event) {
    var target = event && event.currentTarget;
    if (target && target.dataset && target.dataset.message) showToast(target.dataset.message, 'info');
}

function setSftpDeleteConfirmBusy(busy) {
    var confirmButton = document.getElementById('sftpDeleteConfirmButton');
    var cancelButton = document.getElementById('sftpDeleteCancelButton');
    var closeButton = document.getElementById('sftpDeleteCloseButton');
    if (confirmButton) { confirmButton.disabled = !!busy; confirmButton.textContent = busy ? '删除中…' : '确认删除'; }
    if (cancelButton) cancelButton.disabled = !!busy;
    if (closeButton) closeButton.disabled = !!busy;
}

function setRemoteEditorDeletePending(editor, pending, statusText, statusType) {
    if (!editor || remoteEditors.indexOf(editor) < 0) return;
    var saveButton = editor.el && editor.el.querySelector ? editor.el.querySelector('[data-editor-action="save"]') : null;
    if (pending) {
        editor.deletePending = true;
        editor.deletePreviousReadOnly = !!(editor.textarea && editor.textarea.readOnly);
        if (editor.textarea) editor.textarea.readOnly = true;
        if (saveButton) saveButton.disabled = true;
    } else {
        editor.deletePending = false;
        if (editor.textarea) editor.textarea.readOnly = !!editor.deletePreviousReadOnly;
        delete editor.deletePreviousReadOnly;
        if (saveButton) saveButton.disabled = false;
    }
    if (statusText) remoteEditorSetStatus(editor, statusText, statusType || 'info');
}

function requestSftpDelete(path) {
    var session = getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    path = normalizeRemoteFilePath(path);
    if (!path || path === '/') { showToast('文件路径无效', 'error'); return; }
    var editors = typeof remoteEditorsForPath === 'function' ? remoteEditorsForPath(session, path) : (remoteEditorFor(session, path) ? [remoteEditorFor(session, path)] : []);
    var editor = editors.find(function (item) { return remoteEditorIsDirty(item) || item.saving || item.deletePending; });
    if (editor) {
        restoreRemoteEditor(editor);
        showToast('该文件有未保存的修改，请先保存或关闭编辑器', 'error');
        return;
    }
    editor = editors.find(function (item) { return !item.loaded || item.controller; });
    if (editor) {
        restoreRemoteEditor(editor);
        showToast('该文件仍在打开中，请稍后再删除', 'info');
        return;
    }
    var slash = path.lastIndexOf('/');
    sftpDeleteConfirmRequest = {
        sessionId: session.id,
        path: path,
        parentPath: normalizeSftpDir(slash <= 0 ? '/' : path.substring(0, slash)),
        name: path.substring(slash + 1) || path,
        deleting: false,
        controller: null,
        editors: editors.slice()
    };
    document.getElementById('sftpDeleteConfirmName').textContent = sftpDeleteConfirmRequest.name;
    document.getElementById('sftpDeleteConfirmPath').textContent = path;
    var status = document.getElementById('sftpDeleteConfirmStatus');
    if (status) { status.textContent = '删除后无法恢复，请确认远端路径无误。'; status.className = 'sftp-delete-confirm-status'; }
    setSftpDeleteConfirmBusy(false);
    document.getElementById('sftpDeleteConfirmModal').classList.add('show');
    var confirmButton = document.getElementById('sftpDeleteConfirmButton');
    if (confirmButton) setTimeout(function () { confirmButton.focus(); }, 0);
}

function hideSftpDeleteConfirm(force) {
    if (sftpDeleteConfirmRequest && sftpDeleteConfirmRequest.deleting && !force) return;
    sftpDeleteConfirmRequest = null;
    var modal = document.getElementById('sftpDeleteConfirmModal');
    if (modal) modal.classList.remove('show');
    setSftpDeleteConfirmBusy(false);
}

function confirmSftpDelete() {
    var request = sftpDeleteConfirmRequest;
    if (!request || request.deleting) return Promise.resolve(false);
    var session = getSessionById(request.sessionId);
    if (!session || !session._connected) {
        showToast('SSH 连接尚未就绪', 'error');
        hideSftpDeleteConfirm(true);
        return Promise.resolve(false);
    }
    var editors = typeof remoteEditorsForPath === 'function' ? remoteEditorsForPath(session, request.path) : (remoteEditorFor(session, request.path) ? [remoteEditorFor(session, request.path)] : []);
    var editor = editors.find(function (item) { return remoteEditorIsDirty(item) || item.saving || item.deletePending || !item.loaded || item.controller; });
    if (editor) {
        hideSftpDeleteConfirm(true);
        restoreRemoteEditor(editor);
        showToast('文件编辑状态已变化，请先保存或关闭编辑器', 'error');
        return Promise.resolve(false);
    }
    request.editors = editors.slice();
    request.deleting = true;
    setSftpDeleteConfirmBusy(true);
    var status = document.getElementById('sftpDeleteConfirmStatus');
    if (status) { status.textContent = '正在删除远端文件…'; status.className = 'sftp-delete-confirm-status working'; }
    request.editors.forEach(function (item) { setRemoteEditorDeletePending(item, true, '正在删除远端文件…', 'warn'); });
    abortSessionController(session, '_sftpDeleteController');
    var controller = new AbortController();
    request.controller = controller;
    session._sftpDeleteController = controller;
    return remoteEditorRequest('/file/delete', { sshInfo: session.sshInfo, path: request.path }, controller.signal)
        .then(function () {
            if (sftpDeleteConfirmRequest !== request) return false;
            request.deleting = false;
            request.controller = null;
            request.editors.slice().forEach(function (item) {
                if (remoteEditors.indexOf(item) >= 0) destroyRemoteEditor(item);
            });
            hideSftpDeleteConfirm(true);
            showToast('已删除: ' + request.name, 'success');
            if (sessions.indexOf(session) >= 0 && session._connected && normalizeSftpDir(session.sftpPath || '/') === request.parentPath) {
                sftpLoad(request.parentPath, session);
            }
            return true;
        })
        .catch(function (err) {
            if (sftpDeleteConfirmRequest !== request) return false;
            request.deleting = false;
            request.controller = null;
            setSftpDeleteConfirmBusy(false);
            var aborted = requestWasAborted(err);
            var message = aborted ? '删除请求已中断，请刷新目录确认文件状态。' : ((err && err.msg) || '删除失败');
            if (status) { status.textContent = message; status.className = 'sftp-delete-confirm-status error'; }
            request.editors.forEach(function (item) {
                setRemoteEditorDeletePending(item, false, aborted ? '删除请求已中断' : '删除失败，文件仍在工作台中', aborted ? 'warn' : 'error');
            });
            if (!aborted) showToast(message, 'error');
            return false;
        })
        .finally(function () {
            if (session._sftpDeleteController === controller) session._sftpDeleteController = null;
        });
}

function hideSftpDownloadConfirm() {
    sftpDownloadConfirmRequest = null;
    var modal = document.getElementById('sftpDownloadConfirmModal');
    if (modal) modal.classList.remove('show');
    var confirmButton = document.getElementById('sftpDownloadConfirmButton');
    if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = '确认下载'; }
}

function confirmSftpDownload() {
    var request = sftpDownloadConfirmRequest;
    if (!request) return;
    var session = getSessionById(request.sessionId);
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    if (!request.fileHandle && !sftpDownloadPickerAvailable()) {
        hideSftpDownloadConfirm();
        startSftpDownload(session, request.path, request.size, request.name, null, request.isDirectory);
        return;
    }
    if (request.fileHandle) {
        hideSftpDownloadConfirm();
        startSftpDownload(session, request.path, request.size, request.name, request.fileHandle, request.isDirectory);
        return;
    }
    var confirmButton = document.getElementById('sftpDownloadConfirmButton');
    if (confirmButton) { confirmButton.disabled = true; confirmButton.textContent = '选择保存位置…'; }
    var picker;
    try {
        // This must be invoked directly inside the click handler so Chromium
        // keeps the required user activation for the native save dialog.
        picker = window.showSaveFilePicker({ suggestedName: request.name });
    } catch (err) {
        picker = Promise.reject(err);
    }
    Promise.resolve(picker).then(function (fileHandle) {
        if (sftpDownloadConfirmRequest !== request) return;
        hideSftpDownloadConfirm();
        startSftpDownload(session, request.path, request.size, request.name, fileHandle, request.isDirectory);
    }).catch(function (err) {
        if (confirmButton) { confirmButton.disabled = false; confirmButton.textContent = '确认下载'; }
        if (err && err.name === 'AbortError') return;
        if (sftpDownloadConfirmRequest !== request) return;
        hideSftpDownloadConfirm();
        showToast('浏览器无法直接写入所选位置，已切换兼容下载', 'info');
        startSftpDownload(session, request.path, request.size, request.name, null, request.isDirectory);
    });
}

function sftpDownloadPickerAvailable() {
    return typeof window !== 'undefined' && window.isSecureContext === true && typeof window.showSaveFilePicker === 'function';
}

function updateSftpDownloadConfirmHint(request) {
    var hint = document.getElementById('sftpDownloadConfirmHint');
    if (!hint) return;
    if (request && request.isDirectory) {
        hint.textContent = '任务分为“压缩”和“下载”两段：先显示实际扫描/压缩进度，压缩完成后再显示下载速度和剩余时间。临时压缩包会在完成、取消或失败后自动清理。';
    } else if (request && request.fileHandle) {
        hint.textContent = '保存位置已选择。确认后文件会边下载边写入磁盘；进度、速度和剩余时间显示在 SFTP 顶部。';
    } else if (sftpDownloadPickerAvailable()) {
        hint.textContent = '确认后先选择保存位置；文件会边下载边写入磁盘。进度、速度和剩余时间显示在 SFTP 顶部。';
    } else {
        hint.textContent = '下载进度会显示在 SFTP 顶部。当前浏览器不支持直接写入磁盘，将在接收完成后保存。';
    }
}

function sftpDownloadStatusLabel(download) {
    if (download.status === 'preparing') {
        if (download.archiveStage === 'connecting') return '准备压缩';
        if (download.archiveStage === 'scanning') return '扫描文件';
        if (download.archiveStage === 'finalizing') return '完成压缩';
        return '正在压缩';
    }
    if (download.status === 'paused') return '已暂停';
    if (download.status === 'saving') return '正在保存';
    if (download.status === 'completed') return '下载完成';
    if (download.status === 'cancelled') return '已取消';
    if (download.status === 'error') return '下载失败';
    return '下载中';
}

function sftpDownloadSpeed(download, now) {
    if (!download || !download.startedAt) return 0;
    var elapsed = Math.max(0.001, ((now || Date.now()) - download.startedAt - (download.pausedDuration || 0)) / 1000);
    return download.received / elapsed;
}

function formatSftpEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '计算中';
    seconds = Math.ceil(seconds);
    if (seconds < 60) return seconds + ' 秒';
    var minutes = Math.floor(seconds / 60), remain = seconds % 60;
    if (minutes < 60) return minutes + ' 分 ' + remain + ' 秒';
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分';
}

function sftpUploadStatusLabel(upload) {
    if (upload.status === 'queued') return '等待上传';
    if (upload.status === 'processing') return '写入远端';
    if (upload.status === 'completed') return '上传完成';
    if (upload.status === 'cancelled') return '已取消';
    if (upload.status === 'error') return '上传失败';
    return '正在上传';
}

function sftpUploadSpeed(upload, now) {
    if (!upload || !upload.startedAt || upload.status !== 'running') return 0;
    var elapsed = Math.max(0.001, ((now || Date.now()) - upload.startedAt) / 1000);
    return upload.sent / elapsed;
}

function renderSftpUploadTransfer(upload) {
    var total = Math.max(0, upload.total || (upload.file && upload.file.size) || 0);
    var sent = Math.max(0, Math.min(total || upload.sent, upload.sent || 0));
    var percent = total > 0 ? Math.max(0, Math.min(100, Math.round(sent / total * 100))) : (upload.status === 'processing' || upload.status === 'completed' ? 100 : 0);
    var speed = sftpUploadSpeed(upload);
    var remaining = total > sent && speed > 0 ? formatSftpEta((total - sent) / speed) : '计算中';
    var detail = '等待可用上传通道…';
    if (upload.status === 'running') {
        detail = fmtB(sent) + (total ? ' / ' + fmtB(total) : '') + (speed > 0 ? ' · ' + fmtB(speed) + '/s · 剩余 ' + remaining : '');
    } else if (upload.status === 'processing') {
        detail = (total ? fmtB(total) + ' · ' : '') + '数据已发送，正在写入目标服务器…';
    } else if (upload.status === 'completed') {
        detail = (total ? fmtB(total) + ' · ' : '') + '远端文件写入完成';
    } else if (upload.status === 'cancelled') {
        detail = '上传已取消';
    } else if (upload.status === 'error') {
        detail = upload.error || '上传失败';
    }
    var sendDone = upload.status === 'processing' || upload.status === 'completed' || (upload.status === 'error' && percent >= 100);
    var sendClass = upload.status === 'running' ? 'active' : (sendDone ? 'done' : (upload.status === 'error' ? 'error' : (upload.status === 'cancelled' ? 'cancelled' : '')));
    var writeClass = upload.status === 'processing' ? 'active' : (upload.status === 'completed' ? 'done' : (upload.status === 'error' && sendDone ? 'error' : (upload.status === 'cancelled' && sendDone ? 'cancelled' : '')));
    var retry = upload.status === 'error' ? '<button type="button" onclick="event.stopPropagation();retrySftpUpload(\'' + escAttr(upload.id) + '\')">重试</button>' : '';
    var cancel = upload.status === 'queued' || upload.status === 'running' || upload.status === 'processing'
        ? '<button class="danger" type="button" onclick="event.stopPropagation();cancelSftpUploadById(\'' + escAttr(upload.id) + '\')">取消</button>'
        : '<button type="button" onclick="event.stopPropagation();dismissSftpUpload(\'' + escAttr(upload.id) + '\')">关闭</button>';
    var progressLabel = upload.status === 'queued' ? '…' : percent + '%';
    return '<div class="sftp-transfer-item upload ' + escAttr(upload.status) + '">' +
        '<div class="sftp-transfer-stages"><span class="' + sendClass + '"><i>1</i>发送</span><b></b><span class="' + writeClass + '"><i>2</i>远端写入</span></div>' +
        '<div class="sftp-transfer-head"><div><b>' + esc(upload.name) + '</b><span>' + esc(sftpUploadStatusLabel(upload)) + '</span></div><div class="sftp-transfer-actions">' + retry + cancel + '</div></div>' +
        '<div class="sftp-transfer-progress"><i style="width:' + percent + '%"></i></div>' +
        '<div class="sftp-transfer-detail"><span>' + esc(detail) + '</span><b>' + progressLabel + '</b></div></div>';
}

function renderSftpTransfers(session) {
    session = session || getActiveSession();
    var panel = document.getElementById('sftpTransferPanel');
    if (!panel) return;
    var uploads = session && Array.isArray(session._sftpUploads) ? session._sftpUploads : [];
    var downloads = session && Array.isArray(session._sftpDownloads) ? session._sftpDownloads : [];
    if ((!uploads.length && !downloads.length) || getActiveSession() !== session) { panel.className = 'sftp-transfer-panel'; panel.innerHTML = ''; return; }
    panel.className = 'sftp-transfer-panel show';
    var uploadMarkup = uploads.map(renderSftpUploadTransfer).join('');
    var downloadMarkup = downloads.map(function (download) {
        var total = download.total || download.expectedSize || 0;
        var preparing = download.status === 'preparing';
        var percent = preparing ? Math.max(0, Math.min(100, parseInt(download.archivePercent, 10) || 0)) : (total > 0 ? Math.min(100, Math.round(download.received / total * 100)) : 0);
        var speed = sftpDownloadSpeed(download);
        var remaining = total > download.received && speed > 0 ? formatSftpEta((total - download.received) / speed) : (download.status === 'completed' ? '已完成' : '计算中');
        var archiveDetail = '正在连接远端服务器，准备扫描文件夹…';
        if (download.archiveStage === 'scanning') {
            archiveDetail = '已扫描 ' + (download.archiveTotalEntries || 0) + ' 个项目' + (download.archiveTotalBytes ? ' · 已发现 ' + fmtB(download.archiveTotalBytes) : '');
        } else if (download.archiveStage === 'compressing') {
            archiveDetail = download.archiveTotalBytes
                ? '已处理 ' + fmtB(download.archiveProcessedBytes || 0) + ' / ' + fmtB(download.archiveTotalBytes) + ' · ' + (download.archiveProcessedEntries || 0) + ' / ' + (download.archiveTotalEntries || 0) + ' 个项目'
                : '已处理 ' + (download.archiveProcessedEntries || 0) + ' / ' + (download.archiveTotalEntries || 0) + ' 个项目';
        } else if (download.archiveStage === 'finalizing') {
            archiveDetail = '文件内容已处理完成，正在校验临时压缩包…';
        }
        var detail = preparing
            ? archiveDetail
            : (download.status === 'error' && download.error
                ? download.error
                : fmtB(download.received) + (total ? ' / ' + fmtB(total) : '') + ' · ' + (download.status === 'running' && speed > 0 ? fmtB(speed) + '/s · 剩余 ' + remaining : sftpDownloadStatusLabel(download)));
        var retry = download.status === 'error' ? '<button type="button" onclick="event.stopPropagation();retrySftpDownload(\'' + escAttr(download.id) + '\')">重试</button>' : '';
        var pause = download.status === 'running' ? '<button type="button" onclick="event.stopPropagation();pauseSftpDownload(\'' + escAttr(download.id) + '\')">暂停</button>' : (download.status === 'paused' ? '<button type="button" onclick="event.stopPropagation();resumeSftpDownload(\'' + escAttr(download.id) + '\')">继续</button>' : '');
        var cancel = download.status === 'preparing' || download.status === 'running' || download.status === 'paused' || download.status === 'saving' ? '<button class="danger" type="button" onclick="event.stopPropagation();cancelSftpDownloadById(\'' + escAttr(download.id) + '\')">取消</button>' : '<button type="button" onclick="event.stopPropagation();dismissSftpDownload(\'' + escAttr(download.id) + '\')">关闭</button>';
        var stages = '';
        if (download.isDirectory) {
            var archiveDone = !!download.archiveReady || ['running', 'paused', 'saving', 'completed'].indexOf(download.status) >= 0;
            var archiveClass = preparing ? 'active' : (archiveDone ? 'done' : (download.status === 'error' ? 'error' : (download.status === 'cancelled' ? 'cancelled' : '')));
            var downloadClass = archiveDone ? (download.status === 'completed' ? 'done' : (download.status === 'error' ? 'error' : (download.status === 'cancelled' ? 'cancelled' : 'active'))) : '';
            stages = '<div class="sftp-transfer-stages"><span class="' + archiveClass + '"><i>1</i>压缩</span><b></b><span class="' + downloadClass + '"><i>2</i>下载</span></div>';
        }
        var progressLabel = preparing ? ((download.archiveStage === 'connecting' || download.archiveStage === 'scanning') ? '…' : percent + '%') : (total ? percent + '%' : '…');
        var stageClass = preparing ? ' archive-' + escAttr(download.archiveStage || 'connecting') : '';
        return '<div class="sftp-transfer-item ' + escAttr(download.status) + stageClass + '">' + stages + '<div class="sftp-transfer-head"><div><b>' + esc(download.name) + '</b><span>' + esc(sftpDownloadStatusLabel(download)) + '</span></div><div class="sftp-transfer-actions">' + retry + pause + cancel + '</div></div><div class="sftp-transfer-progress"><i style="width:' + percent + '%"></i></div><div class="sftp-transfer-detail"><span>' + esc(detail) + '</span><b>' + progressLabel + '</b></div></div>';
    }).join('');
    panel.innerHTML = uploadMarkup + downloadMarkup;
}

function findSftpDownload(id) {
    for (var i = 0; i < sessions.length; i++) {
        var list = sessions[i]._sftpDownloads || [];
        for (var j = 0; j < list.length; j++) if (list[j].id === id) return list[j];
    }
    return null;
}

function triggerDownloadedBlob(blob, name) {
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name || 'download';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
}

function sftpDownloadWriter(download, total) {
    if (download.fileHandle && typeof download.fileHandle.createWritable === 'function') {
        return Promise.resolve(download.fileHandle.createWritable()).then(function (writer) {
            return { writer: writer, mode: 'disk' };
        });
    }
    if (typeof streamSaver !== 'undefined' && streamSaver && typeof streamSaver.createWriteStream === 'function') {
        return Promise.resolve({ writer: streamSaver.createWriteStream(download.name, total ? { size: total } : undefined).getWriter(), mode: 'stream' });
    }
    return Promise.resolve({ writer: null, mode: 'memory' });
}

function verifySftpDownloadSize(download) {
    var expectedTotal = download.total || download.expectedSize || 0;
    if (expectedTotal > 0 && download.received !== expectedTotal) {
        throw new Error('下载不完整：收到 ' + fmtB(download.received) + '，预期 ' + fmtB(expectedTotal));
    }
    return true;
}

function abortSftpDownloadWriter(download, reason) {
    if (!download || !download.writer || download.writerCommitted || typeof download.writer.abort !== 'function') return Promise.resolve();
    try { return Promise.resolve(download.writer.abort(reason || 'download aborted')).catch(function () { }); }
    catch (e) { return Promise.resolve(); }
}

function applySftpArchiveStatus(download, data) {
    data = data || {};
    download.archiveStage = data.status || download.archiveStage || 'connecting';
    download.archivePercent = Math.max(0, Math.min(100, parseInt(data.percent, 10) || 0));
    download.archiveTotalBytes = Math.max(0, parseInt(data.totalBytes, 10) || 0);
    download.archiveProcessedBytes = Math.max(0, parseInt(data.processedBytes, 10) || 0);
    download.archiveTotalEntries = Math.max(0, parseInt(data.totalEntries, 10) || 0);
    download.archiveProcessedEntries = Math.max(0, parseInt(data.processedEntries, 10) || 0);
    download.archiveCurrentPath = data.currentPath || '';
}

function newSftpArchiveJobId() {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
        if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
            var bytes = new Uint8Array(16);
            crypto.getRandomValues(bytes);
            return Array.prototype.map.call(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
        }
    } catch (e) { }
    var fallback = '';
    for (var i = 0; i < 4; i++) fallback += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    return fallback;
}

function requestSftpArchiveCancel(jobId) {
    if (!jobId) return Promise.resolve();
    return fetch('/file/archive/cancel', {
        method: 'POST', credentials: 'same-origin', keepalive: true,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: jobId })
    }).catch(function () { });
}

function clearSftpArchivePoll(download) {
    if (!download) return;
    if (download.pollTimer) { clearTimeout(download.pollTimer); download.pollTimer = null; }
    var wake = download.pollResolve;
    download.pollResolve = null;
    if (wake) wake();
}

function pollSftpArchivePreparation(download, session, attempt, jobId) {
    if (!download || download.archiveAttempt !== attempt || download.status === 'cancelled' || !jobId) return Promise.resolve(false);
    var controller = new AbortController();
    download.controller = controller;
    return remoteEditorRequest('/file/archive/status', { jobId: jobId }, controller.signal)
        .then(function (data) {
            if (download.controller === controller) download.controller = null;
            if (download.archiveAttempt !== attempt || download.status === 'cancelled') return false;
            applySftpArchiveStatus(download, data);
            if (data.status === 'ready') {
                download.archiveReady = true;
                download.archiveJobId = jobId;
                download.archiveStage = 'ready';
                download.archivePercent = 100;
                download.expectedSize = Math.max(0, parseInt(data.archiveSize, 10) || 0);
                download.total = download.expectedSize;
                download.received = 0;
                renderSftpTransfers(session);
                return runSftpDownload(download);
            }
            if (data.status === 'error') throw new Error(data.error || '文件夹压缩失败');
            if (data.status === 'cancelled') {
                download.status = 'cancelled';
                renderSftpTransfers(session);
                return false;
            }
            renderSftpTransfers(session);
            return new Promise(function (resolve) {
                download.pollResolve = resolve;
                download.pollTimer = setTimeout(function () {
                    download.pollTimer = null;
                    download.pollResolve = null;
                    resolve();
                }, 400);
            }).then(function () { return pollSftpArchivePreparation(download, session, attempt, jobId); });
        })
        .catch(function (err) {
            if (download.controller === controller) download.controller = null;
            if (download.archiveAttempt !== attempt || download.status === 'cancelled' || requestWasAborted(err)) return false;
            requestSftpArchiveCancel(jobId);
            download.status = 'error';
            download.error = (err && (err.message || err.msg)) || '文件夹压缩失败';
            showToast(download.error, 'error');
            renderSftpTransfers(session);
            return false;
        });
}

function runSftpArchivePreparation(download) {
    var session = getSessionById(download.sessionId);
    if (!session || !session._connected) { download.status = 'error'; download.error = 'SSH 连接已断开'; renderSftpTransfers(session); return Promise.resolve(false); }
    clearSftpArchivePoll(download);
    var attempt = (download.archiveAttempt || 0) + 1;
    download.archiveAttempt = attempt;
    download.status = 'preparing';
    download.archiveStage = 'connecting';
    download.archivePercent = 0;
    download.archiveReady = false;
    var jobId = newSftpArchiveJobId();
    download.archiveJobId = jobId;
    download.archiveTotalBytes = 0;
    download.archiveProcessedBytes = 0;
    download.archiveTotalEntries = 0;
    download.archiveProcessedEntries = 0;
    download.startedAt = 0;
    var controller = new AbortController();
    download.controller = controller;
    renderSftpTransfers(session);
    return remoteEditorRequest('/file/archive/prepare', { sshInfo: session.sshInfo, path: download.path, jobId: jobId }, controller.signal)
        .then(function (data) {
            if (download.controller === controller) download.controller = null;
            if (download.archiveAttempt !== attempt || download.status === 'cancelled') return false;
            if (!data || !data.jobId) throw new Error('服务器没有返回压缩任务编号');
            jobId = data.jobId;
            download.archiveJobId = jobId;
            return pollSftpArchivePreparation(download, session, attempt, jobId);
        })
        .catch(function (err) {
            if (download.controller === controller) download.controller = null;
            if (download.archiveAttempt !== attempt || download.status === 'cancelled' || requestWasAborted(err)) return false;
            requestSftpArchiveCancel(jobId);
            download.status = 'error';
            download.error = (err && (err.message || err.msg)) || '无法启动文件夹压缩';
            showToast(download.error, 'error');
            renderSftpTransfers(session);
            return false;
        });
}

function runSftpDownload(download) {
    var session = getSessionById(download.sessionId);
    if (!session || (!session._connected && !(download.isDirectory && download.archiveReady))) { download.status = 'error'; download.error = 'SSH 连接已断开'; renderSftpTransfers(session); return Promise.resolve(false); }
    var controller = new AbortController();
    download.controller = controller;
    download.status = 'running';
    download.startedAt = Date.now();
    renderSftpTransfers(session);
    var preparedArchive = download.isDirectory && download.archiveJobId;
    var preparedJobId = preparedArchive ? download.archiveJobId : '';
    return fetch(preparedArchive ? '/file/archive/download' : '/file/download', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(preparedArchive ? { jobId: preparedJobId } : { sshInfo: session.sshInfo, path: download.path, archive: false }), signal: controller.signal
    }).then(function (response) {
        if (!response.ok) return response.text().then(function (text) { var message = text; try { message = (JSON.parse(text).Msg || text); } catch (e) { } throw new Error(message || '下载失败'); });
        var total = parseInt(response.headers.get('X-WebSSH-File-Size') || response.headers.get('Content-Length'), 10) || download.expectedSize || 0;
        download.total = total;
        download.status = 'running';
        download.startedAt = Date.now();
        renderSftpTransfers(session);
        var reader = response.body && response.body.getReader ? response.body.getReader() : null;
        return sftpDownloadWriter(download, total).then(function (sink) {
            var writer = sink.writer;
            download.writer = writer;
            download.storageMode = sink.mode;
            download.writerCommitted = false;
            download.chunks = writer ? null : [];
            if (!reader) return response.blob().then(function (blob) {
                download.received = blob.size;
                verifySftpDownloadSize(download);
                download.status = 'saving';
                renderSftpTransfers(session);
                if (writer) return writer.write(blob).then(function () { return writer.close(); }).then(function () { download.writerCommitted = true; });
                triggerDownloadedBlob(blob, download.name);
            });
            function pump() {
                if (download.status === 'cancelled') return reader.cancel().catch(function () { });
                if (download.status === 'paused') return new Promise(function (resolve, reject) { download.resumeRead = function () { download.resumeRead = null; pump().then(resolve, reject); }; });
                return reader.read().then(function (result) {
                    if (result.done) return;
                    download.received += result.value.byteLength;
                    if (writer) return writer.write(result.value).then(function () { renderSftpTransfers(session); return pump(); });
                    download.chunks.push(result.value);
                    renderSftpTransfers(session);
                    return pump();
                });
            }
            return pump().then(function () {
                if (download.status === 'cancelled') return;
                verifySftpDownloadSize(download);
                download.status = 'saving';
                renderSftpTransfers(session);
                if (writer) return writer.close().then(function () { download.writerCommitted = true; });
                var blob = new Blob(download.chunks, { type: 'application/octet-stream' });
                if (blob.size !== download.received) throw new Error('下载缓存不完整，请重试');
                triggerDownloadedBlob(blob, download.name);
            });
        });
    }).then(function () {
        if (download.status === 'cancelled') return;
        verifySftpDownloadSize(download);
        download.status = 'completed';
        download.finishedAt = Date.now();
        showToast(download.name + ' 下载完成', 'success');
        renderSftpTransfers(session);
    }).catch(function (err) {
        // A sink/open/write failure can happen after the server has already
        // started streaming. Abort this exact fetch so regular-file downloads
        // do not continue consuming SSH bandwidth in the background; folder
        // jobs are cancelled below as an additional server-side safeguard.
        try { controller.abort(); } catch (e) { }
        return abortSftpDownloadWriter(download, err && err.message).then(function () {
            if (download.status === 'cancelled' || requestWasAborted(err)) return;
            if (preparedArchive) requestSftpArchiveCancel(preparedJobId);
            download.status = 'error';
            download.error = err && err.message ? err.message : '下载失败';
            showToast(download.error, 'error');
            renderSftpTransfers(session);
        });
    }).finally(function () {
        if (download.controller === controller) download.controller = null;
        download.writer = null;
        download.resumeRead = null;
        if (download.isDirectory && download.archiveJobId === preparedJobId) download.archiveJobId = null;
    });
}

function startSftpDownload(session, path, size, name, fileHandle, isDirectory) {
    var download = { id: 'download_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), sessionId: session.id, path: path, name: name, isDirectory: !!isDirectory, expectedSize: size || 0, total: size || 0, received: 0, status: 'queued', startedAt: 0, pausedDuration: 0, pausedAt: 0, controller: null, writer: null, writerCommitted: false, fileHandle: fileHandle || null, storageMode: '', chunks: null, resumeRead: null, pollTimer: null, pollResolve: null, archiveAttempt: 0, archiveJobId: null, archiveStage: '', archivePercent: 0, archiveReady: false, archiveTotalBytes: 0, archiveProcessedBytes: 0, archiveTotalEntries: 0, archiveProcessedEntries: 0, archiveCurrentPath: '' };
    (session._sftpDownloads || (session._sftpDownloads = [])).unshift(download);
    renderSftpTransfers(session);
    if (download.isDirectory) runSftpArchivePreparation(download);
    else runSftpDownload(download);
}

function pauseSftpDownload(id) {
    var download = findSftpDownload(id);
    if (!download || download.status !== 'running') return;
    download.status = 'paused'; download.pausedAt = Date.now(); renderSftpTransfers(getSessionById(download.sessionId));
}

function resumeSftpDownload(id) {
    var download = findSftpDownload(id);
    if (!download || download.status !== 'paused') return;
    download.pausedDuration += Math.max(0, Date.now() - download.pausedAt); download.pausedAt = 0; download.status = 'running';
    var resume = download.resumeRead; renderSftpTransfers(getSessionById(download.sessionId)); if (resume) resume();
}

function cancelSftpDownload(download) {
    if (!download) return;
    clearSftpArchivePoll(download);
    var archiveJobId = download.archiveJobId;
    download.archiveAttempt = (download.archiveAttempt || 0) + 1;
    download.status = 'cancelled';
    if (download.controller) { try { download.controller.abort(); } catch (e) { } }
    requestSftpArchiveCancel(archiveJobId);
    abortSftpDownloadWriter(download, 'cancelled');
    var resume = download.resumeRead;
    download.resumeRead = null;
    if (resume) resume();
    renderSftpTransfers(getSessionById(download.sessionId));
}

function cancelSftpDownloadById(id) { cancelSftpDownload(findSftpDownload(id)); }

function retrySftpDownload(id) {
    var download = findSftpDownload(id);
    if (!download || download.status !== 'error') return;
    download.received = 0; download.total = download.isDirectory ? 0 : (download.expectedSize || 0); download.error = ''; download.startedAt = 0; download.pausedDuration = 0; download.writerCommitted = false; download.storageMode = ''; download.chunks = null; download.archiveJobId = null; download.archiveStage = ''; download.archivePercent = 0; download.archiveReady = false;
    if (download.isDirectory) runSftpArchivePreparation(download);
    else runSftpDownload(download);
}

function dismissSftpDownload(id) {
    var download = findSftpDownload(id);
    if (!download) return;
    var session = getSessionById(download.sessionId);
    if (!session) return;
    session._sftpDownloads = (session._sftpDownloads || []).filter(function (item) { return item !== download; });
    renderSftpTransfers(session);
}

function normalizeSftpDir(path) {
    path = String(path || '').trim();
    if (!path) return '/';
    path = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (path[0] !== '/') path = '/' + path;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path || '/';
}

// ==================== Remote File Editor ====================
function normalizeRemoteFilePath(path) {
    path = String(path || '').trim().replace(/\\/g, '/').replace(/\/+/g, '/');
    if (!path) return '';
    if (path.charAt(0) !== '/') path = '/' + path;
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

function remoteEditorFor(session, path, viewMode) {
    var normalized = normalizeRemoteFilePath(path);
    viewMode = viewMode || 'text';
    for (var i = 0; i < remoteEditors.length; i++) {
        if (remoteEditors[i].sessionId === session.id && remoteEditors[i].path === normalized && (remoteEditors[i].viewMode || 'text') === viewMode) return remoteEditors[i];
    }
    return null;
}

function remoteEditorsForPath(session, path) {
    var normalized = normalizeRemoteFilePath(path);
    return remoteEditors.filter(function (editor) {
        return editor.sessionId === session.id && editor.path === normalized;
    });
}

function remoteEditorSession(editor) {
    return editor ? getSessionById(editor.sessionId) : null;
}

function remoteEditorIsDirty(editor) {
    if (!editor || (editor.viewMode || 'text') !== 'text' || !editor.textarea) return false;
    if (typeof editor._dirty === 'boolean') return editor._dirty;
    return !!editor.isNew || editor.textarea.value !== editor.originalContent;
}

function remoteEditorPathLabel(editor) {
    if (!editor) return '';
    var requestedPath = normalizeRemoteFilePath(editor.path);
    var targetPath = normalizeRemoteFilePath(editor.targetPath);
    return targetPath && targetPath !== requestedPath ? requestedPath + ' → ' + targetPath : requestedPath;
}

function remoteEditorSetStatus(editor, text, type) {
    if (!editor || !editor.status) return;
    editor.status.textContent = text || '';
    editor.status.className = 'remote-editor-status ' + (type || '');
}

function remoteEditorUpdateMetrics(editor) {
    if (!editor) return false;
    if (editor._metricsTimer) {
        clearTimeout(editor._metricsTimer);
        editor._metricsTimer = null;
    }
    var workspace = remoteEditorWorkspaceFor(editor);
    if ((editor.viewMode || 'text') !== 'text' || !editor.textarea) {
        var mediaDetails = [];
        if (editor.mediaWidth && editor.mediaHeight) mediaDetails.push(editor.mediaWidth + ' × ' + editor.mediaHeight);
        if (editor.mediaDuration) mediaDetails.push(formatRemoteMediaDuration(editor.mediaDuration));
        if (editor.sizeBytes >= 0) mediaDetails.push(fmtB(editor.sizeBytes || 0));
        if (editor.metrics) editor.metrics.textContent = mediaDetails.join(' · ') || (editor.viewMode === 'video' ? '视频预览' : '图片预览');
        if (editor.saveBtn) editor.saveBtn.disabled = true;
        remoteEditorUpdateTab(editor);
        updateRemoteEditorWorkspaceSummary(workspace);
        return false;
    }
    var value = editor.textarea.value || '';
    var dirty = !!editor.isNew || value !== editor.originalContent;
    editor._dirty = dirty;
    var lines = 1;
    for (var lineIndex = 0; lineIndex < value.length; lineIndex++) {
        if (value.charCodeAt(lineIndex) === 10) lines++;
    }
    var bytes = 0;
    try { bytes = new TextEncoder().encode(value).length; } catch (e) { bytes = value.length; }
    var largeFileMode = value.length > remoteEditorDecorationMaxBytes || bytes > remoteEditorDecorationMaxBytes || lines > remoteEditorLargeFileMaxLines;
    editor._largeFile = largeFileMode;
    var hideLineNumbers = largeFileMode || lines > 50000;
    if (editor.el) editor.el.classList.toggle('is-large-file', largeFileMode);
    if (editor.metrics) editor.metrics.textContent = lines + ' 行 · ' + bytes + ' 字节' + (editor.maxBytes ? ' / ' + fmtB(editor.maxBytes) : '') + (largeFileMode ? ' · 大文件流畅模式（高亮/行号/缩略图已关闭）' : (hideLineNumbers ? ' · 行号已隐藏' : ''));
    if (editor.gutter) {
        editor.gutter.hidden = hideLineNumbers;
        if (hideLineNumbers) {
            if (editor.gutter.textContent) editor.gutter.textContent = '';
            editor._gutterLineCount = 0;
        } else if (editor._gutterLineCount !== lines) {
            var gutterLines = [];
            for (var i = 1; i <= lines; i++) gutterLines.push(String(i));
            editor.gutter.textContent = gutterLines.join('\n');
            editor._gutterLineCount = lines;
        }
        editor.gutter.scrollTop = editor.textarea.scrollTop;
    }
    if (editor.el) editor.el.classList.toggle('is-dirty', dirty);
    var session = remoteEditorSession(editor);
    var tooLarge = !!editor.maxBytes && bytes > editor.maxBytes;
    if (editor.saveBtn) editor.saveBtn.disabled = !!editor.saving || !editor.loaded || tooLarge || !dirty || !session || !session._connected;
    if (tooLarge && !editor.saving) remoteEditorSetStatus(editor, '内容超过在线编辑上限 ' + fmtB(editor.maxBytes), 'error');
    remoteEditorUpdateTab(editor);
    updateRemoteEditorWorkspaceSummary(workspace);
    scheduleRemoteEditorDecorations(editor);
    if (workspace && workspace.minimized) renderRemoteEditorDock(getActiveSession());
    return tooLarge;
}

function remoteEditorHandleLargeFileInput(editor) {
    if (!editor || !editor.textarea) return false;
    var value = editor.textarea.value || '';
    editor._dirty = true;
    editor._largeFile = true;
    if (editor.el) {
        editor.el.classList.add('is-large-file');
        editor.el.classList.add('highlight-disabled');
        editor.el.classList.add('is-dirty');
    }
    if (editor.highlightCode && editor.highlightCode.textContent) editor.highlightCode.textContent = '';
    if (editor.gutter) {
        editor.gutter.hidden = true;
        if (editor.gutter.textContent) editor.gutter.textContent = '';
        editor._gutterLineCount = 0;
    }
    var session = remoteEditorSession(editor);
    var tooLarge = !!editor.maxBytes && value.length > editor.maxBytes;
    if (editor.saveBtn) editor.saveBtn.disabled = !!editor.saving || !editor.loaded || tooLarge || !session || !session._connected;
    remoteEditorUpdateTab(editor);
    updateRemoteEditorWorkspaceSummary(remoteEditorWorkspaceFor(editor));
    if (editor._metricsTimer) clearTimeout(editor._metricsTimer);
    editor._metricsTimer = setTimeout(function () {
        editor._metricsTimer = null;
        if (remoteEditors.indexOf(editor) >= 0) remoteEditorUpdateMetrics(editor);
    }, 220);
    return tooLarge;
}

function formatRemoteMediaDuration(seconds) {
    seconds = Math.max(0, Math.round(parseFloat(seconds) || 0));
    var minutes = Math.floor(seconds / 60);
    var hours = Math.floor(minutes / 60);
    var secs = seconds % 60;
    minutes %= 60;
    return (hours ? hours + ':' + String(minutes).padStart(2, '0') : minutes) + ':' + String(secs).padStart(2, '0');
}

function replaceRemoteEditorText(textarea, replacement, start, end, selectionStart, selectionEnd) {
    if (typeof textarea.setRangeText === 'function') {
        textarea.setRangeText(replacement, start, end, 'start');
    } else {
        textarea.value = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    }
    textarea.selectionStart = selectionStart;
    textarea.selectionEnd = selectionEnd;
}

function indentRemoteEditorSelection(textarea, outdent) {
    if (!textarea) return false;
    var value = textarea.value || '';
    var start = Math.max(0, textarea.selectionStart || 0);
    var end = Math.max(start, textarea.selectionEnd || 0);

    if (start === end && !outdent) {
        replaceRemoteEditorText(textarea, '    ', start, end, start + 4, start + 4);
        return true;
    }

    var lineStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1;
    if (start === end) {
        var indentation = value.slice(lineStart, lineStart + 4).match(/^(?:\t| {1,4})/);
        if (!indentation) return false;
        var removed = indentation[0].length;
        var caret = Math.max(lineStart, start - Math.min(removed, start - lineStart));
        replaceRemoteEditorText(textarea, '', lineStart, lineStart + removed, caret, caret);
        return true;
    }

    var blockEnd;
    if (value.charAt(end - 1) === '\n') {
        blockEnd = end - 1;
    } else {
        var nextBreak = value.indexOf('\n', end);
        blockEnd = nextBreak < 0 ? value.length : nextBreak;
    }
    var block = value.slice(lineStart, blockEnd);
    var blockLines = block.split('\n');
    var totalChange = 0;
    var firstLineChange = 0;
    var replacement;

    if (outdent) {
        replacement = blockLines.map(function (line, index) {
            var match = line.match(/^(?:\t| {1,4})/);
            var count = match ? match[0].length : 0;
            if (index === 0) firstLineChange = Math.min(count, start - lineStart);
            totalChange += count;
            return line.slice(count);
        }).join('\n');
        if (!totalChange) return false;
        replaceRemoteEditorText(textarea, replacement, lineStart, blockEnd, Math.max(lineStart, start - firstLineChange), Math.max(lineStart, end - totalChange));
        return true;
    }

    replacement = blockLines.map(function (line) { return '    ' + line; }).join('\n');
    totalChange = blockLines.length * 4;
    replaceRemoteEditorText(textarea, replacement, lineStart, blockEnd, start + 4, end + totalChange);
    return true;
}

function remoteEditorRequest(url, body, signal) {
    return fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal
    }).then(function (response) {
        return response.text().then(function (text) {
            var data = {};
            try { data = text ? JSON.parse(text) : {}; } catch (e) { throw { msg: '服务器返回了无效响应', status: response.status }; }
            if (!response.ok || data.Msg !== 'success') throw { msg: data.Msg || '请求失败', status: response.status, data: data.Data };
            return data.Data || {};
        });
    });
}

function removeRemoteEditorController(session, controller) {
    if (!session || !controller) return;
    var list = session._remoteEditorControllers || [];
    var index = list.indexOf(controller);
    if (index >= 0) list.splice(index, 1);
}

function scheduleRemoteEditorInitialLoad(editor, session) {
    if (!editor || !session || editor._loadRetryTimer) return;
    editor._loadRetryTimer = setTimeout(function () {
        editor._loadRetryTimer = null;
        if (remoteEditors.indexOf(editor) < 0 || !session._connected || editor.controller || editor.loaded || remoteEditorIsDirty(editor)) return;
        editor.el.classList.add('is-loading');
        if ((editor.viewMode || 'text') === 'text') loadRemoteEditor(editor);
        else loadRemotePreview(editor);
    }, 50);
}

function prepareRemoteEditorWorkspace() {
    ensureRemoteEditorBoundsObserver();
    var panel = document.getElementById('sftpPanel');
    var termMain = document.querySelector('.term-main');
    if (panel && panel.classList.contains('open') && termMain && panel.getBoundingClientRect().width >= termMain.getBoundingClientRect().width * .9) {
        // On phones and very narrow workspaces the SFTP panel covers the whole
        // terminal. Hide it before opening either an existing or a new file so
        // the requested editor is immediately visible.
        panel.classList.remove('open');
    }
    remoteEditorLayerWidth();
}

function remoteEditorWorkspaceFor(editor) {
    if (editor && editor.workspace) return editor.workspace;
    var session = remoteEditorSession(editor);
    return session ? session._remoteEditorWorkspace || null : null;
}

function remoteEditorsForWorkspace(workspace) {
    if (!workspace) return [];
    return remoteEditors.filter(function (editor) { return editor.sessionId === workspace.sessionId; });
}

function activeRemoteEditorForWorkspace(workspace) {
    var editors = remoteEditorsForWorkspace(workspace);
    for (var i = 0; i < editors.length; i++) {
        if (editors[i].id === workspace.activeEditorId) return editors[i];
    }
    return editors.length ? editors[editors.length - 1] : null;
}

function remoteEditorLanguageForName(name) {
    name = String(name || '');
    var lower = name.toLowerCase();
    var extIndex = lower.lastIndexOf('.');
    var ext = extIndex >= 0 ? lower.slice(extIndex) : '';
    var exact = {
        'dockerfile': ['docker', 'Dockerfile'],
        'makefile': ['make', 'Makefile'],
        '.bashrc': ['shell', 'Shell'],
        '.zshrc': ['shell', 'Shell'],
        '.profile': ['shell', 'Shell'],
        '.gitignore': ['config', 'Config'],
        '.env': ['config', 'ENV']
    };
    if (exact[lower]) return { id: exact[lower][0], label: exact[lower][1] };
    var types = {
        '.html': ['html', 'HTML'], '.htm': ['html', 'HTML'], '.xml': ['html', 'XML'], '.svg': ['html', 'SVG'],
        '.css': ['css', 'CSS'], '.scss': ['css', 'SCSS'], '.less': ['css', 'LESS'],
        '.js': ['javascript', 'JavaScript'], '.mjs': ['javascript', 'JavaScript'], '.cjs': ['javascript', 'JavaScript'],
        '.ts': ['javascript', 'TypeScript'], '.tsx': ['javascript', 'TSX'], '.jsx': ['javascript', 'JSX'],
        '.json': ['json', 'JSON'], '.jsonc': ['javascript', 'JSONC'],
        '.py': ['python', 'Python'], '.pyw': ['python', 'Python'],
        '.sh': ['shell', 'Shell'], '.bash': ['shell', 'Bash'], '.zsh': ['shell', 'Zsh'], '.fish': ['shell', 'Fish'],
        '.yaml': ['yaml', 'YAML'], '.yml': ['yaml', 'YAML'],
        '.go': ['go', 'Go'], '.sql': ['sql', 'SQL'],
        '.ini': ['config', 'INI'], '.conf': ['config', 'Config'], '.cfg': ['config', 'Config'], '.toml': ['config', 'TOML'],
        '.md': ['markdown', 'Markdown'], '.markdown': ['markdown', 'Markdown'],
        '.txt': ['text', 'Text'], '.log': ['text', 'Log']
    };
    var type = types[ext] || ['text', ext ? ext.slice(1).toUpperCase() : 'Text'];
    return { id: type[0], label: type[1] };
}

function remoteEditorIconSVG(kind) {
    if (kind === 'image') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>';
    }
    if (kind === 'video') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="14" height="14" rx="2"/><path d="M17 10l4-2v8l-4-2z"/></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
}

function remoteEditorEscapeCode(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function remoteEditorHighlightWithRules(source, regex, classes) {
    var output = '';
    var lastIndex = 0;
    var match;
    regex.lastIndex = 0;
    while ((match = regex.exec(source))) {
        output += remoteEditorEscapeCode(source.slice(lastIndex, match.index));
        var className = '';
        for (var i = 1; i < match.length; i++) {
            if (match[i] !== undefined) {
                className = classes[i - 1] || '';
                break;
            }
        }
        if (className === 'comment') {
            var trimmedToken = match[0].replace(/^\s+/, '');
            if (/^(?:"|'|\x60)/.test(trimmedToken)) className = 'string';
        }
        var token = remoteEditorEscapeCode(match[0]);
        output += className ? '<span class="tok-' + className + '">' + token + '</span>' : token;
        lastIndex = match.index + match[0].length;
        if (!match[0].length) regex.lastIndex++;
    }
    return output + remoteEditorEscapeCode(source.slice(lastIndex));
}

function remoteEditorHighlightMarkupTag(tag) {
    var openerMatch = tag.match(/^<\/?/);
    var closerMatch = tag.match(/\/?>$/);
    var opener = openerMatch ? openerMatch[0] : '<';
    var closer = closerMatch ? closerMatch[0] : '>';
    var middle = tag.slice(opener.length, Math.max(opener.length, tag.length - closer.length));
    var nameMatch = middle.match(/^[A-Za-z][\w:.-]*/);
    var name = nameMatch ? nameMatch[0] : '';
    var attributes = middle.slice(name.length);
    var highlightedAttributes = remoteEditorHighlightWithRules(
        attributes,
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|([A-Za-z_:][\w:.-]*)(?=\s*=)|(&[A-Za-z0-9#]+;)|(=)/g,
        ['string', 'attr', 'entity', 'punctuation']
    );
    return '<span class="tok-punctuation">' + remoteEditorEscapeCode(opener) + '</span>' +
        '<span class="tok-tag">' + remoteEditorEscapeCode(name) + '</span>' +
        highlightedAttributes +
        '<span class="tok-punctuation">' + remoteEditorEscapeCode(closer) + '</span>';
}

function remoteEditorHighlightMarkup(source) {
    var matcher = /<!--[\s\S]*?-->|<!DOCTYPE[^>]*>|<\/?[A-Za-z][^>]*>/gi;
    var output = '';
    var lastIndex = 0;
    var match;
    while ((match = matcher.exec(source))) {
        output += remoteEditorEscapeCode(source.slice(lastIndex, match.index));
        if (match[0].slice(0, 4) === '<!--') {
            output += '<span class="tok-comment">' + remoteEditorEscapeCode(match[0]) + '</span>';
        } else if (/^<!doctype/i.test(match[0])) {
            output += '<span class="tok-keyword">' + remoteEditorEscapeCode(match[0]) + '</span>';
        } else {
            output += remoteEditorHighlightMarkupTag(match[0]);
        }
        lastIndex = match.index + match[0].length;
    }
    return output + remoteEditorEscapeCode(source.slice(lastIndex));
}

function remoteEditorHighlightCode(source, languageId) {
    source = String(source || '');
    if (languageId === 'html') return remoteEditorHighlightMarkup(source);
    if (languageId === 'json') {
        return remoteEditorHighlightWithRules(source,
            /("(?:\\.|[^"\\])*")(?=\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b)/gi,
            ['property', 'string', 'builtin', 'number']);
    }
    if (languageId === 'javascript') {
        return remoteEditorHighlightWithRules(source,
            /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\[\s\S]|[^\x60\\])*\x60)|\b(break|case|catch|class|const|continue|debugger|default|delete|do|else|export|extends|finally|for|from|function|get|if|import|in|instanceof|let|new|of|return|set|static|super|switch|throw|try|typeof|var|void|while|with|yield|async|await|interface|implements|namespace|private|protected|public|readonly|type)\b|\b(true|false|null|undefined|NaN|Infinity|this)\b|(\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b)|([A-Za-z_$][\w$]*)(?=\s*\()/gi,
            ['comment', 'keyword', 'builtin', 'number', 'function']);
    }
    if (languageId === 'css') {
        return remoteEditorHighlightWithRules(source,
            /(\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(@[\w-]+)|(--?[\w-]+|[\w-]+)(?=\s*:)|(#[\da-f]{3,8}\b)|(-?\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms|deg)?\b)/gi,
            ['comment', 'keyword', 'property', 'number', 'number']);
    }
    if (languageId === 'python') {
        return remoteEditorHighlightWithRules(source,
            /("""[\s\S]*?"""|'''[\s\S]*?'''|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|match|case)\b|\b(True|False|None|self|cls)\b|(@[\w.]+)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*\()/g,
            ['comment', 'keyword', 'builtin', 'decorator', 'number', 'function']);
    }
    if (languageId === 'shell' || languageId === 'docker' || languageId === 'make') {
        return remoteEditorHighlightWithRules(source,
            /(#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*'|\x60[^\x60]*\x60)|\b(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|in|select|time|coproc|export|local|readonly|declare|set|unset|source)\b|(\$\{?[\w@#?$!*-]+\}?|\$\([^)]+\))|(?:^|\s)(--?[\w-]+)|(\b\d+(?:\.\d+)?\b)/gm,
            ['comment', 'keyword', 'variable', 'attr', 'number']);
    }
    if (languageId === 'yaml') {
        return remoteEditorHighlightWithRules(source,
            /(#[^\n]*|"(?:\\.|[^"\\])*"|'[^']*')|(^[ \t-]*[A-Za-z0-9_.-]+)(?=\s*:)|\b(true|false|null|yes|no|on|off)\b|(&[\w-]+|\*[\w-]+|![\w!-]+)|(-?\b\d+(?:\.\d+)?\b)/gim,
            ['comment', 'property', 'builtin', 'variable', 'number']);
    }
    if (languageId === 'go') {
        return remoteEditorHighlightWithRules(source,
            /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60[^\x60]*\x60)|\b(break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\b|\b(true|false|nil|iota)\b|(\b\d+(?:\.\d+)?\b)|([A-Za-z_]\w*)(?=\s*\()/g,
            ['comment', 'keyword', 'builtin', 'number', 'function']);
    }
    if (languageId === 'sql') {
        return remoteEditorHighlightWithRules(source,
            /(\/\*[\s\S]*?\*\/|--[^\n]*|'(?:''|[^'])*'|"(?:\"\"|[^"])*")|\b(select|from|where|insert|into|update|delete|create|alter|drop|table|view|index|join|left|right|inner|outer|on|group|by|order|having|limit|offset|union|all|distinct|as|and|or|not|null|is|in|exists|case|when|then|else|end|values|set|primary|key|foreign|references|constraint|begin|commit|rollback)\b|\b(true|false|null)\b|(\b\d+(?:\.\d+)?\b)/gi,
            ['comment', 'keyword', 'builtin', 'number']);
    }
    if (languageId === 'config' || languageId === 'markdown') {
        return remoteEditorHighlightWithRules(source,
            /(^\s*[#;][^\n]*|<!--[\s\S]*?-->|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60[^\x60]*\x60)|(^\s*\[[^\]\n]+\])|(^\s*[A-Za-z0-9_.-]+)(?=\s*=)|(^#{1,6}\s+.+$)|(\bhttps?:\/\/[^\s<]+)/gm,
            ['comment', 'keyword', 'property', 'tag', 'string']);
    }
    return remoteEditorEscapeCode(source);
}

function remoteEditorUpdateTab(editor) {
    if (!editor || !editor.tab) return;
    var label = editor.tab.querySelector('.remote-editor-tab-name');
    if (label) label.textContent = editor.name || '未命名';
    editor.tab.title = remoteEditorPathLabel(editor) || editor.name || '';
    editor.tab.classList.toggle('is-dirty', remoteEditorIsDirty(editor));
    editor.tab.classList.toggle('is-loading', !!editor.controller && !editor.loaded);
    if (editor.language) editor.tab.dataset.language = editor.language.id;
}

function remoteEditorApplyLanguage(editor) {
    if (!editor || (editor.viewMode || 'text') !== 'text') return;
    editor.language = remoteEditorLanguageForName(editor.name);
    if (editor.languageBadge) {
        editor.languageBadge.textContent = editor.language.label;
        editor.languageBadge.dataset.language = editor.language.id;
    }
    remoteEditorUpdateTab(editor);
}

function updateRemoteEditorWorkspaceSummary(workspace) {
    if (!workspace) return;
    var editors = remoteEditorsForWorkspace(workspace);
    var active = activeRemoteEditorForWorkspace(workspace);
    if (workspace.summary) workspace.summary.textContent = editors.length + ' 个标签';
    if (workspace.activeLabel) {
        workspace.activeLabel.textContent = active ? active.name : '';
        workspace.activeLabel.title = active ? remoteEditorPathLabel(active) : '';
    }
    if (workspace.el) workspace.el.classList.toggle('has-dirty-documents', editors.some(remoteEditorIsDirty));
}

function scheduleRemoteEditorDecorations(editor) {
    if (!editor || !editor.textarea) return;
    var largeFileMode = !!editor._largeFile || editor.textarea.value.length > remoteEditorDecorationMaxBytes;
    if (largeFileMode) {
        if (editor._decorateFrame) {
            cancelAnimationFrame(editor._decorateFrame);
            editor._decorateFrame = 0;
        }
        if (editor.el) editor.el.classList.add('highlight-disabled');
        if (editor.highlightCode && editor.highlightCode.textContent) editor.highlightCode.textContent = '';
        syncRemoteEditorCodeScroll(editor);
        return;
    }
    if (editor._decorateFrame) return;
    editor._decorateFrame = requestAnimationFrame(function () {
        editor._decorateFrame = 0;
        if (!editor.textarea || remoteEditors.indexOf(editor) < 0) return;
        var value = editor.textarea.value || '';
        var highlightEnabled = value.length <= remoteEditorDecorationMaxBytes;
        if (editor.highlightCode) {
            editor.el.classList.toggle('highlight-disabled', !highlightEnabled);
            if (highlightEnabled) editor.highlightCode.innerHTML = remoteEditorHighlightCode(value, editor.language ? editor.language.id : 'text') + '\n';
            else if (editor.highlightCode.textContent) editor.highlightCode.textContent = '';
        }
        syncRemoteEditorCodeScroll(editor);
        drawRemoteEditorMinimap(editor, true);
    });
}

function syncRemoteEditorCodeScroll(editor) {
    if (!editor || !editor.textarea) return;
    if (editor.gutter) editor.gutter.scrollTop = editor.textarea.scrollTop;
    if (editor.highlight) {
        editor.highlight.scrollTop = editor.textarea.scrollTop;
        editor.highlight.scrollLeft = editor.textarea.scrollLeft;
    }
}

function drawRemoteEditorMinimap(editor, redrawContent) {
    if (!editor || !editor.minimap || !editor.minimapWrap || !editor.textarea || !editor.el || !editor.el.classList.contains('is-active')) return;
    var canvas = editor.minimap;
    var wrap = editor.minimapWrap;
    var rect = wrap.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) return;
    var ratio = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    var width = Math.max(1, Math.round(rect.width * ratio));
    var height = Math.max(1, Math.round(rect.height * ratio));
    var canvasResized = canvas.width !== width || canvas.height !== height;
    if (canvasResized) {
        canvas.width = width;
        canvas.height = height;
    }
    if (redrawContent !== false || canvasResized || !editor._minimapDrawn) {
        var context = canvas.getContext('2d');
        if (!context) return;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        context.clearRect(0, 0, rect.width, rect.height);
        var lines = (editor.textarea.value || '').split('\n');
        var drawableHeight = Math.max(1, rect.height - 6);
        var maxRows = Math.max(1, Math.floor(drawableHeight / 2));
        var step = Math.max(1, Math.ceil(lines.length / maxRows));
        var sampledRows = Math.max(1, Math.ceil(lines.length / step));
        // Short files stay grouped at the top instead of being stretched over the
        // entire minimap. Long files are sampled down to the available height.
        var rowHeight = Math.max(1.2, Math.min(2.35, drawableHeight / sampledRows));
        var languageColor = editor.language && editor.language.id === 'html' ? '#fb923c' :
            (editor.language && editor.language.id === 'python' ? '#60a5fa' :
                (editor.language && editor.language.id === 'css' ? '#c084fc' : '#67e8f9'));
        context.globalAlpha = .66;
        var rowIndex = 0;
        for (var i = 0; i < lines.length; i += step) {
            var line = lines[i] || '';
            var trimmed = line.trim();
            var y = 3 + rowIndex * rowHeight;
            rowIndex++;
            if (!trimmed) continue;
            var indent = Math.min(22, line.length - line.replace(/^\s+/, '').length);
            var x = 3 + Math.min(rect.width * .34, indent * .65);
            var lineWidth = Math.max(2, Math.min(rect.width - x - 4, trimmed.length * .72));
            context.fillStyle = /^(#|\/\/|\/\*|<!--|--)/.test(trimmed) ? '#4ade80' :
                (/^["'\x60]/.test(trimmed) ? '#fbbf24' : languageColor);
            context.fillRect(x, y, lineWidth, Math.max(1, Math.min(1.45, rowHeight - .25)));
        }
        editor._minimapDrawn = true;
    }
    var scrollHeight = Math.max(editor.textarea.clientHeight, editor.textarea.scrollHeight);
    var maxScroll = Math.max(0, editor.textarea.scrollHeight - editor.textarea.clientHeight);
    var trackHeight = Math.max(1, rect.height - 4);
    var viewportHeight = maxScroll > 0 ? Math.max(20, trackHeight * editor.textarea.clientHeight / scrollHeight) : trackHeight;
    viewportHeight = Math.min(trackHeight, viewportHeight);
    var viewportTravel = Math.max(0, trackHeight - viewportHeight);
    var viewportTop = 2 + (maxScroll > 0 ? viewportTravel * editor.textarea.scrollTop / maxScroll : 0);
    wrap.classList.toggle('is-scrollable', maxScroll > 0);
    wrap.classList.toggle('is-static', maxScroll <= 0);
    wrap.title = maxScroll > 0 ? '拖动滑块快速滚动，点击缩略图可跳转' : '当前文件已完整显示，无需滚动';
    wrap.setAttribute('aria-valuenow', maxScroll > 0 ? String(Math.round(editor.textarea.scrollTop / maxScroll * 100)) : '0');
    wrap.setAttribute('aria-disabled', maxScroll > 0 ? 'false' : 'true');
    if (editor.minimapViewport) {
        editor.minimapViewport.style.top = viewportTop + 'px';
        editor.minimapViewport.style.height = viewportHeight + 'px';
    }
}

function scrollRemoteEditorFromMinimap(editor, clientY, dragOffset) {
    if (!editor || !editor.minimapWrap || !editor.textarea) return;
    var rect = editor.minimapWrap.getBoundingClientRect();
    var maxScroll = Math.max(0, editor.textarea.scrollHeight - editor.textarea.clientHeight);
    if (maxScroll <= 0) return;
    var trackHeight = Math.max(1, rect.height - 4);
    var scrollHeight = Math.max(editor.textarea.clientHeight, editor.textarea.scrollHeight);
    var viewportHeight = Math.min(trackHeight, Math.max(20, trackHeight * editor.textarea.clientHeight / scrollHeight));
    var viewportTravel = Math.max(1, trackHeight - viewportHeight);
    if (!isFinite(dragOffset)) dragOffset = viewportHeight / 2;
    var viewportTop = clientY - rect.top - 2 - dragOffset;
    var ratio = Math.max(0, Math.min(1, viewportTop / viewportTravel));
    editor.textarea.scrollTop = ratio * maxScroll;
    syncRemoteEditorCodeScroll(editor);
    drawRemoteEditorMinimap(editor, false);
}

function setupRemoteEditorMinimap(editor) {
    if (!editor || !editor.minimapWrap || !editor.minimap) return;
    var wrap = editor.minimapWrap;
    var dragging = false;
    var dragOffset = 0;
    function stopDragging(event) {
        if (!dragging) return;
        dragging = false;
        wrap.classList.remove('is-dragging');
        if (event && event.pointerId != null) {
            try { wrap.releasePointerCapture(event.pointerId); } catch (e) { }
        }
    }
    wrap.addEventListener('pointerdown', function (event) {
        var maxScroll = Math.max(0, editor.textarea.scrollHeight - editor.textarea.clientHeight);
        if (maxScroll <= 0) { wrap.focus(); return; }
        var viewportRect = editor.minimapViewport ? editor.minimapViewport.getBoundingClientRect() : null;
        dragOffset = viewportRect && event.clientY >= viewportRect.top && event.clientY <= viewportRect.bottom
            ? event.clientY - viewportRect.top
            : (viewportRect ? viewportRect.height / 2 : 10);
        dragging = true;
        wrap.classList.add('is-dragging');
        try { wrap.setPointerCapture(event.pointerId); } catch (e) { }
        scrollRemoteEditorFromMinimap(editor, event.clientY, dragOffset);
        event.preventDefault();
    });
    wrap.addEventListener('pointermove', function (event) {
        if (dragging) scrollRemoteEditorFromMinimap(editor, event.clientY, dragOffset);
    });
    wrap.addEventListener('pointerup', stopDragging);
    wrap.addEventListener('pointercancel', stopDragging);
    wrap.addEventListener('wheel', function (event) {
        var maxScroll = Math.max(0, editor.textarea.scrollHeight - editor.textarea.clientHeight);
        if (maxScroll <= 0) return;
        editor.textarea.scrollTop = Math.max(0, Math.min(maxScroll, editor.textarea.scrollTop + event.deltaY));
        syncRemoteEditorCodeScroll(editor);
        drawRemoteEditorMinimap(editor, false);
        event.preventDefault();
    }, { passive: false });
    wrap.addEventListener('keydown', function (event) {
        var maxScroll = Math.max(0, editor.textarea.scrollHeight - editor.textarea.clientHeight);
        if (maxScroll <= 0) return;
        var next = editor.textarea.scrollTop;
        if (event.key === 'ArrowUp') next -= 40;
        else if (event.key === 'ArrowDown') next += 40;
        else if (event.key === 'PageUp') next -= editor.textarea.clientHeight * .9;
        else if (event.key === 'PageDown') next += editor.textarea.clientHeight * .9;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = maxScroll;
        else return;
        editor.textarea.scrollTop = Math.max(0, Math.min(maxScroll, next));
        syncRemoteEditorCodeScroll(editor);
        drawRemoteEditorMinimap(editor, false);
        event.preventDefault();
    });
}

function createRemoteEditorWorkspace(session) {
    if (!session) return null;
    if (session._remoteEditorWorkspace && session._remoteEditorWorkspace.el && session._remoteEditorWorkspace.el.parentNode) {
        return session._remoteEditorWorkspace;
    }
    var layer = document.getElementById('remoteEditorLayer');
    if (!layer) return null;
    var win = document.createElement('section');
    win.className = 'remote-editor-window remote-editor-workspace';
    win.setAttribute('role', 'dialog');
    win.setAttribute('aria-label', 'SFTP 在线工作台');
    win.dataset.sessionId = session.id;
    win.innerHTML = '<div class="remote-editor-header" data-editor-drag="1">' +
        '<div class="remote-editor-workspace-brand">' + remoteEditorIconSVG('text') +
        '<span class="remote-editor-workspace-title"><span><b>SFTP 工作台</b><i>SFTP</i></span><small class="remote-editor-workspace-host"></small></span>' +
        '<span class="remote-editor-workspace-active"></span><small class="remote-editor-workspace-summary"></small></div>' +
        '<div class="remote-editor-actions"><button type="button" class="remote-editor-btn" data-workspace-action="minimize" title="最小化工作台"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg></button><button type="button" class="remote-editor-btn" data-workspace-action="maximize" title="最大化"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="14" rx="1"/></svg></button><button type="button" class="remote-editor-btn close" data-workspace-action="close" title="关闭工作台"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>' +
        '<div class="remote-editor-tabs" role="tablist" aria-label="已打开的远端文件"></div>' +
        '<div class="remote-editor-panes"></div>';
    layer.appendChild(win);
    var workspace = {
        sessionId: session.id,
        el: win,
        header: win.querySelector('.remote-editor-header'),
        tabs: win.querySelector('.remote-editor-tabs'),
        panes: win.querySelector('.remote-editor-panes'),
        summary: win.querySelector('.remote-editor-workspace-summary'),
        host: win.querySelector('.remote-editor-workspace-host'),
        activeLabel: win.querySelector('.remote-editor-workspace-active'),
        maxBtn: win.querySelector('[data-workspace-action="maximize"]'),
        minimized: false,
        maximized: false,
        restoreRect: null,
        activeEditorId: ''
    };
    if (workspace.host) {
        var hostLabel = session.hostname || '远端主机';
        if (session.username) hostLabel = session.username + '@' + hostLabel;
        workspace.host.textContent = hostLabel;
        workspace.host.title = hostLabel;
    }
    session._remoteEditorWorkspace = workspace;
    win.querySelectorAll('[data-workspace-action]').forEach(function (button) {
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            var active = activeRemoteEditorForWorkspace(workspace);
            var action = button.dataset.workspaceAction;
            if (action === 'minimize') minimizeRemoteEditor(active || workspace);
            else if (action === 'maximize') toggleMaximizeRemoteEditor(active || workspace);
            else if (action === 'close') requestCloseRemoteEditorWorkspace(workspace);
        });
    });
    win.addEventListener('pointerdown', function () {
        remoteEditorZIndex += 1;
        win.style.zIndex = remoteEditorZIndex;
    });
    setupRemoteEditorDragging(workspace);
    if (typeof ResizeObserver === 'function') {
        workspace.resizeObserver = new ResizeObserver(function () { scheduleRemoteEditorClamp(workspace); });
        workspace.resizeObserver.observe(win);
    }
    updateRemoteEditorWorkspaceSummary(workspace);
    return workspace;
}

function createRemoteEditorElement(editor) {
    var session = remoteEditorSession(editor);
    var workspace = createRemoteEditorWorkspace(session);
    if (!workspace) return false;
    editor.viewMode = editor.viewMode || 'text';
    editor.workspace = workspace;
    var kind = editor.viewMode === 'image' || editor.viewMode === 'video' ? editor.viewMode : 'text';
    var tab = document.createElement('div');
    tab.className = 'remote-editor-tab';
    tab.setAttribute('role', 'tab');
    tab.setAttribute('tabindex', '0');
    tab.setAttribute('aria-selected', 'false');
    tab.dataset.editorId = editor.id;
    tab.innerHTML = '<span class="remote-editor-tab-icon">' + remoteEditorIconSVG(kind) + '</span><span class="remote-editor-tab-name"></span><i class="remote-editor-tab-dirty" aria-label="有未保存修改"></i><button type="button" class="remote-editor-tab-close" title="关闭标签" aria-label="关闭文件"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
    workspace.tabs.appendChild(tab);

    var pane = document.createElement('section');
    pane.className = 'remote-editor-document' + (editor.isNew ? ' is-new' : ' is-loading');
    pane.setAttribute('role', 'tabpanel');
    pane.dataset.editorId = editor.id;
    var toolbarAction = kind === 'text'
        ? '<button type="button" class="remote-editor-btn primary remote-editor-save" data-editor-action="save" title="保存 (Ctrl+S)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg><span>保存</span></button>'
        : '<button type="button" class="remote-editor-btn remote-media-fit" data-editor-action="media-fit" title="切换适应窗口/原始尺寸"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5"/></svg><span>适应</span></button>';
    var body = kind === 'text'
        ? '<div class="remote-editor-body remote-editor-code-body"><pre class="remote-editor-gutter" aria-hidden="true"></pre><div class="remote-editor-code-surface"><pre class="remote-editor-highlight" aria-hidden="true"><code></code></pre><textarea class="remote-editor-textarea" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off" aria-label="文件内容"></textarea></div><div class="remote-editor-minimap-wrap" role="scrollbar" aria-label="代码快速滚动预览" aria-orientation="vertical" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" tabindex="0"><canvas class="remote-editor-minimap" aria-hidden="true"></canvas><i class="remote-editor-minimap-viewport" aria-hidden="true"></i></div><div class="remote-editor-loading">正在读取远程文件…</div></div>'
        : '<div class="remote-editor-body remote-editor-media-body"><div class="remote-editor-media-stage"><div class="remote-editor-media-placeholder">' + remoteEditorIconSVG(kind) + '<span>正在准备' + (kind === 'video' ? '视频' : '图片') + '预览…</span></div></div><div class="remote-editor-loading">正在读取远程媒体…</div></div>';
    pane.innerHTML = '<div class="remote-editor-document-bar">' + toolbarAction +
        '<span class="remote-editor-file-icon" aria-hidden="true">' + remoteEditorIconSVG(kind) + '</span><span class="remote-editor-title"><input class="remote-editor-name" type="text" maxlength="255" autocomplete="off" spellcheck="false" aria-label="文件名"><small></small></span><span class="remote-editor-language"></span><i class="remote-editor-dirty" aria-label="有未保存修改"></i></div>' +
        body +
        '<div class="remote-editor-footer"><span class="remote-editor-status info">正在连接…</span><span class="remote-editor-metrics"></span></div>';
    workspace.panes.appendChild(pane);

    editor.el = pane;
    editor.tab = tab;
    editor.nameInput = pane.querySelector('.remote-editor-name');
    editor.subtitle = pane.querySelector('.remote-editor-title small');
    editor.status = pane.querySelector('.remote-editor-status');
    editor.metrics = pane.querySelector('.remote-editor-metrics');
    editor.saveBtn = pane.querySelector('[data-editor-action="save"]');
    editor.languageBadge = pane.querySelector('.remote-editor-language');
    editor.nameInput.value = editor.name;
    editor.nameInput.readOnly = !editor.isNew;
    editor.subtitle.textContent = remoteEditorPathLabel(editor);

    tab.addEventListener('click', function (event) {
        if (!event.target.closest('.remote-editor-tab-close')) activateRemoteEditor(editor);
    });
    tab.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activateRemoteEditor(editor);
        }
    });
    tab.querySelector('.remote-editor-tab-close').addEventListener('click', function (event) {
        event.stopPropagation();
        requestCloseRemoteEditor(editor);
    });

    editor.nameInput.addEventListener('input', function () {
        if (!editor.isNew) return;
        editor.name = editor.nameInput.value.trim();
        editor.path = joinRemoteFilePath(editor.parentPath, editor.name);
        editor.targetPath = '';
        editor.subtitle.textContent = remoteEditorPathLabel(editor) || normalizeSftpDir(editor.parentPath);
        remoteEditorApplyLanguage(editor);
        remoteEditorUpdateMetrics(editor);
    });

    if (kind === 'text') {
        editor.textarea = pane.querySelector('.remote-editor-textarea');
        editor.gutter = pane.querySelector('.remote-editor-gutter');
        editor.highlight = pane.querySelector('.remote-editor-highlight');
        editor.highlightCode = pane.querySelector('.remote-editor-highlight code');
        editor.minimapWrap = pane.querySelector('.remote-editor-minimap-wrap');
        editor.minimap = pane.querySelector('.remote-editor-minimap');
        editor.minimapViewport = pane.querySelector('.remote-editor-minimap-viewport');
        editor.textarea.readOnly = true;
        editor.nameInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); editor.textarea.focus(); }
        });
        editor.textarea.addEventListener('input', function () {
            var tooLarge = editor._largeFile || editor.textarea.value.length > remoteEditorDecorationMaxBytes
                ? remoteEditorHandleLargeFileInput(editor)
                : remoteEditorUpdateMetrics(editor);
            if (!editor.saving && !tooLarge) remoteEditorSetStatus(editor, remoteEditorIsDirty(editor) ? '有未保存修改' : '已保存', remoteEditorIsDirty(editor) ? 'warn' : 'success');
        });
        editor.textarea.addEventListener('scroll', function () {
            syncRemoteEditorCodeScroll(editor);
            drawRemoteEditorMinimap(editor, false);
        });
        editor.textarea.addEventListener('keydown', function (event) {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
                event.preventDefault();
                saveRemoteEditor(editor);
                return;
            }
            if (event.key === 'Tab') {
                event.preventDefault();
                if (indentRemoteEditorSelection(editor.textarea, event.shiftKey)) {
                    editor.textarea.dispatchEvent(new Event('input', { bubbles: true }));
                }
            }
        });
        setupRemoteEditorMinimap(editor);
        if (typeof ResizeObserver === 'function') {
            editor.minimapResizeObserver = new ResizeObserver(function () {
                scheduleRemoteEditorDecorations(editor);
            });
            editor.minimapResizeObserver.observe(editor.minimapWrap);
        }
        remoteEditorApplyLanguage(editor);
    } else {
        editor.mediaStage = pane.querySelector('.remote-editor-media-stage');
        editor.language = { id: kind, label: kind === 'video' ? 'Video' : 'Image' };
        editor.languageBadge.textContent = editor.language.label;
        editor.languageBadge.dataset.language = kind;
    }

    pane.querySelectorAll('[data-editor-action]').forEach(function (button) {
        button.addEventListener('click', function (event) {
            event.stopPropagation();
            var action = button.dataset.editorAction;
            if (action === 'save') saveRemoteEditor(editor);
            else if (action === 'media-fit') {
                editor.mediaActualSize = !editor.mediaActualSize;
                editor.el.classList.toggle('media-actual-size', editor.mediaActualSize);
                var label = button.querySelector('span');
                if (label) label.textContent = editor.mediaActualSize ? '原始' : '适应';
            }
        });
    });
    pane.addEventListener('pointerdown', function () { activateRemoteEditor(editor, false); });
    remoteEditorUpdateMetrics(editor);
    updateRemoteEditorWorkspaceSummary(workspace);
    activateRemoteEditor(editor, false);
    return true;
}

function setupRemoteEditorDragging(workspace) {
    if (!workspace || !workspace.header) return;
    var dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;
    workspace.header.addEventListener('pointerdown', function (event) {
        if (workspace.maximized || event.target.closest('button,input,textarea')) return;
        dragging = true;
        startX = event.clientX; startY = event.clientY;
        startLeft = workspace.el.offsetLeft; startTop = workspace.el.offsetTop;
        try { workspace.header.setPointerCapture(event.pointerId); } catch (e) { }
        event.preventDefault();
    });
    workspace.header.addEventListener('pointermove', function (event) {
        if (!dragging || workspace.maximized) return;
        var layer = document.getElementById('remoteEditorLayer');
        if (!layer) return;
        var maxLeft = Math.max(0, layer.clientWidth - workspace.el.offsetWidth);
        var maxTop = Math.max(0, layer.clientHeight - workspace.el.offsetHeight);
        workspace.el.style.left = Math.max(0, Math.min(maxLeft, startLeft + event.clientX - startX)) + 'px';
        workspace.el.style.top = Math.max(0, Math.min(maxTop, startTop + event.clientY - startY)) + 'px';
    });
    workspace.header.addEventListener('pointerup', function () { dragging = false; });
    workspace.header.addEventListener('pointercancel', function () { dragging = false; });
}

function activateRemoteEditor(editor, focusEditor) {
    if (!editor) return;
    var workspace = remoteEditorWorkspaceFor(editor);
    if (!workspace || !workspace.el) return;
    workspace.activeEditorId = editor.id;
    remoteEditorZIndex += 1;
    workspace.el.style.zIndex = remoteEditorZIndex;
    remoteEditorsForWorkspace(workspace).forEach(function (item) {
        var active = item === editor;
        if (item.el) item.el.classList.toggle('is-active', active);
        if (item.tab) {
            item.tab.classList.toggle('is-active', active);
            item.tab.setAttribute('aria-selected', active ? 'true' : 'false');
            item.tab.setAttribute('tabindex', active ? '0' : '-1');
        }
    });
    updateRemoteEditorWorkspaceSummary(workspace);
    requestAnimationFrame(function () {
        scheduleRemoteEditorDecorations(editor);
        if (focusEditor !== false && editor.textarea && !editor.textarea.readOnly) {
            try { editor.textarea.focus(); } catch (e) { }
        }
    });
}

function clampRemoteEditorToLayer(editor) {
    var layer = document.getElementById('remoteEditorLayer');
    if (!editor || !editor.el || !layer || editor.maximized) return;
    var layerWidth = layer.clientWidth;
    var layerHeight = layer.clientHeight;
    if (layerWidth <= 0 || layerHeight <= 0) return;

    if (editor.el.offsetWidth > layerWidth) editor.el.style.width = layerWidth + 'px';
    if (editor.el.offsetHeight > layerHeight) editor.el.style.height = layerHeight + 'px';
    var maxLeft = Math.max(0, layerWidth - editor.el.offsetWidth);
    var maxTop = Math.max(0, layerHeight - editor.el.offsetHeight);
    var left = Math.max(0, Math.min(maxLeft, editor.el.offsetLeft));
    var top = Math.max(0, Math.min(maxTop, editor.el.offsetTop));
    if (editor.el.offsetLeft !== left) editor.el.style.left = left + 'px';
    if (editor.el.offsetTop !== top) editor.el.style.top = top + 'px';
}

function scheduleRemoteEditorClamp(editor) {
    if (!editor || editor._clampFrame) return;
    editor._clampFrame = requestAnimationFrame(function () {
        editor._clampFrame = 0;
        clampRemoteEditorToLayer(editor);
    });
}

function remoteEditorLayerWidth() {
    var layer = document.getElementById('remoteEditorLayer');
    var dock = document.getElementById('remoteEditorDock');
    var panel = document.getElementById('sftpPanel');
    var scriptDrawer = document.getElementById('scriptDrawer');
    if (!layer) return;
    var sftpRight = panel && panel.classList.contains('open') ? panel.getBoundingClientRect().width : 0;
    var scriptRight = scriptDrawer && scriptDrawer.classList.contains('open') ? scriptDrawer.getBoundingClientRect().width : 0;
    var right = Math.max(sftpRight, scriptRight);
    var commandBar = document.querySelector('.cmd-bar');
    var bottom = commandBar ? commandBar.getBoundingClientRect().height : 0;
    layer.style.right = Math.max(0, Math.round(right)) + 'px';
    layer.style.bottom = Math.max(0, Math.round(bottom)) + 'px';
    if (dock) {
        dock.style.right = Math.max(0, Math.round(right)) + 'px';
        dock.style.bottom = Math.max(7, Math.round(bottom) + 7) + 'px';
    }
    var seenWorkspaces = {};
    remoteEditors.forEach(function (editor) {
        var workspace = remoteEditorWorkspaceFor(editor);
        if (!workspace || seenWorkspaces[workspace.sessionId]) return;
        seenWorkspaces[workspace.sessionId] = true;
        scheduleRemoteEditorClamp(workspace);
    });
}

function ensureRemoteEditorBoundsObserver() {
    if (remoteEditorBoundsObserver) return;
    var panel = document.getElementById('sftpPanel');
    var scriptDrawer = document.getElementById('scriptDrawer');
    var commandBar = document.querySelector('.cmd-bar');
    if (typeof ResizeObserver === 'function' && panel) {
        remoteEditorBoundsObserver = new ResizeObserver(remoteEditorLayerWidth);
        remoteEditorBoundsObserver.observe(panel);
        if (scriptDrawer) remoteEditorBoundsObserver.observe(scriptDrawer);
        if (commandBar) remoteEditorBoundsObserver.observe(commandBar);
    } else {
        remoteEditorBoundsObserver = { fallback: true };
    }
    if (panel) panel.addEventListener('transitionend', remoteEditorLayerWidth);
    if (scriptDrawer) scriptDrawer.addEventListener('transitionend', remoteEditorLayerWidth);
    addEventListener('resize', remoteEditorLayerWidth);
    remoteEditorLayerWidth();
}

function syncRemoteEditorVisibility() {
    var active = getActiveSession();
    sessions.forEach(function (session) {
        var workspace = session._remoteEditorWorkspace;
        if (!workspace || !workspace.el) return;
        var visible = !!active && session.id === active.id && !workspace.minimized && remoteEditorsForWorkspace(workspace).length > 0;
        workspace.el.classList.toggle('is-inactive', !visible);
    });
    renderRemoteEditorDock(active);
    remoteEditorLayerWidth();
}

function renderRemoteEditorDock(activeSession) {
    var dock = document.getElementById('remoteEditorDock');
    if (!dock) return;
    dock.innerHTML = '';
    if (!activeSession) return;
    var workspace = activeSession._remoteEditorWorkspace;
    var editors = remoteEditorsForWorkspace(workspace);
    if (!workspace || !workspace.minimized || !editors.length) return;
    var activeEditor = activeRemoteEditorForWorkspace(workspace) || editors[editors.length - 1];
    var dirty = editors.some(remoteEditorIsDirty);
    var item = document.createElement('button');
    item.type = 'button';
    item.className = 'remote-editor-dock-item' + (dirty ? ' is-dirty' : '');
    item.title = '恢复 SFTP 工作台';
    item.innerHTML = remoteEditorIconSVG(activeEditor.viewMode || 'text') + '<span></span><b></b>';
    item.querySelector('span').textContent = activeEditor.name + (dirty ? ' · 未保存' : '');
    item.querySelector('b').textContent = editors.length > 1 ? '+' + (editors.length - 1) : '';
    item.addEventListener('click', function () { restoreRemoteEditor(activeEditor); });
    dock.appendChild(item);
}

function loadRemoteEditor(editor) {
    var session = remoteEditorSession(editor);
    if (!session || !session._connected) {
        remoteEditorSetStatus(editor, 'SSH 连接尚未就绪', 'error');
        editor.el.classList.remove('is-loading');
        remoteEditorUpdateMetrics(editor);
        return;
    }
    editor.retryInitialLoad = false;
    editor.textarea.readOnly = true;
    var controller = new AbortController();
    editor.controller = controller;
    (session._remoteEditorControllers || (session._remoteEditorControllers = [])).push(controller);
    remoteEditorRequest('/file/edit/open', { sshInfo: session.sshInfo, path: editor.path }, controller.signal)
        .then(function (data) {
            if (remoteEditors.indexOf(editor) < 0 || editor.controller !== controller) return;
            editor.originalContent = String(data.content || '');
            editor.textarea.value = editor.originalContent;
            editor.version = String(data.version || '');
            editor.targetPath = normalizeRemoteFilePath(data.targetPath || editor.path);
            editor.sizeBytes = Math.max(0, parseInt(data.size, 10) || 0);
            editor.loaded = true;
            editor.retryInitialLoad = false;
            editor.maxBytes = parseInt(data.maxBytes, 10) || remoteEditorDefaultMaxBytes;
            editor.el.classList.remove('is-loading');
            editor.textarea.readOnly = false;
            editor.subtitle.textContent = remoteEditorPathLabel(editor);
            remoteEditorSetStatus(editor, editor.targetPath !== editor.path ? '已加载符号链接目标 · Ctrl+S 保存' : '已加载 · Ctrl+S 保存', 'success');
            remoteEditorUpdateMetrics(editor);
            var workspace = remoteEditorWorkspaceFor(editor);
            if (workspace && workspace.activeEditorId === editor.id) editor.textarea.focus();
        })
        .catch(function (err) {
            if (remoteEditors.indexOf(editor) < 0 || editor.controller !== controller) return;
            editor.el.classList.remove('is-loading');
            var aborted = requestWasAborted(err);
            editor.retryInitialLoad = aborted;
            if (!aborted) remoteEditorSetStatus(editor, (err.msg || '读取失败') + ' · 再次点击编辑按钮重试', 'error');
            else remoteEditorSetStatus(editor, session._connected ? '读取已取消，正在重试' : 'SSH 已断开，等待重连', 'warn');
            remoteEditorUpdateMetrics(editor);
        })
        .finally(function () {
            removeRemoteEditorController(session, controller);
            if (editor.controller === controller) editor.controller = null;
            if (editor.retryInitialLoad && session._connected) scheduleRemoteEditorInitialLoad(editor, session);
        });
}

function remotePreviewKindForName(name) {
    var ext = String(name || '').toLowerCase().match(/\.[^.]+$/);
    ext = ext ? ext[0] : '';
    if (['.mp4', '.webm', '.ogg', '.ogv', '.mov', '.m4v'].indexOf(ext) >= 0) return 'video';
    if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif', '.svg', '.ico'].indexOf(ext) >= 0) return 'image';
    return '';
}

function loadRemotePreview(editor) {
    var session = remoteEditorSession(editor);
    if (!session || !session._connected) {
        remoteEditorSetStatus(editor, 'SSH 连接尚未就绪', 'error');
        if (editor.el) editor.el.classList.remove('is-loading');
        remoteEditorUpdateMetrics(editor);
        return;
    }
    editor.retryInitialLoad = false;
    var controller = new AbortController();
    editor.controller = controller;
    (session._remoteEditorControllers || (session._remoteEditorControllers = [])).push(controller);
    fetch('/file/preview', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sshInfo: session.sshInfo, path: editor.path }),
        signal: controller.signal
    }).then(function (response) {
        if (!response.ok) {
            return response.text().then(function (text) {
                var data = {};
                try { data = text ? JSON.parse(text) : {}; } catch (e) { }
                throw { msg: data.Msg || '预览读取失败', status: response.status };
            });
        }
        var responseKind = response.headers.get('X-WebSSH-Preview-Kind') || editor.viewMode;
        if (responseKind !== editor.viewMode) throw { msg: '服务器返回的媒体类型与请求不一致' };
        editor.sizeBytes = Math.max(0, parseInt(response.headers.get('X-WebSSH-File-Size') || response.headers.get('Content-Length'), 10) || 0);
        editor.previewMime = response.headers.get('Content-Type') || editor.previewMime || '';
        remoteEditorSetStatus(editor, '正在载入 ' + fmtB(editor.sizeBytes) + '…', 'info');
        return response.blob();
    }).then(function (blob) {
        if (remoteEditors.indexOf(editor) < 0 || editor.controller !== controller) return;
        if (editor.objectUrl) {
            try { URL.revokeObjectURL(editor.objectUrl); } catch (e) { }
        }
        editor.objectUrl = URL.createObjectURL(blob);
        editor.mediaStage.innerHTML = '';
        var media;
        if (editor.viewMode === 'video') {
            media = document.createElement('video');
            media.className = 'remote-editor-video';
            media.controls = true;
            media.preload = 'metadata';
            media.playsInline = true;
            media.addEventListener('loadedmetadata', function () {
                editor.mediaWidth = media.videoWidth || 0;
                editor.mediaHeight = media.videoHeight || 0;
                editor.mediaDuration = media.duration || 0;
                remoteEditorSetStatus(editor, '视频预览已就绪', 'success');
                remoteEditorUpdateMetrics(editor);
            });
        } else {
            media = document.createElement('img');
            media.className = 'remote-editor-image';
            media.alt = editor.name;
            media.addEventListener('load', function () {
                editor.mediaWidth = media.naturalWidth || 0;
                editor.mediaHeight = media.naturalHeight || 0;
                remoteEditorSetStatus(editor, '图片预览已就绪', 'success');
                remoteEditorUpdateMetrics(editor);
            });
        }
        media.addEventListener('error', function () {
            remoteEditorSetStatus(editor, '浏览器无法解码此媒体格式', 'error');
        });
        editor.mediaElement = media;
        editor.mediaStage.appendChild(media);
        editor.loaded = true;
        editor.retryInitialLoad = false;
        editor.el.classList.remove('is-loading');
        media.src = editor.objectUrl;
        remoteEditorUpdateMetrics(editor);
    }).catch(function (err) {
        if (remoteEditors.indexOf(editor) < 0 || editor.controller !== controller) return;
        if (editor.el) editor.el.classList.remove('is-loading');
        var aborted = requestWasAborted(err);
        editor.retryInitialLoad = aborted;
        if (!aborted) remoteEditorSetStatus(editor, (err.msg || '预览读取失败') + ' · 再次点击预览按钮重试', 'error');
        else remoteEditorSetStatus(editor, session._connected ? '预览读取已取消，正在重试' : 'SSH 已断开，等待重连', 'warn');
        remoteEditorUpdateMetrics(editor);
    }).finally(function () {
        removeRemoteEditorController(session, controller);
        if (editor.controller === controller) editor.controller = null;
        if (editor.retryInitialLoad && session._connected) scheduleRemoteEditorInitialLoad(editor, session);
    });
}

function openRemotePreview(path, kind, mime, session) {
    session = session || getActiveSession();
    path = normalizeRemoteFilePath(path);
    kind = kind === 'video' ? 'video' : (kind === 'image' ? 'image' : remotePreviewKindForName(path));
    if (!session || sessions.indexOf(session) < 0 || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    if (!path || !kind) { showToast('此文件不支持在线预览', 'error'); return; }
    prepareRemoteEditorWorkspace();
    var existing = remoteEditorFor(session, path, kind);
    if (existing) {
        restoreRemoteEditor(existing);
        if (!existing.loaded && !existing.controller) {
            existing.el.classList.add('is-loading');
            loadRemotePreview(existing);
        }
        return;
    }
    var editor = {
        id: 'editor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        sessionId: session.id,
        path: path,
        targetPath: '',
        name: path.split('/').pop() || path,
        parentPath: normalizeSftpDir(path.substring(0, path.lastIndexOf('/')) || '/'),
        viewMode: kind,
        previewMime: String(mime || ''),
        isNew: false,
        version: '',
        originalContent: '',
        maxBytes: remotePreviewDefaultMaxBytes,
        sizeBytes: -1,
        minimized: false,
        maximized: false,
        saving: false,
        loaded: false,
        restoreRect: null
    };
    remoteEditors.push(editor);
    if (!createRemoteEditorElement(editor)) { remoteEditors.pop(); return; }
    syncRemoteEditorVisibility();
    loadRemotePreview(editor);
}

function openRemoteEditor(path, session) {
    session = session || getActiveSession();
    path = normalizeRemoteFilePath(path);
    if (!session || sessions.indexOf(session) < 0 || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    if (!path) { showToast('文件路径无效', 'error'); return; }
    prepareRemoteEditorWorkspace();
    var existing = remoteEditorFor(session, path, 'text');
    if (existing) {
        restoreRemoteEditor(existing);
        if (!existing.loaded && !existing.controller && !remoteEditorIsDirty(existing)) {
            existing.el.classList.add('is-loading');
            loadRemoteEditor(existing);
        }
        return;
    }
    var editor = { id: 'editor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), sessionId: session.id, path: path, targetPath: '', name: path.split('/').pop() || path, parentPath: normalizeSftpDir(path.substring(0, path.lastIndexOf('/')) || '/'), viewMode: 'text', isNew: false, version: '', originalContent: '', maxBytes: remoteEditorDefaultMaxBytes, sizeBytes: 0, minimized: false, maximized: false, saving: false, loaded: false, restoreRect: null };
    remoteEditors.push(editor);
    if (!createRemoteEditorElement(editor)) { remoteEditors.pop(); return; }
    syncRemoteEditorVisibility();
    loadRemoteEditor(editor);
}

function sanitizeRemoteFileName(name) {
    name = String(name || '').trim();
    if (!name || name === '.' || name === '..' || name.indexOf('/') >= 0 || name.indexOf('\\') >= 0 || /[\u0000-\u001f\u007f]/.test(name)) return '';
    if (utf8ByteLength(name) > 255) return '';
    return name;
}

function joinRemoteFilePath(directory, name) {
    directory = normalizeSftpDir(directory);
    name = sanitizeRemoteFileName(name);
    return name ? (directory === '/' ? '/' + name : directory + '/' + name) : '';
}

function openNewRemoteFile() {
    var session = getActiveSession();
    if (!session || sessions.indexOf(session) < 0 || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    prepareRemoteEditorWorkspace();
    var parentPath = normalizeSftpDir(session.sftpPath || document.getElementById('sftpPath').value || '/');
    var editor = { id: 'editor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), sessionId: session.id, path: '', targetPath: '', name: '新建文件.txt', parentPath: parentPath, viewMode: 'text', isNew: true, version: '', originalContent: '', maxBytes: remoteEditorDefaultMaxBytes, sizeBytes: 0, minimized: false, maximized: false, saving: false, loaded: true, restoreRect: null };
    editor.path = joinRemoteFilePath(parentPath, editor.name);
    remoteEditors.push(editor);
    if (!createRemoteEditorElement(editor)) { remoteEditors.pop(); return; }
    editor.el.classList.remove('is-loading');
    editor.textarea.readOnly = false;
    editor.subtitle.textContent = remoteEditorPathLabel(editor);
    remoteEditorSetStatus(editor, '新建文件 · 首次保存不会覆盖同名文件', 'info');
    remoteEditorUpdateMetrics(editor);
    syncRemoteEditorVisibility();
    setTimeout(function () { editor.nameInput.focus(); editor.nameInput.select(); }, 0);
}

function minimizeRemoteEditor(editorOrWorkspace) {
    var workspace = editorOrWorkspace && editorOrWorkspace.tabs ? editorOrWorkspace : remoteEditorWorkspaceFor(editorOrWorkspace);
    if (!workspace || !workspace.el) return;
    workspace.minimized = true;
    remoteEditorsForWorkspace(workspace).forEach(function (editor) { editor.minimized = true; });
    workspace.el.classList.add('is-inactive');
    renderRemoteEditorDock(getActiveSession());
}

function restoreRemoteEditor(editor) {
    if (!editor) return;
    var workspace = editor.tabs ? editor : remoteEditorWorkspaceFor(editor);
    if (!workspace || !workspace.el) return;
    workspace.minimized = false;
    remoteEditorsForWorkspace(workspace).forEach(function (item) { item.minimized = false; });
    workspace.el.classList.remove('is-inactive');
    var active = editor.tabs ? activeRemoteEditorForWorkspace(workspace) : editor;
    if (!active) return;
    activateRemoteEditor(active);
    renderRemoteEditorDock(getActiveSession());
}

function toggleMaximizeRemoteEditor(editorOrWorkspace) {
    var workspace = editorOrWorkspace && editorOrWorkspace.tabs ? editorOrWorkspace : remoteEditorWorkspaceFor(editorOrWorkspace);
    if (!workspace || !workspace.el) return;
    if (!workspace.maximized) {
        workspace.restoreRect = { left: workspace.el.offsetLeft, top: workspace.el.offsetTop, width: workspace.el.offsetWidth, height: workspace.el.offsetHeight };
        workspace.maximized = true;
        workspace.el.classList.add('is-maximized');
        workspace.maxBtn.title = '还原窗口';
    } else {
        workspace.maximized = false;
        workspace.el.classList.remove('is-maximized');
        workspace.maxBtn.title = '最大化';
        var rect = workspace.restoreRect;
        if (rect) { workspace.el.style.left = rect.left + 'px'; workspace.el.style.top = rect.top + 'px'; workspace.el.style.width = rect.width + 'px'; workspace.el.style.height = rect.height + 'px'; }
    }
    var active = activeRemoteEditorForWorkspace(workspace);
    if (active) activateRemoteEditor(active, false);
    remoteEditorLayerWidth();
}

function destroyRemoteEditor(editor) {
    if (!editor) return;
    if (editor.controller) { try { editor.controller.abort(); } catch (e) { } }
    if (editor._clampFrame) { cancelAnimationFrame(editor._clampFrame); editor._clampFrame = 0; }
    if (editor._decorateFrame) { cancelAnimationFrame(editor._decorateFrame); editor._decorateFrame = 0; }
    if (editor._metricsTimer) { clearTimeout(editor._metricsTimer); editor._metricsTimer = null; }
    if (editor._loadRetryTimer) { clearTimeout(editor._loadRetryTimer); editor._loadRetryTimer = null; }
    if (editor.minimapResizeObserver) { editor.minimapResizeObserver.disconnect(); editor.minimapResizeObserver = null; }
    var session = remoteEditorSession(editor);
    if (session) removeRemoteEditorController(session, editor.controller);
    if (editor.mediaElement) {
        try { editor.mediaElement.pause(); } catch (e) { }
        try { editor.mediaElement.removeAttribute('src'); editor.mediaElement.load(); } catch (e) { }
    }
    if (editor.objectUrl) {
        try { URL.revokeObjectURL(editor.objectUrl); } catch (e) { }
        editor.objectUrl = '';
    }
    var workspace = remoteEditorWorkspaceFor(editor);
    if (editor.tab && editor.tab.parentNode) editor.tab.parentNode.removeChild(editor.tab);
    if (editor.el && editor.el.parentNode) editor.el.parentNode.removeChild(editor.el);
    var index = remoteEditors.indexOf(editor);
    if (index >= 0) remoteEditors.splice(index, 1);
    var remaining = remoteEditorsForWorkspace(workspace);
    if (!remaining.length) {
        destroyRemoteEditorWorkspace(workspace);
    } else {
        var next = remaining[Math.max(0, Math.min(index, remaining.length - 1))] || remaining[remaining.length - 1];
        activateRemoteEditor(next, false);
        updateRemoteEditorWorkspaceSummary(workspace);
    }
    renderRemoteEditorDock(getActiveSession());
}

function destroyRemoteEditorWorkspace(workspace) {
    if (!workspace) return;
    if (workspace.resizeObserver) { workspace.resizeObserver.disconnect(); workspace.resizeObserver = null; }
    if (workspace._clampFrame) { cancelAnimationFrame(workspace._clampFrame); workspace._clampFrame = 0; }
    if (workspace.el && workspace.el.parentNode) workspace.el.parentNode.removeChild(workspace.el);
    var session = getSessionById(workspace.sessionId);
    if (session && session._remoteEditorWorkspace === workspace) delete session._remoteEditorWorkspace;
}

function requestCloseRemoteEditorWorkspace(workspace) {
    var editors = remoteEditorsForWorkspace(workspace);
    if (!editors.length) { destroyRemoteEditorWorkspace(workspace); return; }
    var dirty = editors.filter(remoteEditorIsDirty);
    if (!dirty.length) {
        editors.slice().forEach(destroyRemoteEditor);
        return;
    }
    showRemoteEditorClosePrompt(dirty, function () {
        remoteEditorsForWorkspace(workspace).slice().forEach(destroyRemoteEditor);
    });
}

function requestCloseRemoteEditor(editor) {
    if (!editor) return;
    if (!remoteEditorIsDirty(editor)) { destroyRemoteEditor(editor); return; }
    showRemoteEditorClosePrompt([editor], null);
}

function showRemoteEditorClosePrompt(queue, onComplete) {
    if (!queue || !queue.length) { if (typeof onComplete === 'function') onComplete(); return; }
    remoteEditorCloseRequest = { queue: queue.slice(), onComplete: onComplete || null, editor: queue[0] };
    var name = document.getElementById('remoteEditorCloseName');
    if (name) name.textContent = queue[0].name + ' 有未保存的修改';
    var modal = document.getElementById('remoteEditorCloseModal');
    if (modal) modal.classList.add('show');
    var save = document.getElementById('remoteEditorSaveCloseBtn');
    if (save) save.disabled = false;
}

function continueRemoteEditorClose() {
    if (!remoteEditorCloseRequest) return;
    var request = remoteEditorCloseRequest;
    request.queue.shift();
    if (request.queue.length) {
        request.editor = request.queue[0];
        var name = document.getElementById('remoteEditorCloseName');
        if (name) name.textContent = request.editor.name + ' 有未保存的修改';
        return;
    }
    remoteEditorCloseRequest = null;
    var modal = document.getElementById('remoteEditorCloseModal');
    if (modal) modal.classList.remove('show');
    if (typeof request.onComplete === 'function') request.onComplete();
}

function cancelRemoteEditorClose() {
    remoteEditorCloseRequest = null;
    var modal = document.getElementById('remoteEditorCloseModal');
    if (modal) modal.classList.remove('show');
}

function confirmRemoteEditorDiscardAndClose() {
    if (!remoteEditorCloseRequest || !remoteEditorCloseRequest.editor) return;
    destroyRemoteEditor(remoteEditorCloseRequest.editor);
    continueRemoteEditorClose();
}

function confirmRemoteEditorSaveAndClose() {
    if (!remoteEditorCloseRequest || !remoteEditorCloseRequest.editor) return;
    var closeRequest = remoteEditorCloseRequest;
    var editor = remoteEditorCloseRequest.editor;
    var save = document.getElementById('remoteEditorSaveCloseBtn');
    if (save) save.disabled = true;
    saveRemoteEditor(editor, false).then(function (ok) {
        if (remoteEditorCloseRequest !== closeRequest || closeRequest.editor !== editor) return;
        if (ok && !remoteEditorIsDirty(editor)) { destroyRemoteEditor(editor); continueRemoteEditorClose(); }
        if (ok && remoteEditorIsDirty(editor)) {
            remoteEditorSetStatus(editor, '保存了旧内容，仍有新修改', 'warn');
        }
        if (save) save.disabled = false;
    });
}

function saveRemoteEditor(editor, closeAfter) {
    if (!editor || editor.saving || editor.deletePending) return Promise.resolve(false);
    var session = remoteEditorSession(editor);
    if (!session || !session._connected) { remoteEditorSetStatus(editor, 'SSH 已断开，无法保存', 'error'); return Promise.resolve(false); }
    if (!remoteEditorIsDirty(editor)) { if (closeAfter) destroyRemoteEditor(editor); return Promise.resolve(true); }
    if (editor.isNew) {
        var newName = sanitizeRemoteFileName(editor.nameInput ? editor.nameInput.value : editor.name);
        if (!newName) { remoteEditorSetStatus(editor, '请输入有效文件名，不能包含 / 或 \\', 'error'); if (editor.nameInput) editor.nameInput.focus(); return Promise.resolve(false); }
        var newPath = joinRemoteFilePath(editor.parentPath, newName);
        var duplicate = remoteEditors.some(function (item) { return item !== editor && item.sessionId === session.id && item.path === newPath; });
        if (duplicate) { remoteEditorSetStatus(editor, '同名文件已在编辑器中打开', 'error'); return Promise.resolve(false); }
        editor.name = newName;
        editor.path = newPath;
        editor.targetPath = '';
        editor.nameInput.value = newName;
        editor.subtitle.textContent = remoteEditorPathLabel(editor);
    }
    var creating = !!editor.isNew;
    var sentPath = editor.path;
    var sentName = editor.name;
    var sentContent = editor.textarea.value;
    var sentBytes = 0;
    try { sentBytes = new TextEncoder().encode(sentContent).length; } catch (e) { sentBytes = sentContent.length; }
    if (editor.maxBytes && sentBytes > editor.maxBytes) {
        remoteEditorSetStatus(editor, '内容超过在线编辑上限 ' + fmtB(editor.maxBytes), 'error');
        remoteEditorUpdateMetrics(editor);
        return Promise.resolve(false);
    }
    var sentVersion = editor.version;
    var sentTargetPath = creating ? '' : normalizeRemoteFilePath(editor.targetPath || sentPath);
    editor.saving = true;
    if (creating && editor.nameInput) editor.nameInput.readOnly = true;
    remoteEditorSetStatus(editor, '正在保存…', 'info');
    remoteEditorUpdateMetrics(editor);
    var controller = new AbortController();
    editor.controller = controller;
    (session._remoteEditorControllers || (session._remoteEditorControllers = [])).push(controller);
    return remoteEditorRequest('/file/edit/save', { sshInfo: session.sshInfo, path: sentPath, targetPath: sentTargetPath, content: sentContent, version: sentVersion, create: creating }, controller.signal)
        .then(function (data) {
            if (remoteEditors.indexOf(editor) < 0 || editor.controller !== controller) return false;
            editor.originalContent = sentContent;
            editor.version = String(data.version || editor.version);
            editor.targetPath = normalizeRemoteFilePath(data.targetPath || sentTargetPath || sentPath);
            editor.sizeBytes = Math.max(0, parseInt(data.size, 10) || sentBytes);
            if (creating) {
                editor.isNew = false;
                editor.path = sentPath;
                editor.name = sentName;
                editor.el.classList.remove('is-new');
                if (editor.nameInput) editor.nameInput.readOnly = true;
                if (typeof remoteEditorApplyLanguage === 'function') remoteEditorApplyLanguage(editor);
            }
            editor.subtitle.textContent = remoteEditorPathLabel(editor);
            if (editor.parentPath) {
                var editorDirectory = normalizeSftpDir(editor.parentPath);
                if (normalizeSftpDir(session.sftpPath || '/') === editorDirectory) sftpLoad(editorDirectory, session);
            }
            editor.saving = false;
            remoteEditorSetStatus(editor, editor.textarea.value === sentContent ? '保存成功' : '已保存，仍有新修改', editor.textarea.value === sentContent ? 'success' : 'warn');
            remoteEditorUpdateMetrics(editor);
            showToast(editor.name + ' 已保存', 'success');
            return true;
        })
        .catch(function (err) {
            if (remoteEditors.indexOf(editor) >= 0) {
                editor.saving = false;
                if (creating && editor.isNew && editor.nameInput) editor.nameInput.readOnly = false;
                remoteEditorSetStatus(editor, requestWasAborted(err) ? '保存已取消' : (err.msg || '保存失败'), 'error');
                remoteEditorUpdateMetrics(editor);
            }
            return false;
        })
        .finally(function () {
            removeRemoteEditorController(session, controller);
            if (editor.controller === controller) editor.controller = null;
        });
}

function requestCloseRemoteEditorsForSession(session, onComplete) {
    var dirty = remoteEditors.filter(function (editor) { return editor.sessionId === session.id && remoteEditorIsDirty(editor); });
    if (!dirty.length) return false;
    showRemoteEditorClosePrompt(dirty, onComplete);
    return true;
}

function closeRemoteEditorsForSession(session, force) {
    remoteEditors.slice().forEach(function (editor) {
        if (editor.sessionId === session.id && (force || !remoteEditorIsDirty(editor))) destroyRemoteEditor(editor);
    });
}

function handleRemoteEditorsSessionDisconnected(session) {
    if (session && session._remoteEditorWorkspace && session._remoteEditorWorkspace.el) {
        session._remoteEditorWorkspace.el.classList.add('is-disconnected');
    }
    remoteEditors.forEach(function (editor) {
        if (editor.sessionId !== session.id || !editor.el) return;
        if (!editor.saving) remoteEditorSetStatus(editor, remoteEditorIsDirty(editor) ? 'SSH 已断开，未保存内容已保留' : 'SSH 已断开', 'warn');
        remoteEditorUpdateMetrics(editor);
    });
}

function handleRemoteEditorsSessionConnected(session) {
    if (session && session._remoteEditorWorkspace && session._remoteEditorWorkspace.el) {
        session._remoteEditorWorkspace.el.classList.remove('is-disconnected');
    }
    remoteEditors.forEach(function (editor) {
        if (editor.sessionId !== session.id || !editor.el) return;
        remoteEditorUpdateMetrics(editor);
        if (!editor.saving) remoteEditorSetStatus(editor, remoteEditorIsDirty(editor) ? '有未保存修改' : '已连接', remoteEditorIsDirty(editor) ? 'warn' : 'success');
        if (!editor.loaded && !remoteEditorIsDirty(editor)) {
            scheduleRemoteEditorInitialLoad(editor, session);
        }
    });
}

function showSftpRemoteModal() {
    var session = getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    var modal = document.getElementById('sftpRemoteModal');
    if (!modal) return;
    sftpRemoteSessionId = session.id;
    document.getElementById('sftpRemoteUrl').value = '';
    document.getElementById('sftpRemoteName').value = '';
    document.getElementById('sftpRemotePath').value = normalizeSftpDir(session.sftpPath || '/');
    document.getElementById('sftpRemoteStatus').textContent = '';
    var btn = document.getElementById('sftpRemoteSubmit');
    if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
    modal.classList.add('show');
    setTimeout(function () { var el = document.getElementById('sftpRemoteUrl'); if (el) el.focus(); }, 80);
}

function hideSftpRemoteModal() {
    var session = getSessionById(sftpRemoteSessionId);
    if (session) abortSessionController(session, '_sftpRemoteController');
    sftpRemoteSessionId = '';
    var modal = document.getElementById('sftpRemoteModal');
    if (modal) modal.classList.remove('show');
}

function setSftpRemoteStatus(message, type) {
    var el = document.getElementById('sftpRemoteStatus');
    if (!el) return;
    el.className = 'sftp-remote-status ' + (type || '');
    el.textContent = message || '';
}

function submitSftpRemoteDownload() {
    var session = getSessionById(sftpRemoteSessionId);
    if (!session || !session._connected) { showToast('连接已关闭或尚未就绪', 'error'); return; }
    var url = document.getElementById('sftpRemoteUrl').value.trim();
    var filename = document.getElementById('sftpRemoteName').value.trim();
    var path = normalizeSftpDir(document.getElementById('sftpRemotePath').value);
    if (!url) { setSftpRemoteStatus('请先填写下载链接', 'error'); return; }
    var btn = document.getElementById('sftpRemoteSubmit');
    var requestGeneration = (session._sftpRemoteGeneration || 0) + 1;
    session._sftpRemoteGeneration = requestGeneration;
    if (btn) { btn.disabled = true; btn.textContent = '下载中...'; }
    setSftpRemoteStatus('正在远程下载到 ' + path + '，请稍等...', 'info');
    abortSessionController(session, '_sftpRemoteController');
    var controller = new AbortController();
    session._sftpRemoteController = controller;
    var fd = new FormData();
    fd.append('sshInfo', session.sshInfo);
    fd.append('url', url);
    fd.append('filename', filename);
    fd.append('path', path);
    fetch('/file/remote', { method: 'POST', body: fd, signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (session._sftpRemoteGeneration !== requestGeneration || session._sftpRemoteController !== controller) return;
            if (d.Msg === 'success') {
                var saved = d.Data && d.Data.path ? d.Data.path : path;
                setSftpRemoteStatus('下载完成：' + saved, 'success');
                showToast('远程下载完成', 'success');
                if (sessions.indexOf(session) !== -1) sftpLoad(path, session);
                setTimeout(function () { if (sftpRemoteSessionId === session.id) hideSftpRemoteModal(); }, 800);
            } else {
                setSftpRemoteStatus(d.Msg || '下载失败', 'error');
                showToast('远程下载失败', 'error');
            }
        })
        .catch(function (err) {
            if (requestWasAborted(err)) return;
            if (session._sftpRemoteGeneration !== requestGeneration) return;
            setSftpRemoteStatus('网络请求失败', 'error');
            showToast('远程下载失败', 'error');
        })
        .finally(function () {
            if (session._sftpRemoteController === controller) {
                session._sftpRemoteController = null;
                if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
            }
        });
}

function showSftpDirPicker() {
    var session = getSessionById(sftpRemoteSessionId) || getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    var modal = document.getElementById('sftpDirModal');
    if (!modal) return;
    sftpDirPickerSessionId = session.id;
    session.sftpDirPickerPath = normalizeSftpDir(document.getElementById('sftpRemotePath').value || session.sftpPath);
    modal.classList.add('show');
    sftpDirLoad(session.sftpDirPickerPath, session);
}

function hideSftpDirPicker() {
    var session = getSessionById(sftpDirPickerSessionId);
    if (session) abortSessionController(session, '_sftpDirController');
    sftpDirPickerSessionId = '';
    var modal = document.getElementById('sftpDirModal');
    if (modal) modal.classList.remove('show');
}

function sftpDirLoad(path, session) {
    session = session || getSessionById(sftpDirPickerSessionId);
    if (!session || sessions.indexOf(session) === -1) return;
    path = normalizeSftpDir(path);
    session.sftpDirPickerPath = path;
    session._sftpDirGeneration = (session._sftpDirGeneration || 0) + 1;
    var generation = session._sftpDirGeneration;
    abortSessionController(session, '_sftpDirController');
    var controller = new AbortController();
    session._sftpDirController = controller;
    var pathInput = document.getElementById('sftpDirPath');
    var listEl = document.getElementById('sftpDirList');
    if (pathInput) pathInput.value = path;
    if (!listEl) return;
    listEl.innerHTML = '<div class="sftp-loading">加载中...</div>';
    fetch('/file/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sshInfo: session.sshInfo, path: path }), signal: controller.signal })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (sessions.indexOf(session) === -1 || session._sftpDirGeneration !== generation || sftpDirPickerSessionId !== session.id) return;
            session._sftpDirController = null;
            if (d.Msg !== 'success') { listEl.innerHTML = '<div class="sftp-loading" style="color:var(--err)">' + esc(d.Msg) + '</div>'; return; }
            path = normalizeSftpDir(d.Data && d.Data.path ? d.Data.path : path);
            session.sftpDirPickerPath = path;
            if (pathInput) pathInput.value = path;
            var list = ((d.Data && d.Data.list) || []).filter(function (f) { return f.IsDir; });
            var rows = [];
            if (path !== '/') rows.push('<button type="button" class="sftp-dir-row up" onclick="sftpDirUp()">.. 上级目录</button>');
            rows = rows.concat(list.map(function (f) {
                var fp = (path === '/' ? '/' : path + '/') + f.Name;
                return '<button type="button" class="sftp-dir-row" onclick="sftpDirLoad(' + escAttr(JSON.stringify(fp)) + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span>' + esc(f.Name) + '</span></button>';
            }));
            listEl.innerHTML = rows.join('') || '<div class="sftp-loading">没有子目录</div>';
        })
        .catch(function (err) {
            if (requestWasAborted(err) || session._sftpDirGeneration !== generation || sftpDirPickerSessionId !== session.id) return;
            session._sftpDirController = null;
            listEl.innerHTML = '<div class="sftp-loading" style="color:var(--err)">加载失败</div>';
        });
}

function sftpDirGo() {
    var session = getSessionById(sftpDirPickerSessionId);
    if (session) sftpDirLoad(document.getElementById('sftpDirPath').value, session);
}

function sftpDirUp() {
    var session = getSessionById(sftpDirPickerSessionId);
    if (!session) return;
    var p = normalizeSftpDir(session.sftpDirPickerPath).replace(/\/$/, '');
    var i = p.lastIndexOf('/');
    sftpDirLoad(i <= 0 ? '/' : p.substring(0, i), session);
}

function confirmSftpDirPicker() {
    var session = getSessionById(sftpDirPickerSessionId);
    if (!session || sftpRemoteSessionId !== session.id) { hideSftpDirPicker(); return; }
    document.getElementById('sftpRemotePath').value = normalizeSftpDir(session.sftpDirPickerPath);
    hideSftpDirPicker();
}

function newSftpUploadId(prefix) {
    var value = '';
    try {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') value = window.crypto.randomUUID();
    } catch (e) { }
    if (!value) value = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
    return (prefix || 'upload') + '_' + value;
}

function findSftpUpload(id) {
    for (var i = 0; i < sessions.length; i++) {
        var list = sessions[i]._sftpUploads || [];
        for (var j = 0; j < list.length; j++) if (list[j].id === id) return list[j];
    }
    return null;
}

function sftpActiveUploadCount() {
    var count = 0;
    sessions.forEach(function (session) {
        (session._sftpUploads || []).forEach(function (upload) {
            if (upload.xhr) count++;
        });
    });
    return count;
}

function pumpSftpUploadQueue() {
    var queued = [];
    sessions.forEach(function (session) {
        (session._sftpUploads || []).forEach(function (upload) {
            if (upload.status === 'queued' && !upload.xhr) queued.push(upload);
        });
    });
    queued.sort(function (left, right) {
        return (left.queueOrder || 0) - (right.queueOrder || 0);
    });
    for (var i = 0; i < queued.length && sftpActiveUploadCount() < SFTP_UPLOAD_CONCURRENCY; i++) {
        runSftpUpload(queued[i]);
    }
}

function scheduleSftpUploadRefresh(session, path) {
    if (!session || sessions.indexOf(session) < 0) return;
    path = normalizeSftpDir(path || '/');
    if (normalizeSftpDir(session.sftpPath || '/') !== path) return;
    if (session._sftpUploadRefreshTimer) clearTimeout(session._sftpUploadRefreshTimer);
    session._sftpUploadRefreshTimer = setTimeout(function () {
        session._sftpUploadRefreshTimer = null;
        if (sessions.indexOf(session) < 0 || normalizeSftpDir(session.sftpPath || '/') !== path) return;
        sftpLoad(path, session);
    }, 140);
}

function runSftpUpload(upload) {
    if (!upload || upload.xhr || upload.status !== 'queued') return;
    var session = getSessionById(upload.sessionId);
    if (!session || !session._connected) {
        upload.status = 'error';
        upload.error = 'SSH 连接已断开';
        upload.finishedAt = Date.now();
        if (session) renderSftpTransfers(session);
        return;
    }
    upload.status = 'running';
    upload.error = '';
    upload.abortReason = '';
    upload.sent = 0;
    upload.startedAt = Date.now();
    upload.finishedAt = 0;
    var xhr = new XMLHttpRequest();
    upload.xhr = xhr;
    (session._sftpUploadControllers || (session._sftpUploadControllers = [])).push(xhr);
    var fd = new FormData();
    fd.append('sshInfo', session.sshInfo);
    fd.append('path', upload.path);
    fd.append('id', newSftpUploadId('request'));
    fd.append('file', upload.file);
    xhr.open('POST', '/file/upload', true);
    xhr.withCredentials = true;
    xhr.upload.onprogress = function (event) {
        if (upload.xhr !== xhr || upload.status !== 'running') return;
        if (event.lengthComputable && event.total > 0 && upload.total > 0) {
            upload.sent = Math.min(upload.total, Math.round(upload.total * event.loaded / event.total));
        } else {
            upload.sent = Math.min(upload.total || event.loaded, event.loaded);
        }
        renderSftpTransfers(session);
    };
    xhr.upload.onload = function () {
        if (upload.xhr !== xhr || upload.status !== 'running') return;
        upload.sent = upload.total;
        upload.status = 'processing';
        renderSftpTransfers(session);
    };
    xhr.onload = function () {
        if (upload.xhr !== xhr || (upload.status !== 'running' && upload.status !== 'processing')) return;
        var data = {};
        try { data = xhr.responseText ? JSON.parse(xhr.responseText) : {}; } catch (e) { data = {}; }
        if (xhr.status >= 200 && xhr.status < 300 && data.Msg === 'success') {
            upload.sent = upload.total;
            upload.status = 'completed';
            upload.finishedAt = Date.now();
            showToast('上传成功: ' + upload.name, 'success');
            scheduleSftpUploadRefresh(session, upload.path);
        } else {
            upload.status = 'error';
            upload.error = data.Msg || (xhr.status >= 200 && xhr.status < 300 ? '服务器返回了无效响应' : ('上传失败（HTTP ' + xhr.status + '）'));
            upload.finishedAt = Date.now();
            showToast('上传失败: ' + upload.error, 'error');
        }
        renderSftpTransfers(session);
    };
    xhr.onerror = function () {
        if (upload.xhr !== xhr || (upload.status !== 'running' && upload.status !== 'processing')) return;
        upload.status = 'error';
        upload.error = '网络请求失败';
        upload.finishedAt = Date.now();
        showToast('上传失败: ' + upload.name, 'error');
        renderSftpTransfers(session);
    };
    xhr.onabort = function () {
        if (upload.xhr !== xhr) return;
        if (upload.abortReason) {
            upload.status = 'error';
            upload.error = upload.abortReason;
        } else {
            upload.status = 'cancelled';
        }
        upload.abortReason = '';
        upload.finishedAt = Date.now();
        renderSftpTransfers(session);
    };
    xhr.onloadend = function () {
        var index = (session._sftpUploadControllers || []).indexOf(xhr);
        if (index >= 0) session._sftpUploadControllers.splice(index, 1);
        if (upload.xhr === xhr) upload.xhr = null;
        renderSftpTransfers(session);
        pumpSftpUploadQueue();
    };
    renderSftpTransfers(session);
    try {
        xhr.send(fd);
    } catch (err) {
        var index = (session._sftpUploadControllers || []).indexOf(xhr);
        if (index >= 0) session._sftpUploadControllers.splice(index, 1);
        if (upload.xhr === xhr) upload.xhr = null;
        upload.status = 'error';
        upload.error = (err && err.message) || '无法启动上传请求';
        upload.finishedAt = Date.now();
        renderSftpTransfers(session);
        pumpSftpUploadQueue();
    }
}

function cancelSftpUploadById(id) {
    var upload = findSftpUpload(id);
    if (!upload || ['completed', 'cancelled', 'error'].indexOf(upload.status) >= 0) return;
    upload.status = 'cancelled';
    upload.abortReason = '';
    upload.finishedAt = Date.now();
    if (upload.xhr) {
        try { upload.xhr.abort(); } catch (e) { }
    }
    renderSftpTransfers(getSessionById(upload.sessionId));
    pumpSftpUploadQueue();
}

function retrySftpUpload(id) {
    var upload = findSftpUpload(id);
    if (!upload || upload.status !== 'error' || upload.xhr) return;
    upload.status = 'queued';
    upload.error = '';
    upload.sent = 0;
    upload.startedAt = 0;
    upload.finishedAt = 0;
    upload.abortReason = '';
    upload.queueOrder = ++sftpUploadSequence;
    renderSftpTransfers(getSessionById(upload.sessionId));
    pumpSftpUploadQueue();
}

function dismissSftpUpload(id) {
    var upload = findSftpUpload(id);
    if (!upload || ['queued', 'running', 'processing'].indexOf(upload.status) >= 0) return;
    var session = getSessionById(upload.sessionId);
    if (!session) return;
    session._sftpUploads = (session._sftpUploads || []).filter(function (item) { return item !== upload; });
    renderSftpTransfers(session);
}

function sftpUpload() {
    var input = document.getElementById('sftpUploadInput');
    var session = getActiveSession();
    if (!input.files.length || !session) return;
    if (!session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    var uploadPath = normalizeSftpDir(session.sftpPath);
    var uploads = Array.from(input.files).map(function (file) {
        return {
            id: newSftpUploadId('upload'),
            sessionId: session.id,
            path: uploadPath,
            name: file.name,
            file: file,
            total: Math.max(0, file.size || 0),
            sent: 0,
            status: 'queued',
            queueOrder: ++sftpUploadSequence,
            startedAt: 0,
            finishedAt: 0,
            xhr: null,
            error: '',
            abortReason: ''
        };
    });
    session._sftpUploads = uploads.concat(session._sftpUploads || []);
    input.value = '';
    renderSftpTransfers(session);
    pumpSftpUploadQueue();
}

document.getElementById('sftpPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') sftpGo(); });
document.getElementById('sftpDirPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') sftpDirGo(); });
addEventListener('pagehide', function () {
    var dirty = remoteEditors.filter(remoteEditorIsDirty);
    if (dirty.length) {
        // Browsers do not allow a custom asynchronous dialog during pagehide;
        // keep the editor model alive for session restoration and only abort
        // network work here.  The explicit window/tab close path still shows
        // the three-way save/discard dialog.
        dirty.forEach(function (editor) { if (editor.controller) { try { editor.controller.abort(); } catch (e) { } } });
    }
    sessions.forEach(function (session) { cancelSessionSftpRequests(session, true); });
});
addEventListener('beforeunload', function (event) {
    if (!remoteEditors.some(remoteEditorIsDirty)) return;
    event.preventDefault();
    event.returnValue = '';
});

// ==================== Copy / Paste / Context Menu ====================
function termCopy() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var sel = sessions[activeIdx].term.getSelection();
    if (!sel) { showToast('没有选中内容', 'info'); return; }
    navigator.clipboard.writeText(sel).then(function () {
        showCopyToast();
    }).catch(function () {
        fallbackCopy(sel);
    });
    hideCtxMenu();
}

function termPaste() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    navigator.clipboard.readText().then(function (text) {
        var s = activeIdx >= 0 ? sessions[activeIdx] : null;
        if (!text || !s || !s.ws || s.ws.readyState !== 1) return;
        // 交给 xterm 处理：它会按远端的 bracketed paste 状态正确包裹多行内容，
        // 最终仍走 onData → sendTerminalInput，不会被误当成控制指令。
        s.term.paste(text);
        s.term.focus();
    }).catch(function () {
        showToast('无法读取剪贴板，请使用 Ctrl+Shift+V', 'info');
    });
    hideCtxMenu();
}

function termSelectAll() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    sessions[activeIdx].term.selectAll();
    hideCtxMenu();
}

function termClear() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    sessions[activeIdx].term.clear();
    hideCtxMenu();
}

function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); showCopyToast(); } catch (e) { }
    document.body.removeChild(ta);
}

function showCopyToast() {
    var d = document.createElement('div');
    d.className = 'copy-toast';
    d.textContent = '已复制到剪贴板';
    document.body.appendChild(d);
    setTimeout(function () { d.remove(); }, 1400);
}

// Auto-copy on selection
function setupAutoCopy(session) {
    if (session._selectionDisposable && typeof session._selectionDisposable.dispose === 'function') {
        try { session._selectionDisposable.dispose(); } catch (e) { }
    }
    session._selectionDisposable = session.term.onSelectionChange(function () {
        var sel = session.term.getSelection();
        if (sel && sel.length > 0) {
            navigator.clipboard.writeText(sel).then(function () {
                showCopyToast();
            }).catch(function () {
                fallbackCopy(sel);
            });
        }
    });
}

// Right-click context menu
document.getElementById('terminalContainer').addEventListener('contextmenu', function (e) {
    e.preventDefault();
    var menu = document.getElementById('ctxMenu');
    menu.style.left = Math.min(e.clientX, window.innerWidth - 160) + 'px';
    menu.style.top = Math.min(e.clientY, window.innerHeight - 160) + 'px';
    menu.classList.add('show');
});

document.addEventListener('click', function () { hideCtxMenu(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hideCtxMenu(); });

function hideCtxMenu() {
    document.getElementById('ctxMenu').classList.remove('show');
}

// Ctrl+Shift+C / Ctrl+Shift+V shortcuts
document.addEventListener('keydown', function (e) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    if (e.ctrlKey && e.shiftKey && e.key === 'C') { e.preventDefault(); termCopy(); }
    if (e.ctrlKey && e.shiftKey && e.key === 'V') { e.preventDefault(); termPaste(); }
});

// ==================== Command Input Bar ====================
function sendCmdInput() {
    var input = document.getElementById('cmdInput');
    var text = input.value;
    if (!text) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) {
        showToast('无活动连接', 'error');
        return;
    }
    if (!sendCommandToSession(sessions[activeIdx], text)) {
        showToast('无活动连接', 'error');
        return;
    }
    input.value = '';
    input.style.height = 'auto';
    sessions[activeIdx].term.focus();
}

(function () {
    var input = document.getElementById('cmdInput');
    if (!input) return;
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendCmdInput();
        }
    });
    input.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 150) + 'px';
    });
})();

// ==================== Copy IP ====================
function copyIP(ip) {
    navigator.clipboard.writeText(ip).then(function () {
        showCopyToast();
    }).catch(function () {
        fallbackCopy(ip);
    });
}

// ==================== Font Size ====================
var FONT_KEY = 'webssh_fontsize';
var COLOR_KEY = 'webssh_colors';

function normColor(c) {
    return String(c || '').trim().toLowerCase();
}

function colorIn(c, list) {
    c = normColor(c);
    return list.indexOf(c) >= 0;
}

function isLightThemeActive() {
    var theme = document.documentElement.getAttribute('data-theme');
    if (theme) return theme === 'light';
    try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches; } catch (e) { return false; }
}

function defaultSavedTermColors() {
    return isLightThemeActive()
        ? { fg: '#1a1a2e', bg: '#e8eaf0', cursor: '#0088cc' }
        : { fg: '#e8e8f0', bg: '#0a0a1a', cursor: '#00d4ff' };
}

function isDefaultTermFg(c) {
    return !c || colorIn(c, ['#e8e8f0', '#ffffff', '#fff', '#1a1a2e', '#0f172a']);
}

function isDefaultTermBg(c) {
    return !c || colorIn(c, ['#0a0a1a', '#000000', '#000', '#1a1a2e', '#0d1117', '#1e1e2e', '#282a36', '#002b36', '#2e3440', '#1a1b26', '#161616', '#0c0c1d', '#121212', '#0f172a', '#18181b', '#27272a', '#1c1917', '#e8eaf0', '#f8fafc', '#ffffff', '#fff']);
}

function isDefaultTermCursor(c) {
    return !c || colorIn(c, ['#00d4ff', '#0088cc']);
}

function buildTerminalTheme(savedColors) {
    savedColors = savedColors || {};
    var isLight = isLightThemeActive();
    var defaults = defaultSavedTermColors();
    var fg = isDefaultTermFg(savedColors.fg) ? defaults.fg : savedColors.fg;
    var bg = isDefaultTermBg(savedColors.bg) ? (isLight ? 'rgba(255,255,255,0)' : 'rgba(10,10,26,0)') : savedColors.bg;
    var cursor = isDefaultTermCursor(savedColors.cursor) ? defaults.cursor : savedColors.cursor;
    if (isLight) {
        return {
            background: bg,
            foreground: fg,
            cursor: cursor,
            cursorAccent: '#f8fafc',
            selectionBackground: 'rgba(0,136,204,.25)',
            black: '#0f172a',
            red: '#d7265a',
            green: '#008844',
            yellow: '#996600',
            blue: '#0066cc',
            magenta: '#6320c0',
            cyan: '#0088aa',
            white: '#334155',
            brightBlack: '#64748b',
            brightRed: '#e11d48',
            brightGreen: '#00aa55',
            brightYellow: '#aa7700',
            brightBlue: '#0088ff',
            brightMagenta: '#7c3aed',
            brightCyan: '#00aacc',
            brightWhite: '#000000'
        };
    }
    return {
        background: bg,
        foreground: fg,
        cursor: cursor,
        cursorAccent: '#0a0a1a',
        selectionBackground: 'rgba(0,212,255,.25)',
        black: '#1a1a2e',
        red: '#ff006e',
        green: '#00ff88',
        yellow: '#ffbe0b',
        blue: '#00d4ff',
        magenta: '#7b2ff7',
        cyan: '#00d4ff',
        white: '#e8e8f0',
        brightBlack: '#3a3a5e',
        brightRed: '#ff4488',
        brightGreen: '#33ffaa',
        brightYellow: '#ffdd33',
        brightBlue: '#33ddff',
        brightMagenta: '#9955ff',
        brightCyan: '#33ddff',
        brightWhite: '#ffffff'
    };
}

function refreshTerminalThemesForCurrentTheme() {
    var colors = getSavedColors();
    sessions.forEach(function (s) {
        if (s && s.term) s.term.options.theme = buildTerminalTheme(colors);
    });
    var body = document.querySelector('.term-body');
    if (body && isDefaultTermBg(colors.bg)) body.style.background = '';
    var fgInput = document.getElementById('fgCustomColor');
    var bgInput = document.getElementById('bgCustomColor');
    var cursorInput = document.getElementById('cursorCustomColor');
    var defaults = defaultSavedTermColors();
    if (fgInput && isDefaultTermFg(colors.fg)) fgInput.value = defaults.fg;
    if (bgInput && isDefaultTermBg(colors.bg)) bgInput.value = defaults.bg;
    if (cursorInput && isDefaultTermCursor(colors.cursor)) cursorInput.value = defaults.cursor;
    var panel = document.getElementById('colorPanel');
    if (panel && panel.classList.contains('show')) renderSwatches();
}

function getCurrentFontSize() {
    var saved = parseInt(safeStorageGet(FONT_KEY));
    return saved || (window.innerWidth <= 520 ? 13 : 15);
}

function changeFontSize(delta) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var s = sessions[activeIdx];
    var cur = s.term.options.fontSize || 15;
    var nv = Math.max(8, Math.min(30, cur + delta));
    s.term.options.fontSize = nv;
    safeStorageSet(FONT_KEY, nv);
    document.getElementById('fontSizeLabel').textContent = nv;
    syncTermSize(s, true);
}

function updateFontSizeLabel() {
    if (activeIdx >= 0 && sessions[activeIdx]) {
        document.getElementById('fontSizeLabel').textContent = sessions[activeIdx].term.options.fontSize || 15;
    }
}

// ==================== Color Picker ====================
var FG_COLORS = ['#1a1a2e','#0f172a','#e8e8f0','#ffffff','#00ff88','#00d4ff','#ffbe0b','#ff006e','#7b2ff7','#ff4488','#33ffaa','#33ddff','#ffdd33','#9955ff','#f97316','#a3e635','#e879f9','#94a3b8'];
var BG_COLORS = ['#e8eaf0','#f8fafc','#ffffff','#0a0a1a','#000000','#1a1a2e','#0d1117','#1e1e2e','#282a36','#002b36','#2e3440','#1a1b26','#161616','#0c0c1d','#121212','#0f172a','#18181b','#27272a','#1c1917'];
var CURSOR_COLORS = ['#0088cc','#00d4ff','#ffffff','#00ff88','#ffbe0b','#ff006e','#7b2ff7','#ff4488','#f97316','#e879f9','#a3e635'];

function toggleColorPicker() {
    var p = document.getElementById('colorPanel');
    if (p.classList.contains('show')) {
        p.classList.remove('show');
    } else {
        renderSwatches();
        p.classList.add('show');
    }
}

function renderSwatches() {
    var colors = getSavedColors();
    renderSwatchGroup('fgSwatches', FG_COLORS, colors.fg, applyFgColor);
    renderSwatchGroup('bgSwatches', BG_COLORS, colors.bg, applyBgColor);
    renderSwatchGroup('cursorSwatches', CURSOR_COLORS, colors.cursor, applyCursorColor);
}

function renderSwatchGroup(containerId, palette, active, onClick) {
    var el = document.getElementById(containerId);
    el.innerHTML = palette.map(function (c) {
        var cls = c.toLowerCase() === active.toLowerCase() ? ' active' : '';
        return '<div class="color-swatch' + cls + '" style="background:' + c + '" data-fn="' + onClick.name + '" data-color="' + c + '" title="' + c + '"></div>';
    }).join('');
    el.querySelectorAll('.color-swatch').forEach(function (s) {
        s.addEventListener('click', function (e) {
            e.stopPropagation();
            window[this.dataset.fn](this.dataset.color);
        });
    });
}

function getSavedColors() {
    var defaults = defaultSavedTermColors();
    try {
        var c = JSON.parse(safeStorageGet(COLOR_KEY));
        if (c) {
            return {
                fg: isDefaultTermFg(c.fg) ? defaults.fg : c.fg,
                bg: isDefaultTermBg(c.bg) ? defaults.bg : c.bg,
                cursor: isDefaultTermCursor(c.cursor) ? defaults.cursor : c.cursor
            };
        }
    } catch (e) { }
    return defaults;
}

function saveColors(fg, bg, cursor) {
    safeStorageSet(COLOR_KEY, JSON.stringify({ fg: fg, bg: bg, cursor: cursor }));
}

function applyFgColor(color) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    sessions[activeIdx].term.options.theme = Object.assign({}, sessions[activeIdx].term.options.theme, { foreground: color });
    var c = getSavedColors(); c.fg = color; saveColors(c.fg, c.bg, c.cursor);
    document.getElementById('fgCustomColor').value = color;
    renderSwatches();
}

function applyBgColor(color) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    sessions[activeIdx].term.options.theme = Object.assign({}, sessions[activeIdx].term.options.theme, { background: color });
    document.querySelector('.term-body').style.background = color;
    var c = getSavedColors(); c.bg = color; saveColors(c.fg, c.bg, c.cursor);
    document.getElementById('bgCustomColor').value = color;
    renderSwatches();
}

function applyCursorColor(color) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    sessions[activeIdx].term.options.theme = Object.assign({}, sessions[activeIdx].term.options.theme, { cursor: color });
    var c = getSavedColors(); c.cursor = color; saveColors(c.fg, c.bg, c.cursor);
    document.getElementById('cursorCustomColor').value = color;
    renderSwatches();
}

function resetTermColors() {
    safeStorageRemove(COLOR_KEY);
    var defaults = defaultSavedTermColors();
    if (activeIdx >= 0 && sessions[activeIdx]) {
        sessions[activeIdx].term.options.theme = buildTerminalTheme(defaults);
        document.querySelector('.term-body').style.background = '';
    }
    document.getElementById('fgCustomColor').value = defaults.fg;
    document.getElementById('bgCustomColor').value = defaults.bg;
    document.getElementById('cursorCustomColor').value = defaults.cursor;
    renderSwatches();
    showToast('已重置默认颜色', 'info');
}

// Close color picker on outside click
document.addEventListener('click', function (e) {
    var panel = document.getElementById('colorPanel');
    var btn = document.getElementById('colorPickerBtn');
    if (panel && panel.classList.contains('show') && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.classList.remove('show');
    }
});

// ==================== Theme ====================
var THEME_KEY = 'webssh_theme';
var themes = ['dark', 'light', 'auto'];
var themeIcons = {
    dark: '<path d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>',
    light: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
    auto: '<circle cx="12" cy="12" r="4" fill="none"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/><path d="M12 6a6 6 0 010 12V6z" fill="currentColor" opacity=".3"/>'
};
var themeLabels = { dark: '暗色模式', light: '亮色模式', auto: '跟随系统' };

function applyTheme(theme) {
    if (theme === 'auto') {
        document.documentElement.removeAttribute('data-theme');
    } else {
        document.documentElement.setAttribute('data-theme', theme);
    }
    document.dispatchEvent(new Event('webssh:background-sync'));
    var icon = document.getElementById('themeIcon');
    if (icon) icon.innerHTML = themeIcons[theme] || themeIcons.auto;
    refreshTerminalThemesForCurrentTheme();
}

function cycleTheme() {
    var cur = safeStorageGet(THEME_KEY) || 'auto';
    var idx = themes.indexOf(cur);
    var next = themes[(idx + 1) % themes.length];
    safeStorageSet(THEME_KEY, next);
    applyTheme(next);
    showToast(themeLabels[next], 'info');
}

function initTheme() {
    var saved = safeStorageGet(THEME_KEY) || 'dark';
    applyTheme(saved);
}

// ==================== Click outside to close drawers ====================
document.addEventListener('click', function (e) {
    var eventPath = typeof e.composedPath === 'function' ? e.composedPath() : [];
    var startedInsideModal = eventPath.some(function (node) {
        return node && node.classList && node.classList.contains('modal-overlay');
    });
    if (startedInsideModal || e.target.closest('.modal-overlay') || e.target.closest('[data-keep-script-drawer]')) return;

    // Close connection bookmark drawer
    var connDrawer = document.getElementById('connDrawer');
    var edgeBtns = document.getElementById('edgeBtns');
    if (connDrawer && connDrawer.classList.contains('open')) {
        if (!connDrawer.contains(e.target) && !edgeBtns.contains(e.target)) {
            connDrawer.classList.remove('open');
        }
    }
    // Close script bookmark drawer
    var scriptDrawer = document.getElementById('scriptDrawer');
    var termEdge = document.getElementById('termEdgeBtns');
    var startedInsideScriptDrawer = scriptDrawer && (scriptDrawer.contains(e.target) || eventPath.indexOf(scriptDrawer) !== -1);
    if (scriptDrawer && scriptDrawer.classList.contains('open')) {
        if (!startedInsideScriptDrawer && !(termEdge && termEdge.contains(e.target)) && !e.target.closest('.tb-btn')) {
            scriptDrawer.classList.remove('open');
            remoteEditorLayerWidth();
            setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) syncTermSize(sessions[activeIdx]); }, 350);
        }
    }
    // Close SFTP panel
    var sftpPanel = document.getElementById('sftpPanel');
    if (sftpPanel && sftpPanel.classList.contains('open')) {
        if (!sftpPanel.contains(e.target) && !(termEdge && termEdge.contains(e.target)) && e.target.closest('.term-body')) {
            sftpPanel.classList.remove('open');
            remoteEditorLayerWidth();
            setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) syncTermSize(sessions[activeIdx]); }, 350);
        }
    }
});

// ==================== System Info Interval ====================
var SYS_INTERVAL_KEY = 'webssh_sys_interval';
var _sysIntervalTemp = 60;

function getSysInterval() {
    var v = parseInt(safeStorageGet(SYS_INTERVAL_KEY));
    return (v && v >= 5 && v <= 600) ? v : 60;
}

function getServerInfoRefreshSeconds() {
    return SERVER_INFO_NET_REFRESH_MS / 1000;
}

function changeSysInterval(delta) {
    _sysIntervalTemp = Math.max(5, Math.min(600, _sysIntervalTemp + delta));
    document.getElementById('sysIntervalLabel').textContent = _sysIntervalTemp + 's';
    var btn = document.getElementById('sysIntervalSaveBtn');
    btn.classList.remove('saved');
    btn.textContent = '保存';
}

function saveSysInterval() {
    var btn = document.getElementById('sysIntervalSaveBtn');
    if (btn.classList.contains('saved')) {
        btn.classList.remove('saved');
        btn.textContent = '保存';
        return;
    }
    safeStorageSet(SYS_INTERVAL_KEY, _sysIntervalTemp);
    btn.classList.add('saved');
    btn.textContent = '已保存';

    // Update login page hint text
    updateSysInfoHint();

    // Only the visible terminal needs the optional status polling. Background
    // tabs keep their SSH sessions alive without opening extra SSH probes.
    if (activeIdx >= 0 && sessions[activeIdx]) startTopbarMetricsPolling(sessions[activeIdx]);
    restartServerInfoTimer();
    if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] && sessions[serverInfoModalIdx]._lastMetrics) {
        renderServerInfo(sessions[serverInfoModalIdx]._lastMetrics, sessions[serverInfoModalIdx]);
    }
    showToast('检测间隔已设为 ' + _sysIntervalTemp + ' 秒', 'success');
}

function saveTopbarMetricsPreference() {
    var cb = document.getElementById('enableSysInfo');
    var enabled = !!(cb && cb.checked);
    try { safeStorageSet(TOPBAR_METRICS_KEY, enabled ? 'true' : 'false'); } catch (e) { }
    updateSysInfoHint();
    if (!enabled) {
        sessions.forEach(function (s) {
            stopTopbarMetricsPolling(s);
        });
        setTopbarMetricsVisible(false);
        return;
    }
    if (activeIdx >= 0 && sessions[activeIdx]) startTopbarMetricsPolling(sessions[activeIdx]);
}

function updateSysInfoHint() {
    var el = document.querySelector('label[for="enableSysInfo"] span:last-child');
    if (!el) return;
    var sec = getSysInterval();
    var cb = document.getElementById('enableSysInfo');
    if (!cb || !cb.checked) {
        el.textContent = '显示顶部服务器状态（默认隐藏，不占用检测资源）';
        return;
    }
    if (sec >= 60 && sec % 60 === 0) {
        el.textContent = '显示顶部服务器状态（每' + (sec / 60) + '分钟刷新一次）';
    } else {
        el.textContent = '显示顶部服务器状态（每' + sec + '秒刷新一次）';
    }
}

function initTopbarMetricsPreference() {
    var cb = document.getElementById('enableSysInfo');
    if (!cb) return;
    cb.checked = isTopbarMetricsEnabled();
    setTopbarMetricsVisible(false);
    updateSysInfoHint();
}

function initSysInterval() {
    _sysIntervalTemp = getSysInterval();
    document.getElementById('sysIntervalLabel').textContent = _sysIntervalTemp + 's';
    updateSysInfoHint();
}

// ==================== Settings Panel ====================
var SETTINGS_KEY = 'webssh_settings';
var BG_PRESETS = ['#0a0a1a','#0d1117','#1a1a2e','#000000','#1e1e2e','#282a36','#002b36','#2e3440','#e8eaf0','#f0f0f5','#ffffff','#fdf6e3'];

function loadSettings() {
    try { return JSON.parse(safeStorageGet(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings(s) { safeStorageSet(SETTINGS_KEY, JSON.stringify(s)); }

function toggleSettings() {
    var p = document.getElementById('settingsPanel');
    var o = document.getElementById('settingsOverlay');
    var show = !p.classList.contains('show');
    p.classList.toggle('show');
    o.classList.toggle('show');
    if (show) renderBgSwatches();
}

function changeZoom(delta) {
    var s = loadSettings();
    var cur = s.zoom || 100;
    var nv = Math.max(50, Math.min(200, cur + delta));
    s.zoom = nv;
    saveSettings(s);
    document.getElementById('zoomLabel').textContent = nv + '%';
    document.body.style.zoom = (nv / 100);
}

function changeCardScale(delta) {
    var s = loadSettings();
    var cur = s.cardScale || 100;
    var nv = Math.max(50, Math.min(150, cur + delta));
    s.cardScale = nv;
    saveSettings(s);
    document.getElementById('cardScaleLabel').textContent = nv + '%';
    applyCardScale(nv);
}

function applyCardScale(val) {
    var el = document.querySelector('.login-container');
    if (el) {
        el.style.transform = val === 100 ? '' : 'scale(' + (val / 100) + ')';
        el.style.transformOrigin = 'center center';
    }
}

function changeEdgeScale(delta) {
    var s = loadSettings();
    var cur = s.edgeScale || 100;
    var nv = Math.max(50, Math.min(150, cur + delta));
    s.edgeScale = nv;
    saveSettings(s);
    document.getElementById('edgeScaleLabel').textContent = nv + '%';
    applyEdgeScale(nv);
}

function applyEdgeScale(val) {
    var ratio = val / 100;
    document.querySelectorAll('.edge-btns, .term-edge-btns').forEach(function (el) {
        el.style.transform = 'translateY(-50%) scale(' + ratio + ')';
    });
}

function applyBgImage() {
    var btn = document.getElementById('bgImageSaveBtn');
    if (btn.classList.contains('saved')) { btn.classList.remove('saved'); btn.textContent = '保存'; return; }
    var url = document.getElementById('bgImageUrl').value.trim();
    var s = loadSettings();
    s.bgImage = url;
    saveSettings(s);
    setBgImage(url);
    btn.classList.add('saved'); btn.textContent = '已保存';
    showToast(url ? '背景已设置' : '背景已清除', 'success');
}

function setBgImage(url) {
    var el = document.getElementById('customBg');
    if (url) {
        el.style.backgroundImage = 'url("' + url + '")';
        el.style.display = 'block';
    } else {
        el.style.backgroundImage = '';
        el.style.display = 'none';
    }
}

function renderBgSwatches() {
    var s = loadSettings();
    var el = document.getElementById('bgColorSwatches');
    el.innerHTML = BG_PRESETS.map(function (c) {
        var cls = (s.bgColor && s.bgColor === c) ? ' active' : '';
        return '<div class="set-color-swatch' + cls + '" style="background:' + c + '" data-color="' + c + '"></div>';
    }).join('');
    el.querySelectorAll('.set-color-swatch').forEach(function (sw) {
        sw.addEventListener('click', function () { applyBgColorPreset(this.dataset.color); });
    });
    document.getElementById('zoomLabel').textContent = (s.zoom || 100) + '%';
    document.getElementById('cardScaleLabel').textContent = (s.cardScale || 100) + '%';
    document.getElementById('edgeScaleLabel').textContent = (s.edgeScale || 100) + '%';
    document.getElementById('bgImageUrl').value = s.bgImage || '';
    document.getElementById('blurRange').value = s.blur != null ? s.blur : 20;
    document.getElementById('blurLabel').textContent = (s.blur != null ? s.blur : 20) + 'px';
    document.getElementById('toggleParticles').checked = s.particles !== false;
}

function applyBgColorPreset(color) {
    var s = loadSettings();
    s.bgColor = color;
    saveSettings(s);
    document.documentElement.style.setProperty('--bg', color);
    renderBgSwatches();
    showToast('背景颜色已更新', 'success');
}

function applyBgColorCustom() {
    var btn = document.getElementById('bgColorSaveBtn');
    if (btn.classList.contains('saved')) { btn.classList.remove('saved'); btn.textContent = '保存'; return; }
    var color = document.getElementById('bgColorPicker').value;
    applyBgColorPreset(color);
    btn.classList.add('saved'); btn.textContent = '已保存';
}

function toggleParticlesEffect() {
    var show = document.getElementById('toggleParticles').checked;
    var s = loadSettings();
    s.particles = show;
    saveSettings(s);
    document.getElementById('particles').style.display = show ? '' : 'none';
    document.querySelector('.bg-animation').style.display = show ? '' : 'none';
    document.dispatchEvent(new Event('webssh:background-sync'));
}

function toggleFooterVisibility() {
    var show = document.getElementById('toggleFooter').checked;
    var s = loadSettings();
    s.footer = show;
    saveSettings(s);
    var footer = document.querySelector('.global-footer');
    if (footer) {
        footer.style.setProperty('--footer-user-hidden', show ? '' : 'none');
        if (!show) {
            footer.classList.add('user-hidden');
        } else {
            footer.classList.remove('user-hidden');
        }
    }
}

function changeBlur(val) {
    var s = loadSettings();
    s.blur = parseInt(val);
    saveSettings(s);
    document.documentElement.style.setProperty('--blur', val + 'px');
    document.getElementById('blurLabel').textContent = val + 'px';
}

function resetAllSettings() {
    safeStorageRemove(SETTINGS_KEY);
    document.body.style.zoom = '';
    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--blur');
    setBgImage('');
    document.getElementById('particles').style.display = '';
    document.querySelector('.bg-animation').style.display = '';
    document.dispatchEvent(new Event('webssh:background-sync'));
    var toggleP = document.getElementById('toggleParticles');
    if (toggleP) toggleP.checked = true;
    applyCardScale(100);
    applyEdgeScale(100);
    var footer = document.querySelector('.global-footer');
    if (footer) footer.classList.remove('user-hidden');
    var toggleF = document.getElementById('toggleFooter');
    if (toggleF) toggleF.checked = true;
    try { safeStorageRemove(TOPBAR_METRICS_KEY); } catch (e) { }
    var topbarToggle = document.getElementById('enableSysInfo');
    if (topbarToggle) topbarToggle.checked = false;
    updateSysInfoHint();
    sessions.forEach(function (s) {
        stopTopbarMetricsPolling(s);
    });
    setTopbarMetricsVisible(false);
    renderBgSwatches();
    showToast('已恢复默认', 'success');
}

function initSettings() {
    var s = loadSettings();
    if (s.zoom && s.zoom !== 100) {
        document.body.style.zoom = (s.zoom / 100);
    }
    if (s.bgImage) {
        setBgImage(s.bgImage);
    }
    if (s.bgColor) {
        document.documentElement.style.setProperty('--bg', s.bgColor);
    }
    if (s.particles === false) {
        document.getElementById('particles').style.display = 'none';
        document.querySelector('.bg-animation').style.display = 'none';
        var cb = document.getElementById('toggleParticles');
        if (cb) cb.checked = false;
    }
    document.dispatchEvent(new Event('webssh:background-sync'));
    if (s.blur != null) {
        document.documentElement.style.setProperty('--blur', s.blur + 'px');
    }
    if (s.cardScale && s.cardScale !== 100) applyCardScale(s.cardScale);
    if (s.edgeScale && s.edgeScale !== 100) applyEdgeScale(s.edgeScale);
    if (s.footer === false) {
        var footer = document.querySelector('.global-footer');
        if (footer) footer.classList.add('user-hidden');
        var cb2 = document.getElementById('toggleFooter');
        if (cb2) cb2.checked = false;
    }
}

// ==================== URL Auto-Login ====================
function isPrivateKey(s) {
    if (!s) return false;
    var decoded = safeDecodeURIComponent(s);
    return /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(decoded);
}

function parseUrlLoginPath(pathname) {
    var path = String(pathname || '');
    if (!path || path === '/') return null;
    path = path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!path) return null;

    var parts = path.split('/');
    var host, port, user, pass, authType;

    // Supported formats:
    // ip:port/password                 (2 parts)
    // ip:port/user/password            (3 parts, host has colon)
    // ip/port/password                 (3 parts, port is numeric)
    // ip/user/password                 (3 parts, port is not numeric)
    // ip/port/user/password            (4 parts)
    // ip/port/user/privatekey          (4 parts, key detected)

    if (parts.length === 2) {
        // ip:port/password OR ip/password OR [ipv6]:port/password OR ipv6/password
        var hp2 = parseHostPortInput(safeDecodeURIComponent(parts[0]), 22);
        host = hp2.host;
        port = hp2.port;
        pass = safeDecodeURIComponent(parts[1]);
        user = 'root';
    } else if (parts.length === 3) {
        var hp3 = parseHostPortInput(safeDecodeURIComponent(parts[0]), 22);
        var middle = safeDecodeURIComponent(parts[1]);
        if (middle.charAt(0) === '@') {
            // Explicit username syntax, including all-numeric usernames: host/@12345/password
            host = hp3.host;
            port = hp3.port;
            user = middle.slice(1);
            pass = safeDecodeURIComponent(parts[2]);
        } else if (/^\d+$/.test(parts[1])) {
            // ip/port/password
            host = hp3.host;
            port = normalizePortValue(parts[1], hp3.port);
            pass = safeDecodeURIComponent(parts[2]);
            user = 'root';
        } else {
            // ip:port/user/password OR ip/user/password OR ipv6/user/password
            host = hp3.host;
            port = hp3.port;
            user = middle;
            pass = safeDecodeURIComponent(parts[2]);
        }
    } else if (parts.length === 4) {
        // ip/port/user/password  OR  ip/port/user/privatekey
        var hp4 = parseHostPortInput(safeDecodeURIComponent(parts[0]), 22);
        host = hp4.host;
        port = /^\d+$/.test(parts[1]) ? normalizePortValue(parts[1], hp4.port) : hp4.port;
        user = safeDecodeURIComponent(parts[2]);
        pass = safeDecodeURIComponent(parts[3]);
    } else {
        return null;
    }

    if (!host) return null;

    // Detect if credential is a private key
    authType = isPrivateKey(pass) ? 'key' : 'password';

    return { host: host, port: port || 22, user: user || 'root', pass: pass || '', authType: authType };
}

function decodeBase64UrlUTF8(value) {
    var normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    if (window.TextDecoder) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    var escaped = '';
    for (var j = 0; j < bytes.length; j++) escaped += '%' + bytes[j].toString(16).padStart(2, '0');
    return decodeURIComponent(escaped);
}

function parseUrlLoginFragment(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    var encoded = new URLSearchParams(raw).get('ssh');
    if (!encoded) return null;
    try {
        var data = JSON.parse(decodeBase64UrlUTF8(encoded));
        if (!data || typeof data !== 'object') return null;
        var hostValue = data.hostname !== undefined ? data.hostname : data.host;
        var hp = parseHostPortInput(String(hostValue || ''), data.port || 22);
        if (!hp.host) return null;
        var privateKey = typeof data.privateKey === 'string' ? data.privateKey : '';
        var password = typeof data.password === 'string' ? data.password : (typeof data.pass === 'string' ? data.pass : '');
        var keyLogin = data.logintype === 1 || data.loginType === 1 || data.authType === 'key' || !!privateKey;
        return {
            host: hp.host,
            port: hp.port,
            user: String(data.username !== undefined ? data.username : (data.user || 'root')),
            pass: keyLogin ? privateKey : password,
            passphrase: typeof data.passphrase === 'string' ? data.passphrase : '',
            authType: keyLogin ? 'key' : 'password'
        };
    } catch (e) {
        return null;
    }
}

function parseUrlLogin() {
    return parseUrlLoginFragment(location.hash) || (allowLegacyPathLogin ? parseUrlLoginPath(location.pathname) : null);
}

function tryAutoLogin() {
    if (urlAutoLoginHandled) return;
    var info = parseUrlLogin();
    if (!info) return;
    urlAutoLoginHandled = true;

    // Fill form
    document.getElementById('hostname').value = formatHostForInput(info.host);
    document.getElementById('port').value = info.port;
    document.getElementById('username').value = info.user;

    if (info.authType === 'key') {
        switchAuthTab('key');
        document.getElementById('privateKey').value = info.pass;
        var passphrase = document.getElementById('passphrase');
        if (passphrase) passphrase.value = info.passphrase || '';
    } else {
        switchAuthTab('password');
        document.getElementById('password').value = info.pass;
    }

    // Clean URL without reload
    history.replaceState(null, '', '/');

    // Auto connect after short delay
    setTimeout(function () {
        connectFromLogin();
    }, 500);
}

// ==================== Local UI Preview ====================
function initPreviewMode() {
    var params = new URLSearchParams(location.search);
    if (params.get('preview') !== 'terminal' && params.get('drawer') !== 'settings') return;
    var previewTheme = params.get('theme');
    if (previewTheme === 'dark' || previewTheme === 'light') applyTheme(previewTheme);

    var host = params.get('host') || '54.209.196.41';
    showView('terminalView');
    setStatus('', 'UI 预览');
    document.getElementById('tabBar').innerHTML =
        '<div class="ssh-tab active"><span class="tab-ip">' + esc(host) + '</span><button class="tab-close"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
    renderScriptBookmarks();

    var drawer = params.get('drawer') || 'script';
    if (drawer === 'script') {
        document.getElementById('scriptDrawer').classList.add('open');
    } else if (drawer === 'sftp') {
        document.getElementById('sftpPanel').classList.add('open');
        var sftpBody = document.getElementById('sftpBody');
        if (sftpBody) sftpBody.innerHTML = [
            { name: 'logs', size: '文件夹', isDir: true, editable: false },
            { name: 'notes.txt', size: '3KB', editable: true },
            { name: 'archive.log', size: '18MB', editable: false },
            { name: 'initrd.img.old', size: '17.4MB', editable: false }
        ].map(function (item) {
            var icon = item.isDir
                ? '<svg class="sftp-icon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>'
                : '<svg class="sftp-icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
            var editTitle = item.editable ? '在线编辑' : '文件超过在线编辑上限 2MB';
            var edit = item.isDir ? '' : '<button class="sftp-edit' + (item.editable ? '' : ' disabled') + '" title="' + editTitle + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1-1 1 1-4z"/></svg></button>';
            var downloadTitle = item.isDir ? '压缩并下载文件夹' : '下载';
            var download = '<button class="sftp-dl' + (item.isDir ? ' directory' : '') + '" title="' + downloadTitle + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>';
            var remove = item.isDir ? '' : '<button class="sftp-delete" title="删除"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>';
            return '<div class="sftp-row">' + icon + '<span class="sftp-name">' + esc(item.name) + '</span><span class="sftp-meta">' + item.size + '</span>' + edit + download + remove + '</div>';
        }).join('');
        if (params.get('upload') === 'progress') {
            var uploadPreviewPanel = document.getElementById('sftpTransferPanel');
            if (uploadPreviewPanel) {
                uploadPreviewPanel.className = 'sftp-transfer-panel show';
                uploadPreviewPanel.innerHTML = renderSftpUploadTransfer({ id: 'preview-upload', name: 'website-backup.tar.gz', total: 128 * 1024 * 1024, sent: 71 * 1024 * 1024, status: 'running', startedAt: Date.now() - 9200 });
            }
        } else if (params.get('upload') === 'processing') {
            var processingPreviewPanel = document.getElementById('sftpTransferPanel');
            if (processingPreviewPanel) {
                processingPreviewPanel.className = 'sftp-transfer-panel show';
                processingPreviewPanel.innerHTML = renderSftpUploadTransfer({ id: 'preview-upload', name: 'website-backup.tar.gz', total: 128 * 1024 * 1024, sent: 128 * 1024 * 1024, status: 'processing', startedAt: Date.now() - 14000 });
            }
        } else if (params.get('delete') === 'confirm') {
            sftpDeleteConfirmRequest = { sessionId: 'preview', path: '/var/log/archive.log', parentPath: '/var/log', name: 'archive.log', deleting: false };
            document.getElementById('sftpDeleteConfirmName').textContent = 'archive.log';
            document.getElementById('sftpDeleteConfirmPath').textContent = '/var/log/archive.log';
            document.getElementById('sftpDeleteConfirmModal').classList.add('show');
        } else if (params.get('download') === 'confirm') {
            sftpDownloadConfirmRequest = { sessionId: 'preview', path: '/var/log/archive.log', name: 'archive.log', size: 18 * 1024 * 1024 };
            document.getElementById('sftpDownloadConfirmName').textContent = 'archive.log';
            document.getElementById('sftpDownloadConfirmPath').textContent = '/var/log/archive.log';
            document.getElementById('sftpDownloadConfirmSize').textContent = fmtB(18 * 1024 * 1024);
            document.getElementById('sftpDownloadConfirmModal').classList.add('show');
        } else if (params.get('download') === 'folder-confirm') {
            sftpDownloadConfirmRequest = { sessionId: 'preview', path: '/var/log/logs', name: 'logs.tar.gz', sourceName: 'logs', size: 0, isDirectory: true };
            document.getElementById('sftpDownloadConfirmTitle').textContent = '确认压缩并下载文件夹';
            document.getElementById('sftpDownloadConfirmDescription').textContent = '确认后先在远端服务器生成临时压缩包，再下载到本地。';
            document.getElementById('sftpDownloadConfirmSizeLabel').textContent = '压缩包大小';
            document.getElementById('sftpDownloadConfirmName').textContent = 'logs.tar.gz';
            document.getElementById('sftpDownloadConfirmPath').textContent = '/var/log/logs';
            document.getElementById('sftpDownloadConfirmSize').textContent = '压缩完成后确定';
            updateSftpDownloadConfirmHint(sftpDownloadConfirmRequest);
            document.getElementById('sftpDownloadConfirmModal').classList.add('show');
        } else if (params.get('download') === 'compress') {
            var compressionPanel = document.getElementById('sftpTransferPanel');
            if (compressionPanel) {
                compressionPanel.className = 'sftp-transfer-panel show';
                compressionPanel.innerHTML = '<div class="sftp-transfer-item preparing archive-compressing"><div class="sftp-transfer-stages"><span class="active"><i>1</i>压缩</span><b></b><span><i>2</i>下载</span></div><div class="sftp-transfer-head"><div><b>logs.tar.gz</b><span>正在压缩</span></div><div class="sftp-transfer-actions"><button class="danger">取消</button></div></div><div class="sftp-transfer-progress"><i style="width:63%"></i></div><div class="sftp-transfer-detail"><span>已处理 620MB / 1GB · 138 / 220 个项目</span><b>63%</b></div></div>';
            }
        } else if (params.get('download') === 'folder-progress') {
            var folderPanel = document.getElementById('sftpTransferPanel');
            if (folderPanel) {
                folderPanel.className = 'sftp-transfer-panel show';
                folderPanel.innerHTML = '<div class="sftp-transfer-item running"><div class="sftp-transfer-stages"><span class="done"><i>1</i>压缩</span><b></b><span class="active"><i>2</i>下载</span></div><div class="sftp-transfer-head"><div><b>logs.tar.gz</b><span>下载中</span></div><div class="sftp-transfer-actions"><button>暂停</button><button class="danger">取消</button></div></div><div class="sftp-transfer-progress"><i style="width:42%"></i></div><div class="sftp-transfer-detail"><span>310MB / 738MB · 8.4MB/s · 剩余 51 秒</span><b>42%</b></div></div>';
            }
        } else if (params.get('download') === 'progress') {
            var panel = document.getElementById('sftpTransferPanel');
            if (panel) {
                panel.className = 'sftp-transfer-panel show';
                panel.innerHTML = '<div class="sftp-transfer-item running"><div class="sftp-transfer-head"><div><b>archive.log</b><span>下载中</span></div><div class="sftp-transfer-actions"><button>暂停</button><button class="danger">取消</button></div></div><div class="sftp-transfer-progress"><i style="width:42%"></i></div><div class="sftp-transfer-detail"><span>7.6MB / 18MB · 3.2MB/s · 剩余 4 秒</span><b>42%</b></div></div>';
            }
        } else if (params.get('editor') === 'open' || params.get('editor') === 'workbench') {
            var previewSession = { id: 'preview', hostname: host, sshInfo: 'preview', _connected: true };
            sessions.push(previewSession);
            activeIdx = sessions.length - 1;
            var workbenchPreview = params.get('editor') === 'workbench';
            var previewDocuments = workbenchPreview ? [
                { name: 'index.html', content: '<!doctype html>\n<html lang="zh-CN">\n<head>\n    <meta charset="UTF-8">\n    <title>WebSSH 工作台</title>\n</head>\n<body>\n    <main class="hero">\n        <h1>Remote workspace</h1>\n        <p>多个文件共享一个窗口。</p>\n    </main>\n    <script src="app.js"></script>\n</body>\n</html>\n' },
                { name: 'server.py', content: 'from pathlib import Path\n\n\ndef load_config(path: str) -> dict:\n    """Load one remote configuration file."""\n    text = Path(path).read_text(encoding="utf-8")\n    return {"content": text, "length": len(text)}\n\n\nif __name__ == "__main__":\n    print(load_config("/etc/webssh/config.json"))\n' },
                { name: 'app.js', content: 'const workbench = {\n    tabs: [],\n    activeId: null,\n};\n\nfunction openDocument(document) {\n    workbench.tabs.push(document);\n    workbench.activeId = document.id;\n    return document;\n}\n\nexport { openDocument, workbench };\n' },
                { name: 'style.css', content: ':root {\n    --accent: #22d3ee;\n    --surface: #07090c;\n}\n\n.workbench {\n    display: grid;\n    grid-template-columns: 1fr 88px;\n    color: var(--accent);\n    background: var(--surface);\n}\n' },
                { name: 'config.json', content: '{\n    "name": "webssh",\n    "editor": {\n        "syntaxHighlight": true,\n        "minimap": true,\n        "completion": false\n    }\n}\n' },
                { name: 'deploy.sh', content: '#!/usr/bin/env bash\nset -euo pipefail\n\necho "building webssh"\ndocker compose build webssh\ndocker compose up -d webssh\n' },
                { name: 'values.yaml', content: 'webssh:\n  image: webssh:latest\n  service:\n    port: 8008\n  features:\n    preview: true\n    editor: true\n' },
                { name: 'main.go', content: 'package main\n\nimport (\n    "fmt"\n    "net/http"\n)\n\nfunc health(w http.ResponseWriter, _ *http.Request) {\n    _, _ = fmt.Fprintln(w, "ok")\n}\n' },
                { name: 'README.md', content: '# WebSSH SFTP 工作台\n\n- 多文件标签\n- 图片与视频预览\n- 轻量语法高亮\n- 代码缩略图\n' },
                { name: 'logo.ico', viewMode: 'image', mime: 'image/svg+xml' }
            ] : [{ name: 'example.conf', content: 'server {\n    listen 80;\n}\n' }];
            var previewEditors = [];
            previewDocuments.forEach(function (documentInfo, index) {
                var previewPath = '/workspace/' + documentInfo.name;
                var previewEditor = { id: 'preview-editor-' + index, sessionId: previewSession.id, path: previewPath, targetPath: previewPath, name: documentInfo.name, parentPath: '/workspace', viewMode: documentInfo.viewMode || 'text', previewMime: documentInfo.mime || '', isNew: false, version: 'preview', originalContent: documentInfo.content || '', maxBytes: remoteEditorDefaultMaxBytes, sizeBytes: (documentInfo.content || '').length, minimized: false, maximized: false, saving: false, loaded: true, restoreRect: null };
                remoteEditors.push(previewEditor);
                if (!createRemoteEditorElement(previewEditor)) return;
                previewEditor.el.classList.remove('is-loading');
                if (previewEditor.viewMode === 'text') {
                    previewEditor.textarea.readOnly = false;
                    previewEditor.textarea.value = previewEditor.originalContent;
                    remoteEditorSetStatus(previewEditor, '已加载 · Ctrl+S 保存', 'success');
                } else {
                    previewEditor.mediaStage.innerHTML = '';
                    var previewImage = document.createElement('img');
                    previewImage.className = 'remote-editor-image';
                    previewImage.alt = 'WebSSH preview';
                    previewImage.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#07111d"/><stop offset="1" stop-color="#172554"/></linearGradient></defs><rect width="960" height="540" rx="30" fill="url(#g)"/><circle cx="480" cy="240" r="105" fill="#22d3ee" opacity=".16"/><path d="M410 300l58-120 45 74 36-42 71 88z" fill="#67e8f9"/><text x="480" y="390" text-anchor="middle" fill="#e2e8f0" font-family="sans-serif" font-size="34">SFTP 在线图片预览</text></svg>');
                    previewEditor.mediaStage.appendChild(previewImage);
                    previewEditor.mediaElement = previewImage;
                    previewEditor.mediaWidth = 960;
                    previewEditor.mediaHeight = 540;
                    remoteEditorSetStatus(previewEditor, '图片预览已就绪', 'success');
                }
                remoteEditorUpdateMetrics(previewEditor);
                previewEditors.push(previewEditor);
            });
            var preferredPreview = params.get('media') === 'image' ? previewEditors[previewEditors.length - 1] : previewEditors[0];
            if (preferredPreview) activateRemoteEditor(preferredPreview, false);
            syncRemoteEditorVisibility();
            remoteEditorLayerWidth();
        }
    } else if (drawer === 'settings') {
        var p = document.getElementById('settingsPanel');
        var o = document.getElementById('settingsOverlay');
        if (p && o) { p.classList.add('show'); o.classList.add('show'); }
    } else if (drawer === 'auth') {
        openAuthModal('login');
    }
}

// ==================== Splash Screen ====================
(function () {
    var splashStart = Date.now();
    var MIN_SPLASH = 1500;
    var dismissed = false;

    function doFade() {
        if (dismissed) return;
        dismissed = true;
        var el = document.getElementById('splash');
        if (!el) return;
        el.classList.add('fade-out');
        setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 650);
    }

    function dismissSplash() {
        var elapsed = Date.now() - splashStart;
        var delay = Math.max(0, MIN_SPLASH - elapsed);
        setTimeout(doFade, delay);
    }

    window.__dismissSplash = dismissSplash;
})();

// ==================== Init ====================
warmTerminalEndpoint();
initTheme();
initSettings();
loadVersionCache();
initTopbarMetricsPreference();
initSysInterval();
ensureScriptBookmarkClock();
renderConnBookmarks();
renderScriptBookmarks();
updateAccountUI();
refreshAccountState();
loadProxyConfig();
tryAutoLogin();
initPreviewMode();

var authModalEl = document.getElementById('authModal');
if (authModalEl) {
    authModalEl.addEventListener('click', function (e) {
        if (e.target === authModalEl) hideAuthModal();
    });
}
var sshAuthRetryModalEl = document.getElementById('sshAuthRetryModal');
if (sshAuthRetryModalEl) {
    sshAuthRetryModalEl.addEventListener('click', function (e) {
        if (e.target === sshAuthRetryModalEl) hideSSHAuthRetryModal(true);
    });
}
var sftpDownloadConfirmModalEl = document.getElementById('sftpDownloadConfirmModal');
if (sftpDownloadConfirmModalEl) {
    sftpDownloadConfirmModalEl.addEventListener('click', function (e) {
        if (e.target === sftpDownloadConfirmModalEl) hideSftpDownloadConfirm();
    });
}
var sftpDeleteConfirmModalEl = document.getElementById('sftpDeleteConfirmModal');
if (sftpDeleteConfirmModalEl) {
    sftpDeleteConfirmModalEl.addEventListener('click', function (e) {
        if (e.target === sftpDeleteConfirmModalEl) hideSftpDeleteConfirm();
    });
}
var editScriptModalEl = document.getElementById('editScriptModal');
if (editScriptModalEl) {
    editScriptModalEl.addEventListener('click', function (e) {
        if (e.target === editScriptModalEl) hideEditScriptModal();
    });
}
var scriptManagerModalEl = document.getElementById('scriptManagerModal');
if (scriptManagerModalEl) {
    scriptManagerModalEl.addEventListener('click', function (e) {
        if (e.target === scriptManagerModalEl) hideScriptManager();
    });
}
var siteBookmarkRestoreModalEl = document.getElementById('siteBookmarkRestoreModal');
if (siteBookmarkRestoreModalEl) {
    siteBookmarkRestoreModalEl.addEventListener('click', function (e) {
        if (e.target === siteBookmarkRestoreModalEl) hideSiteScriptRestoreConfirm();
    });
}
var categoryNameEl = document.getElementById('categoryName');
if (categoryNameEl) categoryNameEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') saveScriptCategory();
});
['authUsername', 'authPassword'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submitAuthForm();
    });
});
['retryHost', 'retryPort', 'retryUser', 'retryPass'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submitSSHAuthRetry();
    });
});
['editScriptName', 'editScriptContent'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') saveEditedScriptBookmark();
    });
});
['oldPassword', 'newPassword', 'confirmNewPassword'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') changeAccountPassword();
    });
});

// Fetch server config (footer visibility etc.), then dismiss splash
(function () {
    function applyPasswordStoragePolicy(enabled) {
        savePasswords = enabled === true;
        if (savePasswords) {
            loadProxyConfig();
            return;
        }
        var bookmarks = loadBM(CBK);
        var changed = false;
        bookmarks.forEach(function (bookmark) {
            if (bookmark && Object.prototype.hasOwnProperty.call(bookmark, 'password')) {
                delete bookmark.password;
                changed = true;
            }
        });
        if (changed) safeStorageSet(CBK, JSON.stringify(bookmarks));
        try {
            var proxyConfig = JSON.parse(safeStorageGet(PROXY_KEY, 'null'));
            if (proxyConfig && Object.prototype.hasOwnProperty.call(proxyConfig, 'pass')) {
                delete proxyConfig.pass;
                safeStorageSet(PROXY_KEY, JSON.stringify(proxyConfig));
            }
        } catch (e) { }
        var proxyPassword = document.getElementById('proxyPass');
        if (proxyPassword) proxyPassword.value = '';
    }

    function applyServerConfig(cfg) {
        if (cfg && cfg.appVersion) {
            applyRunningAppVersion(cfg.appVersion);
        }
        allowRegistration = !!(cfg && cfg.allowRegistration);
        allowLegacyPathLogin = !!(cfg && cfg.allowLegacyPathLogin === true);
        requireGatewayAccount = !!(cfg && cfg.requireAccount === true);
        var configuredEditorLimit = parseInt(cfg && cfg.remoteEditorMaxBytes, 10);
        if (configuredEditorLimit >= 1024) remoteEditorDefaultMaxBytes = configuredEditorLimit;
        var configuredPreviewLimit = parseInt(cfg && cfg.remotePreviewMaxBytes, 10);
        if (configuredPreviewLimit >= 1024 * 1024) remotePreviewDefaultMaxBytes = configuredPreviewLimit;
        applyPasswordStoragePolicy(!!(cfg && cfg.savePass === true));
        var registerTab = document.getElementById('authRegisterTab');
        if (registerTab) registerTab.style.display = allowRegistration ? '' : 'none';
        if (!allowRegistration && authMode === 'register') switchAuthMode('login');
        if (cfg && cfg.showFooter === false) {
            var footer = document.querySelector('.global-footer');
            if (footer) footer.classList.add('server-hidden');
        }
        if (allowLegacyPathLogin) {
            tryAutoLogin();
        } else if (!urlAutoLoginHandled && parseUrlLoginPath(location.pathname)) {
            history.replaceState(null, '', '/');
            showToast('路径携带 SSH 凭据的旧式快速登录已禁用，请改用 #ssh= 片段格式', 'error');
        }
    }

    var req = new XMLHttpRequest();
    req.open('GET', '/config', true);
    req.timeout = 3000;
    req.onload = function () {
        if (req.status === 200) {
            try { applyServerConfig(JSON.parse(req.responseText)); } catch (e) { applyServerConfig(null); }
        } else {
            applyServerConfig(null);
        }
        if (window.__dismissSplash) window.__dismissSplash();
    };
    req.onerror = req.ontimeout = function () {
        applyServerConfig(null);
        if (window.__dismissSplash) window.__dismissSplash();
    };
    req.send();
})();
