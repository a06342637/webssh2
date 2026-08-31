// ==================== 连接设置菜单 & 连接分享 ====================
// 这个文件承载终端顶栏右侧「设置」下拉，以及「分享连接」对话框的全部逻辑。
// 分享分两种：
//   明文分享 —— 凭据 base64 编码后直接挂在 URL 的 # 之后，不经过服务器，
//               复用 app.js 里既有的 #ssh= 直连格式（parseUrlLoginFragment）。
//   隐私分享 —— 浏览器本地用 AES-GCM 加密，只把密文 POST 给服务端换一个短 token，
//               密钥留在 /s/<token>#k=<key> 的 # 之后。浏览器从不把 # 发给服务器，
//               所以服务端全程只见密文，拿不到密码。

var CONNECTION_SHARE_PATH_PREFIX = '/s/';
var connectionShareBusy = false;

// ==================== 设置菜单 ====================

function connectionSettingsElements() {
    return {
        button: document.getElementById('connectionSettingsButton'),
        menu: document.getElementById('connectionSettingsMenu')
    };
}

function closeConnectionSettingsMenu() {
    var el = connectionSettingsElements();
    if (!el.menu || !el.menu.classList.contains('show')) return;
    el.menu.classList.remove('show');
    el.menu.setAttribute('aria-hidden', 'true');
    if (el.button) el.button.setAttribute('aria-expanded', 'false');
}

function toggleConnectionSettingsMenu() {
    var el = connectionSettingsElements();
    if (!el.menu) return;
    if (el.menu.classList.contains('show')) {
        closeConnectionSettingsMenu();
        return;
    }
    // 色板是懒渲染的：原来由 toggleColorPicker 负责，现在配色区块内联在菜单里，
    // 改成每次展开菜单时重画一次，保证选中态跟当前主题一致。
    if (typeof renderSwatches === 'function') {
        try { renderSwatches(); } catch (e) { }
    }
    el.menu.classList.add('show');
    el.menu.setAttribute('aria-hidden', 'false');
    if (el.button) el.button.setAttribute('aria-expanded', 'true');
}

document.addEventListener('click', function (event) {
    var el = connectionSettingsElements();
    if (!el.menu || !el.menu.classList.contains('show')) return;
    if (el.menu.contains(event.target)) return;
    if (el.button && el.button.contains(event.target)) return;
    closeConnectionSettingsMenu();
});

document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var el = connectionSettingsElements();
    if (el.menu && el.menu.classList.contains('show')) {
        closeConnectionSettingsMenu();
        if (el.button && typeof el.button.focus === 'function') el.button.focus();
        return;
    }
    var modal = document.getElementById('connectionShareModal');
    if (modal && modal.classList.contains('show')) closeConnectionShareModal();
});

// ==================== base64url 编解码 ====================

function shareBytesToBase64Url(bytes) {
    var view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var binary = '';
    for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function shareBase64UrlToBytes(value) {
    var normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) normalized += '=';
    var binary = atob(normalized);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function shareTextToBase64Url(text) {
    return shareBytesToBase64Url(new TextEncoder().encode(String(text)));
}

function shareBase64UrlToText(value) {
    return new TextDecoder('utf-8', { fatal: true }).decode(shareBase64UrlToBytes(value));
}

// ==================== 采集当前连接的凭据 ====================

function connectionShareActiveSession() {
    if (typeof sessions === 'undefined' || typeof activeIdx === 'undefined') return null;
    if (activeIdx < 0 || activeIdx >= sessions.length) return null;
    return sessions[activeIdx] || null;
}

// 把当前会话还原成一份「能直接拿去重连」的凭据对象。
// SSH 直接复用 session.sshInfo（buildSSHInfoFromForm 产出的 base64(JSON)），
// 它的字段跟 parseUrlLoginFragment 期望的完全一致，不需要另造一套格式。
function buildConnectionSharePayload(session) {
    if (!session) return null;
    if (session.kind === 'rdp') {
        return {
            kind: 'rdp',
            data: {
                hostname: session.hostname,
                port: session.port,
                username: session.username || '',
                password: session.password || '',
                domain: session.domain || '',
                relay: session.relay || { kind: 'none' }
            }
        };
    }
    if (!session.sshInfo) return null;
    var decoded;
    try {
        decoded = JSON.parse(decodeURIComponent(escape(atob(session.sshInfo))));
    } catch (e) {
        return null;
    }
    if (!decoded || typeof decoded !== 'object') return null;
    // trustScope 是本机的主机密钥信任域，属于接收方自己的东西，不能跟着链接外传。
    delete decoded.trustScope;
    return { kind: 'ssh', data: decoded };
}

function connectionShareSummaryText(session) {
    if (!session) return '';
    var proto = session.kind === 'rdp' ? 'RDP' : 'SSH';
    var user = session.username || (session.kind === 'rdp' ? '' : 'root');
    var host = session.hostname || '';
    var port = session.port || (session.kind === 'rdp' ? 3389 : 22);
    if (host.indexOf(':') !== -1 && host.charAt(0) !== '[') host = '[' + host + ']';
    return proto + ' · ' + (user ? user + '@' : '') + host + ':' + port;
}

// ==================== 分享对话框 ====================

function connectionShareIsPrivateMode() {
    var radio = document.getElementById('connectionShareModePrivate');
    return !!(radio && radio.checked);
}

function connectionShareCryptoAvailable() {
    return !!(window.crypto && window.crypto.subtle &&
        typeof window.crypto.subtle.generateKey === 'function' && window.isSecureContext !== false);
}

function onConnectionShareModeChange() {
    var options = document.getElementById('connectionSharePrivateOptions');
    var note = document.getElementById('connectionShareSecurityNote');
    var isPrivate = connectionShareIsPrivateMode();
    if (options) options.hidden = !isPrivate;
    if (note) {
        note.innerHTML = isPrivate
            ? '<strong>提示：</strong>密钥在链接的 # 之后，服务器只存密文。但拿到完整链接的人依然能连上这台服务器。'
            : '<strong>注意：</strong>链接包含登录凭据，等同于把这台服务器的账号密码交出去。只发给你信任的人。';
    }
    var url = document.getElementById('connectionShareUrl');
    if (url) url.value = '';
}

function openConnectionShareModal() {
    closeConnectionSettingsMenu();
    var session = connectionShareActiveSession();
    var modal = document.getElementById('connectionShareModal');
    if (!modal) return;
    if (!session) {
        showToast('没有可分享的连接', 'error');
        return;
    }
    var payload = buildConnectionSharePayload(session);
    if (!payload) {
        showToast('这个连接缺少可分享的凭据信息', 'error');
        return;
    }

    var summary = document.getElementById('connectionShareSummary');
    if (summary) summary.textContent = connectionShareSummaryText(session);
    var url = document.getElementById('connectionShareUrl');
    if (url) url.value = '';

    // 非 HTTPS（且非 localhost）下 crypto.subtle 根本不存在，隐私分享无法加密。
    // 与其生成一条假装加密的链接，不如直接禁用并说清楚原因。
    var privateRadio = document.getElementById('connectionShareModePrivate');
    var plainRadio = document.getElementById('connectionShareModePlain');
    var hint = document.getElementById('connectionSharePrivateHint');
    if (privateRadio) {
        var cryptoOk = connectionShareCryptoAvailable();
        privateRadio.disabled = !cryptoOk;
        if (!cryptoOk) {
            if (privateRadio.checked && plainRadio) plainRadio.checked = true;
            if (hint) hint.textContent = '当前站点不是 HTTPS，浏览器禁用了加密接口，隐私分享不可用。请改用明文分享，或给站点配置 HTTPS。';
        }
    }
    onConnectionShareModeChange();

    modal.classList.add('show');
    modal.setAttribute('aria-hidden', 'false');
}

function closeConnectionShareModal() {
    var modal = document.getElementById('connectionShareModal');
    if (!modal) return;
    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
    var url = document.getElementById('connectionShareUrl');
    if (url) url.value = '';
}

function connectionShareSetBusy(busy, label) {
    connectionShareBusy = busy;
    var btn = document.getElementById('connectionShareGenerateButton');
    if (!btn) return;
    btn.disabled = busy;
    btn.textContent = busy ? (label || '生成中…') : '生成分享链接';
}

function connectionShareOrigin() {
    return location.protocol + '//' + location.host;
}

function buildPlainShareLink(payload) {
    var encoded = shareTextToBase64Url(JSON.stringify(payload.data));
    return connectionShareOrigin() + '/#' + (payload.kind === 'rdp' ? 'rdp=' : 'ssh=') + encoded;
}

function encryptConnectionSharePayload(payload) {
    var plaintext = JSON.stringify(payload);
    var key;
    return window.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'])
        .then(function (generated) {
            key = generated;
            var iv = window.crypto.getRandomValues(new Uint8Array(12));
            return window.crypto.subtle.encrypt(
                { name: 'AES-GCM', iv: iv }, key, new TextEncoder().encode(plaintext)
            ).then(function (cipher) {
                return { cipher: cipher, iv: iv };
            });
        })
        .then(function (result) {
            return window.crypto.subtle.exportKey('raw', key).then(function (raw) {
                return {
                    ciphertext: shareBytesToBase64Url(result.cipher),
                    iv: shareBytesToBase64Url(result.iv),
                    key: shareBytesToBase64Url(raw)
                };
            });
        });
}

function generateConnectionShareLink() {
    if (connectionShareBusy) return;
    var session = connectionShareActiveSession();
    var payload = session ? buildConnectionSharePayload(session) : null;
    if (!payload) {
        showToast('没有可分享的连接', 'error');
        return;
    }
    var output = document.getElementById('connectionShareUrl');

    if (!connectionShareIsPrivateMode()) {
        var link = buildPlainShareLink(payload);
        if (output) output.value = link;
        showToast('明文分享链接已生成', 'success');
        return;
    }

    if (!connectionShareCryptoAvailable()) {
        showToast('当前站点不是 HTTPS，无法加密，请改用明文分享', 'error');
        return;
    }

    var expirySelect = document.getElementById('connectionShareExpiry');
    var burnBox = document.getElementById('connectionShareBurn');
    var expiresIn = expirySelect ? parseInt(expirySelect.value, 10) : 3600;
    if (!expiresIn || expiresIn < 60) expiresIn = 3600;

    connectionShareSetBusy(true, '加密中…');
    encryptConnectionSharePayload(payload).then(function (encrypted) {
        connectionShareSetBusy(true, '上传中…');
        return fetch('/api/share', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                expiresIn: expiresIn,
                burn: !!(burnBox && burnBox.checked)
            })
        }).then(function (response) {
            return response.json().catch(function () { return null; }).then(function (body) {
                if (!response.ok || !body || body.ok !== true || !body.data || !body.data.token) {
                    throw new Error((body && body.msg) || '服务器拒绝了分享请求');
                }
                return body.data.token;
            });
        }).then(function (token) {
            var link = connectionShareOrigin() + CONNECTION_SHARE_PATH_PREFIX + token + '#k=' + encrypted.key;
            if (output) output.value = link;
            showToast('隐私分享链接已生成', 'success');
        });
    }).catch(function (error) {
        showToast((error && error.message) || '生成分享链接失败', 'error');
    }).then(function () {
        connectionShareSetBusy(false);
    });
}

function copyConnectionShareLink() {
    var output = document.getElementById('connectionShareUrl');
    if (!output || !output.value) {
        showToast('请先生成分享链接', 'info');
        return;
    }
    var text = output.value;
    function fallbackCopy() {
        try {
            output.removeAttribute('readonly');
            output.focus();
            output.select();
            var ok = document.execCommand('copy');
            output.setAttribute('readonly', 'readonly');
            showToast(ok ? '链接已复制' : '复制失败，请手动选中复制', ok ? 'success' : 'error');
        } catch (e) {
            showToast('复制失败，请手动选中复制', 'error');
        }
    }
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext !== false) {
        navigator.clipboard.writeText(text).then(function () {
            showToast('链接已复制', 'success');
        }).catch(fallbackCopy);
        return;
    }
    fallbackCopy();
}

// ==================== 接收端：打开分享链接后自动连接 ====================

function connectionShareApplyPayload(payload) {
    if (!payload || !payload.data) return false;
    if (payload.kind === 'rdp') {
        if (typeof startRdpFromHandoff !== 'function') {
            showToast('远程桌面模块尚未就绪', 'error');
            return false;
        }
        startRdpFromHandoff({
            hostname: payload.data.hostname,
            port: payload.data.port || 3389,
            username: payload.data.username || '',
            password: payload.data.password || '',
            domain: payload.data.domain || '',
            relay: payload.data.relay || { kind: 'none' }
        });
        return true;
    }
    // SSH 走 app.js 既有的 #ssh= 自动登录链路：写回 hash 再交给 tryAutoLogin，
    // 表单填充、认证方式切换、自动连接全部沿用原逻辑，不另起一套。
    if (typeof tryAutoLogin !== 'function') return false;
    location.hash = 'ssh=' + shareTextToBase64Url(JSON.stringify(payload.data));
    if (typeof urlAutoLoginHandled !== 'undefined') urlAutoLoginHandled = false;
    tryAutoLogin();
    return true;
}

function connectionShareParsePlainRdpHash(hash) {
    var raw = String(hash || '').replace(/^#/, '');
    if (!raw) return null;
    var encoded = new URLSearchParams(raw).get('rdp');
    if (!encoded) return null;
    try {
        var data = JSON.parse(shareBase64UrlToText(encoded));
        if (!data || typeof data !== 'object' || !data.hostname) return null;
        return { kind: 'rdp', data: data };
    } catch (e) {
        return null;
    }
}

function connectionShareTokenFromPath(pathname) {
    var path = String(pathname || '');
    if (path.indexOf(CONNECTION_SHARE_PATH_PREFIX) !== 0) return '';
    var token = path.slice(CONNECTION_SHARE_PATH_PREFIX.length).replace(/\/+$/, '');
    return /^[A-Za-z0-9_-]{8,128}$/.test(token) ? token : '';
}

function connectionShareResolveToken(token, keyValue) {
    if (!connectionShareCryptoAvailable()) {
        showToast('当前站点不是 HTTPS，无法解密分享链接', 'error');
        return;
    }
    var keyBytes;
    try {
        keyBytes = shareBase64UrlToBytes(keyValue);
    } catch (e) {
        showToast('分享链接的密钥格式不正确', 'error');
        return;
    }
    if (keyBytes.length !== 32) {
        showToast('分享链接的密钥格式不正确', 'error');
        return;
    }

    showToast('正在打开分享的连接…', 'info');
    fetch('/api/share/' + encodeURIComponent(token), { credentials: 'same-origin' })
        .then(function (response) {
            return response.json().catch(function () { return null; }).then(function (body) {
                if (!response.ok || !body || body.ok !== true || !body.data) {
                    throw new Error((body && body.msg) || '分享链接已失效或不存在');
                }
                return body.data;
            });
        })
        .then(function (data) {
            return window.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['decrypt'])
                .then(function (key) {
                    return window.crypto.subtle.decrypt(
                        { name: 'AES-GCM', iv: shareBase64UrlToBytes(data.iv) },
                        key,
                        shareBase64UrlToBytes(data.ciphertext)
                    );
                });
        })
        .then(function (plain) {
            var payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
            history.replaceState(null, '', '/');
            if (!connectionShareApplyPayload(payload)) {
                showToast('分享链接的内容无法识别', 'error');
            }
        })
        .catch(function (error) {
            history.replaceState(null, '', '/');
            var message = (error && error.message) || '';
            // 解密失败几乎只有一个原因：链接里的 # 密钥被截断或改动过。
            showToast(message || '分享链接已失效，或密钥不完整', 'error');
        });
}

function tryConnectionShareAutoConnect() {
    var token = connectionShareTokenFromPath(location.pathname);
    if (token) {
        var key = new URLSearchParams(String(location.hash || '').replace(/^#/, '')).get('k');
        if (!key) {
            history.replaceState(null, '', '/');
            showToast('分享链接缺少密钥，无法打开', 'error');
            return;
        }
        connectionShareResolveToken(token, key);
        return;
    }
    var plainRdp = connectionShareParsePlainRdpHash(location.hash);
    if (plainRdp) {
        history.replaceState(null, '', '/');
        // RDP 的 WASM 客户端由 rdp.js 异步加载，稍等一拍再发起，避免抢在脚本就绪前。
        setTimeout(function () { connectionShareApplyPayload(plainRdp); }, 300);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryConnectionShareAutoConnect);
} else {
    tryConnectionShareAutoConnect();
}
