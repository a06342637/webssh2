/* ============================================================
   WebSSH v5 - Multi-tab, SFTP, Dual Bookmarks
   ============================================================ */

// ==================== State ====================
var sessions = [];
var activeIdx = -1;
var sftpCurrentPath = '/';

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
function showView(id) { document.querySelectorAll('.view').forEach(function (v) { v.classList.remove('active'); }); document.getElementById(id).classList.add('active'); }

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
    if (e.key === 'Escape' && document.getElementById('terminalView').classList.contains('active')) {
        closeActiveTab();
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
            document.getElementById('proxyPanel').classList.add('show');
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

    var isMobile = window.innerWidth <= 520;
    var t = new Terminal({
        cursorBlink: true, cursorStyle: 'bar',
        fontSize: isMobile ? 13 : 15,
        fontFamily: "'JetBrains Mono','Fira Code','Cascadia Code',Consolas,monospace",
        theme: { background: 'rgba(10,10,26,0)', foreground: '#e8e8f0', cursor: '#00d4ff', cursorAccent: '#0a0a1a', selectionBackground: 'rgba(0,212,255,.25)', black: '#1a1a2e', red: '#ff006e', green: '#00ff88', yellow: '#ffbe0b', blue: '#00d4ff', magenta: '#7b2ff7', cyan: '#00d4ff', white: '#e8e8f0', brightBlack: '#3a3a5e', brightRed: '#ff4488', brightGreen: '#33ffaa', brightYellow: '#ffdd33', brightBlue: '#33ddff', brightMagenta: '#9955ff', brightCyan: '#33ddff', brightWhite: '#fff' },
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
}

function renderTabs() {
    var bar = document.getElementById('tabBar');
    bar.innerHTML = sessions.map(function (s, i) {
        var cls = i === activeIdx ? 'ssh-tab active' : 'ssh-tab';
        return '<div class="' + cls + '" onclick="switchTab(' + i + ')">' +
            '<span>' + esc(s.hostname) + '</span>' +
            '<button class="tab-close" onclick="event.stopPropagation();closeTab(' + i + ')">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
    }).join('');
}

function updateMetricsForActive() {
    document.getElementById('topbarMetrics').innerHTML = '';
    if (activeIdx >= 0 && sessions[activeIdx]) {
        var s = sessions[activeIdx];
        if (s._lastMetrics) renderMetrics(s._lastMetrics);
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
            session.heartbeat = setInterval(function () { if (ws.readyState === 1) ws.send('ping'); }, 30000);
            if (document.getElementById('enableSysInfo').checked) {
                fetchSysInfoFor(session);
                session.sysInfoTimer = setInterval(function () { fetchSysInfoFor(session); }, 60000);
            }
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

// ==================== Tab Actions ====================
function closeTab(idx) {
    if (idx < 0 || idx >= sessions.length) return;
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
    fetch('/sysinfo?sshInfo=' + encodeURIComponent(session.sshInfo))
        .then(function (r) { return r.json(); })
        .then(function (d) {
            if (d.Msg === 'success' && d.Data) {
                session._lastMetrics = d.Data;
                if (sessions[activeIdx] === session) renderMetrics(d.Data);
            }
        })
        .catch(function () { });
}

function renderMetrics(d) {
    var c = document.getElementById('topbarMetrics');
    var mp = pct(d.memUsed, d.memTotal), dp = pct(d.diskUsed, d.diskTotal), cv = parseFloat(d.cpuUsage) || 0;
    var pills = [
        { i: 'server', l: d.os || '?' },
        { i: 'cpu', l: d.arch, v: (d.cpuCores || '?') + 'C' },
        { i: 'activity', l: 'CPU', v: cv.toFixed(0) + '%', c: pillCls(cv) },
        { i: 'memory', l: 'MEM', v: fmtB(d.memUsed) + '/' + fmtB(d.memTotal), c: pillCls(mp) },
        { i: 'hdd', l: 'DISK', v: fmtB(d.diskUsed) + '/' + fmtB(d.diskTotal), c: pillCls(dp) },
        { i: 'zap', l: 'Load', v: d.load || '0' },
        { i: 'down', l: 'IN', v: fmtB(d.rxTotal) },
        { i: 'up', l: 'OUT', v: fmtB(d.txTotal) }
    ];
    var sv = { server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/></svg>', cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/></svg>', activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>', memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/></svg>', hdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/></svg>', zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>', down: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>', up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>' };
    c.innerHTML = pills.map(function (p) {
        var cls = p.c ? ' ' + p.c : '';
        return '<div class="metric-pill' + cls + '">' + (sv[p.i] || '') + p.l + (p.v ? ' <span class="metric-value">' + p.v + '</span>' : '') + '</div>';
    }).join('');
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

function loadBM(k) { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } }
function saveBM(k, v) { localStorage.setItem(k, JSON.stringify(v)); }

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

// ==================== Script Bookmarks ====================
function renderScriptBookmarks() {
    var l = document.getElementById('scriptBookmarkList'), bms = loadBM(SBK);
    if (!bms.length) { l.innerHTML = '<div class="bm-empty">暂无脚本</div>'; return; }
    l.innerHTML = bms.map(function (b, i) {
        return '<div class="bm-item" onclick="runScript(' + i + ')" title="' + esc(b.cmd) + '"><div class="bm-item-info"><div class="bm-item-name">' + esc(b.name) + '</div><div class="bm-item-host">' + esc(b.cmd.substring(0, 40)) + '</div></div><span class="bm-item-run">▶</span><button class="bm-item-del" onclick="event.stopPropagation();delScript(' + i + ')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="10" height="10"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button></div>';
    }).join('');
}

function saveScriptBookmark() {
    var n = document.getElementById('scriptName').value.trim(), c = document.getElementById('scriptContent').value.trim();
    if (!n || !c) { showToast('名称和命令不能为空', 'error'); return; }
    var bms = loadBM(SBK); bms.push({ name: n, cmd: c }); saveBM(SBK, bms);
    document.getElementById('scriptName').value = ''; document.getElementById('scriptContent').value = '';
    renderScriptBookmarks(); showToast('脚本已保存', 'success');
}

function runScript(i) {
    var b = loadBM(SBK)[i]; if (!b) return;
    if (activeIdx < 0 || !sessions[activeIdx] || !sessions[activeIdx].ws || sessions[activeIdx].ws.readyState !== 1) { showToast('无活动连接', 'error'); return; }
    sessions[activeIdx].ws.send(b.cmd + '\n');
    showToast('已执行: ' + b.name, 'success');
    sessions[activeIdx].term.focus();
}

function delScript(i) { var bms = loadBM(SBK); bms.splice(i, 1); saveBM(SBK, bms); renderScriptBookmarks(); showToast('已删除', 'info'); }

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

// ==================== Init ====================
renderConnBookmarks();
loadProxyConfig();
