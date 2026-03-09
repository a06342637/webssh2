/* ============================================================
   WebSSH - Frontend Application
   ============================================================ */

let term = null;
let fitAddon = null;
let ws = null;
let currentSSHInfo = '';
let heartbeatTimer = null;

// ============================================================
// Particle Background
// ============================================================
(function initParticles() {
    const canvas = document.getElementById('particles');
    const ctx = canvas.getContext('2d');
    let particles = [];
    let mouse = { x: null, y: null };

    function resize() {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
    resize();
    window.addEventListener('resize', resize);

    document.addEventListener('mousemove', (e) => {
        mouse.x = e.clientX;
        mouse.y = e.clientY;
    });

    class Particle {
        constructor() {
            this.reset();
        }
        reset() {
            this.x = Math.random() * canvas.width;
            this.y = Math.random() * canvas.height;
            this.size = Math.random() * 2 + 0.5;
            this.speedX = (Math.random() - 0.5) * 0.5;
            this.speedY = (Math.random() - 0.5) * 0.5;
            this.opacity = Math.random() * 0.5 + 0.1;
            this.hue = Math.random() * 60 + 180; // cyan to blue range
        }
        update() {
            this.x += this.speedX;
            this.y += this.speedY;

            if (mouse.x !== null) {
                const dx = mouse.x - this.x;
                const dy = mouse.y - this.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 150) {
                    const force = (150 - dist) / 150;
                    this.x -= dx * force * 0.01;
                    this.y -= dy * force * 0.01;
                    this.opacity = Math.min(0.8, this.opacity + 0.02);
                }
            }

            if (this.x < 0 || this.x > canvas.width) this.speedX *= -1;
            if (this.y < 0 || this.y > canvas.height) this.speedY *= -1;
        }
        draw() {
            ctx.beginPath();
            ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${this.hue}, 80%, 60%, ${this.opacity})`;
            ctx.fill();
        }
    }

    const particleCount = Math.min(80, Math.floor(window.innerWidth * window.innerHeight / 15000));
    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }

    function drawConnections() {
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 120) {
                    const opacity = (1 - dist / 120) * 0.15;
                    ctx.beginPath();
                    ctx.moveTo(particles[i].x, particles[i].y);
                    ctx.lineTo(particles[j].x, particles[j].y);
                    ctx.strokeStyle = `rgba(0, 212, 255, ${opacity})`;
                    ctx.lineWidth = 0.5;
                    ctx.stroke();
                }
            }
        }
    }

    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        particles.forEach(p => { p.update(); p.draw(); });
        drawConnections();
        requestAnimationFrame(animate);
    }
    animate();
})();

// ============================================================
// Ripple Effect on Connect Button
// ============================================================
document.querySelector('.btn-connect')?.addEventListener('click', function(e) {
    const ripple = this.querySelector('.btn-ripple');
    const rect = this.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    ripple.classList.remove('active');
    void ripple.offsetWidth;
    ripple.classList.add('active');
});

// ============================================================
// Auth Tab Switching
// ============================================================
function switchAuthTab(tab) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.auth-panel').forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
    document.getElementById(tab === 'password' ? 'passwordAuth' : 'keyAuth').classList.add('active');
}

// ============================================================
// Toggle Password Visibility
// ============================================================
function togglePassword() {
    const input = document.getElementById('password');
    input.type = input.type === 'password' ? 'text' : 'password';
}

// ============================================================
// Toast Notification
// ============================================================
function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const icons = {
        success: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
        error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
        info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
    };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('removing');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// ============================================================
// Status Indicator
// ============================================================
function setStatus(status, text) {
    const el = document.getElementById('statusIndicator');
    el.className = `status-indicator ${status}`;
    el.querySelector('.status-text').textContent = text;
}

// ============================================================
// View Switching
// ============================================================
function showView(viewId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById(viewId).classList.add('active');
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
    return btoa(JSON.stringify(info));
}

function initTerminal() {
    if (term) {
        term.dispose();
        term = null;
    }

    term = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Consolas', monospace",
        theme: {
            background: 'rgba(10, 10, 26, 0.0)',
            foreground: '#e8e8f0',
            cursor: '#00d4ff',
            cursorAccent: '#0a0a1a',
            selectionBackground: 'rgba(0, 212, 255, 0.25)',
            selectionForeground: '#ffffff',
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
        },
        allowTransparency: true,
        scrollback: 10000,
        tabStopWidth: 4,
    });

    fitAddon = new FitAddon.FitAddon();
    const webLinksAddon = new WebLinksAddon.WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    const termEl = document.getElementById('terminal');
    termEl.innerHTML = '';
    term.open(termEl);

    setTimeout(() => fitAddon.fit(), 100);
}

function connect() {
    const btn = document.getElementById('connectBtn');
    btn.classList.add('loading');
    setStatus('connecting', '连接中...');

    currentSSHInfo = buildSSHInfo();
    initTerminal();

    const cols = term.cols;
    const rows = term.rows;

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/term?sshInfo=${encodeURIComponent(currentSSHInfo)}&cols=${cols}&rows=${rows}`;

    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
        btn.classList.remove('loading');
        setStatus('', '就绪');

        const hostname = document.getElementById('hostname').value.trim();
        const username = document.getElementById('username').value.trim();
        document.getElementById('terminalTitle').textContent = `${username}@${hostname}`;

        showView('terminalView');
        showToast('连接成功！', 'success');

        setTimeout(() => {
            fitAddon.fit();
            term.focus();
        }, 200);

        heartbeatTimer = setInterval(() => {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send('ping');
            }
        }, 30000);
    };

    ws.onmessage = (evt) => {
        term.write(evt.data);
    };

    ws.onerror = () => {
        btn.classList.remove('loading');
        setStatus('error', '连接失败');
        showToast('连接失败，请检查参数', 'error');
    };

    ws.onclose = () => {
        btn.classList.remove('loading');
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
    };

    term.onData((data) => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(data);
        }
    });

    window.addEventListener('resize', () => {
        if (fitAddon && term) {
            fitAddon.fit();
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(`resize:${term.rows}:${term.cols}`);
            }
        }
    });
}

// ============================================================
// Disconnect & Reconnect
// ============================================================
function disconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    if (term) {
        term.dispose();
        term = null;
    }
    showView('loginView');
    setStatus('', '就绪');
    showToast('已断开连接', 'info');
}

function reconnect() {
    if (ws) {
        ws.close();
        ws = null;
    }
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
    showToast('正在重新连接...', 'info');
    setTimeout(connect, 300);
}

// ============================================================
// Form Submit Handler
// ============================================================
document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();

    const hostname = document.getElementById('hostname').value.trim();
    const username = document.getElementById('username').value.trim();

    if (!hostname) {
        showToast('请输入主机地址', 'error');
        return;
    }
    if (!username) {
        showToast('请输入用户名', 'error');
        return;
    }

    connect();
});

// ============================================================
// Keyboard Shortcut
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('terminalView').classList.contains('active')) {
        disconnect();
    }
});
