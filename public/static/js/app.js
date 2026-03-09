/* ============================================================
   WebSSH - Frontend Application v3
   ============================================================ */

let term = null;
let fitAddon = null;
let ws = null;
let currentSSHInfo = '';
let heartbeatTimer = null;
let sysInfoTimer = null;
let resizeHandler = null;

// ============================================================
// Particle Background
// ============================================================
(function initParticles() {
    const canvas = document.getElementById('particles');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    let particles = [];
    let mouse = { x: null, y: null };

    function resize() { canvas.width = window.innerWidth; canvas.height = window.innerHeight; }
    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });

    class Particle {
        constructor() { this.reset(); }
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.5;
            this.speedY = (Math.random() - 0.5) * 0.5;
            this.opacity = Math.random() * 0.5 + 0.1;
            this.hue = Math.random() * 60 + 180;
        }
        update() {
            this.x += this.speedX; this.y += this.speedY;
            if (mouse.x !== null) {
                const dx = mouse.x - this.x, dy = mouse.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 150) { const f = (150 - dist) / 150; this.x -= dx * f * 0.01; this.y -= dy * f * 0.01; }
            }
            if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
            if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
        }
        draw() {
            ctx.beginPath(); ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${this.hue}, 80%, 60%, ${this.opacity})`; ctx.fill();
        }
    }

    const count = Math.min(60, Math.floor(window.innerWidth * window.innerHeight / 20000));
    for (let i = 0; i < count; i++) particles.push(new Particle());

    function drawConnections() {
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x, dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    ctx.beginPath(); ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(0, 212, 255, ${(1 - dist / 120) * 0.15})`;
                    ctx.lineWidth = 0.5; ctx.stroke();
                }
            }
        }
    }

    (function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        drawConnections();
        requestAnimationFrame(animate);
    })();
})();

// ============================================================
// Ripple
// ============================================================
document.querySelector('.btn-connect')?.addEventListener('click', function(e) {
    const ripple = this.querySelector('.btn-ripple');
    const rect = this.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    ripple.classList.remove('active'); void ripple.offsetWidth; ripple.classList.add('active');
});

// ============================================================
// Auth Tabs
// ============================================================
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(tab === 'password' ? 'passwordAuth' : 'keyAuth').classList.add('active');
}

function togglePassword() {
    const input = document.getElementById('password');
    input.type = input.type === 'password' ? 'text' : 'password';
}

// ============================================================
// Toast
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); }, 3500);
}

function setStatus(status, text) {
    const el = document.getElementById('statusIndicator');
    el.className = `status-indicator ${status}`;
    el.querySelector('.status-text').textContent = text;
}

function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
}

// ============================================================
// Helpers
// ============================================================
function fmtBytes(b) {
    b = parseInt(b) || 0;
    if (b === 0) return '0B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0) + u[i];
}
function pct(used, total) {
    const u = parseInt(used) || 0, t = parseInt(total) || 1;
    return Math.round(u / t * 100);
}
function pillClass(val) {
    if (val >= 90) return 'danger';
    if (val >= 70) return 'warn';
    return '';
}

// ============================================================
// System Info
// ============================================================
function fetchSysInfo() {
    if (!currentSSHInfo) return;
    fetch(`/sysinfo?sshInfo=${encodeURIComponent(currentSSHInfo)}`)
        .then(r => r.json())
        .then(data => {
            if (data.Msg !== 'success' || !data.Data) return;
            renderMetrics(data.Data);
        })
        .catch(() => {});
}

function renderMetrics(d) {
    const container = document.getElementById('topbarMetrics');
    const memPct = pct(d.memUsed, d.memTotal);
    const diskPct = pct(d.diskUsed, d.diskTotal);
    const cpuVal = parseFloat(d.cpuUsage) || 0;

    const pills = [
        { icon: 'server', label: d.os || 'unknown' },
        { icon: 'cpu', label: d.arch, value: (d.cpuCores || '?') + ' Core' },
        { icon: 'activity', label: 'CPU', value: cpuVal.toFixed(0) + '%', cls: pillClass(cpuVal) },
        { icon: 'memory', label: 'MEM', value: fmtBytes(d.memUsed) + '/' + fmtBytes(d.memTotal) + ' (' + memPct + '%)', cls: pillClass(memPct) },
        { icon: 'hdd', label: 'DISK', value: fmtBytes(d.diskUsed) + '/' + fmtBytes(d.diskTotal) + ' (' + diskPct + '%)', cls: pillClass(diskPct) },
        { icon: 'zap', label: 'Load', value: d.load || '0' },
    ];

    const svgs = {
        server: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>',
        cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>',
        activity: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
        memory: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="6" width="20" height="12" rx="2"/><line x1="6" y1="10" x2="6" y2="14"/><line x1="10" y1="10" x2="10" y2="14"/><line x1="14" y1="10" x2="14" y2="14"/><line x1="18" y1="10" x2="18" y2="14"/></svg>',
        hdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="12" x2="2" y2="12"/><path d="M5.45 5.11L2 12v6a2 2 0 002 2h16a2 2 0 002-2v-6l-3.45-6.89A2 2 0 0016.76 4H7.24a2 2 0 00-1.79 1.11z"/><line x1="6" y1="16" x2="6.01" y2="16"/><line x1="10" y1="16" x2="10.01" y2="16"/></svg>',
        zap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    };

    container.innerHTML = pills.map(p => {
        const cls = p.cls ? ` ${p.cls}` : '';
        const val = p.value ? `<span class="metric-value">${p.value}</span>` : '';
        return `<div class="metric-pill${cls}">${svgs[p.icon] || ''}${p.label} ${val}</div>`;
    }).join('');
}

function startSysInfoPolling() {
    fetchSysInfo();
    sysInfoTimer = setInterval(fetchSysInfo, 60000);
}

function stopSysInfoPolling() {
    if (sysInfoTimer) { clearInterval(sysInfoTimer); sysInfoTimer = null; }
}

// ============================================================
// Bookmark Drawer
// ============================================================
function toggleDrawer() {
    const drawer = document.getElementById('bookmarkDrawer');
    drawer.classList.toggle('open');
    setTimeout(() => {
        if (fitAddon && term) fitAddon.fit();
    }, 350);
}

// ============================================================
// SSH Connection
// ============================================================
function buildSSHInfo() {
    const activeTab = document.querySelector('.auth-tab.active').dataset.tab;
    const info = {
        hostname: document.getElementById('hostname').value.trim(),
        port: parseInt(document.getElementById('port').value) || 22,
        username: document.getElementById('username').value.trim(),
        logintype: activeTab === 'key' ? 1 : 0,
    };
    if (activeTab === 'password') {
        info.password = document.getElementById('password').value;
    } else {
        info.privateKey = document.getElementById('privateKey').value;
        info.passphrase = document.getElementById('passphrase').value;
    }
    return btoa(unescape(encodeURIComponent(JSON.stringify(info))));
}

function initTerminal() {
    if (term) { term.dispose(); term = null; }

    const isMobile = window.innerWidth <= 520;
    term = new Terminal({
        cursorBlink: true, cursorStyle: 'bar',
        fontSize: isMobile ? 13 : 15,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        theme: {
            background: 'rgba(10, 10, 26, 0.0)',
            foreground: '#e8e8f0', cursor: '#00d4ff', cursorAccent: '#0a0a1a',
            selectionBackground: 'rgba(0, 212, 255, 0.25)', selectionForeground: '#ffffff',
            black: '#1a1a2e', red: '#ff006e', green: '#00ff88', yellow: '#ffbe0b',
            blue: '#00d4ff', magenta: '#7b2ff7', cyan: '#00d4ff', white: '#e8e8f0',
            brightBlack: '#3a3a5e', brightRed: '#ff4488', brightGreen: '#33ffaa',
            brightYellow: '#ffdd33', brightBlue: '#33ddff', brightMagenta: '#9955ff',
            brightCyan: '#33ddff', brightWhite: '#ffffff'
        },
        allowTransparency: true, scrollback: 10000, tabStopWidth: 4,
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon); term.loadAddon(webLinksAddon);

    const termEl = document.getElementById('terminal');
    termEl.innerHTML = '';
    term.open(termEl);
    setTimeout(() => fitAddon.fit(), 50);
}

function connect() {
    const btn = document.getElementById('connectBtn');
    btn.classList.add('loading');
    setStatus('connecting', '连接中...');

    currentSSHInfo = buildSSHInfo();
    initTerminal();

    const cols = term.cols, rows = term.rows;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/term?cols=${cols}&rows=${rows}`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        ws.send(currentSSHInfo);
    };

    let gotFirstData = false;

    ws.onmessage = (evt) => {
        if (!gotFirstData) {
            gotFirstData = true;
            btn.classList.remove('loading');
            setStatus('', '已连接');

            const hostname = document.getElementById('hostname').value.trim();
            const username = document.getElementById('username').value.trim();
            document.getElementById('topbarUser').textContent = `${username}@${hostname}`;
            document.getElementById('topbarMetrics').innerHTML = '';

            showView('terminalView');
            showToast('连接成功', 'success');

            setTimeout(() => { fitAddon.fit(); term.focus(); }, 150);

            heartbeatTimer = setInterval(() => {
                if (ws && ws.readyState === WebSocket.OPEN) ws.send('ping');
            }, 30000);

            if (document.getElementById('enableSysInfo').checked) {
                startSysInfoPolling();
            }
        }
        term.write(evt.data);
    };

    ws.onerror = () => {
        btn.classList.remove('loading');
        setStatus('error', '连接失败');
        showToast('WebSocket 连接失败', 'error');
    };

    ws.onclose = (e) => {
        btn.classList.remove('loading');
        if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
        stopSysInfoPolling();
        if (!gotFirstData) {
            setStatus('error', '连接失败');
            showToast('无法连接到服务器', 'error');
        }
    };

    term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    if (resizeHandler) window.removeEventListener('resize', resizeHandler);
    resizeHandler = () => {
        if (fitAddon && term) {
            fitAddon.fit();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(`resize:${term.rows}:${term.cols}`);
            }
        }
    };
    window.addEventListener('resize', resizeHandler);
}

function disconnect() {
    if (ws) { ws.close(); ws = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    stopSysInfoPolling();
    if (term) { term.dispose(); term = null; }
    if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
    const drawer = document.getElementById('bookmarkDrawer');
    if (drawer) drawer.classList.remove('open');
    showView('loginView');
    setStatus('', '就绪');
    showToast('已断开连接', 'info');
}

function reconnect() {
    if (ws) { ws.close(); ws = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
    stopSysInfoPolling();
    showToast('正在重新连接...', 'info');
    setTimeout(connect, 300);
}

// ============================================================
// Form Submit
// ============================================================
document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const hostname = document.getElementById('hostname').value.trim();
    const username = document.getElementById('username').value.trim();
    if (!hostname) { showToast('请输入主机地址', 'error'); return; }
    if (!username) { showToast('请输入用户名', 'error'); return; }
    connect();
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('terminalView').classList.contains('active')) {
        disconnect();
    }
});

// ============================================================
// Bookmarks (localStorage)
// ============================================================
const BM_KEY = 'webssh_bookmarks';

function loadBookmarks() {
    try { return JSON.parse(localStorage.getItem(BM_KEY)) || []; }
    catch { return []; }
}

function saveBookmarks(bms) {
    localStorage.setItem(BM_KEY, JSON.stringify(bms));
}

function renderBookmarks() {
    const list = document.getElementById('bookmarkList');
    const bms = loadBookmarks();
    if (bms.length === 0) {
        list.innerHTML = '<div class="bm-empty">暂无书签<br>点击下方保存当前连接</div>';
        return;
    }
    list.innerHTML = bms.map((b, i) => `
        <div class="bm-item" onclick="applyBookmark(${i})" title="点击填入并连接">
            <div class="bm-item-info">
                <div class="bm-item-name">${escHtml(b.name || b.username + '@' + b.hostname)}</div>
                <div class="bm-item-host">${escHtml(b.hostname)}:${b.port || 22}</div>
            </div>
            <button class="bm-item-del" onclick="event.stopPropagation(); deleteBookmark(${i})" title="删除">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');
}

function saveCurrentAsBookmark() {
    const hostname = document.getElementById('hostname').value.trim();
    const port = document.getElementById('port').value || '22';
    const username = document.getElementById('username').value.trim();
    const activeTab = document.querySelector('.auth-tab.active').dataset.tab;

    if (!hostname || !username) {
        showToast('请先填写主机和用户名', 'error');
        return;
    }

    const bm = {
        hostname, port: parseInt(port), username,
        authType: activeTab,
        name: username + '@' + hostname,
    };
    if (activeTab === 'password') {
        bm.password = document.getElementById('password').value;
    }

    const bms = loadBookmarks();
    const exists = bms.findIndex(b => b.hostname === hostname && b.port === bm.port && b.username === username);
    if (exists >= 0) {
        bms[exists] = bm;
        showToast('书签已更新', 'success');
    } else {
        bms.push(bm);
        showToast('书签已保存', 'success');
    }
    saveBookmarks(bms);
    renderBookmarks();
}

function applyBookmark(index) {
    const bms = loadBookmarks();
    const b = bms[index];
    if (!b) return;

    document.getElementById('hostname').value = b.hostname || '';
    document.getElementById('port').value = b.port || 22;
    document.getElementById('username').value = b.username || '';

    if (b.authType === 'key') {
        switchAuthTab('key');
    } else {
        switchAuthTab('password');
        if (b.password) document.getElementById('password').value = b.password;
    }

    showToast('已填入: ' + b.name, 'info');

    if (document.getElementById('terminalView').classList.contains('active')) {
        setTimeout(() => {
            reconnect();
        }, 200);
    }
}

function deleteBookmark(index) {
    const bms = loadBookmarks();
    bms.splice(index, 1);
    saveBookmarks(bms);
    renderBookmarks();
    showToast('书签已删除', 'info');
}

function escHtml(s) {
    const d = document.createElement('div'); d.textContent = s; return d.innerHTML;
}

renderBookmarks();
