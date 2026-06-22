/* ============================================================
   WebSSH v5 - Multi-tab, SFTP, Dual Bookmarks
   ============================================================ */

// ==================== State ====================
var sessions = [];
var activeIdx = -1;
var sftpCurrentPath = '/';
var serverInfoModalIdx = -1;
var serverInfoTimer = null;
var serverInfoSelectedIface = {};
var serverInfoDetailType = null;
var TOPBAR_METRICS_KEY = 'webssh_topbar_metrics';
var FIRST_SSH_SUCCESS_KEY = 'webssh_first_ssh_success_seen';
var NET_UNIT_KEY = 'webssh_server_net_unit';
var serverInfoNetUnit = (function () {
    try { return localStorage.getItem(NET_UNIT_KEY) === 'bits' ? 'bits' : 'bytes'; } catch (e) { return 'bytes'; }
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
function esc(s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function fmtB(b) { b = parseInt(b) || 0; if (!b) return '0B'; var u = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(b) / Math.log(1024)); return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + u[i]; }
function pct(u, t) { return Math.round((parseInt(u) || 0) / (parseInt(t) || 1) * 100); }
function pillCls(v) { return v >= 90 ? 'danger' : v >= 70 ? 'warn' : ''; }

function showToast(msg, type) {
    type = type || 'info';
    var c = document.getElementById('toastContainer');
    var icons = { success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>', error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>', info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>' };
    var d = document.createElement('div');
    d.className = 'toast ' + type;
    d.innerHTML = (icons[type] || icons.info) + '<span>' + msg + '</span>';
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
        localStorage.setItem(PROXY_KEY, JSON.stringify(cfg));
        showToast('代理配置已保存', 'success');
    } else {
        localStorage.removeItem(PROXY_KEY);
    }
}

function loadProxyConfig() {
    try {
        var cfg = JSON.parse(localStorage.getItem(PROXY_KEY));
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

// ==================== Build SSH Info ====================
function buildSSHInfoFromForm() {
    var at = document.querySelector('.auth-tab.active').dataset.tab;
    var info = {
        hostname: document.getElementById('hostname').value.trim(),
        port: parseInt(document.getElementById('port').value) || 22,
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
    var info = { hostname: host, port: parseInt(port) || 22, username: user || 'root', logintype: 0, password: pass || '' };
    var proxy = getProxyInfo();
    if (proxy.proxyHost) { info.proxyHost = proxy.proxyHost; info.proxyPort = proxy.proxyPort; info.proxyUser = proxy.proxyUser; info.proxyPass = proxy.proxyPass; }
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

// ==================== Multi-Tab Session Management ====================
function createSession(hostname, port, username, sshInfo) {
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
        fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace",
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
        heartbeat: null, sysInfoTimer: null, resizeObs: null
    };

    session.resizeObs = new ResizeObserver(function () { try { fa.fit(); } catch (e) { } });
    session.resizeObs.observe(termDiv);

    sessions.push(session);
    return session;
}

function switchTab(idx) {
    if (idx < 0 || idx >= sessions.length) return;
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
}

function renderTabs() {
    var bar = document.getElementById('tabBar');
    var addBtn = '<button class="tab-add-btn" onclick="event.stopPropagation();showAddTab()" title="新建连接">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>';
    bar.innerHTML = sessions.map(function (s, i) {
        var cls = i === activeIdx ? 'ssh-tab active' : 'ssh-tab';
        return '<div class="' + cls + '" onclick="switchTab(' + i + ')">' +
            '<span class="tab-ip" onclick="event.stopPropagation();switchTab(' + i + ');copyIP(sessions[' + i + '].hostname)" title="点击复制 IP">' + esc(s.hostname) + '</span>' +
            '<button class="tab-info" onclick="event.stopPropagation();openServerInfoModal(' + i + ')" title="服务器详情">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="10" x2="12" y2="16"/><circle cx="12" cy="7" r="1"/></svg></button>' +
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
    try { return localStorage.getItem(TOPBAR_METRICS_KEY) === 'true'; } catch (e) { return false; }
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
    fetchSysInfoFor(session);
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
function connectSession(session) {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var cols = session.term.cols, rows = session.term.rows;
    var wsUrl = proto + '//' + location.host + '/term?cols=' + cols + '&rows=' + rows;
    var ws = new WebSocket(wsUrl);
    session.ws = ws;
    var got = false;

    ws.onopen = function () { ws.send(session.sshInfo); };

    ws.onmessage = function (e) {
        if (!got) {
            got = true;
            showToast(session.hostname + ' 连接成功', 'success');
            setupAutoCopy(session);
            maybeShowFirstServerInfoGuide(session);
            session.heartbeat = setInterval(function () { if (ws.readyState === 1) ws.send('ping'); }, 30000);
            startTopbarMetricsPolling(session);
        }
        session.term.write(e.data);
    };

    ws.onerror = function () { showToast(session.hostname + ' 连接失败', 'error'); };
    ws.onclose = function () {
        if (session.heartbeat) { clearInterval(session.heartbeat); session.heartbeat = null; }
        if (session.sysInfoTimer) { clearInterval(session.sysInfoTimer); session.sysInfoTimer = null; }
        if (!got) showToast(session.hostname + ' 无法连接', 'error');
    };

    session.term.onData(function (data) { if (ws.readyState === 1) ws.send(data); });

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
    var h = document.getElementById('hostname').value.trim();
    var p = parseInt(document.getElementById('port').value) || 22;
    var u = document.getElementById('username').value.trim() || 'root';

    var session = createSession(h, p, u, sshInfo);
    showView('terminalView');
    switchTab(sessions.length - 1);

    setTimeout(function () {
        try { session.fitAddon.fit(); } catch (e) { }
        connectSession(session);
        btn.classList.remove('loading');
        setStatus('', '就绪');
        renderScriptBookmarks();
    }, 300);
}

function maybeShowFirstServerInfoGuide(session) {
    try {
        if (localStorage.getItem(FIRST_SSH_SUCCESS_KEY)) return;
        localStorage.setItem(FIRST_SSH_SUCCESS_KEY, String(Date.now()));
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
    if (s.resizeObs) s.resizeObs.disconnect();
    if (s._resizeHandler) removeEventListener('resize', s._resizeHandler);
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
    showToast('重新连接 ' + s.hostname + '...', 'info');
    setTimeout(function () { connectSession(s); }, 300);
}

function showAddTab() { document.getElementById('addTabModal').classList.add('show'); document.getElementById('newTabHost').focus(); }
function hideAddTab() { document.getElementById('addTabModal').classList.remove('show'); }

function addNewTab() {
    var h = document.getElementById('newTabHost').value.trim();
    var p = document.getElementById('newTabPort').value || '22';
    var u = document.getElementById('newTabUser').value.trim() || 'root';
    var pw = document.getElementById('newTabPass').value;
    if (!h) { showToast('请输入主机地址', 'error'); return; }
    var sshInfo = buildSSHInfoDirect(h, p, u, pw);
    var session = createSession(h, parseInt(p), u, sshInfo);
    switchTab(sessions.length - 1);
    hideAddTab();
    setTimeout(function () {
        try { session.fitAddon.fit(); } catch (e) { }
        connectSession(session);
    }, 300);
}

// ==================== System Info ====================
function fetchSysInfoFor(session) {
    if (!session.sshInfo) return;
    return fetch('/sysinfo?sshInfo=' + encodeURIComponent(session.sshInfo))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg === 'success' && d.Data) {
                session._lastMetrics = d.Data;
                recordNetworkSample(session, d.Data);
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
        });
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
        return '<div class="metric-pill' + cls + '">' + (sv[p.i] || '') + p.l + (p.v ? ' <span class="metric-value">' + p.v + '</span>' : '') + '</div>';
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
    try { localStorage.setItem(NET_UNIT_KEY, serverInfoNetUnit); } catch (e) { }
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
        if (session._netHistory[name].length > 600) session._netHistory[name].shift();
    }
    if (ifaces.length) {
        ifaces.forEach(function (n) { push(n.name, n.rxRate, n.txRate); });
    } else {
        push(d.mainIface || '__main__', d.rxRate, d.txRate);
    }
}

function getNetworkHistory(session, ifaceName) {
    if (!session || !session._netHistory) return [];
    return session._netHistory[ifaceName] || session._netHistory.__main__ || [];
}

function netPointX(item, idx, items, width, pad, domainStart, domainEnd) {
    if (domainEnd > domainStart && item && item.t) {
        var ratio = (item.t - domainStart) / (domainEnd - domainStart);
        ratio = Math.max(0, Math.min(1, ratio));
        return pad + ratio * (width - pad * 2);
    }
    var span = Math.max(1, items.length - 1);
    return pad + (idx / span) * (width - pad * 2);
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
    return height - pad - ((parseFloat(item[key]) || 0) / max) * (height - pad * 2);
}

function buildNetArea(path, items, width, height, pad, domainStart, domainEnd) {
    if (!path || !items.length) return '';
    var firstX = netPointX(items[0], 0, items, width, pad, domainStart, domainEnd);
    var lastX = netPointX(items[items.length - 1], items.length - 1, items, width, pad, domainStart, domainEnd);
    return path + ' L' + lastX + ' ' + (height - pad) + ' L' + firstX + ' ' + (height - pad) + ' Z';
}

function buildNetLabels(items, key, max, width, height, pad, domainStart, domainEnd, cls) {
    if (!items.length) return '';
    var labelLimit = Math.max(8, Math.floor((width - pad * 2) / 54));
    var step = Math.max(1, Math.ceil(items.length / labelLimit));
    var seen = {};
    var picked = [];
    function pick(idx) {
        if (idx < 0 || idx >= items.length || seen[idx]) return;
        seen[idx] = true;
        picked.push(idx);
    }
    for (var i = 0; i < items.length; i += step) pick(i);
    pick(items.length - 1);
    if (step > 1) {
        for (var j = 1; j < items.length - 1; j++) {
            var prev = parseFloat(items[j - 1][key]) || 0;
            var cur = parseFloat(items[j][key]) || 0;
            var next = parseFloat(items[j + 1][key]) || 0;
            if ((cur >= prev && cur > next) || (cur > prev && cur >= next) || (cur <= prev && cur < next) || (cur < prev && cur <= next)) pick(j);
        }
    }
    picked.sort(function (a, b) { return a - b; });
    var lastX = -Infinity;
    var minGap = items.length <= labelLimit ? 0 : 42;
    return picked.map(function (idx) {
        var item = items[idx];
        var value = parseFloat(item[key]) || 0;
        var x = netPointX(item, idx, items, width, pad, domainStart, domainEnd);
        if (x - lastX < minGap && idx !== items.length - 1) return '';
        lastX = x;
        var label = fmtNetRate(value);
        var y = netPointY(item, key, max, height, pad) + (cls === 'rx' ? 13 : -11);
        y = Math.max(13, Math.min(height - pad - 8, y));
        var anchor = x < pad + 34 ? 'start' : (x > width - pad - 34 ? 'end' : 'middle');
        var labelWidth = Math.max(24, label.length * 5.3 + 8);
        var rectX = anchor === 'start' ? x - 3 : (anchor === 'end' ? x - labelWidth + 3 : x - labelWidth / 2);
        var rectY = y - 10;
        rectX = Math.max(2, Math.min(width - labelWidth - 2, rectX));
        rectY = Math.max(2, Math.min(height - 14, rectY));
        return '<g class="net-label-wrap ' + cls + '">' +
            '<rect class="net-label-bg ' + cls + '" x="' + rectX.toFixed(1) + '" y="' + rectY.toFixed(1) + '" width="' + labelWidth.toFixed(1) + '" height="12" rx="4"/>' +
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
            hour12: false
        }).format(new Date(ts)).replace(/\s/g, '');
    } catch (e) {
        var d = new Date(ts + 8 * 60 * 60 * 1000);
        return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
    }
}

function networkDomain(history) {
    var end = history.length && history[history.length - 1].t ? history[history.length - 1].t : Date.now();
    var first = history.length && history[0].t ? history[0].t : end;
    var rawSpan = Math.max(0, end - first);
    var span = Math.max(60 * 1000, Math.min(6 * 60 * 1000, rawSpan || 60 * 1000));
    return { start: end - span, end: end, span: span };
}

function networkSpanText(ms) {
    if (ms >= 60 * 1000) return Math.ceil(ms / 60000) + ' 分钟';
    return Math.max(1, Math.ceil(ms / 1000)) + ' 秒';
}

function networkTimeAxisHtml(domain) {
    var ticks = [domain.start];
    var firstMinute = Math.ceil(domain.start / 60000) * 60000;
    for (var t = firstMinute; t < domain.end; t += 60000) ticks.push(t);
    ticks.push(domain.end);
    if (ticks.length > 7) {
        var step = Math.ceil((ticks.length - 1) / 6);
        var compact = ticks.filter(function (_, i) { return i === 0 || i === ticks.length - 1 || i % step === 0; });
        if (compact[compact.length - 1] !== domain.end) compact.push(domain.end);
        ticks = compact;
    }
    return ticks.map(function (t, i) {
        var left = domain.end > domain.start ? ((t - domain.start) / (domain.end - domain.start)) * 100 : 0;
        left = Math.max(0, Math.min(100, left));
        var cls = 'time-tick' + (left <= 1 ? ' left-edge' : '') + (left >= 99 ? ' right-edge' : '');
        return '<span class="' + cls + '" style="left:' + left.toFixed(2) + '%">' + formatBeijingMinute(t) + '</span>';
    }).join('');
}

function networkChartHtml(session, ifaceName) {
    var history = getNetworkHistory(session, ifaceName).slice(-360);
    var domain = networkDomain(history);
    history = history.filter(function (p) { return !p.t || (p.t >= domain.start && p.t <= domain.end); });
    var width = 720, height = 210, pad = 22;
    var max = 1;
    var rxPeak = 0, txPeak = 0;
    history.forEach(function (p) {
        var rx = parseFloat(p.rx) || 0;
        var tx = parseFloat(p.tx) || 0;
        rxPeak = Math.max(rxPeak, rx);
        txPeak = Math.max(txPeak, tx);
        max = Math.max(max, rx, tx);
    });
    var rxPath = buildNetPath(history, 'rx', max, width, height, pad, domain.start, domain.end);
    var txPath = buildNetPath(history, 'tx', max, width, height, pad, domain.start, domain.end);
    var rxArea = buildNetArea(rxPath, history, width, height, pad, domain.start, domain.end);
    var txArea = buildNetArea(txPath, history, width, height, pad, domain.start, domain.end);
    var rxLabels = buildNetLabels(history, 'rx', max, width, height, pad, domain.start, domain.end, 'rx');
    var txLabels = buildNetLabels(history, 'tx', max, width, height, pad, domain.start, domain.end, 'tx');
    var empty = history.length < 2 ? '<div class="server-net-empty">等待下一次刷新后生成实时曲线</div>' : '';
    var grid = '';
    for (var gi = 0; gi <= 4; gi++) {
        var y = pad + gi * ((height - pad * 2) / 4);
        grid += '<line class="net-grid-h" x1="' + pad + '" y1="' + y.toFixed(1) + '" x2="' + (width - pad) + '" y2="' + y.toFixed(1) + '"/>';
    }
    for (var gx = 0; gx <= 6; gx++) {
        var x = pad + gx * ((width - pad * 2) / 6);
        grid += '<line class="net-grid-v" x1="' + x.toFixed(1) + '" y1="' + pad + '" x2="' + x.toFixed(1) + '" y2="' + (height - pad) + '"/>';
    }
    return '<div class="server-net-chart">' +
        '<div class="server-net-chart-head"><div><b>实时网络曲线</b><span>最近 ' + networkSpanText(domain.span) + ' · 北京时间 · 当前单位：' + (serverInfoNetUnit === 'bits' ? 'bits/s' : 'B/s') + '</span></div><div class="server-net-legend"><span class="rx">接收</span><span class="tx">发送</span></div></div>' +
        '<div class="server-net-peaks"><span class="server-net-peak rx"><em>接收峰值</em><b>' + fmtNetRate(rxPeak) + '</b></span><span class="server-net-peak tx"><em>发送峰值</em><b>' + fmtNetRate(txPeak) + '</b></span></div>' +
        '<div class="server-net-canvas">' + empty +
        '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="none" aria-hidden="true">' +
        grid +
        (rxArea ? '<path class="net-area rx" d="' + rxArea + '"/>' : '') +
        (txArea ? '<path class="net-area tx" d="' + txArea + '"/>' : '') +
        (rxPath ? '<path class="net-line rx" d="' + rxPath + '"/>' : '') +
        (txPath ? '<path class="net-line tx" d="' + txPath + '"/>' : '') +
        rxLabels +
        txLabels +
        '</svg></div>' +
        '<div class="server-net-axis">' + networkTimeAxisHtml(domain) + '</div>' +
        '</div>';
}

function fmtKb(kb) {
    return fmtB((parseFloat(kb) || 0) * 1024);
}

function fmtPct(v) {
    v = parseFloat(v) || 0;
    return v.toFixed(v >= 10 ? 0 : 1) + '%';
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
    serverInfoModalIdx = idx;
    var s = sessions[idx];
    var modal = document.getElementById('serverInfoModal');
    var title = document.getElementById('serverInfoTitle');
    var sub = document.getElementById('serverInfoSub');
    if (title) title.textContent = s.hostname;
    if (sub) sub.textContent = (s.username || 'root') + '@' + s.hostname + ':' + (s.port || 22);
    if (s._lastMetrics) renderServerInfo(s._lastMetrics, s);
    else document.getElementById('serverInfoBody').innerHTML = '<div class="server-info-loading"><span></span>正在读取服务器信息...</div>';
    modal.classList.add('show');
    restartServerInfoTimer();
}

function hideServerInfoModal() {
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
    serverInfoTimer = setInterval(refreshOpenServerInfo, getServerInfoRefreshSeconds() * 1000);
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
    var cb = d.cpuBreakdown || {};
    var procRows = (Array.isArray(d.processes) ? d.processes : []).map(function (p) {
        return '<tr><td>' + esc(p.pid) + '</td><td>' + esc(p.user) + '</td><td>' + esc(fmtKb(p.rss)) + '</td><td>' + esc(fmtPct(p.cpu)) + '</td><td title="' + esc(p.cmd || p.name) + '">' + esc(p.cmd || p.name || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="5">暂无进程数据</td></tr>';
    var fsRows = (Array.isArray(d.filesystems) ? d.filesystems : []).map(function (fs) {
        return '<tr><td title="' + esc(fs.name) + '">' + esc(fs.mount || fs.name) + '</td><td>' + esc(fmtB(fs.used)) + ' / ' + esc(fmtB(fs.size)) + '</td><td>' + esc(fmtB(fs.avail)) + '</td><td>' + esc(fs.pct || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="4">暂无文件系统数据</td></tr>';
    var titles = { network: '网络详情', processes: '进程详情', filesystems: '文件系统详情', facts: '基础信息', summary: '资源概览' };
    title.textContent = titles[type] || '服务器详情';
    if (type === 'network') {
        body.innerHTML = '<div class="server-detail-section">' +
            '<div class="server-detail-kv"><div><span>当前网卡</span><b>' + esc(ifaceName) + '</b></div><div><span>接收速度</span><b>↓ ' + fmtNetRate(rxRate) + '</b><small>' + fmtNetRateAlt(rxRate) + '</small></div><div><span>发送速度</span><b>↑ ' + fmtNetRate(txRate) + '</b><small>' + fmtNetRateAlt(txRate) + '</small></div><div><span>总接收</span><b>' + fmtB(rxTotal) + '</b></div><div><span>总发送</span><b>' + fmtB(txTotal) + '</b></div><div><span>网卡数量</span><b>' + esc(ifaces.length || 1) + '</b></div></div>' +
            networkChartHtml(session, ifaceName) + '</div>';
    } else if (type === 'processes') {
        body.innerHTML = '<div class="server-table-wrap detail-table"><table class="server-table"><thead><tr><th>PID</th><th>用户</th><th>内存</th><th>CPU</th><th>完整命令</th></tr></thead><tbody>' + procRows + '</tbody></table></div>';
    } else if (type === 'filesystems') {
        body.innerHTML = '<div class="server-table-wrap detail-table"><table class="server-table"><thead><tr><th>挂载点</th><th>已用 / 大小</th><th>可用</th><th>使用率</th></tr></thead><tbody>' + fsRows + '</tbody></table></div>';
    } else if (type === 'facts') {
        body.innerHTML = '<div class="server-info-facts detail-facts">' +
            '<div><span>操作系统</span><b>' + esc(d.os || '-') + '</b></div><div><span>内核版本</span><b>' + esc(d.kernelVersion || '-') + '</b></div>' +
            '<div><span>主机名</span><b>' + esc(d.hostname || '-') + '</b></div><div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div>' +
            '<div><span>运行时间</span><b>' + esc(fmtUptimeLong(d.uptime)) + '</b></div><div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div>' +
            '<div><span>CPU 型号</span><b>' + esc(d.cpuModel || '-') + '</b></div><div><span>CPU 核心</span><b>' + esc(d.cpuCores || '-') + '</b></div>' +
            '</div>';
    } else {
        body.innerHTML = '<div class="server-summary-grid detail-summary">' +
            '<div><span>CPU</span><b>' + cpu.toFixed(1) + '%</b><small>用户 ' + esc(cb.user || '0') + '% · 系统 ' + esc(cb.system || '0') + '% · IO ' + esc(cb.iowait || '0') + '%</small></div>' +
            '<div><span>内存</span><b>' + memPct + '%</b><small>' + fmtB(d.memUsed) + ' / ' + fmtB(d.memTotal) + '，可用 ' + fmtB(d.memAvailable || d.memFree) + '</small></div>' +
            '<div><span>Swap</span><b>' + percentOf(d.swapUsed, d.swapTotal) + '%</b><small>' + fmtB(d.swapUsed) + ' / ' + fmtB(d.swapTotal) + '</small></div>' +
            '<div><span>磁盘</span><b>' + diskPct + '%</b><small>' + fmtB(d.diskUsed) + ' / ' + fmtB(d.diskTotal) + '，剩余 ' + fmtB(d.diskFree) + '</small></div>' +
            '<div><span>连接</span><b>' + esc(connTotal) + '</b><small>TCP ' + esc(d.tcpCount || '0') + ' · UDP ' + esc(d.udpCount || '0') + '</small></div>' +
            '<div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b><small>运行 ' + esc(fmtUptimeLong(d.uptime)) + '</small></div>' +
            '</div>';
    }
}

function renderServerInfo(d, session) {
    var body = document.getElementById('serverInfoBody');
    if (!body) return;
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
        return '<option value="' + esc(n.name) + '"' + (selectedIface && n.name === selectedIface.name ? ' selected' : '') + '>' + esc(n.name) + (n.main === 'true' ? ' · 主网卡' : '') + '</option>';
    }).join('');
    var procRows = (Array.isArray(d.processes) ? d.processes : []).slice(0, 12).map(function (p) {
        return '<tr><td>' + esc(p.pid) + '</td><td>' + esc(p.user) + '</td><td>' + esc(fmtKb(p.rss)) + '</td><td>' + esc(fmtPct(p.cpu)) + '</td><td title="' + esc(p.cmd || p.name) + '">' + esc(p.name || p.cmd || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="5">暂无进程数据</td></tr>';
    var fsRows = (Array.isArray(d.filesystems) ? d.filesystems : []).slice(0, 12).map(function (fs) {
        return '<tr><td title="' + esc(fs.name) + '">' + esc(fs.mount || fs.name) + '</td><td>' + esc(fmtB(fs.used)) + '/' + esc(fmtB(fs.size)) + '</td><td>' + esc(fs.pct || '-') + '</td></tr>';
    }).join('') || '<tr><td colspan="3">暂无文件系统数据</td></tr>';
    var cb = d.cpuBreakdown || {};
    var rxRate = selectedIface ? selectedIface.rxRate : d.rxRate;
    var txRate = selectedIface ? selectedIface.txRate : d.txRate;
    var rxTotal = selectedIface ? selectedIface.rxTotal : d.rxTotal;
    var txTotal = selectedIface ? selectedIface.txTotal : d.txTotal;
    var memPct = percentOf(d.memUsed, d.memTotal);
    var connTotal = (parseInt(d.tcpCount) || 0) + (parseInt(d.udpCount) || 0);
    var netUnitToggle = '<div class="server-net-unit-toggle"><button type="button" class="' + (serverInfoNetUnit === 'bytes' ? 'active' : '') + '" onclick="event.stopPropagation();changeServerNetUnit(\'bytes\')">MB/s</button><button type="button" class="' + (serverInfoNetUnit === 'bits' ? 'active' : '') + '" onclick="event.stopPropagation();changeServerNetUnit(\'bits\')">Mbps</button></div>';
    body.innerHTML =
        '<div class="server-info-hero">' +
        '<div><div class="server-info-kicker">当前连接</div><h3 class="server-info-host-copy" onclick="copyIP(sessions[serverInfoModalIdx].hostname)" title="点击复制 IP">' + esc(session.hostname) + '</h3><p>' + esc(d.hostname || '-') + ' · ' + esc(d.os || '-') + '</p></div>' +
        '<div class="server-info-live"><span></span>每 ' + getServerInfoRefreshSeconds() + ' 秒刷新</div>' +
        '</div>' +
        '<div class="server-info-grid">' +
        '<div class="server-info-card wide server-summary-card server-expandable" onclick="openServerInfoDetailModal(\'summary\')" title="点击放大查看资源概览"><div class="server-card-open">放大</div><h4>资源概览</h4><div class="server-summary-grid">' +
        '<div><span>CPU</span><b>' + cpu.toFixed(1) + '%</b><small>' + esc(d.cpuCores || '?') + ' 核</small></div>' +
        '<div><span>内存</span><b>' + memPct + '%</b><small>' + fmtB(d.memUsed) + ' / ' + fmtB(d.memTotal) + '</small></div>' +
        '<div><span>磁盘</span><b>' + diskPct + '%</b><small>剩余 ' + fmtB(d.diskFree) + '</small></div>' +
        '<div><span>连接</span><b>' + esc(connTotal) + '</b><small>TCP ' + esc(d.tcpCount || '0') + ' · UDP ' + esc(d.udpCount || '0') + '</small></div>' +
        '</div><div class="server-info-mini">CPU：用户 ' + esc(cb.user || '0') + '% · 系统 ' + esc(cb.system || '0') + '% · IO ' + esc(cb.iowait || '0') + '%</div></div>' +
        '<div class="server-info-card wide server-facts-card server-expandable" onclick="openServerInfoDetailModal(\'facts\')" title="点击放大查看基础信息"><div class="server-card-open">放大</div><h4>基础信息</h4><div class="server-info-facts">' +
        '<div><span>操作系统</span><b>' + esc(d.os || '-') + '</b></div><div><span>内核</span><b>' + esc(d.kernelVersion || '-') + '</b></div>' +
        '<div><span>主机名</span><b>' + esc(d.hostname || '-') + '</b></div><div><span>架构</span><b>' + esc(d.arch || '-') + '</b></div>' +
        '<div><span>运行时间</span><b>' + esc(fmtUptimeLong(d.uptime)) + '</b></div><div><span>负载</span><b>' + esc(d.load || '0 0 0') + '</b></div>' +
        '</div></div>' +
        '<div class="server-info-card wide network-card server-expandable" onclick="openServerInfoDetailModal(\'network\')" title="点击放大查看网络"><div class="server-card-open">放大</div><div class="server-info-card-head network-head"><h4>网络</h4><div class="server-iface-control">' + netUnitToggle + (ifaces.length > 1 ? '<select class="server-iface-select" onclick="event.stopPropagation()" onchange="changeServerInfoIface(this.value)">' + ifaceOptions + '</select>' : '<span class="server-iface-chip">' + esc(ifaceName) + '</span>') + '</div></div>' +
        '<div class="server-net-pair"><div class="net-stat rx"><span>接收速度</span><b>↓ ' + fmtNetRate(rxRate) + '</b><small>' + fmtNetRateAlt(rxRate) + '</small></div><div class="net-stat tx"><span>发送速度</span><b>↑ ' + fmtNetRate(txRate) + '</b><small>' + fmtNetRateAlt(txRate) + '</small></div><div><span>总接收</span><b>' + fmtB(rxTotal) + '</b></div><div><span>总发送</span><b>' + fmtB(txTotal) + '</b></div></div>' + networkChartHtml(session, ifaceName) + '</div>' +
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
var SBK_UPDATED = 'webssh_script_bm_updated_at';
var currentAccount = null;
var authMode = 'login';
var accountAutoSynced = false;
var scriptSyncTimer = null;
var managedAccounts = [];
var editingManagedAccount = null;
var versionUpdatePollTimer = null;

function loadBM(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }
function getScriptUpdatedAt() { return parseInt(localStorage.getItem(SBK_UPDATED)) || 0; }
function setScriptUpdatedAt(ts) { localStorage.setItem(SBK_UPDATED, parseInt(ts) || Date.now()); }
function saveScriptBookmarksData(v, ts) {
    localStorage.setItem(SBK, JSON.stringify(v || []));
    setScriptUpdatedAt(ts || Date.now());
}
function saveBM(k, v) {
    localStorage.setItem(k, JSON.stringify(v));
    if (k === SBK) setScriptUpdatedAt(Date.now());
}
function ensureScriptBookmarkClock() {
    if (loadBM(SBK).length && !getScriptUpdatedAt()) setScriptUpdatedAt(Date.now());
}

function exportScriptBookmarks() {
    var scripts = loadBM(SBK);
    if (!scripts.length) { showToast('暂无脚本可导出', 'info'); return; }
    var data = {
        app: 'webssh2',
        type: 'script_bookmarks',
        version: 1,
        exportedAt: new Date().toISOString(),
        origin: location.origin,
        updatedAt: getScriptUpdatedAt(),
        scripts: scripts
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-');
    a.href = url;
    a.download = 'webssh-script-bookmarks-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    showToast('导出成功：已下载 ' + scripts.length + ' 个脚本', 'success');
}

function triggerScriptImport() {
    var input = document.getElementById('scriptImportFile');
    if (!input) { showToast('导入控件未找到', 'error'); return; }
    input.value = '';
    input.click();
}

function extractImportedScripts(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.scripts)) return data.scripts;
    if (data && data.storage && Array.isArray(data.storage[SBK])) return data.storage[SBK];
    if (data && data.bookmarks && Array.isArray(data.bookmarks.scripts)) return data.bookmarks.scripts;
    if (data && Array.isArray(data[SBK])) return data[SBK];
    return [];
}

function normalizeImportedScripts(items) {
    var out = [];
    items.forEach(function (item, idx) {
        if (!item || typeof item !== 'object') return;
        var name = typeof item.name === 'string' ? item.name.trim() : '';
        var cmd = '';
        if (typeof item.cmd === 'string') cmd = item.cmd;
        else if (typeof item.command === 'string') cmd = item.command;
        else if (typeof item.content === 'string') cmd = item.content;
        cmd = cmd.trim();
        if (!cmd) return;
        if (!name) name = '导入脚本 ' + (idx + 1);
        var normalized = { name: name, cmd: cmd };
        var useCount = parseScriptUseCount(item);
        var lastUsed = parseScriptLastUsed(item);
        if (useCount > 0) normalized.useCount = useCount;
        if (lastUsed > 0) normalized.lastUsed = lastUsed;
        out.push(normalized);
    });
    return out;
}

function importScriptBookmarks(input) {
    var file = input && input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
        try {
            var data = JSON.parse(reader.result);
            var incoming = normalizeImportedScripts(extractImportedScripts(data));
            if (!incoming.length) { showToast('未找到可导入的脚本书签', 'error'); return; }
            var current = loadSortedScriptBookmarks();
            var seen = {};
            current.forEach(function (b) {
                seen[((b.name || '').trim()) + '\n' + ((b.cmd || '').trim())] = true;
            });
            var added = 0, skipped = 0;
            incoming.forEach(function (b) {
                var key = b.name + '\n' + b.cmd;
                if (seen[key]) { skipped++; return; }
                current.push(b);
                seen[key] = true;
                added++;
            });
            if (added) {
                sortScriptBookmarks(current);
                saveBM(SBK, current);
                renderScriptBookmarks();
                syncLocalScriptsIfLogged();
            }
            showToast(added ? ('已导入 ' + added + ' 个脚本') : ('没有新增脚本，跳过 ' + skipped + ' 个重复项'), added ? 'success' : 'info');
        } catch (e) {
            showToast('导入失败：JSON 文件无效', 'error');
        } finally {
            input.value = '';
        }
    };
    reader.onerror = function () {
        input.value = '';
        showToast('导入失败：无法读取文件', 'error');
    };
    reader.readAsText(file, 'utf-8');
}

var _cloudStatusTimer = null;
function hideCloudStatus() {
    var el = document.getElementById('scriptCloudStatus');
    if (!el) return;
    if (_cloudStatusTimer) {
        clearTimeout(_cloudStatusTimer);
        _cloudStatusTimer = null;
    }
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
}

function switchAuthMode(mode) {
    authMode = mode === 'register' ? 'register' : 'login';
    var loginTab = document.getElementById('authLoginTab');
    var registerTab = document.getElementById('authRegisterTab');
    var submit = document.querySelector('.auth-submit-btn');
    var hint = document.getElementById('authHint');
    if (loginTab) loginTab.classList.toggle('active', authMode === 'login');
    if (registerTab) registerTab.classList.toggle('active', authMode === 'register');
    if (submit) submit.textContent = authMode === 'register' ? '注册并登录' : '登录';
    if (hint) hint.textContent = authMode === 'register' ? '用户名只能用字母或数字，用户名大于 4 位，密码大于 6 位。' : '登录后会自动同步脚本书签；未登录时仍保存在本地浏览器。';
}

function submitAuthForm() {
    var username = document.getElementById('authUsername').value.trim();
    var password = document.getElementById('authPassword').value.trim();
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) { showToast('用户名只能使用 5-32 位字母或数字', 'error'); return; }
    if (password.length < 7) { showToast('密码必须大于 6 位', 'error'); return; }
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
    var oldPassword = document.getElementById('oldPassword').value.trim();
    var newPassword = document.getElementById('newPassword').value.trim();
    var confirmPassword = document.getElementById('confirmNewPassword').value.trim();
    if (!oldPassword) { showToast('请输入当前密码', 'error'); return; }
    if (newPassword.length < 7) { showToast('新密码必须大于 6 位', 'error'); return; }
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

function updateManagedAccounts(data) {
    data = data || {};
    managedAccounts = Array.isArray(data.users) ? data.users : [];
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
    if (!managedAccounts.length) {
        list.innerHTML = '<div class="account-empty">暂无账号</div>';
        return;
    }
    list.innerHTML = managedAccounts.map(function (u) {
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
            '<button class="script-tool-btn" type="button" onclick="openAccountEdit(\'' + esc(username) + '\')">编辑</button>' +
            '<button class="script-tool-btn danger-inline" type="button" onclick="deleteManagedAccount(\'' + esc(username) + '\')">删除</button>' +
            '</div>' +
            '</div>';
    }).join('');
}

function createManagedAccount() {
    if (!requireAdminAccountAccess()) return;
    var username = document.getElementById('managedNewUsername').value.trim();
    var password = document.getElementById('managedNewPassword').value.trim();
    var isAdmin = document.getElementById('managedNewIsAdmin').checked;
    if (!/^[A-Za-z0-9]{5,32}$/.test(username)) { showToast('用户名只能使用 5-32 位字母或数字', 'error'); return; }
    if (password.length < 7) { showToast('密码必须大于 6 位', 'error'); return; }
    apiJSON('/api/admin/accounts', {
        method: 'POST',
        body: { username: username, password: password, isAdmin: isAdmin }
    })
        .then(function (res) {
            clearManagedAccountCreateForm();
            updateManagedAccounts(res.data || {});
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
    var password = document.getElementById('managedEditPassword').value.trim();
    var isAdmin = document.getElementById('managedEditIsAdmin').checked;
    if (!username) { showToast('账号不能为空', 'error'); return; }
    if (password && password.length < 7) { showToast('新密码必须大于 6 位', 'error'); return; }
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
    var payload = { mode: mode, scripts: loadSortedScriptBookmarks(), updatedAt: getScriptUpdatedAt() };
    apiJSON('/api/scripts/sync', { method: 'POST', body: payload })
        .then(function (res) {
            var d = res.data || {};
            var scripts = normalizeCloudScripts(d.scripts);
            var merged = mergeScriptBookmarksIncremental(scripts, d.updatedAt || Date.now());
            updateAccountUI();
            var msg = '书签已是最新';
            if (d.mode === 'push') msg = '本地书签已同步到云端';
            else if (d.mode === 'pull') msg = '云端书签已同步到本地';
            if (merged.added) msg += '，新增 ' + merged.added + ' 个';
            if (!silent) setCloudStatus(msg + ' · ' + merged.scripts.length + ' 个脚本', 'synced', 3500);
            if (!silent) showToast(msg + '（' + merged.scripts.length + ' 个）', 'success');
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
    var current = clean(data.currentVersion || data.current, '0.5.18');
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
    var h = document.getElementById('hostname').value.trim(), u = document.getElementById('username').value.trim() || 'root', p = parseInt(document.getElementById('port').value) || 22;
    if (!h) { showToast('请先填写主机', 'error'); return; }
    var at = document.querySelector('.auth-tab.active').dataset.tab;
    var bm = { hostname: h, port: p, username: u, authType: at };
    if (at === 'password') bm.password = document.getElementById('password').value;
    var bms = loadBM(CBK), idx = bms.findIndex(function (b) { return b.hostname === h && b.port === p && b.username === u; });
    if (idx >= 0) bms[idx] = bm; else bms.push(bm);
    saveBM(CBK, bms); renderConnBookmarks(); showToast('已保存', 'success');
}

function applyConn(i) {
    var b = loadBM(CBK)[i]; if (!b) return;
    document.getElementById('hostname').value = b.hostname || '';
    document.getElementById('port').value = b.port || 22;
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
        var au = parseScriptUseCount(a), bu = parseScriptUseCount(b);
        if (bu !== au) return bu - au;
        var at = parseScriptLastUsed(a), bt = parseScriptLastUsed(b);
        if (bt !== at) return bt - at;
        return (a.__scriptSortIndex || 0) - (b.__scriptSortIndex || 0);
    });
    bms.forEach(function (b) { if (b) delete b.__scriptSortIndex; });
    var after = bms.map(function (b) { return scriptBookmarkKey(b) + '\u0000' + parseScriptUseCount(b) + '\u0000' + parseScriptLastUsed(b); }).join('\u0001');
    return before !== after;
}

function loadSortedScriptBookmarks() {
    var bms = loadBM(SBK);
    if (sortScriptBookmarks(bms)) {
        localStorage.setItem(SBK, JSON.stringify(bms));
    }
    return bms;
}

function scriptBookmarkItemHtml(b, i) {
    var name = b.name || '';
    var cmd = b.cmd || '';
    return '<div class="bm-item" data-script-row="1" data-script-index="' + i + '" onclick="event.stopPropagation();runScript(' + i + ')" title="' + esc(cmd) + '"><div class="bm-item-info"><div class="bm-item-name">' + esc(name) + '</div><div class="bm-item-host">' + esc(cmd.substring(0, 35)) + '</div></div><div class="bm-item-actions"><span class="bm-item-run">▶</span><button class="bm-item-icon-btn bm-item-edit" title="编辑脚本" onclick="event.stopPropagation();openEditScriptModal(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="11" height="11"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L7 19l-4 1 1-4z"/></svg></button><button class="bm-item-del" title="删除脚本" onclick="event.stopPropagation();delScript(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div></div>';
}

function makeScriptBookmarkNode(b, i) {
    var t = document.createElement('template');
    t.innerHTML = scriptBookmarkItemHtml(b, i).trim();
    return t.content.firstElementChild;
}

function refreshScriptBookmarkIndices() {
    var rows = document.querySelectorAll('#scriptBookmarkList .bm-item[data-script-row]:not(.removing)');
    rows.forEach(function (row, i) {
        row.dataset.scriptIndex = i;
        row.setAttribute('onclick', 'event.stopPropagation();runScript(' + i + ')');
        var edit = row.querySelector('.bm-item-edit');
        var del = row.querySelector('.bm-item-del');
        if (edit) edit.setAttribute('onclick', 'event.stopPropagation();openEditScriptModal(' + i + ')');
        if (del) del.setAttribute('onclick', 'event.stopPropagation();delScript(' + i + ')');
    });
}

function ensureScriptEmptyState() {
    var l = document.getElementById('scriptBookmarkList');
    if (!l || showPresets) return;
    var hasRows = !!l.querySelector('.bm-item[data-script-row]');
    var empty = l.querySelector('.bm-empty');
    if (hasRows && empty) empty.remove();
    if (!hasRows && !empty) {
        var div = document.createElement('div');
        div.className = 'bm-empty';
        div.textContent = '暂无自定义脚本';
        l.appendChild(div);
    }
}

function appendScriptBookmarkItems(items, startIndex) {
    var l = document.getElementById('scriptBookmarkList');
    if (!l || showPresets || !items || !items.length) return;
    var empty = l.querySelector('.bm-empty');
    if (empty) empty.remove();
    var frag = document.createDocumentFragment();
    items.forEach(function (b, offset) {
        frag.appendChild(makeScriptBookmarkNode(b, startIndex + offset));
    });
    l.appendChild(frag);
}

function replaceScriptBookmarkRow(i, b) {
    if (showPresets) return;
    var row = document.querySelector('#scriptBookmarkList .bm-item[data-script-row][data-script-index="' + i + '"]');
    if (!row) return;
    row.replaceWith(makeScriptBookmarkNode(b, i));
}

function removeScriptBookmarkRow(i) {
    if (showPresets) return;
    var row = document.querySelector('#scriptBookmarkList .bm-item[data-script-row][data-script-index="' + i + '"]');
    if (!row) return;
    row.classList.add('removing');
    refreshScriptBookmarkIndices();
    setTimeout(function () {
        if (row.parentNode) row.parentNode.removeChild(row);
        refreshScriptBookmarkIndices();
        ensureScriptEmptyState();
    }, 160);
}

function mergeScriptBookmarksIncremental(incoming, updatedAt) {
    incoming = normalizeCloudScripts(incoming);
    var current = loadSortedScriptBookmarks();
    var seen = {};
    current.forEach(function (b) { seen[scriptBookmarkKey(b)] = true; });
    var added = [];
    incoming.forEach(function (b) {
        var key = scriptBookmarkKey(b);
        if (!key.trim() || seen[key]) return;
        current.push(b);
        added.push(b);
        seen[key] = true;
    });
    if (added.length || updatedAt) {
        sortScriptBookmarks(current);
        saveScriptBookmarksData(current, updatedAt || Date.now());
    }
    if (added.length) renderScriptBookmarks();
    return { scripts: current, added: added.length };
}

function renderScriptBookmarks() {
    var l = document.getElementById('scriptBookmarkList'), bms = loadSortedScriptBookmarks();
    var html = '';

    // Preset entry
    if (!showPresets) {
        html += '<div class="bm-item preset-entry" onclick="event.stopPropagation();showPresets=true;renderScriptBookmarks()"><div class="bm-item-info"><div class="bm-item-name" style="color:var(--c1)">📦 推荐脚本</div><div class="bm-item-host">点击查看常用命令</div></div><span class="bm-item-run" style="color:var(--c1)">›</span></div>';
    } else {
        html += '<div class="bm-item" onclick="event.stopPropagation();showPresets=false;renderScriptBookmarks()" style="border-color:rgba(0,212,255,.15)"><div class="bm-item-info"><div class="bm-item-name" style="color:var(--c1)">‹ 返回</div></div></div>';
        html += PRESET_SCRIPTS.map(function (p) {
            return '<div class="bm-item" onclick="event.stopPropagation();runPresetScript(\'' + p.cmd.replace(/'/g, "\\'").replace(/"/g, "&quot;") + '\')" title="' + esc(p.cmd) + '"><div class="bm-item-info"><div class="bm-item-name">' + esc(p.name) + '</div><div class="bm-item-host">' + esc(p.cmd.substring(0, 35)) + '</div></div><span class="bm-item-run">▶</span></div>';
        }).join('');
        l.innerHTML = html;
        return;
    }

    // User scripts
    if (bms.length) {
        html += bms.map(function (b, i) {
            return scriptBookmarkItemHtml(b, i);
        }).join('');
    } else {
        html += '<div class="bm-empty">暂无自定义脚本</div>';
    }
    l.innerHTML = html;
}

function runPresetScript(cmd) {
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    sessions[activeIdx].ws.send(cmd + '\n');
    showToast('已执行', 'success');
    sessions[activeIdx].term.focus();
}

function saveScriptBookmark() {
    var n = document.getElementById('scriptName').value.trim(), c = document.getElementById('scriptContent').value.trim();
    if (!n || !c) { showToast('名称和命令不能为空', 'error'); return; }
    var item = { name: n, cmd: c };
    var bms = loadBM(SBK); bms.push(item); saveBM(SBK, bms);
    document.getElementById('scriptName').value = ''; document.getElementById('scriptContent').value = '';
    appendScriptBookmarkItems([item], bms.length - 1);
    syncLocalScriptsIfLogged(); showToast('脚本已保存', 'success');
}

function openEditScriptModal(i) {
    var b = loadSortedScriptBookmarks()[i];
    if (!b) return;
    document.getElementById('editScriptIndex').value = i;
    document.getElementById('editScriptName').value = b.name || '';
    document.getElementById('editScriptContent').value = b.cmd || '';
    document.getElementById('editScriptModal').classList.add('show');
    setTimeout(function () {
        var input = document.getElementById('editScriptName');
        if (input) input.focus();
    }, 60);
}

function hideEditScriptModal() {
    var modal = document.getElementById('editScriptModal');
    if (modal) modal.classList.remove('show');
    var idx = document.getElementById('editScriptIndex');
    var name = document.getElementById('editScriptName');
    var content = document.getElementById('editScriptContent');
    if (idx) idx.value = '-1';
    if (name) name.value = '';
    if (content) content.value = '';
}

function saveEditedScriptBookmark() {
    var idx = parseInt(document.getElementById('editScriptIndex').value, 10);
    var name = document.getElementById('editScriptName').value.trim();
    var cmd = document.getElementById('editScriptContent').value.trim();
    if (idx < 0 || !isFinite(idx)) { hideEditScriptModal(); return; }
    if (!name || !cmd) { showToast('名称和命令不能为空', 'error'); return; }
    var bms = loadSortedScriptBookmarks();
    if (!bms[idx]) { hideEditScriptModal(); return; }
    bms[idx] = Object.assign({}, bms[idx], { name: name, cmd: cmd });
    sortScriptBookmarks(bms);
    saveBM(SBK, bms);
    hideEditScriptModal();
    renderScriptBookmarks();
    syncLocalScriptsIfLogged();
    showToast('脚本已更新', 'success');
}

function runScript(i) {
    var bms = loadSortedScriptBookmarks();
    var b = bms[i]; if (!b) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    sessions[activeIdx].ws.send(b.cmd + '\n');
    b.useCount = parseScriptUseCount(b) + 1;
    b.lastUsed = Date.now();
    sortScriptBookmarks(bms);
    saveBM(SBK, bms);
    renderScriptBookmarks();
    syncLocalScriptsIfLogged();
    showToast('已执行: ' + b.name, 'success');
    sessions[activeIdx].term.focus();
}

function delScript(i) {
    var bms = loadSortedScriptBookmarks();
    if (!bms[i]) return;
    bms.splice(i, 1);
    saveBM(SBK, bms);
    removeScriptBookmarkRow(i);
    syncLocalScriptsIfLogged();
    showToast('已删除', 'info');
}

// ==================== SFTP ====================
function sftpLoad(path) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var sshInfo = sessions[activeIdx].sshInfo;
    sftpCurrentPath = path;
    document.getElementById('sftpPath').value = path;
    document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">加载中...</div>';
    fetch('/file/list?sshInfo=' + encodeURIComponent(sshInfo) + '&path=' + encodeURIComponent(path))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg !== 'success') { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">' + esc(d.Msg) + '</div>'; return; }
            var list = (d.Data && d.Data.list) || [];
            if (!list.length) { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading">空目录</div>'; return; }
            document.getElementById('sftpBody').innerHTML = list.map(function (f) {
                var isDir = f.IsDir;
                var fp = (path === '/' ? '/' : path + '/') + f.Name;
                var fpSafe = fp.replace(/'/g, "\\'");
                var icon = isDir ? '<svg class="sftp-icon dir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>' : '<svg class="sftp-icon file" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>';
                var click = isDir ? 'onclick="sftpLoad(\'' + fpSafe + '\')"' : 'onclick="sftpDownload(\'' + fpSafe + '\')"';
                var dl = isDir ? '' : '<button class="sftp-dl" onclick="event.stopPropagation();sftpDownload(\'' + fpSafe + '\')" title="下载"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg></button>';
                return '<div class="sftp-row" ' + click + '>' + icon + '<span class="sftp-name">' + esc(f.Name) + '</span><span class="sftp-meta">' + f.Size + '</span>' + dl + '</div>';
            }).join('');
        })
        .catch(function () { document.getElementById('sftpBody').innerHTML = '<div class="sftp-loading" style="color:var(--err)">加载失败</div>'; });
}

function sftpGo() { sftpLoad(document.getElementById('sftpPath').value.trim() || '/'); }
function sftpUp() { var p = sftpCurrentPath.replace(/\/$/, ''); var i = p.lastIndexOf('/'); sftpLoad(i <= 0 ? '/' : p.substring(0, i)); }

function sftpDownload(path) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    window.open('/file/download?sshInfo=' + encodeURIComponent(sessions[activeIdx].sshInfo) + '&path=' + encodeURIComponent(path), '_blank');
}

function sftpUpload() {
    var input = document.getElementById('sftpUploadInput');
    if (!input.files.length || activeIdx < 0) return;
    var sshInfo = sessions[activeIdx].sshInfo;
    Array.from(input.files).forEach(function (f) {
        var fd = new FormData();
        fd.append('file', f); fd.append('sshInfo', sshInfo); fd.append('path', sftpCurrentPath); fd.append('id', Date.now().toString());
        fetch('/file/upload', { method: 'POST', body: fd })
            .then(function (r) { return r.json(); })
            .then(function (d) { if (d.Msg === 'success') { showToast('上传成功: ' + f.name, 'success'); sftpLoad(sftpCurrentPath); } else showToast('上传失败', 'error'); })
            .catch(function () { showToast('上传失败', 'error'); });
    });
    input.value = '';
}

document.getElementById('sftpPath').addEventListener('keydown', function (e) { if (e.key === 'Enter') sftpGo(); });

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
    var saved = parseInt(localStorage.getItem(FONT_KEY));
    return saved || (window.innerWidth <= 520 ? 13 : 15);
}

function changeFontSize(delta) {
    if (activeIdx < 0 || !sessions[activeIdx]) return;
    var s = sessions[activeIdx];
    var cur = s.term.options.fontSize || 15;
    var nv = Math.max(8, Math.min(30, cur + delta));
    s.term.options.fontSize = nv;
    localStorage.setItem(FONT_KEY, nv);
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
        var c = JSON.parse(localStorage.getItem(COLOR_KEY));
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
    localStorage.setItem(COLOR_KEY, JSON.stringify({ fg: fg, bg: bg, cursor: cursor }));
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
    localStorage.removeItem(COLOR_KEY);
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
    var cur = localStorage.getItem(THEME_KEY) || 'auto';
    var idx = themes.indexOf(cur);
    var next = themes[(idx + 1) % themes.length];
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
    showToast(themeLabels[next], 'info');
}

function initTheme() {
    var saved = localStorage.getItem(THEME_KEY) || 'dark';
    applyTheme(saved);
}

// ==================== Click outside to close drawers ====================
document.addEventListener('click', function (e) {
    if (e.target.closest('.modal-overlay')) return;

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
    if (scriptDrawer && scriptDrawer.classList.contains('open')) {
        if (!scriptDrawer.contains(e.target) && !(termEdge && termEdge.contains(e.target)) && !e.target.closest('.tb-btn')) {
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
    var v = parseInt(localStorage.getItem(SYS_INTERVAL_KEY));
    return (v && v >= 5 && v <= 600) ? v : 60;
}

function getServerInfoRefreshSeconds() {
    return 1;
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
    localStorage.setItem(SYS_INTERVAL_KEY, _sysIntervalTemp);
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
    try { localStorage.setItem(TOPBAR_METRICS_KEY, enabled ? 'true' : 'false'); } catch (e) { }
    updateSysInfoHint();
    if (!enabled) {
        sessions.forEach(function (s) {
            if (s.sysInfoTimer) {
                clearInterval(s.sysInfoTimer);
                s.sysInfoTimer = null;
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
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (e) { return {}; }
}
function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }

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
    localStorage.removeItem(SETTINGS_KEY);
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
    try { localStorage.removeItem(TOPBAR_METRICS_KEY); } catch (e) { }
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
    var decoded = s;
    try { decoded = decodeURIComponent(s); } catch (e) {}
    // Private keys start with -----BEGIN or are very long (>200 chars)
    return decoded.indexOf('-----BEGIN') === 0 || decoded.indexOf('-----BEGIN') !== -1 || decoded.length > 200;
}

function parseUrlLogin() {
    var path = location.pathname;
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
        // ip:port/password OR ip/password
        var hp = parts[0].split(':');
        host = hp[0];
        port = hp[1] ? parseInt(hp[1]) : 22;
        pass = decodeURIComponent(parts[1]);
        user = 'root';
    } else if (parts.length === 3) {
        var hp = parts[0].split(':');
        if (hp.length === 2) {
            // ip:port/user/password
            host = hp[0];
            port = parseInt(hp[1]);
            user = decodeURIComponent(parts[1]);
            pass = decodeURIComponent(parts[2]);
        } else if (/^\d+$/.test(parts[1])) {
            // ip/port/password
            host = parts[0];
            port = parseInt(parts[1]);
            pass = decodeURIComponent(parts[2]);
            user = 'root';
        } else {
            // ip/user/password
            host = parts[0];
            port = 22;
            user = decodeURIComponent(parts[1]);
            pass = decodeURIComponent(parts[2]);
        }
    } else if (parts.length === 4) {
        // ip/port/user/password  OR  ip/port/user/privatekey
        host = parts[0];
        port = parseInt(parts[1]);
        user = decodeURIComponent(parts[2]);
        pass = decodeURIComponent(parts[3]);
    } else {
        return null;
    }

    if (!host) return null;

    // Detect if credential is a private key
    authType = isPrivateKey(pass) ? 'key' : 'password';

    return { host: host, port: port || 22, user: user || 'root', pass: pass || '', authType: authType };
}

function tryAutoLogin() {
    var info = parseUrlLogin();
    if (!info) return;

    // Fill form
    document.getElementById('hostname').value = info.host;
    document.getElementById('port').value = info.port;
    document.getElementById('username').value = info.user;

    if (info.authType === 'key') {
        switchAuthTab('key');
        document.getElementById('privateKey').value = info.pass;
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
var editScriptModalEl = document.getElementById('editScriptModal');
if (editScriptModalEl) {
    editScriptModalEl.addEventListener('click', function (e) {
        if (e.target === editScriptModalEl) hideEditScriptModal();
    });
}
['authUsername', 'authPassword'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') submitAuthForm();
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
