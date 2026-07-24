/* ============================================================
   WebSSH v5 - Multi-tab, SFTP, Dual Bookmarks
   ============================================================ */

// ==================== State ====================
var sessions = [];
var activeIdx = -1;
var sftpCurrentPath = '/';
var sftpDirPickerPath = '/';
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

// ==================== Particles ====================
(function () {
    var c = document.getElementById('particles');
    if (!c) return;
    var x = c.getContext('2d'), ps = [], m = { x: null, y: null };
    function rs() { c.width = innerWidth; c.height = innerHeight; }
    rs(); addEventListener('resize', rs);
    document.addEventListener('mousemove', function (e) { m.x = e.clientX; m.y = e.clientY; });
    function P() { this.r(); }
    P.prototype.r = function () { this.x = Math.random() * c.width; this.y = Math.random() * c.height; this.s = Math.random() * 2 + .5; this.sx = (Math.random() - .5) * .5; this.sy = (Math.random() - .5) * .5; this.o = Math.random() * .5 + .1; this.h = Math.random() * 60 + 180; };
    P.prototype.u = function () { this.x += this.sx; this.y += this.sy; if (m.x !== null) { var dx = m.x - this.x, dy = m.y - this.y, d = Math.sqrt(dx * dx + dy * dy); if (d < 150) { var f = (150 - d) / 150; this.x -= dx * f * .01; this.y -= dy * f * .01; } } if (this.x < 0 || this.x > c.width) this.sx *= -1; if (this.y < 0 || this.y > c.height) this.sy *= -1; };
    P.prototype.d = function () { x.beginPath(); x.arc(this.x, this.y, this.s, 0, Math.PI * 2); x.fillStyle = 'hsla(' + this.h + ',80%,60%,' + this.o + ')'; x.fill(); };
    var n = Math.min(50, Math.floor(innerWidth * innerHeight / 22000));
    for (var i = 0; i < n; i++) ps.push(new P());
    (function a() {
        x.clearRect(0, 0, c.width, c.height);
        for (var i = 0; i < ps.length; i++) { ps[i].u(); ps[i].d(); }
        for (var i = 0; i < ps.length; i++) for (var j = i + 1; j < ps.length; j++) { var dx = ps[i].x - ps[j].x, dy = ps[i].y - ps[j].y, d = Math.sqrt(dx * dx + dy * dy); if (d < 120) { x.beginPath(); x.moveTo(ps[i].x, ps[i].y); x.lineTo(ps[j].x, ps[j].y); x.strokeStyle = 'rgba(0,212,255,' + ((1 - d / 120) * .15) + ')'; x.lineWidth = .5; x.stroke(); } }
        requestAnimationFrame(a);
    })();
})();

// ==================== Utility ====================
var storageErrorShown = false;
function safeStorageGet(key, fallback) {
    try {
        var value = localStorage.getItem(key);
        return value === null || value === undefined ? fallback : value;
    } catch (e) {
        return fallback;
    }
}
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
        var scriptDeleteModal = document.getElementById('scriptDeleteModal');
        if (scriptDeleteModal && scriptDeleteModal.classList.contains('show')) { hideScriptDeleteModal(); return; }
        var categoryDeleteModal = document.getElementById('categoryDeleteModal');
        if (categoryDeleteModal && categoryDeleteModal.classList.contains('show')) { hideCategoryDeleteModal(); return; }
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
    }
});

document.addEventListener('click', function (e) {
    var serverInfoDetailModal = document.getElementById('serverInfoDetailModal');
    if (serverInfoDetailModal && serverInfoDetailModal.classList.contains('show') && e.target === serverInfoDetailModal) {
        hideServerInfoDetailModal();
    }
    var scriptDeleteModal = document.getElementById('scriptDeleteModal');
    if (scriptDeleteModal && scriptDeleteModal.classList.contains('show') && e.target === scriptDeleteModal) {
        hideScriptDeleteModal();
    }
    var categoryDeleteModal = document.getElementById('categoryDeleteModal');
    if (categoryDeleteModal && categoryDeleteModal.classList.contains('show') && e.target === categoryDeleteModal) {
        hideCategoryDeleteModal();
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
            user: document.getElementById('proxyUser').value,
            pass: document.getElementById('proxyPass').value
        };
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
            document.getElementById('proxyPass').value = cfg.pass || '';
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
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

function buildSSHInfoDirect(host, port, user, pass) {
    var hp = parseHostPortInput(host, port);
    var info = { hostname: hp.host, port: hp.port, username: user || 'root', logintype: 0, password: pass || '' };
    var proxy = getProxyInfo();
    if (proxy.proxyHost) { info.proxyHost = proxy.proxyHost; info.proxyPort = proxy.proxyPort; info.proxyUser = proxy.proxyUser; info.proxyPass = proxy.proxyPass; }
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

// ==================== Multi-Tab Session Management ====================
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
        authType: opts.authType || 'password',
        authRetry: null,
        _connected: false,
        _dataDisposable: null
    };

    session.resizeObs = new ResizeObserver(function () { try { fa.fit(); } catch (e) { } });
    session.resizeObs.observe(termDiv);

    sessions.push(session);
    return session;
}

function switchTab(idx, userActivated) {
    if (idx < 0 || idx >= sessions.length) return;
    var prevIdx = activeIdx;
    activeIdx = idx;
    sessions.forEach(function (s, i) {
        if (i === idx) { s.termDiv.classList.add('active'); }
        else { s.termDiv.classList.remove('active'); }
    });
    renderTabs();
    var s = sessions[idx];
    setTimeout(function () { try { s.fitAddon.fit(); s.term.focus(); } catch (e) { } }, 100);
    updateMetricsForActive();
    updateFontSizeLabel();
    if ((prevIdx !== idx || userActivated) && s.authRetry) s.authRetry.dismissed = false;
    updateSSHAuthRetryModalForActive();
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

function startTopbarMetricsPolling(session) {
    if (!session || !isTopbarMetricsEnabled()) return;
    if (session.sysInfoTimer) clearInterval(session.sysInfoTimer);
    if (session.sysInfoStartTimer) clearTimeout(session.sysInfoStartTimer);
    // Do not open a second SSH connection while the terminal is still
    // receiving its first prompt. This is only for the optional metrics UI;
    // the terminal WebSocket remains completely independent.
    session.sysInfoStartTimer = setTimeout(function () {
        session.sysInfoStartTimer = null;
        if (session._connected && session.ws && session.ws.readyState === 1 && isTopbarMetricsEnabled()) {
            fetchSysInfoFor(session);
        }
    }, 1500);
    session.sysInfoTimer = setInterval(function () { fetchSysInfoFor(session); }, getSysInterval() * 1000);
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
    if (s.ws && (s.ws.readyState === 0 || s.ws.readyState === 1)) {
        try { s.ws.close(); } catch (e) { }
    }
    s.hostname = host;
    s.port = port;
    s.username = user;
    s.authType = 'password';
    s.sshInfo = buildSSHInfoDirect(host, port, user, pass);
    s.authRetry = null;
    s._connected = false;
    hideSSHAuthRetryModal(false);
    renderTabs();
    showToast('正在重新连接 ' + host + '...', 'info');
    startSessionConnection(s);
}

function startSessionConnection(session, afterStart) {
    var start = function () {
        try { session.fitAddon.fit(); } catch (e) { }
        connectSession(session);
        if (typeof afterStart === 'function') afterStart();
    };
    if (typeof requestAnimationFrame === 'function' && document.visibilityState !== 'hidden') requestAnimationFrame(start);
    else setTimeout(start, 0);
}

function buildTerminalWebSocketURL(cols, rows) {
    var fallbackProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var fallback = fallbackProto + '//' + location.host + '/term';
    var configured = typeof window.__WEBSSH_TERMINAL_WS_URL__ === 'string'
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

function connectSession(session) {
    if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
    if (session._resizeHandler) {
        removeEventListener('resize', session._resizeHandler);
        session._resizeHandler = null;
    }
    if (session._dataDisposable && typeof session._dataDisposable.dispose === 'function') {
        try { session._dataDisposable.dispose(); } catch (e) { }
        session._dataDisposable = null;
    }
    var cols = session.term.cols, rows = session.term.rows;
    var wsUrl = buildTerminalWebSocketURL(cols, rows);
    var ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    session.ws = ws;
    session._connected = false;
    var failedBeforeConnect = false;

    ws.onopen = function () { ws.send(session.sshInfo); };

    ws.onmessage = function (e) {
        var isText = typeof e.data === 'string';
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
            session._connected = true;
            session.authRetry = null;
            updateSSHAuthRetryModalForActive();
            showToast(session.hostname + ' 连接成功', 'success');
            setupAutoCopy(session);
            maybeShowFirstServerInfoGuide(session);
            session.heartbeat = setInterval(function () { if (ws.readyState === 1) ws.send('ping'); }, 30000);
            startTopbarMetricsPolling(session);
        }
        session.term.write(terminalData);
    };

    ws.onerror = function () { showToast(session.hostname + ' 连接失败', 'error'); };
    ws.onclose = function () {
        if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
        if (session.sysInfoTimer) { clearInterval(session.sysInfoTimer); session.sysInfoTimer = null; }
        if (session.sysInfoStartTimer) { clearTimeout(session.sysInfoStartTimer); session.sysInfoStartTimer = null; }
        if (!session._connected && !failedBeforeConnect) showToast(session.hostname + ' 无法连接', 'error');
    };

    session._dataDisposable = session.term.onData(function (data) { if (ws.readyState === 1) ws.send(data); });

    var resizeHandler = function () {
        try { session.fitAddon.fit(); } catch (e) { }
        if (ws.readyState === 1 && session.term) ws.send('resize:' + session.term.rows + ':' + session.term.cols);
    };
    addEventListener('resize', resizeHandler);
    session._resizeHandler = resizeHandler;
}

function connectFromLogin() {
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
    if (serverInfoModalIdx === idx) hideServerInfoModal();
    var s = sessions[idx];
    if (s.ws) s.ws.close();
    if (s.heartbeat) clearInterval(s.heartbeat);
    if (s.sysInfoTimer) clearInterval(s.sysInfoTimer);
    if (s.sysInfoStartTimer) clearTimeout(s.sysInfoStartTimer);
    if (s.resizeObs) s.resizeObs.disconnect();
    if (s._resizeHandler) removeEventListener('resize', s._resizeHandler);
    if (s._dataDisposable && typeof s._dataDisposable.dispose === 'function') { try { s._dataDisposable.dispose(); } catch (e) { } }
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
        activeIdx = Math.min(idx, sessions.length - 1);
        switchTab(activeIdx);
    }
    renderTabs();
}

function closeActiveTab() { if (activeIdx >= 0) closeTab(activeIdx); }

function reconnectTab() {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var s = sessions[activeIdx];
    if (s.ws) s.ws.close();
    if (s.heartbeat) { clearInterval(s.heartbeat); s.heartbeat = null; }
    if (s.sysInfoTimer) { clearInterval(s.sysInfoTimer); s.sysInfoTimer = null; }
    if (s.sysInfoStartTimer) { clearTimeout(s.sysInfoStartTimer); s.sysInfoStartTimer = null; }
    showToast('重新连接 ' + s.hostname + '...', 'info');
    startSessionConnection(s);
}

function showAddTab() { document.getElementById('addTabModal').classList.add('show'); document.getElementById('newTabHost').focus(); }
function hideAddTab() { document.getElementById('addTabModal').classList.remove('show'); }

function addNewTab() {
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
    if (!session.sshInfo) return;
    if (session._sysInfoFetchPromise) return session._sysInfoFetchPromise;
    session._sysInfoFetchPromise = fetch('/sysinfo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sshInfo: session.sshInfo }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
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
        .catch(function () {
            if (serverInfoModalIdx >= 0 && sessions[serverInfoModalIdx] === session) {
                renderServerInfoError('网络请求失败，请稍后重试');
            }
        })
        .finally(function () {
            session._sysInfoFetchPromise = null;
        });
    return session._sysInfoFetchPromise;
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
    if (!session || !session.sshInfo || session._serverInfoNetWanted) return;
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
    document.getElementById('scriptDrawer').classList.toggle('open');
    setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) try { sessions[activeIdx].fitAddon.fit(); } catch (e) { } }, 350);
}
function toggleSftp() {
    var p = document.getElementById('sftpPanel');
    var wasOpen = p.classList.contains('open');
    p.classList.toggle('open');
    if (!wasOpen && activeIdx >= 0) sftpLoad(document.getElementById('sftpPath').value || '/');
    setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) try { sessions[activeIdx].fitAddon.fit(); } catch (e) { } }, 350);
}

// ==================== Connection Bookmarks ====================
var CBK = 'webssh_conn_bm';
var SBK = 'webssh_script_bm';
var SCAT = 'webssh_script_categories';
var SBK_UPDATED = 'webssh_script_bm_updated_at';
var scriptSearchQuery = '';
var activeScriptCategory = '';
var scriptSearchFrame = 0;
var scriptSearchIndex = [];
var MAX_SCRIPT_BOOKMARKS = 500;
var MAX_SCRIPT_CATEGORIES = 100;
var MAX_SCRIPT_COMMAND_CHARS = 20000;
var EMOJI_OPTIONS = ['🛠️','⚙️','🔧','🔨','🧰','💻','🖥️','⌨️','🖱️','📦','🐳','☁️','🌐','🛰️','📡','🔐','🛡️','🔑','🚀','⚡','🔥','💡','🧪','🧹','🗄️','💾','📊','📈','🔍','📝','📌','⭐','✅','🚨','🩺','🔄','⬆️','⬇️','🐧','🍎','🤖','👾','🎯','🏠','🏢','🧱','🔌','🕸️','🧭','⏱️','📁','📜','🪄','🎨','🌈','💎','❤️','💚','💙','🟣'];
var currentAccount = null;
var authMode = 'login';
var allowRegistration = false;
var accountAutoSynced = false;
var scriptSyncTimer = null;
var managedAccounts = [];
var managedAdminCount = 0;
var managedAccountPage = 1;
var managedAccountPageSize = 5;
var categoryManagerPage = 1;
var categoryManagerPageSize = 5;
var pendingDeleteCategoryId = '';
var pendingDeleteScriptIndex = -1;
var scriptManagerPreserveDrawer = false;
var editingManagedAccount = null;
var versionUpdatePollTimer = null;

function loadBM(k) { try { return JSON.parse(safeStorageGet(k)) || []; } catch (e) { return []; } }
function getScriptUpdatedAt() { return parseInt(safeStorageGet(SBK_UPDATED)) || 0; }
function setScriptUpdatedAt(ts) { safeStorageSet(SBK_UPDATED, parseInt(ts) || Date.now()); }
function saveScriptBookmarksData(v, ts) {
    safeStorageSet(SBK, JSON.stringify(v || []));
    setScriptUpdatedAt(ts || Date.now());
}
function loadScriptCategories() {
    return normalizeScriptCategories(loadBM(SCAT));
}
function saveScriptCategoriesData(v, ts) {
    safeStorageSet(SCAT, JSON.stringify(normalizeScriptCategories(v)));
    setScriptUpdatedAt(ts || Date.now());
}
function saveBM(k, v) {
    safeStorageSet(k, JSON.stringify(v));
    if (k === SBK) setScriptUpdatedAt(Date.now());
}
function ensureScriptBookmarkClock() {
    if (loadBM(SBK).length && !getScriptUpdatedAt()) setScriptUpdatedAt(Date.now());
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

function exportScriptBookmarks() {
    var scripts = loadBM(SBK);
    var categories = loadScriptCategories();
    if (!scripts.length && !categories.length) { showToast('暂无脚本或分类可导出', 'info'); return; }
    var data = {
        app: 'webssh2',
        type: 'script_bookmarks',
        version: 2,
        exportedAt: new Date().toISOString(),
        origin: location.origin,
        updatedAt: getScriptUpdatedAt(),
        categories: categories,
        scripts: scripts
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.dataset.keepScriptDrawer = '1';
    a.style.display = 'none';
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = 'webssh-script-bookmarks-' + stamp + '.json';
    preserveScriptDrawerAfterCategoryChange();
    document.body.appendChild(a);
    a.click();
    a.remove();
    preserveScriptDrawerAfterCategoryChange();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
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
    var out = [];
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
        var normalized = { name: name.slice(0, 80), cmd: cmd };
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

function mergeImportedScriptCategories(incoming) {
    var current = loadScriptCategories();
    var byId = {}, bySignature = {}, idMap = {}, added = 0, capacitySkipped = 0;
    current.forEach(function (cat) {
        byId[cat.id] = cat;
        bySignature[cat.emoji + '\n' + cat.name.toLowerCase()] = cat;
    });
    normalizeScriptCategories(incoming).forEach(function (cat) {
        var sig = cat.emoji + '\n' + cat.name.toLowerCase();
        if (bySignature[sig]) {
            idMap[cat.id] = bySignature[sig].id;
            return;
        }
        var originalId = cat.id;
        if (current.length >= MAX_SCRIPT_CATEGORIES) {
            idMap[originalId] = '';
            capacitySkipped++;
            return;
        }
        if (byId[cat.id]) cat.id = createScriptCategoryId();
        idMap[originalId] = cat.id;
        current.push(cat);
        byId[cat.id] = cat;
        bySignature[sig] = cat;
        added++;
    });
    return { categories: current, idMap: idMap, added: added, capacitySkipped: capacitySkipped };
}

function importScriptBookmarks(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        try {
            var data = JSON.parse(reader.result);
            var categoryMerge = mergeImportedScriptCategories(extractImportedCategories(data));
            var validCategoryIds = {};
            categoryMerge.categories.forEach(function (cat) { validCategoryIds[cat.id] = true; });
            var incoming = normalizeImportedScripts(extractImportedScripts(data));
            incoming.forEach(function (script) {
                if (!script.categoryId) return;
                script.categoryId = categoryMerge.idMap[script.categoryId] || script.categoryId;
                if (!validCategoryIds[script.categoryId]) delete script.categoryId;
            });
            if (!incoming.length && !categoryMerge.added) { showToast('未找到可导入的脚本书签或分类', 'error'); return; }
            var current = loadSortedScriptBookmarks();
            var seen = {};
            current.forEach(function (b) { seen[scriptBookmarkKey(b)] = true; });
            var added = 0, skipped = 0, capacitySkipped = 0;
            incoming.forEach(function (b) {
                var key = scriptBookmarkKey(b);
                if (seen[key]) { skipped++; return; }
                if (current.length >= MAX_SCRIPT_BOOKMARKS) { capacitySkipped++; return; }
                current.push(b);
                seen[key] = true;
                added++;
            });
            var cleaned = cleanScriptCategoryReferences(current, categoryMerge.categories);
            var now = Date.now();
            if (added || cleaned) {
                sortScriptBookmarks(current);
                saveScriptBookmarksData(current, now);
            }
            if (categoryMerge.added) saveScriptCategoriesData(categoryMerge.categories, now);
            renderScriptBookmarks();
            renderCategoryManager();
            updateScriptManagerSummary();
            if (added || categoryMerge.added || cleaned) syncLocalScriptsIfLogged();
            var message = '已导入 ' + added + ' 个脚本、' + categoryMerge.added + ' 个分类';
            if (!added && !categoryMerge.added) message = '没有新增内容，跳过 ' + skipped + ' 个重复脚本';
            if (capacitySkipped || categoryMerge.capacitySkipped) {
                message += '；容量已满，另跳过 ' + capacitySkipped + ' 个脚本、' + categoryMerge.capacitySkipped + ' 个分类';
            }
            showToast(message, (added || categoryMerge.added) ? 'success' : 'info');
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
        adminBtn.classList.toggle('show', !!(currentAccount && currentAccount.isAdmin));
    }
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
            if (!r.ok || data.ok === false) throw data;
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

function submitAuthForm() {
    var username = document.getElementById('authUsername').value.trim();
    var password = document.getElementById('authPassword').value;
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) { showToast('用户名只能使用 5-32 位字母或数字', 'error'); return; }
    if (!validateAccountPasswordInput(password, '密码')) return;
    var path = authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    apiJSON(path, { method: 'POST', body: { username: username, password: password } })
        .then(function (res) {
            currentAccount = {
                username: res.data && res.data.username ? res.data.username : username.toLowerCase(),
                isAdmin: !!(res.data && res.data.isAdmin)
            };
            accountAutoSynced = false;
            updateAccountUI();
            hideAuthModal();
            showToast((authMode === 'register' ? '注册成功' : '登录成功') + '，正在同步书签...', 'success');
            syncScriptBookmarks('auto');
        })
        .catch(function (err) { showToast(err.msg || '登录失败', 'error'); });
}

function logoutAccount() {
    apiJSON('/api/auth/logout', { method: 'POST' })
        .then(function () {
            currentAccount = null;
            accountAutoSynced = false;
            updateAccountUI();
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
                currentAccount = null;
                updateAccountUI();
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
    apiJSON('/api/auth/me')
        .then(function (res) {
            var d = res.data || {};
            currentAccount = d.loggedIn ? { username: d.username, isAdmin: !!d.isAdmin } : null;
            updateAccountUI();
            if (currentAccount && !accountAutoSynced) {
                accountAutoSynced = true;
                syncScriptBookmarks('auto', true);
            }
        })
        .catch(function () {
            currentAccount = null;
            updateAccountUI();
        });
}

function normalizeCloudScripts(items) {
    return normalizeImportedScripts(Array.isArray(items) ? items : []);
}

function syncScriptBookmarks(mode, silent) {
    mode = mode || 'auto';
    if (!currentAccount || !currentAccount.username) {
        openAuthModal('login');
        showToast('请先登录账号再同步云端书签', 'info');
        return;
    }
    if (!silent) setCloudStatus('正在同步书签...', '');
    var payload = {
        mode: mode,
        scripts: loadSortedScriptBookmarks(),
        categories: loadScriptCategories(),
        updatedAt: getScriptUpdatedAt()
    };
    apiJSON('/api/scripts/sync', { method: 'POST', body: payload })
        .then(function (res) {
            var d = res.data || {};
            var scripts = normalizeCloudScripts(d.scripts);
            var categories = Array.isArray(d.categories) ? normalizeScriptCategories(d.categories) : loadScriptCategories();
            cleanScriptCategoryReferences(scripts, categories);
            if (Array.isArray(d.categories)) saveScriptCategoriesData(categories, d.updatedAt || Date.now());
            var merged = mergeScriptBookmarksIncremental(scripts, d.updatedAt || Date.now(), d.mode === 'pull' || d.mode === 'push');
            if (cleanScriptCategoryReferences(merged.scripts, categories)) saveScriptBookmarksData(merged.scripts, d.updatedAt || Date.now());
            renderScriptBookmarks();
            renderCategoryManager();
            updateScriptManagerSummary();
            updateAccountUI();
            var msg = '书签已是最新';
            if (d.mode === 'push') msg = '本地书签已同步到云端';
            else if (d.mode === 'pull') msg = '云端书签已同步到本地';
            if (merged.added) msg += '，新增 ' + merged.added + ' 个';
            var categoryCount = categories.length;
            var detail = merged.scripts.length + ' 个脚本 · ' + categoryCount + ' 个分类';
            if (!silent) setCloudStatus(msg + ' · ' + detail, 'synced', 3500);
            if (!silent) showToast(msg + '（' + detail + '）', 'success');
        })
        .catch(function (err) {
            if (!silent) setCloudStatus('同步失败：' + (err.msg || '请稍后重试'), 'warn', 5000);
            if (!silent) showToast(err.msg || '同步失败', 'error');
        });
}

function syncLocalScriptsIfLogged() {
    if (!currentAccount || !currentAccount.username) return;
    if (scriptSyncTimer) clearTimeout(scriptSyncTimer);
    scriptSyncTimer = setTimeout(function () {
        scriptSyncTimer = null;
        syncScriptBookmarks('push', true);
    }, 350);
}

function setVersionStatus(text, cls) {
    var el = document.getElementById('updateVersionStatus');
    if (!el) return;
    el.className = 'update-version-status' + (cls ? ' ' + cls : '');
    el.textContent = text;
}

function setVersionLabels(data) {
    data = data || {};
    var cur = document.getElementById('currentVersionLabel');
    var remote = document.getElementById('remoteVersionLabel');
    function clean(v, fallback) {
        v = (v == null ? '' : String(v)).trim();
        return /^\d+(?:\.\d+){1,3}$/.test(v) ? v : fallback;
    }
    var current = clean(data.currentVersion || data.current, '0.5.43');
    var latest = clean(data.latestVersion || data.latest, current);
    if (cur) cur.textContent = current;
    if (remote) remote.textContent = latest;
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
    setVersionStatus('正在检测远端版本...', '');
    apiJSON('/api/admin/version')
        .then(function (res) {
            var data = res.data || {};
            setVersionLabels(data);
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

function stopVersionUpdatePolling() {
    if (versionUpdatePollTimer) {
        clearInterval(versionUpdatePollTimer);
        versionUpdatePollTimer = null;
    }
}

function pollVersionUpdateStatus(updater) {
    stopVersionUpdatePolling();
    var startedAt = Date.now();
    function tick() {
        apiJSON('/api/admin/update/status?updater=' + encodeURIComponent(updater || ''))
            .then(function (res) {
                var data = res.data || {};
                var logs = compactUpdateLog(data.logs);
                if (data.success) {
                    stopVersionUpdatePolling();
                    setVersionStatus('更新完成，正在刷新页面...' + (logs ? ' · ' + logs : ''), 'ok');
                    showToast('更新完成，正在刷新页面', 'success');
                    setTimeout(function () { location.reload(); }, 5000);
                    return;
                }
                if (data.failed) {
                    stopVersionUpdatePolling();
                    setVersionStatus('更新失败：' + (logs || data.error || '请查看 Docker 日志'), 'err');
                    showToast('更新失败，已显示日志末尾', 'error');
                    return;
                }
                setVersionStatus('更新进行中...' + (logs ? ' · ' + logs : ''), 'warn');
            })
            .catch(function (err) {
                if (Date.now() - startedAt > 240000) {
                    stopVersionUpdatePolling();
                    setVersionStatus((err && err.msg) || '更新状态读取失败，请稍后手动刷新页面', 'warn');
                    return;
                }
                setVersionStatus('更新中，服务可能正在重启，稍后自动刷新...', 'warn');
            });
    }
    tick();
    versionUpdatePollTimer = setInterval(tick, 5000);
    setTimeout(function () { location.reload(); }, 300000);
}

function runVersionUpdate() {
    if (!requireAdminForUpdate()) return;
    var force = !!document.getElementById('forceUpdateVersion').checked;
    stopVersionUpdatePolling();
    setVersionStatus(force ? '正在启动强制更新任务，请稍候...' : '正在启动更新任务，请稍候...', 'warn');
    apiJSON('/api/admin/update', { method: 'POST', body: { force: force } })
        .then(function (res) {
            var updater = res.data && res.data.updater ? res.data.updater : '';
            setVersionStatus((res.msg || '更新任务已启动') + '。正在跟踪构建日志...', 'warn');
            showToast(res.msg || '更新任务已启动', 'success');
            pollVersionUpdateStatus(updater);
        })
        .catch(function (err) {
            if (!err || !err.msg) {
                setVersionStatus('更新请求已发出，Docker 可能正在重启或构建中。页面会稍后自动刷新。', 'warn');
                showToast('Docker 可能正在重启或构建中，请稍后刷新', 'info');
                setTimeout(function () { location.reload(); }, 180000);
                return;
            }
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
    if (at === 'password') bm.password = document.getElementById('password').value;
    var bms = loadBM(CBK), idx = bms.findIndex(function (b) { return b.hostname === h && b.port === p && b.username === u; });
    if (idx >= 0) bms[idx] = bm; else bms.push(bm);
    saveBM(CBK, bms); renderConnBookmarks(); showToast('已保存', 'success');
}

function applyConn(i) {
    var b = loadBM(CBK)[i]; if (!b) return;
    var hp = parseHostPortInput(b.hostname, b.port);
    document.getElementById('hostname').value = formatHostForInput(hp.host);
    document.getElementById('port').value = hp.port;
    document.getElementById('username').value = b.username || 'root';
    if (b.authType === 'key') switchAuthTab('key');
    else { switchAuthTab('password'); if (b.password) document.getElementById('password').value = b.password; }
    showToast('已填入', 'info');
}

function delConn(i) { var bms = loadBM(CBK); bms.splice(i, 1); saveBM(CBK, bms); renderConnBookmarks(); showToast('已删除', 'info'); }

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

function scriptBookmarkKey(b) {
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
    if (sortScriptBookmarks(bms)) safeStorageSet(SBK, JSON.stringify(bms));
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
    PRESET_SCRIPTS.forEach(function (p, i) {
        scriptSearchIndex.push({ type: 'preset', index: i, search: normalizeScriptSearchText((p.name || '') + ' ' + (p.cmd || '')) });
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
        html += PRESET_SCRIPTS.map(function (p, i) { return presetScriptItemHtml(p, i); }).join('');
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
        saveScriptBookmarksData(incoming, updatedAt || Date.now());
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
        saveScriptBookmarksData(current, updatedAt || Date.now());
    }
    rebuildScriptSearchIndex(current);
    return { scripts: current, added: added.length, capacitySkipped: capacitySkipped };
}

function runPresetScript(i) {
    var preset = PRESET_SCRIPTS[i];
    if (!preset) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    sessions[activeIdx].ws.send(preset.cmd + '\n');
    showToast('已执行: ' + preset.name, 'success');
    sessions[activeIdx].term.focus();
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
    ['editScriptIndex','editScriptName','editScriptContent','editScriptCategory'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = id === 'editScriptIndex' ? '-1' : '';
    });
}

function saveEditedScriptBookmark() {
    var idx = parseInt(document.getElementById('editScriptIndex').value, 10);
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
        if (!bms[idx]) { hideEditScriptModal(); return; }
        item = Object.assign({}, bms[idx], item);
        if (!categoryId) delete item.categoryId;
        bms[idx] = item;
    } else {
        if (bms.length >= MAX_SCRIPT_BOOKMARKS) { showToast('脚本数量已达到 ' + MAX_SCRIPT_BOOKMARKS + ' 个上限', 'error'); return; }
        bms.push(item);
    }
    sortScriptBookmarks(bms);
    saveBM(SBK, bms);
    hideEditScriptModal();
    renderScriptBookmarks();
    updateScriptManagerSummary();
    syncLocalScriptsIfLogged();
    showToast(editing ? '脚本已更新' : '脚本已添加', 'success');
}

function saveScriptBookmark() {
    openAddScriptModal();
}

function runScript(i) {
    var bms = loadSortedScriptBookmarks();
    var b = bms[i]; if (!b) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    sessions[activeIdx].ws.send(b.cmd + '\n');
    b = Object.assign({}, b, { useCount: parseScriptUseCount(b) + 1, lastUsed: Date.now() });
    bms.splice(i, 1);
    bms.unshift(b);
    saveBM(SBK, bms);
    renderScriptBookmarks();
    syncLocalScriptsIfLogged();
    showToast('已执行: ' + b.name, 'success');
    sessions[activeIdx].term.focus();
}

function delScript(i) {
    var bms = loadSortedScriptBookmarks();
    var bookmark = bms[i];
    if (!bookmark) return;
    pendingDeleteScriptIndex = i;
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
}

function confirmDelScript() {
    var i = pendingDeleteScriptIndex;
    if (i < 0) return;
    var bms = loadSortedScriptBookmarks();
    if (!bms[i]) { hideScriptDeleteModal(); return; }
    bms.splice(i, 1);
    saveBM(SBK, bms);
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
    el.innerHTML = '<span><b>' + scriptCount + '</b> 个脚本</span><span><b>' + categoryCount + '</b> 个分类</span><span>' + (currentAccount ? ('已登录 ' + esc(currentAccount.username)) : '仅保存在本机') + '</span>';
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
    if (drawer) drawer.classList.add('open');
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
    saveScriptCategoriesData(categories);
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
    var now = Date.now();
    saveScriptCategoriesData(categories, now);
    if (affected) saveScriptBookmarksData(bms, now);
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
function sftpLoad(path) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var sshInfo = sessions[activeIdx].sshInfo;
    sftpCurrentPath = path;
    document.getElementById('sftpPath').value = path;
    document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">加载中...</div>';
    fetch('/file/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sshInfo: sshInfo, path: path }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg !== 'success') { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">' + esc(d.Msg) + '</div>'; return; }
            var list = (d.Data && d.Data.list) || [];
            if (!list.length) { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">空目录</div>'; return; }
            document.getElementById('sftpBody').innerHTML = list.map(function (f) {
                var isDir = f.IsDir;
                var fp = (path === '/' ? '/' : path + '/') + f.Name;
                var fpArg = escAttr(JSON.stringify(fp));
                var icon = isDir ? '<svg class="sftp-icon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : '<svg class="sftp-icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
                var click = isDir ? 'onclick="sftpLoad(' + fpArg + ')"' : 'onclick="sftpDownload(' + fpArg + ')"';
                var dl = isDir ? '' : '<button class="sftp-dl" onclick="event.stopPropagation();sftpDownload(' + fpArg + ')" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>';
                return '<div class="sftp-row" ' + click + '>' + icon + '<span class="sftp-name">' + esc(f.Name) + '</span><span class="sftp-meta">' + esc(f.Size) + '</span>' + dl + '</div>';
            }).join('');
        })
        .catch(function () { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">加载失败</div>'; });
}

function sftpGo() { sftpLoad(document.getElementById('sftpPath').value.trim() || '/'); }
function sftpUp() { var p = sftpCurrentPath.replace(/\/$/, ''); var i = p.lastIndexOf('/'); sftpLoad(i <= 0 ? '/' : p.substring(0, i)); }

function sftpDownload(path) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var sshInfo = sessions[activeIdx].sshInfo;
    showToast('正在准备下载...', 'info');
    fetch('/file/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sshInfo: sshInfo, path: path })
    }).then(function (response) {
        if (!response.ok) return response.json().then(function (data) { throw new Error(data.Msg || '下载失败'); });
        return response.blob().then(function (blob) { return { blob: blob, disposition: response.headers.get('Content-Disposition') || '' }; });
    }).then(function (result) {
        var filename = String(path || '').split('/').pop() || 'download';
        var match = /filename(?:\*=UTF-8''|=)\"?([^\";]+)/i.exec(result.disposition);
        if (match && match[1]) { try { filename = decodeURIComponent(match[1]); } catch (e) { filename = match[1]; } }
        var objectURL = URL.createObjectURL(result.blob);
        var link = document.createElement('a');
        link.href = objectURL; link.download = filename; document.body.appendChild(link); link.click(); link.remove();
        setTimeout(function () { URL.revokeObjectURL(objectURL); }, 1000);
    }).catch(function (err) { showToast(err.message || '下载失败', 'error'); });
}

function normalizeSftpDir(path) {
    path = String(path || '').trim();
    if (!path) return '/';
    path = path.replace(/\\/g, '/').replace(/\/+/g, '/');
    if (path[0] !== '/') path = '/' + path;
    if (path.length > 1) path = path.replace(/\/+$/, '');
    return path || '/';
}

function showSftpRemoteModal() {
    if (activeIdx < 0 || !sessions[activeIdx]) { showToast('无活动连接', 'error'); return; }
    var modal = document.getElementById('sftpRemoteModal');
    if (!modal) return;
    document.getElementById('sftpRemoteUrl').value = '';
    document.getElementById('sftpRemoteName').value = '';
    document.getElementById('sftpRemotePath').value = normalizeSftpDir(sftpCurrentPath || document.getElementById('sftpPath').value || '/');
    document.getElementById('sftpRemoteStatus').textContent = '';
    var btn = document.getElementById('sftpRemoteSubmit');
    if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
    modal.classList.add('show');
    setTimeout(function () { var el = document.getElementById('sftpRemoteUrl'); if (el) el.focus(); }, 80);
}

function hideSftpRemoteModal() {
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
    if (activeIdx < 0 || !sessions[activeIdx]) { showToast('无活动连接', 'error'); return; }
    var url = document.getElementById('sftpRemoteUrl').value.trim();
    var filename = document.getElementById('sftpRemoteName').value.trim();
    var path = normalizeSftpDir(document.getElementById('sftpRemotePath').value);
    if (!url) { setSftpRemoteStatus('请先填写下载链接', 'error'); return; }
    var btn = document.getElementById('sftpRemoteSubmit');
    if (btn) { btn.disabled = true; btn.textContent = '下载中...'; }
    setSftpRemoteStatus('正在远程下载到 ' + path + '，请稍等...', 'info');
    var fd = new FormData();
    fd.append('sshInfo', sessions[activeIdx].sshInfo);
    fd.append('url', url);
    fd.append('filename', filename);
    fd.append('path', path);
    fetch('/file/remote', { method: 'POST', body: fd })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg === 'success') {
                var saved = d.Data && d.Data.path ? d.Data.path : path;
                setSftpRemoteStatus('下载完成：' + saved, 'success');
                showToast('远程下载完成', 'success');
                sftpLoad(path);
                setTimeout(hideSftpRemoteModal, 800);
            } else {
                setSftpRemoteStatus(d.Msg || '下载失败', 'error');
                showToast('远程下载失败', 'error');
            }
        })
        .catch(function () {
            setSftpRemoteStatus('网络请求失败', 'error');
            showToast('远程下载失败', 'error');
        })
        .finally(function () {
            if (btn) { btn.disabled = false; btn.textContent = '开始下载'; }
        });
}

function showSftpDirPicker() {
    if (activeIdx < 0 || !sessions[activeIdx]) { showToast('无活动连接', 'error'); return; }
    var modal = document.getElementById('sftpDirModal');
    if (!modal) return;
    sftpDirPickerPath = normalizeSftpDir(document.getElementById('sftpRemotePath').value || sftpCurrentPath);
    modal.classList.add('show');
    sftpDirLoad(sftpDirPickerPath);
}

function hideSftpDirPicker() {
    var modal = document.getElementById('sftpDirModal');
    if (modal) modal.classList.remove('show');
}

function sftpDirLoad(path) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    path = normalizeSftpDir(path);
    sftpDirPickerPath = path;
    var pathInput = document.getElementById('sftpDirPath');
    var listEl = document.getElementById('sftpDirList');
    if (pathInput) pathInput.value = path;
    if (!listEl) return;
    listEl.innerHTML = '<div class="sftp-loading">加载中...</div>';
    fetch('/file/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sshInfo: sessions[activeIdx].sshInfo, path: path }) })
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg !== 'success') { listEl.innerHTML = '<div class="sftp-loading" style="color:var(--err)">' + esc(d.Msg) + '</div>'; return; }
            var list = ((d.Data && d.Data.list) || []).filter(function (f) { return f.IsDir; });
            var rows = [];
            if (path !== '/') rows.push('<button type="button" class="sftp-dir-row up" onclick="sftpDirUp()">.. 上级目录</button>');
            rows = rows.concat(list.map(function (f) {
                var fp = (path === '/' ? '/' : path + '/') + f.Name;
                return '<button type="button" class="sftp-dir-row" onclick="sftpDirLoad(' + escAttr(JSON.stringify(fp)) + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg><span>' + esc(f.Name) + '</span></button>';
            }));
            listEl.innerHTML = rows.join('') || '<div class="sftp-loading">没有子目录</div>';
        })
        .catch(function () { listEl.innerHTML = '<div class="sftp-loading" style="color:var(--err)">加载失败</div>'; });
}

function sftpDirGo() {
    sftpDirLoad(document.getElementById('sftpDirPath').value);
}

function sftpDirUp() {
    var p = normalizeSftpDir(sftpDirPickerPath).replace(/\/$/, '');
    var i = p.lastIndexOf('/');
    sftpDirLoad(i <= 0 ? '/' : p.substring(0, i));
}

function confirmSftpDirPicker() {
    document.getElementById('sftpRemotePath').value = normalizeSftpDir(sftpDirPickerPath);
    hideSftpDirPicker();
}

function sftpUpload() {
    var input = document.getElementById('sftpUploadInput');
    if (!input.files.length || activeIdx < 0) return;
    var sshInfo = sessions[activeIdx].sshInfo;
    Array.from(input.files).forEach(function (f, index) {
        var fd = new FormData();
        var uploadId = window.crypto && typeof window.crypto.randomUUID === 'function'
            ? window.crypto.randomUUID()
            : Date.now().toString(36) + '_' + index + '_' + Math.random().toString(36).slice(2);
        fd.append('file', f); fd.append('sshInfo', sshInfo); fd.append('path', sftpCurrentPath); fd.append('id', uploadId);
        fetch('/file/upload', { method: 'POST', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.Msg === 'success') { showToast('上传成功: ' + f.name, 'success'); sftpLoad(sftpCurrentPath); } else showToast('上传失败', 'error'); })
            .catch(function () { showToast('上传失败', 'error'); });
    });
    input.value = '';
}

document.getElementById('sftpPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') sftpGo(); });
document.getElementById('sftpDirPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') sftpDirGo(); });

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
        if (text && sessions[activeIdx].ws && sessions[activeIdx].ws.readyState === 1) {
            sessions[activeIdx].ws.send(text);
            sessions[activeIdx].term.focus();
        }
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
    session.term.onSelectionChange(function () {
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
    sessions[activeIdx].ws.send(text + '\n');
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
    try { s.fitAddon.fit(); } catch (e) { }
    if (s.ws && s.ws.readyState === 1) s.ws.send('resize:' + s.term.rows + ':' + s.term.cols);
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
            setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) try { sessions[activeIdx].fitAddon.fit(); } catch (ex) { } }, 350);
        }
    }
    // Close SFTP panel
    var sftpPanel = document.getElementById('sftpPanel');
    if (sftpPanel && sftpPanel.classList.contains('open')) {
        if (!sftpPanel.contains(e.target) && !(termEdge && termEdge.contains(e.target)) && e.target.closest('.term-body')) {
            sftpPanel.classList.remove('open');
            setTimeout(function () { if (activeIdx >= 0 && sessions[activeIdx]) try { sessions[activeIdx].fitAddon.fit(); } catch (ex) { } }, 350);
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

    // Restart polling for all active sessions
    sessions.forEach(function (s) {
        if (s.sysInfoTimer) {
            clearInterval(s.sysInfoTimer);
            s.sysInfoTimer = setInterval(function () { fetchSysInfoFor(s); }, _sysIntervalTemp * 1000);
        }
    });
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
            if (s.sysInfoTimer) {
                clearInterval(s.sysInfoTimer);
                s.sysInfoTimer = null;
            }
            if (s.sysInfoStartTimer) {
                clearTimeout(s.sysInfoStartTimer);
                s.sysInfoStartTimer = null;
            }
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
        if (s.sysInfoTimer) {
            clearInterval(s.sysInfoTimer);
            s.sysInfoTimer = null;
        }
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
    return parseUrlLoginFragment(location.hash) || parseUrlLoginPath(location.pathname);
}

function tryAutoLogin() {
    var info = parseUrlLogin();
    if (!info) return;

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
initTheme();
initSettings();
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
    function applyServerConfig(cfg) {
        allowRegistration = !!(cfg && cfg.allowRegistration);
        var registerTab = document.getElementById('authRegisterTab');
        if (registerTab) registerTab.style.display = allowRegistration ? '' : 'none';
        if (!allowRegistration && authMode === 'register') switchAuthMode('login');
        if (cfg && cfg.showFooter === false) {
            var footer = document.querySelector('.global-footer');
            if (footer) footer.classList.add('server-hidden');
        }
    }

    var req = new XMLHttpRequest();
    req.open('GET', '/config', true);
    req.timeout = 3000;
    req.onload = function () {
        if (req.status === 200) {
            try { applyServerConfig(JSON.parse(req.responseText)); } catch (e) {}
        }
        if (window.__dismissSplash) window.__dismissSplash();
    };
    req.onerror = req.ontimeout = function () {
        if (window.__dismissSplash) window.__dismissSplash();
    };
    req.send();
})();
