// ==================== 连接设置菜单 & 连接分享 ====================
// 这个文件承载终端顶栏右侧「设置」下拉，以及「分享连接」对话框的全部逻辑。
//
// 分享只有一种方式：浏览器本地用 AES-GCM 加密，只把密文 POST 给服务端换一个
// 短 token，密钥留在 /s/<token>#k=<key> 的 # 之后。浏览器从不把 # 发给服务器，
// 所以服务端全程只见密文，拿不到密码。
//
// 早期版本还有一种「明文分享」，凭据直接编码在 # 里、完全不经过服务器。
// 那种链接既无法撤销也无法过期，已经废弃：现在每条分享都在服务端有记录，
// 可以随时删除，且最长 24 小时自动失效。
//
// 完整链接（含解密密钥）只保存在生成它的这台浏览器里——服务端没有密钥，
// 也就不可能替用户把链接再拼出来。换设备后仍能看到列表并撤销。

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

function connectionShareCryptoAvailable() {
    return !!(window.crypto && window.crypto.subtle &&
        typeof window.crypto.subtle.generateKey === 'function' && window.isSecureContext !== false);
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

    // 分享一律走浏览器端加密，而 crypto.subtle 在非 HTTPS（且非 localhost）
    // 下根本不存在。与其生成一条假装加密的链接，不如把生成按钮禁掉说清原因。
    var generate = document.getElementById('connectionShareGenerateButton');
    var note = document.getElementById('connectionShareSecurityNote');
    var cryptoOk = connectionShareCryptoAvailable();
    if (generate) {
        generate.disabled = !cryptoOk;
        generate.textContent = cryptoOk ? '生成分享链接' : '当前站点不支持加密分享';
    }
    if (note) {
        note.innerHTML = cryptoOk
            ? '<strong>注意：</strong>凭据在你的浏览器里加密，服务器只存密文；但拿到完整链接的人依然能连上这台服务器。所有链接最长 24 小时后自动失效。'
            : '<strong>无法分享：</strong>当前站点不是 HTTPS，浏览器禁用了加密接口。请给站点配置 HTTPS 后再使用分享功能。';
    }

    renderConnectionShareHistory();
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

// ==================== 本地分享记录 ====================
//
// 服务端只有密文和元信息，解密密钥永远只在链接的 # 之后。所以要能「再次
// 复制完整链接」，就只能把链接留在生成它的这台浏览器里。
// 换设备后仍然能通过服务端列表看到并撤销分享，只是复制不出完整链接。

var CONNECTION_SHARE_HISTORY_KEY = 'webssh_share_history';
var CONNECTION_SHARE_MAX_TTL = 24 * 60 * 60 * 1000;
var connectionShareHistoryOpen = false;
var connectionShareHistoryGeneration = 0;

function connectionShareHistoryScope() {
    var account = typeof currentAccount === 'undefined' ? null : currentAccount;
    var username = account && account.username ? String(account.username).trim().toLowerCase() : '';
    return username ? 'account:' + username : 'guest';
}

function connectionShareIdentitySnapshot() {
    return {
        scope: connectionShareHistoryScope(),
        generation: typeof authStateGeneration === 'undefined' ? 0 : authStateGeneration
    };
}

function connectionShareIdentityIsCurrent(snapshot) {
    var current = connectionShareIdentitySnapshot();
    return snapshot.scope === current.scope && snapshot.generation === current.generation;
}

function connectionShareResponseScope(data, fallbackScope) {
    if (!data || !Object.prototype.hasOwnProperty.call(data, 'historyScope')) return fallbackScope;
    var scope = data.historyScope;
    if (typeof scope !== 'string' || (scope !== 'guest' && !/^account:[^\s:]+$/.test(scope))) {
        throw new Error('服务器返回的分享归属无效');
    }
    return scope;
}

function connectionShareHistoryStorageKey(scope) {
    return CONNECTION_SHARE_HISTORY_KEY + '::' + encodeURIComponent(scope || connectionShareHistoryScope());
}

function readConnectionShareHistoryItems(storageKey) {
    var raw = [];
    try {
        raw = JSON.parse(safeStorageGet(storageKey) || '[]');
    } catch (e) {
        raw = [];
    }
    if (!Array.isArray(raw)) raw = [];
    var now = Date.now();
    // 无论当初选了多久，本地记录也一律不超过 24 小时。
    return raw.filter(function (item) {
        return item && typeof item.token === 'string' && item.expiresAt > now &&
            (now - (item.createdAt || 0)) < CONNECTION_SHARE_MAX_TTL;
    });
}

function readConnectionShareHistory(scope) {
    return readConnectionShareHistoryItems(connectionShareHistoryStorageKey(scope));
}

function writeConnectionShareHistory(items, scope) {
    try {
        return safeStorageSet(connectionShareHistoryStorageKey(scope), JSON.stringify(items.slice(0, 50)));
    } catch (error) { return false; }
}

function rememberConnectionShare(entry, scope) {
    var items = readConnectionShareHistory(scope).filter(function (item) { return item.token !== entry.token; });
    items.unshift(entry);
    return writeConnectionShareHistory(items, scope);
}

function forgetConnectionShare(token, scope) {
    return writeConnectionShareHistory(readConnectionShareHistory(scope).filter(function (item) {
        return item.token !== token;
    }), scope);
}

function connectionShareRelativeTime(ts) {
    var diff = ts - Date.now();
    if (diff <= 0) return '已过期';
    var minutes = Math.round(diff / 60000);
    if (minutes < 60) return minutes + ' 分钟后失效';
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + ' 小时' + (rest ? rest + ' 分钟' : '') + '后失效';
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
    var identity = connectionShareIdentitySnapshot();
    var session = connectionShareActiveSession();
    var payload = session ? buildConnectionSharePayload(session) : null;
    if (!payload) {
        showToast('没有可分享的连接', 'error');
        return;
    }
    if (!connectionShareCryptoAvailable()) {
        showToast('当前站点不是 HTTPS，浏览器禁用了加密接口，无法分享', 'error');
        return;
    }
    var output = document.getElementById('connectionShareUrl');
    var expirySelect = document.getElementById('connectionShareExpiry');
    var burnBox = document.getElementById('connectionShareBurn');
    var expiresIn = expirySelect ? parseInt(expirySelect.value, 10) : 3600;
    if (!expiresIn || expiresIn < 60) expiresIn = 3600;
    if (expiresIn > 24 * 60 * 60) expiresIn = 24 * 60 * 60;
    var burn = !!(burnBox && burnBox.checked);
    // 说明文字会明文存在服务端，只能放主机和协议，绝不能带密码。
    var label = connectionShareSummaryText(session);

    connectionShareSetBusy(true, '加密中…');
    return encryptConnectionSharePayload(payload).then(function (encrypted) {
        if (!connectionShareIdentityIsCurrent(identity)) throw new Error('账号已切换，请重新生成分享链接');
        connectionShareSetBusy(true, '上传中…');
        return fetch('/api/share', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                ciphertext: encrypted.ciphertext,
                iv: encrypted.iv,
                label: label,
                kind: payload.kind,
                expiresIn: expiresIn,
                burn: burn
            })
        }).then(function (response) {
            return response.json().catch(function () { return null; }).then(function (body) {
                if (!response.ok || !body || body.ok !== true || !body.data || !body.data.token) {
                    throw new Error((body && body.msg) || '服务器拒绝了分享请求');
                }
                return body.data;
            });
        }).then(function (data) {
            var responseScope = connectionShareResponseScope(data, identity.scope);
            var link = connectionShareOrigin() + CONNECTION_SHARE_PATH_PREFIX + data.token + '#k=' + encrypted.key;
            var remembered = rememberConnectionShare({
                token: data.token,
                id: data.id || '',
                link: link,
                label: label,
                kind: payload.kind,
                burn: burn,
                createdAt: Date.now(),
                expiresAt: (data.expiresAt ? data.expiresAt * 1000 : Date.now() + expiresIn * 1000)
            }, responseScope);
            if (responseScope !== identity.scope || !connectionShareIdentityIsCurrent(identity)) {
                if (typeof refreshAccountState === 'function') refreshAccountState();
                showToast(remembered ? '分享链接已保留在所属身份的本地历史中' : '分享已生成，但本地历史保存失败', remembered ? 'info' : 'error');
                return;
            }
            if (output) output.value = link;
            renderConnectionShareHistory();
            showToast('分享链接已生成', 'success');
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

// ==================== 分享历史 ====================

function toggleConnectionShareHistory() {
    connectionShareHistoryOpen = !connectionShareHistoryOpen;
    var panel = document.getElementById('connectionShareHistoryPanel');
    var toggle = document.getElementById('connectionShareHistoryToggle');
    if (panel) panel.hidden = !connectionShareHistoryOpen;
    if (toggle) {
        toggle.setAttribute('aria-expanded', connectionShareHistoryOpen ? 'true' : 'false');
        toggle.classList.toggle('open', connectionShareHistoryOpen);
    }
    if (connectionShareHistoryOpen) renderConnectionShareHistory();
}

// 列表以服务端为准（它才知道链接到底还在不在），完整链接从本地记录里补。
// 服务端查不到时退回纯本地渲染，至少让用户还能复制和清理自己的记录。
function renderConnectionShareHistory() {
    var list = document.getElementById('connectionShareHistoryList');
    var count = document.getElementById('connectionShareHistoryCount');
    var hint = document.getElementById('connectionShareHistoryHint');
    if (!list) return;
    var identity = connectionShareIdentitySnapshot();
    var requestGeneration = ++connectionShareHistoryGeneration;
    var local = readConnectionShareHistory(identity.scope);
    var originalTokens = Object.create(null);
    local.forEach(function (item) { originalTokens[item.token] = true; });

    function paint(items, loggedIn, serverAware) {
        if (count) count.textContent = items.length ? String(items.length) : '';
        if (hint) {
            hint.textContent = !serverAware
                ? '无法连接服务器，下面是本机保存的记录。'
                : (loggedIn
                    ? '已登录，分享记录跟着账号走，换设备也能在这里撤销。'
                    : '未登录，分享记录只存在这台浏览器里。登录后新建的分享会记到账号上。');
        }
        if (!items.length) {
            list.innerHTML = '<div class="connection-share-history-empty">还没有生成过分享链接。</div>';
            return;
        }
        list.innerHTML = items.map(function (item) {
            var canCopy = !!item.link;
            return '<div class="connection-share-history-item">' +
                '<div class="connection-share-history-meta">' +
                '<span class="connection-share-history-label">' + esc(item.label || '未命名分享') + '</span>' +
                '<span class="connection-share-history-sub">' + esc(connectionShareRelativeTime(item.expiresAt)) +
                (item.burn ? ' · 阅后即焚' : '') +
                (canCopy ? '' : ' · 本机没有链接副本') + '</span>' +
                '</div>' +
                '<div class="connection-share-history-actions">' +
                (canCopy
                    ? '<button class="tb-btn" type="button" title="复制链接" aria-label="复制链接" data-share-copy="' + escAttr(item.token) + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>'
                    : '') +
                '<button class="tb-btn danger" type="button" title="删除分享" aria-label="删除分享" data-share-delete="' + escAttr(item.id || item.token) + '" data-share-token="' + escAttr(item.token || '') + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6M10 11v6M14 11v6M9 6V4a2 2 0 012-2h2a2 2 0 012 2v2"/></svg></button>' +
                '</div></div>';
        }).join('');
    }

    paint(local, false, false);

    return fetch('/api/shares', { credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (body) {
            if (requestGeneration !== connectionShareHistoryGeneration || !connectionShareIdentityIsCurrent(identity)) return;
            if (!body || body.ok !== true || !body.data) throw new Error('bad response');
            var responseScope = connectionShareResponseScope(body.data, identity.scope);
            if (responseScope !== identity.scope || (body.data.loggedIn === true) !== (responseScope !== 'guest')) {
                if (typeof refreshAccountState === 'function') refreshAccountState();
                return;
            }
            var alive = Object.create(null);
            (body.data.items || []).forEach(function (entry) { alive[entry.id] = true; });
            local = readConnectionShareHistory(identity.scope);
            var localTokens = Object.create(null);
            local.forEach(function (item) { localTokens[item.token] = true; });
            var legacy = readConnectionShareHistoryItems(CONNECTION_SHARE_HISTORY_KEY);
            var migrated = legacy.filter(function (item) { return item.id && alive[item.id] && !localTokens[item.token]; });
            if (migrated.length) {
                var combined = local.concat(migrated).slice(0, 50);
                if (writeConnectionShareHistory(combined, identity.scope)) {
                    local = combined;
                    var copiedTokens = Object.create(null);
                    combined.forEach(function (item) { copiedTokens[item.token] = true; });
                    safeStorageSet(CONNECTION_SHARE_HISTORY_KEY, JSON.stringify(legacy.filter(function (item) {
                        return !alive[item.id] || !copiedTokens[item.token];
                    })));
                }
            }
            var merged = (body.data.items || []).map(function (entry) {
                // 服务端只认存储键；本地记录里存了同一个键，用它反查完整链接。
                var match = null;
                for (var i = 0; i < local.length; i++) {
                    if (local[i].id && local[i].id === entry.id) { match = local[i]; break; }
                }
                return {
                    id: entry.id,
                    token: match ? match.token : '',
                    link: match ? match.link : '',
                    label: entry.label || (match && match.label) || '',
                    burn: !!entry.burn,
                    expiresAt: (entry.expiresAt || 0) * 1000
                };
            });
            paint(merged, body.data.loggedIn === true, true);

            // 服务端是权威：阅后即焚被对方打开烧掉、在别的设备上删除、或已过期，
            // 服务端都不再返回。本地记录跟着清掉，否则生成端历史里会一直挂着
            // 一条死链，点复制还会复制出去。
            var pruned = local.filter(function (item) { return !item.id || alive[item.id] || !originalTokens[item.token]; });
            if (pruned.length !== local.length) writeConnectionShareHistory(pruned, identity.scope);
        })
        .catch(function () { /* 服务端不可用时保留本地渲染 */ });
}

function copyConnectionShareHistoryLink(token) {
    var item = readConnectionShareHistory().filter(function (x) { return x.token === token; })[0];
    if (!item || !item.link) {
        showToast('这台浏览器上没有保存这条链接的副本', 'info');
        return;
    }
    var output = document.getElementById('connectionShareUrl');
    if (output) output.value = item.link;
    copyConnectionShareLink();
}

function deleteConnectionShare(id, token) {
    if (!id) return;
    var identity = connectionShareIdentitySnapshot();
    return fetch('/api/shares/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' })
        .then(function (r) {
            return r.json().catch(function () { return null; }).then(function (body) {
                if (!r.ok && r.status !== 404) {
                    throw new Error((body && body.msg) || '删除失败');
                }
                var responseScope = connectionShareResponseScope(body && body.data, '');
                if (responseScope !== identity.scope) {
                    if (typeof refreshAccountState === 'function') refreshAccountState();
                    return false;
                }
                return true;
            });
        })
        .then(function (deleted) {
            if (!deleted) return;
            if (token) forgetConnectionShare(token, identity.scope);
            if (connectionShareIdentityIsCurrent(identity)) renderConnectionShareHistory();
            showToast('分享链接已删除', 'success');
        })
        .catch(function (err) {
            showToast((err && err.message) || '删除分享失败', 'error');
        });
}

document.addEventListener('click', function (event) {
    var copyBtn = event.target && event.target.closest && event.target.closest('[data-share-copy]');
    if (copyBtn) {
        event.preventDefault();
        copyConnectionShareHistoryLink(copyBtn.getAttribute('data-share-copy'));
        return;
    }
    var delBtn = event.target && event.target.closest && event.target.closest('[data-share-delete]');
    if (delBtn) {
        event.preventDefault();
        deleteConnectionShare(delBtn.getAttribute('data-share-delete'), delBtn.getAttribute('data-share-token'));
    }
});

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
    // 用 replaceState 而不是 location.hash=，后者会往浏览器历史里塞一条
    // 带明文凭据的记录。tryAutoLogin 成功后会再 replaceState 成 '/'。
    history.replaceState(null, '', '/#ssh=' + shareTextToBase64Url(JSON.stringify(payload.data)));
    if (typeof urlAutoLoginHandled !== 'undefined') urlAutoLoginHandled = false;
    tryAutoLogin();
    return true;
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
    // 早期版本发过一种把凭据直接编码在 # 里的明文分享链接。那种链接无法
    // 撤销也无法过期，已经废弃；遇到时明确拒绝，而不是安静地不反应。
    var raw = String(location.hash || '').replace(/^#/, '');
    if (raw && new URLSearchParams(raw).get('rdp')) {
        history.replaceState(null, '', '/');
        showToast('这是旧版明文分享链接，已停用。请让分享者重新生成。', 'error');
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', tryConnectionShareAutoConnect);
} else {
    tryConnectionShareAutoConnect();
}
