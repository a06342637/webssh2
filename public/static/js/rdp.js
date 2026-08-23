// ==================== RDP (IronRDP WASM) ====================
// 与 SSH 侧最大的不同：RDP 协议完全在浏览器里解析。后端 /rdp 只做
// RDCleanPath 握手 + 透明字节转发，不做任何图形转码，所以画面延迟基本
// 只受网络往返和本机解码速度影响。

var RDP_WASM_URL = '/static/vendor/ironrdp/rdp_client.js';
var RDP_SETTINGS_KEY = 'webssh_rdp_settings';
var RDP_RELAY_KEY = 'webssh_rdp_relay';

var rdpWasmModule = null;
var rdpWasmLoading = null;

var rdpDefaultSettings = {
    resolution: 'fit',
    customWidth: 1280,
    customHeight: 720,
    startFullscreen: false,
    dynamicResize: true,
    scaleMode: 'fit',
    hiDpi: false,
    clipboard: true,
    unicodeKeyboard: true,
    grabKeys: true,
    openInNewWindow: false,
    autoHideToolbar: true
};

function rdpSettings() {
    var saved = {};
    try { saved = JSON.parse(safeStorageGet(RDP_SETTINGS_KEY) || '{}') || {}; } catch (e) { saved = {}; }
    var merged = {};
    for (var key in rdpDefaultSettings) {
        if (!Object.prototype.hasOwnProperty.call(rdpDefaultSettings, key)) continue;
        merged[key] = Object.prototype.hasOwnProperty.call(saved, key) ? saved[key] : rdpDefaultSettings[key];
    }
    return merged;
}

function rdpRelayConfig() {
    try {
        var saved = JSON.parse(safeStorageGet(RDP_RELAY_KEY) || '{}') || {};
        return {
            kind: saved.kind || 'none',
            host: saved.host || '',
            port: saved.port || 1080,
            username: saved.username || '',
            password: saved.password || '',
            privateKey: saved.privateKey || '',
            remember: !!saved.remember
        };
    } catch (e) {
        return { kind: 'none', host: '', port: 1080, username: '', password: '', privateKey: '', remember: false };
    }
}

// ==================== 协议切换 ====================

var currentProtocol = 'ssh';

// SSH 和 RDP 共用同一组输入框，但两边的连接信息必须互不可见：
// 切走时把当前协议填的内容收进草稿，切回来时再原样恢复。
var protocolDrafts = {
    ssh: { hostname: '', port: '22', username: 'root', password: '', domain: '' },
    rdp: { hostname: '', port: '3389', username: 'Administrator', password: '', domain: '' }
};
var protocolDraftLoaded = false;
function protocolFieldValue(id) {
    var el = document.getElementById(id);
    return el ? el.value : '';
}

function setProtocolFieldValue(id, value) {
    var el = document.getElementById(id);
    if (el) el.value = value;
}

function captureProtocolDraft(proto) {
    protocolDrafts[proto] = {
        hostname: protocolFieldValue('hostname'),
        port: protocolFieldValue('port'),
        username: protocolFieldValue('username'),
        password: protocolFieldValue('password')
    };
}

function restoreProtocolDraft(proto) {
    var draft = protocolDrafts[proto] || {};
    setProtocolFieldValue('hostname', draft.hostname || '');
    setProtocolFieldValue('port', draft.port || (proto === 'rdp' ? '3389' : '22'));
    setProtocolFieldValue('username', draft.username || (proto === 'rdp' ? 'Administrator' : 'root'));
    setProtocolFieldValue('password', draft.password || '');
}

// 供 SSH 侧的书签回填、URL 快速登录调用：那些入口只认 SSH，
// 回填前必须确保表单已经切回 SSH，否则会把 SSH 信息写进 RDP 的框里。
function ensureSSHProtocolForFill() {
    if (currentProtocol !== 'ssh') switchProtocol('ssh');
}

function switchProtocol(proto) {
    var next = proto === 'rdp' ? 'rdp' : 'ssh';
    if (protocolDraftLoaded && next === currentProtocol) return;
    // 首次调用也要先存：此时表单里可能已经是用户填好的 SSH 信息，
    // 不存下来的话第一次切到 RDP 就把它丢了。
    captureProtocolDraft(currentProtocol);
    protocolDraftLoaded = true;

    currentProtocol = next;
    document.querySelectorAll('.proto-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.proto === currentProtocol);
    });
    document.body.classList.toggle('proto-rdp', currentProtocol === 'rdp');

    restoreProtocolDraft(currentProtocol);
    document.querySelector('#connectBtn .btn-text').textContent =
        currentProtocol === 'rdp' ? '连接远程桌面' : '连接终端';
    updateRdpQuickSummary();
    syncRdpWindowCheckbox();
}

function updateRdpQuickSummary() {
    var el = document.getElementById('rdpQuickSummary');
    if (!el) return;
    var s = rdpSettings();
    var relay = rdpRelayConfig();
    var sizeText = s.resolution === 'fit' ? '适应窗口'
        : s.resolution === 'custom' ? (s.customWidth + '×' + s.customHeight)
            : s.resolution.replace('x', '×');
    var relayText = relay.kind === 'socks5' ? ('SOCKS5 ' + (relay.host || '未填'))
        : relay.kind === 'ssh' ? ('SSH 跳板 ' + (relay.host || '未填'))
            : '直连';
    el.textContent = sizeText + ' · ' + relayText + (s.startFullscreen ? ' · 全屏启动' : '');
}

// ==================== 设置面板 ====================

function openRdpSettings() {
    var s = rdpSettings();
    var relay = rdpRelayConfig();
    document.getElementById('rdpResolution').value = s.resolution;
    document.getElementById('rdpCustomWidth').value = s.customWidth;
    document.getElementById('rdpCustomHeight').value = s.customHeight;
    document.getElementById('rdpStartFullscreen').checked = !!s.startFullscreen;
    document.getElementById('rdpDynamicResize').checked = !!s.dynamicResize;
    document.getElementById('rdpScaleMode').value = s.scaleMode;
    document.getElementById('rdpHiDpi').checked = !!s.hiDpi;
    document.getElementById('rdpAutoHideToolbar').checked = !!s.autoHideToolbar;
    document.getElementById('rdpClipboard').checked = !!s.clipboard;
    document.getElementById('rdpUnicodeKeyboard').checked = !!s.unicodeKeyboard;
    document.getElementById('rdpGrabKeys').checked = !!s.grabKeys;

    document.getElementById('rdpRelayKind').value = relay.kind;
    document.getElementById('rdpRelayHost').value = relay.host;
    document.getElementById('rdpRelayPort').value = relay.port;
    document.getElementById('rdpRelayUser').value = relay.username;
    document.getElementById('rdpRelayPass').value = relay.password;
    document.getElementById('rdpRelayKey').value = relay.privateKey;
    document.getElementById('rdpRememberRelay').checked = !!relay.remember;

    onRdpResolutionChange();
    onRdpRelayKindChange();
    document.getElementById('rdpSettingsModal').classList.add('show');
}

function closeRdpSettings() {
    document.getElementById('rdpSettingsModal').classList.remove('show');
}

function switchRdpTab(tab) {
    document.querySelectorAll('.rdp-tab').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.rtab === tab);
    });
    document.querySelectorAll('.rdp-pane').forEach(function (pane) {
        pane.classList.toggle('active', pane.dataset.rpane === tab);
    });
}

function onRdpResolutionChange() {
    var custom = document.getElementById('rdpResolution').value === 'custom';
    document.getElementById('rdpCustomSizeRow').classList.toggle('show', custom);
}

function onRdpRelayKindChange() {
    var kind = document.getElementById('rdpRelayKind').value;
    document.getElementById('rdpRelayFields').classList.toggle('show', kind !== 'none');
    document.getElementById('rdpRelayWarn').classList.toggle('show', kind !== 'none');
    document.getElementById('rdpRelayKeyField').classList.toggle('show', kind === 'ssh');
    var portInput = document.getElementById('rdpRelayPort');
    if (kind === 'ssh' && (portInput.value === '1080' || !portInput.value)) portInput.value = '22';
    if (kind === 'socks5' && (portInput.value === '22' || !portInput.value)) portInput.value = '1080';
    document.getElementById('rdpRelayUserLabel').textContent = kind === 'ssh' ? '用户名' : '用户名 (可选)';
}

function saveRdpSettings() {
    var settings = {
        resolution: document.getElementById('rdpResolution').value,
        customWidth: parseInt(document.getElementById('rdpCustomWidth').value, 10) || 1280,
        customHeight: parseInt(document.getElementById('rdpCustomHeight').value, 10) || 720,
        startFullscreen: document.getElementById('rdpStartFullscreen').checked,
        dynamicResize: document.getElementById('rdpDynamicResize').checked,
        scaleMode: document.getElementById('rdpScaleMode').value,
        hiDpi: document.getElementById('rdpHiDpi').checked,
        autoHideToolbar: document.getElementById('rdpAutoHideToolbar').checked,
        clipboard: document.getElementById('rdpClipboard').checked,
        unicodeKeyboard: document.getElementById('rdpUnicodeKeyboard').checked,
        grabKeys: document.getElementById('rdpGrabKeys').checked,
        // 这一项不在本对话框里，它由登录页那个复选框控制；
        // 不带上的话每次保存设置都会把用户的选择抹掉。
        openInNewWindow: rdpSettings().openInNewWindow
    };
    safeStorageSet(RDP_SETTINGS_KEY, JSON.stringify(settings));

    var remember = document.getElementById('rdpRememberRelay').checked;
    var relay = {
        kind: document.getElementById('rdpRelayKind').value,
        host: document.getElementById('rdpRelayHost').value.trim(),
        port: parseInt(document.getElementById('rdpRelayPort').value, 10) || 1080,
        username: document.getElementById('rdpRelayUser').value.trim(),
        // 中转凭据只在用户明确勾选后才落盘，且始终只存在本地。
        password: remember ? document.getElementById('rdpRelayPass').value : '',
        privateKey: remember ? document.getElementById('rdpRelayKey').value : '',
        remember: remember
    };
    if (remember) {
        safeStorageSet(RDP_RELAY_KEY, JSON.stringify(relay));
    } else {
        safeStorageRemove(RDP_RELAY_KEY);
        // 不记住时仍要让本次连接用上，挂在内存里。
        rdpPendingRelay = relay;
    }
    updateRdpQuickSummary();
    applyRdpToolbarMode();
    // 已经连上的会话也要跟着新设置走，否则要重连才生效。
    var live = activeRdpSession();
    if (live) {
        live.rdpSettings = rdpSettings();
        applyRdpCanvasScale(live);
        scheduleRdpResize(live);
    }
    closeRdpSettings();
    showToast('远程桌面设置已保存', 'success');
}

var rdpPendingRelay = null;

function activeRdpRelay() {
    var saved = rdpRelayConfig();
    if (saved.remember && saved.kind !== 'none') return saved;
    if (rdpPendingRelay && rdpPendingRelay.kind !== 'none') return rdpPendingRelay;
    return { kind: 'none' };
}

// ==================== 顶部栏自动隐藏 ====================

// RDP 会话把整个视口让给画面，顶部栏平时收起来，鼠标贴到屏幕顶边才滑出。
// 触发区只有 3px 并且要停留一小会儿，否则用户去点远端窗口的标题栏时会误触发。
var RDP_BAR_PEEK_ZONE = 3;
var RDP_BAR_PEEK_DELAY = 240;
var RDP_BAR_HIDE_DELAY = 600;

var rdpBarPeekTimer = null;
var rdpBarHideTimer = null;

function rdpBarPinned() {
    return !rdpSettings().autoHideToolbar;
}

function applyRdpToolbarMode() {
    var pinned = rdpBarPinned();
    document.body.classList.toggle('rdp-bar-pinned', pinned);
    if (pinned) {
        document.body.classList.remove('rdp-bar-open');
        clearRdpBarTimers();
    }
    // 顶部栏的显隐会改变可用高度，画面要跟着重新适配。
    var session = activeRdpSession();
    if (session) scheduleRdpResize(session);
}

function clearRdpBarTimers() {
    if (rdpBarPeekTimer) { clearTimeout(rdpBarPeekTimer); rdpBarPeekTimer = null; }
    if (rdpBarHideTimer) { clearTimeout(rdpBarHideTimer); rdpBarHideTimer = null; }
}

function openRdpBar() {
    document.body.classList.add('rdp-bar-open');
    if (rdpBarHideTimer) { clearTimeout(rdpBarHideTimer); rdpBarHideTimer = null; }
}

function closeRdpBar() {
    document.body.classList.remove('rdp-bar-open');
    clearRdpBarTimers();
}

function handleRdpBarPointer(event) {
    if (!document.body.classList.contains('active-rdp')) return;
    if (rdpBarPinned()) return;

    var isOpen = document.body.classList.contains('rdp-bar-open');
    if (!isOpen) {
        if (event.clientY <= RDP_BAR_PEEK_ZONE) {
            if (!rdpBarPeekTimer) {
                rdpBarPeekTimer = setTimeout(function () {
                    rdpBarPeekTimer = null;
                    openRdpBar();
                }, RDP_BAR_PEEK_DELAY);
            }
        } else if (rdpBarPeekTimer) {
            clearTimeout(rdpBarPeekTimer);
            rdpBarPeekTimer = null;
        }
        return;
    }

    var bar = document.querySelector('.term-topbar');
    var barBottom = bar ? bar.getBoundingClientRect().bottom : 52;
    if (event.clientY > barBottom + 10) {
        if (!rdpBarHideTimer) {
            rdpBarHideTimer = setTimeout(function () {
                rdpBarHideTimer = null;
                document.body.classList.remove('rdp-bar-open');
            }, RDP_BAR_HIDE_DELAY);
        }
    } else if (rdpBarHideTimer) {
        clearTimeout(rdpBarHideTimer);
        rdpBarHideTimer = null;
    }
}

// ==================== 独立窗口 ====================

// 勾选状态单独持久化：它和「远程桌面设置」对话框里的项不同，
// 是在登录页直接切换的，改完立刻要记住，不经过对话框的保存按钮。
function saveRdpWindowPreference() {
    var checkbox = document.getElementById('rdpOpenInNewWindow');
    if (!checkbox) return;
    var settings = rdpSettings();
    settings.openInNewWindow = checkbox.checked;
    safeStorageSet(RDP_SETTINGS_KEY, JSON.stringify(settings));
    updateRdpNewWindowHint();
}

function syncRdpWindowCheckbox() {
    var checkbox = document.getElementById('rdpOpenInNewWindow');
    if (!checkbox) return;
    checkbox.checked = !!rdpSettings().openInNewWindow;
    updateRdpNewWindowHint();
}

// 当前页面是否已经运行在无浏览器外壳的窗口里（桌面快捷方式的 --app 模式，
// 或者已安装的 PWA）。这决定了 window.open 出来的新窗口有没有地址栏。
function runningInAppWindow() {
    try {
        if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
        if (navigator.standalone) return true;
    } catch (e) { }
    // --app 模式没有标准 API 可判定，用窗口外框和视口的高度差近似：
    // 普通标签页要塞下标签栏+地址栏+书签栏，差值通常在 100px 以上。
    return (window.outerHeight - window.innerHeight) < 90;
}

function updateRdpNewWindowHint() {
    var hint = document.getElementById('rdpNewWindowHint');
    if (!hint) return;
    var checkbox = document.getElementById('rdpOpenInNewWindow');
    if (checkbox && !checkbox.checked) {
        hint.textContent = '不勾选则在当前页面打开';
        hint.classList.remove('is-warn');
        return;
    }
    if (runningInAppWindow()) {
        hint.textContent = '新窗口不带任何浏览器外壳';
        hint.classList.remove('is-warn');
    } else {
        hint.textContent = '当前是普通标签页，新窗口会保留一条地址栏；用桌面快捷方式打开可去掉';
        hint.classList.add('is-warn');
    }
}

var RDP_HANDOFF_HASH = '#rdp-window';
var RDP_HANDOFF_READY = 'webssh-rdp-window-ready';
var RDP_HANDOFF_CONNECT = 'webssh-rdp-connect';

function rdpNewWindowSize() {
    var s = rdpSettings();
    var availW = window.screen.availWidth || 1600;
    var availH = window.screen.availHeight || 1000;
    if (s.resolution !== 'fit' && s.resolution !== 'custom') {
        var parts = s.resolution.split('x');
        // 远端分辨率之外还要给顶部标签栏和窗口边框留位置。
        return {
            width: Math.min(availW, parseInt(parts[0], 10) + 16),
            height: Math.min(availH, parseInt(parts[1], 10) + 96)
        };
    }
    if (s.resolution === 'custom') {
        return {
            width: Math.min(availW, s.customWidth + 16),
            height: Math.min(availH, s.customHeight + 96)
        };
    }
    return { width: Math.round(availW * 0.92), height: Math.round(availH * 0.92) };
}

// openRdpWindow 打开子窗口并把连接信息交给它。
// 凭据不进 URL——URL 会落进浏览器历史；改用 postMessage 直接递，只存在于内存。
function openRdpWindow(payload) {
    var size = rdpNewWindowSize();
    var left = Math.max(0, Math.round((window.screen.availWidth - size.width) / 2));
    var top = Math.max(0, Math.round((window.screen.availHeight - size.height) / 2));
    var features = [
        'popup=yes',
        'noopener=no',
        'width=' + size.width,
        'height=' + size.height,
        'left=' + left,
        'top=' + top
    ].join(',');

    var child = window.open(location.origin + '/' + RDP_HANDOFF_HASH, '_blank', features);
    if (!child) {
        showToast('新窗口被浏览器拦截了，请允许本站弹出窗口', 'error');
        return false;
    }

    var delivered = false;
    function onMessage(event) {
        if (event.origin !== location.origin) return;
        if (!event.data || event.data.type !== RDP_HANDOFF_READY) return;
        if (event.source !== child) return;
        child.postMessage({ type: RDP_HANDOFF_CONNECT, payload: payload }, location.origin);
        delivered = true;
        cleanup();
    }
    function cleanup() {
        window.removeEventListener('message', onMessage);
        if (timer) { clearTimeout(timer); timer = null; }
    }
    window.addEventListener('message', onMessage);

    // 子窗口一直没握手（被拦、加载失败）时不要把监听器留着。
    var timer = setTimeout(function () {
        if (!delivered) {
            cleanup();
            showToast('新窗口没有响应，请检查是否被拦截', 'error');
        }
    }, 15000);

    try { child.focus(); } catch (e) { }
    return true;
}

// 子窗口侧：告诉父窗口自己准备好了，然后等连接信息。
function initRdpHandoffTarget() {
    if (location.hash !== RDP_HANDOFF_HASH || !window.opener) return;

    // 干净起见先把 hash 抹掉，避免刷新时又走一遍交接流程。
    try { history.replaceState(null, '', location.pathname); } catch (e) { }

    document.body.classList.add('rdp-handoff-pending');

    window.addEventListener('message', function (event) {
        if (event.origin !== location.origin) return;
        if (!event.data || event.data.type !== RDP_HANDOFF_CONNECT) return;
        if (event.source !== window.opener) return;
        document.body.classList.remove('rdp-handoff-pending');
        startRdpFromHandoff(event.data.payload);
    });

    try {
        window.opener.postMessage({ type: RDP_HANDOFF_READY }, location.origin);
    } catch (e) { }
}

function startRdpFromHandoff(payload) {
    if (!payload) return;
    switchProtocol('rdp');
    var session = createRdpSession(payload.hostname, payload.port, payload.username, {
        password: payload.password,
        domain: payload.domain,
        relay: payload.relay
    });
    // 设置是从父窗口原样带过来的，不重新读 localStorage：
    // 父窗口可能刚改完还没落盘。但独立窗口本身不需要再套一层新窗口。
    if (payload.settings) {
        session.rdpSettings = payload.settings;
        session.rdpSettings.openInNewWindow = false;
    }
    applyRdpCanvasScale(session);
    showView('terminalView');
    switchTab(sessions.length - 1);
    connectRdpSession(session);
}

// ==================== WASM 加载 ====================

function loadRdpWasm() {
    if (rdpWasmModule) return Promise.resolve(rdpWasmModule);
    if (rdpWasmLoading) return rdpWasmLoading;
    rdpWasmLoading = import(RDP_WASM_URL).then(function (mod) {
        return mod.default().then(function () {
            try { mod.setup('warn'); } catch (e) { }
            rdpWasmModule = mod;
            return mod;
        });
    }).catch(function (err) {
        rdpWasmLoading = null;
        throw err;
    });
    return rdpWasmLoading;
}

// ==================== 尺寸计算 ====================

function rdpTargetSize(session) {
    var s = session.rdpSettings;
    var dpr = s.hiDpi ? (window.devicePixelRatio || 1) : 1;
    if (s.resolution === 'custom') {
        return { width: s.customWidth, height: s.customHeight };
    }
    if (s.resolution !== 'fit') {
        var parts = s.resolution.split('x');
        return { width: parseInt(parts[0], 10), height: parseInt(parts[1], 10) };
    }
    var host = session.rdpViewport || session.termDiv;
    var rect = host.getBoundingClientRect();
    var width = Math.round((rect.width || 1280) * dpr);
    var height = Math.round((rect.height || 720) * dpr);
    // RDP 要求宽高为偶数，且有合理下限。
    width = Math.max(640, width - (width % 2));
    height = Math.max(480, height - (height % 2));
    return { width: Math.min(width, 4096), height: Math.min(height, 2160) };
}

function applyRdpCanvasScale(session) {
    var canvas = session.canvas;
    if (!canvas) return;
    var mode = session.rdpSettings.scaleMode;
    canvas.classList.remove('scale-fit', 'scale-stretch', 'scale-none');
    canvas.classList.add('scale-' + (mode === 'stretch' ? 'stretch' : mode === 'none' ? 'none' : 'fit'));
}

// ==================== 会话创建 ====================

function createRdpSession(hostname, port, username, opts) {
    opts = opts || {};
    var id = Date.now() + '_' + Math.random().toString(36).substr(2, 5);

    var wrap = document.createElement('div');
    wrap.className = 'term-instance rdp-instance';
    wrap.id = 'term_' + id;

    var viewport = document.createElement('div');
    viewport.className = 'rdp-viewport';

    var canvas = document.createElement('canvas');
    canvas.className = 'rdp-canvas scale-fit';
    canvas.tabIndex = 0;
    canvas.width = 1280;
    canvas.height = 720;

    var overlay = document.createElement('div');
    overlay.className = 'rdp-overlay';
    overlay.innerHTML = '<div class="rdp-overlay-box"><span class="spinner"></span><span class="rdp-overlay-text">正在连接远程桌面…</span></div>';

    viewport.appendChild(canvas);
    viewport.appendChild(overlay);
    wrap.appendChild(viewport);
    document.getElementById('terminalContainer').appendChild(wrap);

    var session = {
        kind: 'rdp',
        id: id,
        hostname: hostname,
        port: port,
        username: username,
        password: opts.password || '',
        domain: opts.domain || '',
        relay: opts.relay || { kind: 'none' },
        rdpSettings: rdpSettings(),
        termDiv: wrap,
        rdpViewport: viewport,
        canvas: canvas,
        overlay: overlay,
        term: null,
        fitAddon: null,
        ws: null,
        rdpSession: null,
        rdpModule: null,
        resizeObs: null,
        _connected: false,
        _closing: false,
        _resizeTimer: null,
        _inputCleanup: null,
        _keyboardLocked: false
    };

    session.resizeObs = new ResizeObserver(function () { scheduleRdpResize(session); });
    session.resizeObs.observe(viewport);

    applyRdpCanvasScale(session);
    sessions.push(session);
    return session;
}

function setRdpOverlay(session, text, kind) {
    if (!session.overlay) return;
    if (text === null) {
        session.overlay.classList.remove('show', 'error');
        return;
    }
    session.overlay.classList.add('show');
    session.overlay.classList.toggle('error', kind === 'error');
    var box = session.overlay.querySelector('.rdp-overlay-box');
    if (kind === 'error') {
        box.innerHTML = '<div class="rdp-overlay-text">' + esc(text) + '</div>' +
            '<button class="drawer-add" style="margin-top:10px" onclick="reconnectRdpTab()">重新连接</button>';
    } else {
        box.innerHTML = '<span class="spinner"></span><span class="rdp-overlay-text">' + esc(text) + '</span>';
    }
}

// ==================== 连接 ====================

function connectRdpSession(session, afterStart) {
    var finish = function () { if (typeof afterStart === 'function') { afterStart(); afterStart = null; } };

    setRdpOverlay(session, '正在加载远程桌面组件…');

    loadRdpWasm().then(function (mod) {
        session.rdpModule = mod;
        setRdpOverlay(session, '正在申请连接票据…');
        return requestRdpTicket(session);
    }).then(function (ticketInfo) {
        setRdpOverlay(session, '正在连接 ' + session.hostname + '…');
        return startRdpConnection(session, ticketInfo);
    }).then(function () {
        finish();
    }).catch(function (err) {
        finish();
        var message = rdpErrorText(session, err);
        setRdpOverlay(session, message, 'error');
        setStatus('error', '连接失败');
        showToast(message, 'error');
    });
}

function requestRdpTicket(session) {
    var relay = session.relay || { kind: 'none' };
    var payload = {
        hostname: session.hostname,
        port: session.port,
        relay: {
            kind: relay.kind || 'none',
            host: relay.host || '',
            port: parseInt(relay.port, 10) || 0,
            username: relay.username || '',
            password: relay.password || '',
            privateKey: relay.privateKey || '',
            passphrase: relay.passphrase || '',
            loginType: relay.privateKey ? 1 : 0
        }
    };
    return fetch('/rdp/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    }).then(function (res) {
        return res.json().catch(function () { return { Msg: 'HTTP ' + res.status }; }).then(function (body) {
            if (!res.ok || (body.Msg && body.Msg !== 'success')) {
                throw new Error(body.Msg || ('HTTP ' + res.status));
            }
            return body.Data || {};
        });
    });
}

function startRdpConnection(session, ticketInfo) {
    var mod = session.rdpModule;
    var s = session.rdpSettings;
    var size = rdpTargetSize(session);

    var wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var proxyAddress = wsProtocol + '//' + location.host + '/rdp';

    var builder = new mod.SessionBuilder();
    builder.username(session.username);
    builder.password(session.password);
    if (session.domain) builder.serverDomain(session.domain);
    builder.destination(ticketInfo.destination || (session.hostname + ':' + session.port));
    builder.proxyAddress(proxyAddress);
    builder.authToken(ticketInfo.ticket);
    builder.desktopSize(new mod.DesktopSize(size.width, size.height));
    builder.renderCanvas(session.canvas);
    // NLA/CredSSP 是 Windows 默认要求的，关掉基本连不上现代系统。
    builder.extension(new mod.Extension('enable_credssp', true));

    builder.setCursorStyleCallbackContext(session.canvas);
    builder.setCursorStyleCallback(function (style) {
        session.canvas.style.cursor = style || 'default';
    });
    builder.canvasResizedCallback(function () {
        try {
            var ds = session.rdpSession && session.rdpSession.desktopSize();
            if (ds) {
                session.canvas.width = ds.width;
                session.canvas.height = ds.height;
            }
        } catch (e) { }
    });

    if (s.clipboard) attachRdpClipboard(session, builder, mod);

    return builder.connect().then(function (rdpSession) {
        session.rdpSession = rdpSession;
        session._connected = true;

        var ds = rdpSession.desktopSize();
        session.canvas.width = ds.width;
        session.canvas.height = ds.height;
        applyRdpCanvasScale(session);

        // 远端未必接受我们请求的分辨率。对不上就意味着画面比例和窗口不一致，
        // 四周会留黑边——等界面稳定后再纠正一次。
        if (s.dynamicResize && s.resolution === 'fit') {
            var want = rdpTargetSize(session);
            if (Math.abs(ds.width - want.width) > 2 || Math.abs(ds.height - want.height) > 2) {
                setTimeout(function () { applyRdpResize(session, true); }, 350);
            }
        }

        setRdpOverlay(session, null);
        setStatus('', '就绪');
        renderTabs();

        session._inputCleanup = attachRdpInput(session, mod);
        session.canvas.focus();

        if (s.startFullscreen) setTimeout(function () { toggleRdpFullscreen(session, true); }, 120);

        rdpSession.run().then(function (info) {
            var reason = '';
            try { reason = info.reason(); } catch (e) { }
            handleRdpSessionEnd(session, reason || '会话已结束');
        }).catch(function (err) {
            handleRdpSessionEnd(session, rdpErrorText(session, err));
        });
        return rdpSession;
    });
}

function handleRdpSessionEnd(session, reason) {
    session._connected = false;
    session.rdpSession = null;
    if (session._closing) return;
    setRdpOverlay(session, reason || '远程桌面连接已断开', 'error');
    renderTabs();
}

function rdpErrorText(session, err) {
    if (!err) return '未知错误';
    var mod = session && session.rdpModule;
    if (mod && mod.IronError && err instanceof mod.IronError) {
        var kind = -1;
        try { kind = err.kind(); } catch (e) { }
        // 取值与 IronErrorKind 一一对应，注意 General 是 0。
        var map = {
            0: '连接失败',
            1: '密码错误',
            2: '登录失败：账号、密码或域不正确',
            3: '服务端拒绝访问：该账号可能没有远程桌面登录权限',
            4: '网关握手失败',
            5: '无法连接到网关',
            6: '协议协商失败：目标可能未启用 RDP，或要求了不支持的安全层'
        };
        var text = map[kind] || '连接失败';
        var extra = '';
        try {
            var backtrace = String(err.backtrace() || '');
            // backtrace 里常常带着 Windows 的 NTSTATUS，比笼统的 kind 有用得多。
            var status = backtrace.match(/STATUS_[A-Z_]+/);
            if (status) {
                var statusMap = {
                    STATUS_LOGON_FAILURE: '用户名或密码错误',
                    STATUS_ACCOUNT_DISABLED: '账号已被禁用',
                    STATUS_ACCOUNT_LOCKED_OUT: '账号已被锁定',
                    STATUS_PASSWORD_EXPIRED: '密码已过期，需要先在本机修改',
                    STATUS_PASSWORD_MUST_CHANGE: '首次登录需要先修改密码',
                    STATUS_ACCOUNT_RESTRICTION: '账号被策略限制（例如不允许空密码登录）',
                    STATUS_LOGON_TYPE_NOT_GRANTED: '该账号没有被授予远程登录权限'
                };
                extra = statusMap[status[0]] || status[0];
            } else if (backtrace.indexOf('WebSocket Closed') >= 0) {
                extra = '网关连接被中断';
            }
        } catch (e) { }
        try {
            var details = err.rdcleanpathDetails();
            if (details && !extra) {
                if (details.wsaErrorCode) extra = 'WSA ' + details.wsaErrorCode;
                else if (details.httpStatusCode) extra = 'HTTP ' + details.httpStatusCode;
                else if (details.tlsAlertCode) extra = 'TLS alert ' + details.tlsAlertCode;
            }
        } catch (e) { }
        return extra ? (text + '（' + extra + '）') : text;
    }
    return err.message || String(err);
}

// ==================== 输入 ====================

var RDP_SCANCODES = {
    'Escape': 0x01, 'Digit1': 0x02, 'Digit2': 0x03, 'Digit3': 0x04,
    'Digit4': 0x05, 'Digit5': 0x06, 'Digit6': 0x07, 'Digit7': 0x08,
    'Digit8': 0x09, 'Digit9': 0x0A, 'Digit0': 0x0B, 'Minus': 0x0C,
    'Equal': 0x0D, 'Backspace': 0x0E, 'Tab': 0x0F,
    'KeyQ': 0x10, 'KeyW': 0x11, 'KeyE': 0x12, 'KeyR': 0x13,
    'KeyT': 0x14, 'KeyY': 0x15, 'KeyU': 0x16, 'KeyI': 0x17,
    'KeyO': 0x18, 'KeyP': 0x19, 'BracketLeft': 0x1A, 'BracketRight': 0x1B,
    'Enter': 0x1C, 'ControlLeft': 0x1D,
    'KeyA': 0x1E, 'KeyS': 0x1F, 'KeyD': 0x20, 'KeyF': 0x21,
    'KeyG': 0x22, 'KeyH': 0x23, 'KeyJ': 0x24, 'KeyK': 0x25,
    'KeyL': 0x26, 'Semicolon': 0x27, 'Quote': 0x28, 'Backquote': 0x29,
    'ShiftLeft': 0x2A, 'Backslash': 0x2B,
    'KeyZ': 0x2C, 'KeyX': 0x2D, 'KeyC': 0x2E, 'KeyV': 0x2F,
    'KeyB': 0x30, 'KeyN': 0x31, 'KeyM': 0x32, 'Comma': 0x33,
    'Period': 0x34, 'Slash': 0x35, 'ShiftRight': 0x36,
    'NumpadMultiply': 0x37, 'AltLeft': 0x38, 'Space': 0x39,
    'CapsLock': 0x3A,
    'F1': 0x3B, 'F2': 0x3C, 'F3': 0x3D, 'F4': 0x3E,
    'F5': 0x3F, 'F6': 0x40, 'F7': 0x41, 'F8': 0x42,
    'F9': 0x43, 'F10': 0x44,
    'NumLock': 0x45, 'ScrollLock': 0x46,
    'Numpad7': 0x47, 'Numpad8': 0x48, 'Numpad9': 0x49,
    'NumpadSubtract': 0x4A, 'Numpad4': 0x4B, 'Numpad5': 0x4C,
    'Numpad6': 0x4D, 'NumpadAdd': 0x4E, 'Numpad1': 0x4F,
    'Numpad2': 0x50, 'Numpad3': 0x51, 'Numpad0': 0x52,
    'NumpadDecimal': 0x53,
    'F11': 0x57, 'F12': 0x58,
    'NumpadEnter': 0xE01C, 'ControlRight': 0xE01D,
    'NumpadDivide': 0xE035, 'PrintScreen': 0xE037,
    'AltRight': 0xE038, 'Home': 0xE047, 'ArrowUp': 0xE048,
    'PageUp': 0xE049, 'ArrowLeft': 0xE04B, 'ArrowRight': 0xE04D,
    'End': 0xE04F, 'ArrowDown': 0xE050, 'PageDown': 0xE051,
    'Insert': 0xE052, 'Delete': 0xE053,
    'MetaLeft': 0xE05B, 'MetaRight': 0xE05C, 'ContextMenu': 0xE05D,
    'Pause': 0xE11D45
};

function attachRdpInput(session, mod) {
    var canvas = session.canvas;
    var DeviceEvent = mod.DeviceEvent;
    var InputTransaction = mod.InputTransaction;

    function send(events) {
        if (!session.rdpSession || !events.length) return;
        try {
            var tx = new InputTransaction();
            for (var i = 0; i < events.length; i++) tx.addEvent(events[i]);
            session.rdpSession.applyInputs(tx);
        } catch (e) { }
    }

    function onKeyDown(e) {
        if (!session.rdpSession) return;
        e.preventDefault();
        e.stopPropagation();
        var scancode = RDP_SCANCODES[e.code];
        if (scancode === undefined) return;
        send([DeviceEvent.keyPressed(scancode)]);
    }

    function onKeyUp(e) {
        if (!session.rdpSession) return;
        e.preventDefault();
        e.stopPropagation();
        var scancode = RDP_SCANCODES[e.code];
        if (scancode === undefined) return;
        send([DeviceEvent.keyReleased(scancode)]);
    }

    // 中文等非 ASCII 字符没有对应扫描码，走 Unicode 通道补一次。
    function onBeforeInput(e) {
        if (!session.rdpSession || !session.rdpSettings.unicodeKeyboard) return;
        if (!e.data || e.inputType !== 'insertText') return;
        var chars = Array.from(e.data);
        for (var i = 0; i < chars.length; i++) {
            if (RDP_SCANCODES['Key' + chars[i].toUpperCase()] !== undefined) continue;
            send([DeviceEvent.unicodePressed(chars[i]), DeviceEvent.unicodeReleased(chars[i])]);
        }
    }

    function canvasPoint(e) {
        var rect = canvas.getBoundingClientRect();
        var scaleX = canvas.width / (rect.width || 1);
        var scaleY = canvas.height / (rect.height || 1);
        return {
            x: Math.round((e.clientX - rect.left) * scaleX),
            y: Math.round((e.clientY - rect.top) * scaleY)
        };
    }

    function onMouseMove(e) {
        if (!session.rdpSession) return;
        var p = canvasPoint(e);
        send([DeviceEvent.mouseMove(p.x, p.y)]);
    }

    function onMouseDown(e) {
        e.preventDefault();
        canvas.focus();
        if (!session.rdpSession) return;
        send([DeviceEvent.mouseButtonPressed(e.button)]);
    }

    function onMouseUp(e) {
        e.preventDefault();
        if (!session.rdpSession) return;
        send([DeviceEvent.mouseButtonReleased(e.button)]);
    }

    function onWheel(e) {
        e.preventDefault();
        if (!session.rdpSession) return;
        var events = [];
        if (e.deltaY !== 0) events.push(DeviceEvent.wheelRotations(true, e.deltaY > 0 ? -1 : 1, 1));
        if (e.deltaX !== 0) events.push(DeviceEvent.wheelRotations(false, e.deltaX > 0 ? -1 : 1, 1));
        send(events);
    }

    function onContextMenu(e) { e.preventDefault(); }

    // 失焦时把按下的键全部松开，否则回来时会出现"Ctrl 粘住"的现象。
    function onBlur() {
        if (!session.rdpSession) return;
        try { session.rdpSession.releaseAllInputs(); } catch (e) { }
    }

    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('beforeinput', onBeforeInput);
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', onContextMenu);
    canvas.addEventListener('blur', onBlur);

    return function cleanup() {
        canvas.removeEventListener('keydown', onKeyDown);
        canvas.removeEventListener('keyup', onKeyUp);
        canvas.removeEventListener('beforeinput', onBeforeInput);
        canvas.removeEventListener('mousemove', onMouseMove);
        canvas.removeEventListener('mousedown', onMouseDown);
        canvas.removeEventListener('mouseup', onMouseUp);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('contextmenu', onContextMenu);
        canvas.removeEventListener('blur', onBlur);
    };
}

// ==================== 剪贴板 ====================

function attachRdpClipboard(session, builder, mod) {
    builder.remoteClipboardChangedCallback(function (data) {
        try {
            var items = data.items();
            for (var i = 0; i < items.length; i++) {
                if (items[i].mimeType() === 'text/plain') {
                    var text = items[i].value();
                    if (typeof text === 'string' && navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(function () { });
                    }
                    break;
                }
            }
        } catch (e) { }
    });
    builder.forceClipboardUpdateCallback(function () {
        if (!navigator.clipboard || !navigator.clipboard.readText) return;
        navigator.clipboard.readText().then(function (text) {
            if (!session.rdpSession || typeof text !== 'string') return;
            var data = new mod.ClipboardData();
            data.addText('text/plain', text);
            session.rdpSession.onClipboardPaste(data).catch(function () { });
        }).catch(function () { });
    });
}

// ==================== 尺寸同步 / 全屏 ====================

function scheduleRdpResize(session) {
    if (!session || session.kind !== 'rdp') return;
    if (session._resizeTimer) clearTimeout(session._resizeTimer);
    session._resizeTimer = setTimeout(function () {
        session._resizeTimer = null;
        applyRdpResize(session);
    }, 180);
}

function applyRdpResize(session, force) {
    if (!session.rdpSession || !session._connected) return;
    if (!session.rdpSettings.dynamicResize) return;
    if (session.rdpSettings.resolution !== 'fit') return;
    var size = rdpTargetSize(session);
    var dpr = session.rdpSettings.hiDpi ? (window.devicePixelRatio || 1) : 1;
    if (!force && session._lastResize === size.width + 'x' + size.height) return;
    session._lastResize = size.width + 'x' + size.height;
    try {
        session.rdpSession.resize(size.width, size.height, dpr, null, null);
        // 远端接受与否只能靠回读确认：Win7/2008R2 这类不支持动态分辨率的
        // 系统会静默忽略，画面就会一直和窗口比例对不上。
        setTimeout(function () {
            if (!session.rdpSession) return;
            try {
                var now = session.rdpSession.desktopSize();
                var matched = Math.abs(now.width - size.width) <= 2 && Math.abs(now.height - size.height) <= 2;
                console.debug('[rdp] resize ' + size.width + 'x' + size.height +
                    ' -> 远端 ' + now.width + 'x' + now.height + (matched ? ' (已生效)' : ' (远端未接受)'));
                if (!matched && !session._resizeWarned) {
                    session._resizeWarned = true;
                    showToast('远端未接受动态分辨率，画面按比例缩放显示；可在设置里改用「拉伸填满」', 'info');
                }
            } catch (e) { }
        }, 900);
    } catch (e) { }
}

function toggleRdpFullscreen(session, force) {
    session = session || activeRdpSession();
    if (!session) return;
    var target = session.rdpViewport;
    var isFull = document.fullscreenElement === target;
    if (isFull && force !== true) {
        if (document.exitFullscreen) document.exitFullscreen();
        return;
    }
    if (isFull) return;
    if (!target.requestFullscreen) { showToast('当前浏览器不支持全屏', 'error'); return; }
    target.requestFullscreen().then(function () {
        if (session.rdpSettings.grabKeys && navigator.keyboard && navigator.keyboard.lock) {
            navigator.keyboard.lock(['Escape', 'Tab', 'MetaLeft', 'MetaRight', 'AltLeft', 'AltRight'])
                .then(function () { session._keyboardLocked = true; })
                .catch(function () { });
        }
        session.canvas.focus();
        scheduleRdpResize(session);
    }).catch(function (err) {
        showToast('进入全屏失败: ' + (err.message || err), 'error');
    });
}

function activeRdpSession() {
    var s = activeIdx >= 0 ? sessions[activeIdx] : null;
    return s && s.kind === 'rdp' ? s : null;
}

function reconnectRdpTab() {
    var session = activeRdpSession();
    if (!session) return;
    if (session.rdpSession) {
        try { session.rdpSession.shutdown(); } catch (e) { }
        session.rdpSession = null;
    }
    session._connected = false;
    if (session._inputCleanup) { session._inputCleanup(); session._inputCleanup = null; }
    connectRdpSession(session);
}

function closeRdpSession(session) {
    session._closing = true;
    if (session._resizeTimer) { clearTimeout(session._resizeTimer); session._resizeTimer = null; }
    if (session._inputCleanup) { try { session._inputCleanup(); } catch (e) { } session._inputCleanup = null; }
    if (session._keyboardLocked && navigator.keyboard && navigator.keyboard.unlock) {
        try { navigator.keyboard.unlock(); } catch (e) { }
        session._keyboardLocked = false;
    }
    if (session.rdpSession) {
        try { session.rdpSession.shutdown(); } catch (e) { }
        session.rdpSession = null;
    }
    if (session.resizeObs) { try { session.resizeObs.disconnect(); } catch (e) { } }
}

// ==================== 登录入口 ====================

function connectRdpFromLogin() {
    var btn = document.getElementById('connectBtn');
    btn.classList.add('loading');
    setStatus('connecting', '连接中...');

    var hp = parseHostPortInput(document.getElementById('hostname').value, document.getElementById('port').value);
    var host = hp.host;
    var port = hp.port || 3389;
    var username = document.getElementById('username').value.trim();
    var password = document.getElementById('password').value;
    document.getElementById('hostname').value = formatHostForInput(host);
    document.getElementById('port').value = port;

    if (!host) {
        btn.classList.remove('loading');
        setStatus('error', '请填写主机地址');
        showToast('请填写主机地址', 'error');
        return;
    }

    var relay = activeRdpRelay();
    var settings = rdpSettings();

    // 勾了「在独立窗口中打开」就把这次连接整个交给子窗口，当前页面保持在登录态。
    if (settings.openInNewWindow) {
        var opened = openRdpWindow({
            hostname: host,
            port: port,
            username: username,
            password: password,
            domain: '',
            relay: relay,
            settings: settings
        });
        btn.classList.remove('loading');
        setStatus('', opened ? '已在独立窗口中打开' : '就绪');
        return;
    }

    var session = createRdpSession(host, port, username, {
        password: password,
        domain: '',
        relay: relay
    });
    showView('terminalView');
    switchTab(sessions.length - 1);

    connectRdpSession(session, function () {
        btn.classList.remove('loading');
    });
}

document.addEventListener('fullscreenchange', function () {
    var session = activeRdpSession();
    if (!session) return;
    if (!document.fullscreenElement) {
        if (session._keyboardLocked && navigator.keyboard && navigator.keyboard.unlock) {
            try { navigator.keyboard.unlock(); } catch (e) { }
            session._keyboardLocked = false;
        }
    }
    scheduleRdpResize(session);
});

// ==================== 启动 ====================

function initRdpModule() {
    syncRdpWindowCheckbox();
    document.addEventListener('mousemove', handleRdpBarPointer);
    applyRdpToolbarMode();
    // 交接必须放在最后：它可能直接切到终端视图并发起连接。
    initRdpHandoffTarget();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initRdpModule);
} else {
    setTimeout(initRdpModule, 0);
}
