const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'js', 'app.js'), 'utf8');
const styleSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'css', 'style.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const composeSource = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
const setupSource = fs.readFileSync(path.join(__dirname, '..', 'setup.sh'), 'utf8');
const updateScriptSource = fs.readFileSync(path.join(__dirname, '..', 'update.sh'), 'utf8');

function extractFunction(name) {
    const start = appSource.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'missing function ' + name);
    const open = appSource.indexOf('{', start);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let regex = false;
    let regexClass = false;
    for (let i = open; i < appSource.length; i++) {
        const ch = appSource[i];
        const next = appSource[i + 1];
        if (lineComment) {
            if (ch === '\n') lineComment = false;
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                i++;
            }
            continue;
        }
        if (regex) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '[') regexClass = true;
            else if (ch === ']') regexClass = false;
            else if (ch === '/' && !regexClass) regex = false;
            continue;
        }
        if (quote) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === quote) quote = '';
            continue;
        }
        if (ch === '/' && next === '/') {
            lineComment = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            blockComment = true;
            i++;
            continue;
        }
        if (ch === '/') {
            let previousIndex = i - 1;
            while (previousIndex >= open && /\s/.test(appSource[previousIndex])) previousIndex--;
            const previous = previousIndex >= open ? appSource[previousIndex] : '';
            if (!previous || /[\(\[\{=,:;!?&|+\-*%^~<>]/.test(previous)) {
                regex = true;
                regexClass = false;
                escaped = false;
                continue;
            }
        }
        if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
            continue;
        }
        if (ch === '{') depth++;
        if (ch === '}' && --depth === 0) return appSource.slice(start, i + 1);
    }
    throw new Error('unterminated function ' + name);
}

function loadFunctions(names, sandbox) {
    vm.createContext(sandbox);
    vm.runInContext(names.map(extractFunction).join('\n'), sandbox);
    return sandbox;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function flushPromises() {
    return new Promise((resolve) => setImmediate(resolve));
}

test('Docker deployment defaults to a publicly reachable bind address', () => {
    assert.match(composeSource, /\$\{BIND_ADDRESS:-0\.0\.0\.0\}:\$\{PORT:-8008\}/);
    assert.match(setupSource, /\[回车\]=监听所有网卡/);
    assert.match(setupSource, /else\s+\n?\s*BIND_ADDRESS=0\.0\.0\.0/);
});

test('guest SSH and SFTP access is the deployment default but remains configurable', () => {
    assert.match(composeSource, /WEBSSH_REQUIRE_ACCOUNT=\$\{WEBSSH_REQUIRE_ACCOUNT:-false\}/);
    assert.match(setupSource, /是否禁止游客直接连接 SSH\/SFTP/);
    assert.match(setupSource, /WEBSSH_REQUIRE_ACCOUNT=%s/);
    assert.match(appSource, /var requireGatewayAccount = false;/);
    assert.match(appSource, /requireGatewayAccount = !!\(cfg && cfg\.requireAccount === true\);/);
});

test('local script timestamps stay monotonic even when the wall clock is behind', () => {
    const storage = new Map([['updated', '5000']]);
    const sandbox = loadFunctions(
        ['getScriptUpdatedAt', 'setScriptUpdatedAt', 'touchScriptUpdatedAt'],
        {
            SBK_UPDATED: 'updated',
            scriptStorageGet: (key) => storage.get(key),
            scriptStorageSet: (key, value) => { storage.set(key, value); return true; },
        },
    );

    assert.equal(sandbox.touchScriptUpdatedAt(1000), 5001);
    assert.equal(storage.get('updated'), '5001');
    assert.equal(sandbox.touchScriptUpdatedAt(9000), 9000);
    assert.equal(storage.get('updated'), '9000');

    // Server timestamps are deliberately accepted exactly after a successful
    // pull/push; the next local edit advances from that server baseline.
    assert.equal(sandbox.setScriptUpdatedAt(3000), 3000);
    assert.equal(sandbox.touchScriptUpdatedAt(1000), 3001);
});

test('a cloud response cannot overwrite edits made while its request was in flight', async () => {
    const request = deferred();
    const state = {
        updatedAt: 1,
        scripts: [{ name: 'old', cmd: 'old' }],
        categories: [{ id: 'ops', name: 'Ops' }],
    };
    const storageValue = (key) => key === 'scripts' ? JSON.stringify(state.scripts) : JSON.stringify(state.categories);
    let saveCalls = 0;
    let retryDelay = null;
    const sandbox = loadFunctions(
        ['captureScriptSyncSnapshot', 'scriptSyncSnapshotIsCurrent', 'syncScriptBookmarks'],
        {
            currentAccount: { username: 'admin' },
            scriptSyncGeneration: 0,
            scriptAccountName: (account) => account && account.username || '',
            getScriptRevision: () => 0,
            scriptStorageGet: storageValue,
            loadSortedScriptBookmarks: () => structuredClone(state.scripts),
            loadScriptCategories: () => structuredClone(state.categories),
            getScriptUpdatedAt: () => state.updatedAt,
            SBK: 'scripts',
            SCAT: 'categories',
            safeStorageGet: storageValue,
            apiJSON: () => request.promise,
            setCloudStatus: () => {},
            syncLocalScriptsIfLogged: (delay) => { retryDelay = delay; },
            normalizeCloudScripts: (items) => items,
            normalizeScriptCategories: (items) => items,
            cleanScriptCategoryReferences: () => 0,
            saveScriptCategoriesData: () => { saveCalls++; },
            saveScriptBookmarksData: () => { saveCalls++; },
            mergeScriptBookmarksIncremental: () => { saveCalls++; return { scripts: [], added: 0 }; },
            renderScriptBookmarks: () => {},
            renderCategoryManager: () => {},
            updateScriptManagerSummary: () => {},
            updateAccountUI: () => {},
            showToast: () => {},
            openAuthModal: () => {},
        },
    );

    sandbox.syncScriptBookmarks('pull', true);
    state.updatedAt = 2;
    state.scripts = [{ name: 'new local edit', cmd: 'do-not-lose-me' }];
    request.resolve({ data: { mode: 'pull', updatedAt: 10, scripts: [{ name: 'cloud', cmd: 'old' }], categories: [] } });
    await flushPromises();

    assert.equal(saveCalls, 0);
    assert.equal(retryDelay, 0);
});

test('an older cloud request cannot apply after a newer request', async () => {
    const requests = [deferred(), deferred()];
    const state = { updatedAt: 7, scripts: [], categories: [] };
    let requestIndex = 0;
    let applied = 0;
    const sandbox = loadFunctions(
        ['captureScriptSyncSnapshot', 'scriptSyncSnapshotIsCurrent', 'syncScriptBookmarks'],
        {
            currentAccount: { username: 'admin' },
            scriptSyncGeneration: 0,
            scriptAccountName: (account) => account && account.username || '',
            getScriptRevision: () => 0,
            scriptStorageGet: (key) => key === 'scripts' ? JSON.stringify(state.scripts) : JSON.stringify(state.categories),
            loadSortedScriptBookmarks: () => structuredClone(state.scripts),
            loadScriptCategories: () => structuredClone(state.categories),
            getScriptUpdatedAt: () => state.updatedAt,
            SBK: 'scripts',
            SCAT: 'categories',
            safeStorageGet: (key) => key === 'scripts' ? JSON.stringify(state.scripts) : JSON.stringify(state.categories),
            apiJSON: () => requests[requestIndex++].promise,
            setCloudStatus: () => {},
            syncLocalScriptsIfLogged: () => {},
            normalizeCloudScripts: (items) => items,
            normalizeScriptCategories: (items) => items,
            cleanScriptCategoryReferences: () => 0,
            saveScriptCategoriesData: () => {},
            saveScriptBookmarksData: () => {},
            saveScriptWorkspaceAtomically: () => { applied++; return true; },
            refreshActiveScriptWorkspaceUI: () => {},
            renderScriptBookmarks: () => {},
            renderCategoryManager: () => {},
            updateScriptManagerSummary: () => {},
            updateAccountUI: () => {},
            showToast: () => {},
            openAuthModal: () => {},
        },
    );

    sandbox.syncScriptBookmarks('auto', true);
    sandbox.syncScriptBookmarks('auto', true);
    requests[1].resolve({ data: { mode: 'same', updatedAt: 7, scripts: [], categories: [] } });
    await flushPromises();
    requests[0].resolve({ data: { mode: 'pull', updatedAt: 8, scripts: [{ name: 'stale', cmd: 'stale' }], categories: [] } });
    await flushPromises();

    assert.equal(applied, 1);
});

test('SAVE_PASS=false omits new passwords and purges old stored passwords', () => {
    let savedBookmarks;
    const elements = {
        hostname: { value: 'ssh.example.com' },
        port: { value: '22' },
        username: { value: 'root' },
        password: { value: 'super-secret' },
    };
    const sandbox = loadFunctions(
        ['saveConnBookmark', 'applyPasswordStoragePolicy'],
        {
            CBK: 'connection-bookmarks',
            savePasswords: false,
            document: {
                getElementById: (id) => elements[id],
                querySelector: () => ({ dataset: { tab: 'password' } }),
            },
            parseHostPortInput: (host, port) => ({ host, port: Number(port) }),
            formatHostForInput: (host) => host,
            loadBM: () => [],
            saveBM: (key, value) => { savedBookmarks = value; },
            renderConnBookmarks: () => {},
            showToast: () => {},
            safeStorageSet: () => {},
            safeStorageGet: () => null,
            PROXY_KEY: 'proxy',
            loadProxyConfig: () => {},
        },
    );

    sandbox.saveConnBookmark();
    assert.equal(Object.hasOwn(savedBookmarks[0], 'password'), false);

    let persisted;
    sandbox.loadBM = () => [{ hostname: 'old.example', password: 'old-secret' }];
    sandbox.safeStorageSet = (key, value) => { persisted = JSON.parse(value); };
    sandbox.applyPasswordStoragePolicy(false);
    assert.equal(Object.hasOwn(persisted[0], 'password'), false);

    sandbox.savePasswords = true;
    sandbox.loadBM = () => [];
    sandbox.saveConnBookmark();
    assert.equal(savedBookmarks[0].password, 'super-secret');
});

test('SAVE_PASS=false also strips a remembered SOCKS5 password', () => {
    let persistedProxy;
    const proxyPassword = { value: 'legacy-proxy-secret' };
    const sandbox = loadFunctions(
        ['applyPasswordStoragePolicy'],
        {
            CBK: 'connection-bookmarks',
            PROXY_KEY: 'proxy',
            savePasswords: true,
            loadBM: () => [],
            safeStorageGet: (key) => key === 'proxy' ? JSON.stringify({ host: 'proxy.example', pass: 'legacy-proxy-secret' }) : null,
            safeStorageSet: (key, value) => { if (key === 'proxy') persistedProxy = JSON.parse(value); },
            loadProxyConfig: () => {},
            document: { getElementById: (id) => id === 'proxyPass' ? proxyPassword : null },
        },
    );

    sandbox.applyPasswordStoragePolicy(false);
    assert.equal(Object.hasOwn(persistedProxy, 'pass'), false);
    assert.equal(proxyPassword.value, '');
});

test('password retry preserves the session proxy and trust scope', () => {
    const original = {
        hostname: 'old.example', port: 22, username: 'root', logintype: 0, password: 'old',
        proxyHost: 'proxy.example', proxyPort: 1080, proxyUser: 'puser', proxyPass: 'ppass',
        trustScope: 'a'.repeat(32),
    };
    const session = {
        sshInfo: Buffer.from(JSON.stringify(original), 'utf8').toString('base64'),
        ws: null,
        authRetry: {},
    };
    const fields = {
        retryHost: { value: 'new.example' }, retryPort: { value: '2222' },
        retryUser: { value: 'deploy' }, retryPass: { value: 'new-password' },
    };
    const sandbox = loadFunctions(
        ['decodeSSHInfoPayload', 'encodeSSHInfoPayload', 'submitSSHAuthRetry'],
        {
            getActiveSSHAuthRetrySession: () => session,
            parseHostPortInput: (host, port) => ({ host, port: Number(port) }),
            formatHostForInput: (host) => host,
            document: { getElementById: (id) => fields[id] },
            invalidateSessionConnection: () => {}, hideSSHAuthRetryModal: () => {},
            renderTabs: () => {}, showToast: () => {}, startSessionConnection: () => {},
            buildSSHInfoDirect: () => { throw new Error('fallback should not be used'); },
            setSSHAuthRetryError: (message) => { throw new Error(message); },
            atob, btoa, escape, unescape, encodeURIComponent, decodeURIComponent,
        },
    );

    sandbox.submitSSHAuthRetry();
    const updated = JSON.parse(Buffer.from(session.sshInfo, 'base64').toString('utf8'));
    assert.equal(updated.hostname, 'new.example');
    assert.equal(updated.port, 2222);
    assert.equal(updated.password, 'new-password');
    assert.equal(updated.proxyPass, 'ppass');
    assert.equal(updated.trustScope, 'a'.repeat(32));
});

test('an SFTP response from another tab cannot repaint the active tab', async () => {
    const requests = [deferred(), deferred()];
    let requestIndex = 0;
    const elements = {
        sftpPath: { value: '' },
        sftpBody: { innerHTML: '' },
    };
    const first = { id: 'first', sshInfo: 'first-info', sftpPath: '/', _sftpListGeneration: 0, _connected: true };
    const second = { id: 'second', sshInfo: 'second-info', sftpPath: '/', _sftpListGeneration: 0, _connected: true };
    const sandbox = loadFunctions(
        ['getActiveSession', 'abortSessionController', 'cancelSessionSftpBrowsing', 'requestWasAborted', 'normalizeSftpDir', 'sftpLoad'],
        {
            sessions: [first, second], activeIdx: 0,
            document: { getElementById: (id) => elements[id] },
            fetch: () => requests[requestIndex++].promise,
            AbortController,
            esc: (value) => String(value), escAttr: (value) => String(value), JSON,
        },
    );

    sandbox.sftpLoad('/first', first);
    sandbox.cancelSessionSftpBrowsing(first);
    sandbox.activeIdx = 1;
    sandbox.sftpLoad('/second', second);
    requests[0].resolve({ json: async () => ({ Msg: 'success', Data: { path: '/stale', list: [] } }) });
    await flushPromises();
    assert.notEqual(elements.sftpPath.value, '/stale');
    requests[1].resolve({ json: async () => ({ Msg: 'success', Data: { path: '/second', list: [] } }) });
    await flushPromises();
    assert.equal(elements.sftpPath.value, '/second');
    assert.match(elements.sftpBody.innerHTML, /空目录/);
});

test('one-time host-key trust remains available only for the live SSH tab', () => {
    const connectSource = extractFunction('connectSession');
    const reconnectSource = extractFunction('reconnectTab');
    assert.match(connectSource, /if \(session\.hostKeyDecision === ['"]replace['"]\) clearHostKeyDecision\(session\);/);
    assert.match(connectSource, /if \(wasConnected && session\.hostKeyDecision\) clearHostKeyDecision\(session\);/);
    assert.match(reconnectSource, /if \(s\.hostKeyDecision\) clearHostKeyDecision\(s\);/);
});

test('terminal close marks the session offline and cancels dependent work', () => {
    const connectSource = extractFunction('connectSession');
    assert.match(connectSource, /session\._connected = false;/);
    assert.match(connectSource, /session\.ws = null;/);
    assert.match(connectSource, /stopServerInfoNetStream\(session\);/);
    assert.match(connectSource, /cancelSessionSftpRequests\(session, false\);/);
});

test('credential-bearing path login is gated behind an explicit server flag', () => {
    const source = extractFunction('parseUrlLogin');
    assert.match(source, /allowLegacyPathLogin\s*\?\s*parseUrlLoginPath/);
    assert.match(appSource, /var allowLegacyPathLogin = false/);
});

test('corrupt connection bookmarks do not block script cloud sync', () => {
    const storage = new Map([
        ['connection-bookmarks', '{bad json'],
        ['scripts', '[]'],
        ['categories', '[]'],
    ]);
    const sandbox = loadFunctions(
        ['safeStorageGet', 'storageReadIsUnavailable', 'scriptAccountName', 'scriptStorageKey', 'isScriptStorageBaseKey', 'activeStorageKey', 'markScriptStorageCorrupt', 'loadBM', 'isScriptStorageCorrupt'],
        {
            localStorage: { getItem: (key) => storage.has(key) ? storage.get(key) : null },
            storageReadFailed: {}, scriptStorageCorrupt: {}, currentAccount: null,
            CBK: 'connection-bookmarks', SBK: 'scripts', SCAT: 'categories',
            SBK_UPDATED: 'updated', SBK_REVISION: 'revision',
        },
    );

    assert.deepEqual(Array.from(sandbox.loadBM('connection-bookmarks')), []);
    assert.equal(sandbox.isScriptStorageCorrupt(), false);
    storage.set('scripts', '{}');
    assert.deepEqual(Array.from(sandbox.loadBM('scripts')), []);
    assert.equal(sandbox.isScriptStorageCorrupt(), true);
});

test('script workspace writes roll back if a later localStorage write fails', () => {
    const storage = new Map([
        ['scripts', '[{"name":"old","cmd":"old"}]'],
        ['categories', '[]'],
        ['updated', '9'],
        ['revision', '3'],
    ]);
    let failed = false;
    const sandbox = loadFunctions(
        ['saveScriptWorkspaceAtomically'],
        {
            SBK: 'scripts', SCAT: 'categories', SBK_UPDATED: 'updated', SBK_REVISION: 'revision',
            activeStorageKey: (key) => key,
            safeStorageGet: (key, fallback) => storage.has(key) ? storage.get(key) : fallback,
            storageReadIsUnavailable: () => false,
            getScriptUpdatedAt: () => Number(storage.get('updated')),
            normalizeScriptCategories: (items) => items,
            safeStorageSet: (key, value) => {
                if (key === 'updated' && !failed) { failed = true; return false; }
                storage.set(key, value);
                return true;
            },
            safeStorageRemove: (key) => { storage.delete(key); return true; },
            Date, JSON, isFinite,
        },
    );

    assert.equal(sandbox.saveScriptWorkspaceAtomically([{ name: 'new', cmd: 'new' }], [{ id: 'ops', name: 'Ops' }], 10, 3, false), false);
    assert.equal(storage.get('scripts'), '[{"name":"old","cmd":"old"}]');
    assert.equal(storage.get('categories'), '[]');
    assert.equal(storage.get('updated'), '9');
    assert.equal(storage.get('revision'), '3');
});

test('gateway-required deployments stop before opening a terminal socket', () => {
    let modalOpened = 0;
    let connected = 0;
    const sandbox = loadFunctions(
        ['ensureGatewayAccount', 'startSessionConnection'],
        {
            requireGatewayAccount: true, currentAccount: null,
            openAuthModal: () => { modalOpened++; }, showToast: () => {},
            connectSession: () => { connected++; },
            document: { visibilityState: 'hidden' }, setTimeout: (fn) => fn(),
        },
    );
    const session = { fitAddon: { fit: () => {} } };
    assert.equal(sandbox.startSessionConnection(session), false);
    assert.equal(modalOpened, 1);
    assert.equal(connected, 0);
});

test('guest-enabled deployments open the terminal without a bookmark account', () => {
    let modalOpened = 0;
    let connected = 0;
    const sandbox = loadFunctions(
        ['ensureGatewayAccount', 'startSessionConnection'],
        {
            requireGatewayAccount: false, currentAccount: null,
            openAuthModal: () => { modalOpened++; }, showToast: () => {},
            connectSession: () => { connected++; },
            document: { visibilityState: 'hidden' }, setTimeout: (fn) => fn(),
        },
    );
    const session = { fitAddon: { fit: () => {} } };
    assert.equal(sandbox.startSessionConnection(session), true);
    assert.equal(modalOpened, 0);
    assert.equal(connected, 1);
});

test('script bookmarks and SFTP panels close each other when opened', () => {
    function panel(open) {
        const state = new Set(open ? ['open'] : []);
        return {
            classList: {
                contains: (name) => state.has(name),
                remove: (name) => state.delete(name),
                toggle: (name) => state.has(name) ? (state.delete(name), false) : (state.add(name), true),
            },
            isOpen: () => state.has('open'),
        };
    }
    const scriptDrawer = panel(true);
    const sftpPanel = panel(false);
    let sftpLoads = 0;
    const sandbox = loadFunctions(
        ['toggleScriptDrawer', 'toggleSftp'],
        {
            document: { getElementById: (id) => id === 'scriptDrawer' ? scriptDrawer : sftpPanel },
            sessions: [{ sftpPath: '/tmp' }], activeIdx: 0,
            sftpLoad: () => { sftpLoads++; }, remoteEditorLayerWidth: () => {}, syncTermSize: () => {},
            setTimeout: (fn) => fn(),
        },
    );

    sandbox.toggleSftp();
    assert.equal(scriptDrawer.isOpen(), false);
    assert.equal(sftpPanel.isOpen(), true);
    assert.equal(sftpLoads, 1);

    sandbox.toggleScriptDrawer();
    assert.equal(scriptDrawer.isOpen(), true);
    assert.equal(sftpPanel.isOpen(), false);
});

test('returning from script category management also closes SFTP', () => {
    const source = extractFunction('preserveScriptDrawerAfterCategoryChange');
    assert.match(source, /sftpPanel\.classList\.remove\('open'\)/);
    assert.ok(source.indexOf("sftpPanel.classList.remove('open')") < source.indexOf("drawer.classList.add('open')"));
});

test('terminal direct endpoint fallback tells users it is using the current website', () => {
    assert.doesNotMatch(appSource, /直连通道|兼容线路/);
    assert.match(appSource, /终端专用直连地址不可用，正在改用当前网站连接/);
    assert.match(appSource, /终端专用直连地址响应超时，正在改用当前网站连接/);
});

test('login and new-tab entry points authenticate before creating sessions', () => {
    const loginSource = extractFunction('connectFromLogin');
    const addTabSource = extractFunction('addNewTab');
    assert.match(loginSource, /^function connectFromLogin\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
    assert.match(addTabSource, /^function addNewTab\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
});

test('SFTP download asks for confirmation and uses a cancellable streamed response', () => {
    const openSource = extractFunction('sftpDownload');
    const runSource = extractFunction('runSftpDownload');
    assert.match(openSource, /sftpDownloadConfirmRequest = \{/);
    assert.match(openSource, /sftpDownloadConfirmModal/);
    assert.match(runSource, /var controller = new AbortController\(\)/);
    assert.match(runSource, /signal: controller\.signal/);
    assert.match(runSource, /response\.body && response\.body\.getReader/);
    assert.match(runSource, /download\.received \+= result\.value\.byteLength/);
});

test('SFTP folders are confirmed as temporary tar.gz archives before downloading', () => {
    const classes = new Set();
    const elements = {
        sftpDownloadConfirmTitle: { textContent: '' },
        sftpDownloadConfirmDescription: { textContent: '' },
        sftpDownloadConfirmSizeLabel: { textContent: '' },
        sftpDownloadConfirmName: { textContent: '' },
        sftpDownloadConfirmPath: { textContent: '' },
        sftpDownloadConfirmSize: { textContent: '' },
        sftpDownloadConfirmHint: { textContent: '' },
        sftpDownloadConfirmButton: { disabled: false, textContent: '' },
        sftpDownloadConfirmModal: { classList: { add: (name) => classes.add(name) } },
    };
    const session = { id: 'session-1', _connected: true };
    const sandbox = loadFunctions(
        ['normalizeRemoteFilePath', 'sftpDownloadPickerAvailable', 'updateSftpDownloadConfirmHint', 'sftpDownload'],
        {
            sftpDownloadConfirmRequest: null,
            getActiveSession: () => session,
            document: { getElementById: (id) => elements[id] || null },
            window: { isSecureContext: false },
            fmtB: (value) => String(value), parseInt,
        },
    );

    sandbox.sftpDownload('/srv/logs', 4096, true);
    assert.equal(sandbox.sftpDownloadConfirmRequest.path, '/srv/logs');
    assert.equal(sandbox.sftpDownloadConfirmRequest.name, 'logs.tar.gz');
    assert.equal(sandbox.sftpDownloadConfirmRequest.isDirectory, true);
    assert.equal(sandbox.sftpDownloadConfirmRequest.size, 0);
    assert.equal(elements.sftpDownloadConfirmTitle.textContent, '确认压缩并下载文件夹');
    assert.equal(elements.sftpDownloadConfirmSize.textContent, '压缩完成后确定');
    assert.match(elements.sftpDownloadConfirmHint.textContent, /两段/);
    assert.match(elements.sftpDownloadConfirmHint.textContent, /临时压缩包.*自动清理/);
    assert.equal(classes.has('show'), true);
});

test('SFTP file rows place a delete action after edit and download', () => {
    const source = extractFunction('sftpLoad');
    const previewIndex = source.indexOf("var preview =");
    const editIndex = source.indexOf("var edit =");
    const downloadIndex = source.indexOf("var dl =");
    const deleteIndex = source.indexOf("var del =");
    assert.ok(previewIndex >= 0 && editIndex > previewIndex && downloadIndex > editIndex && deleteIndex > downloadIndex);
    assert.match(source, /f\.Previewable/);
    assert.match(source, /openRemotePreview/);
    assert.match(source, /requestSftpDelete/);
    assert.match(source, /event\.stopPropagation\(\)/);
    assert.match(source, /isDir \? '压缩并下载文件夹' : '下载'/);
    assert.match(source, /isDir \? 'true' : 'false'/);
    assert.match(source, /isDir \? ' directory' : ''/);
});

test('SFTP folder downloads show real compression progress before byte download progress', () => {
    const statusSource = extractFunction('sftpDownloadStatusLabel');
    const renderSource = extractFunction('renderSftpTransfers');
    const prepareSource = extractFunction('runSftpArchivePreparation');
    const pollSource = extractFunction('pollSftpArchivePreparation');
    const runSource = extractFunction('runSftpDownload');
    assert.match(statusSource, /download\.status === 'preparing'/);
    assert.match(renderSource, /已扫描/);
    assert.match(renderSource, /archiveProcessedBytes/);
    assert.match(renderSource, /archiveProcessedEntries/);
    assert.match(renderSource, /<i>1<\/i>压缩/);
    assert.match(renderSource, /<i>2<\/i>下载/);
    assert.match(renderSource, /download\.status === 'preparing'.*取消/);
    assert.match(prepareSource, /\/file\/archive\/prepare/);
    assert.match(prepareSource, /jobId: jobId/);
    assert.match(pollSource, /\/file\/archive\/status/);
    assert.match(pollSource, /data\.status === 'ready'/);
    assert.match(pollSource, /return runSftpDownload\(download\)/);
    assert.match(runSource, /\/file\/archive\/download/);
    assert.match(styleSource, /archive-scanning .*animation:sftpArchivePreparing/);
    assert.match(styleSource, /archive-compressing .*animation:none/);
});

test('SFTP uploads expose real browser progress and a remote-write stage', () => {
    const uploadSource = extractFunction('runSftpUpload');
    const renderSource = extractFunction('renderSftpUploadTransfer');
    const cancelSource = extractFunction('cancelSftpUploadById');
    const queueSource = extractFunction('pumpSftpUploadQueue');
    const refreshSource = extractFunction('scheduleSftpUploadRefresh');
    assert.match(uploadSource, /new XMLHttpRequest\(\)/);
    assert.match(uploadSource, /xhr\.upload\.onprogress/);
    assert.match(uploadSource, /upload\.sent = Math\.min/);
    assert.match(uploadSource, /upload\.status = 'processing'/);
    assert.match(queueSource, /SFTP_UPLOAD_CONCURRENCY/);
    assert.match(refreshSource, /clearTimeout\(session\._sftpUploadRefreshTimer\)/);
    assert.match(refreshSource, /normalizeSftpDir\(session\.sftpPath \|\| '\/'\) !== path/);
    assert.match(renderSource, /<i>1<\/i>发送/);
    assert.match(renderSource, /<i>2<\/i>远端写入/);
    assert.match(renderSource, /fmtB\(speed\) \+ '\/s · 剩余 '/);
    assert.match(cancelSource, /upload\.xhr\.abort\(\)/);
    assert.match(styleSource, /sftp-transfer-item\.upload\.processing/);
});

test('SFTP upload progress transitions through send, remote write and completion', () => {
    let lastXHR;
    let refreshed = '';
    class FakeXHR {
        constructor() {
            this.upload = {};
            this.status = 0;
            this.responseText = '';
            lastXHR = this;
        }
        open(method, url) { this.method = method; this.url = url; }
        send(body) { this.body = body; }
        abort() { if (this.onabort) this.onabort(); if (this.onloadend) this.onloadend(); }
    }
    class FakeFormData {
        constructor() { this.values = []; }
        append(name, value) { this.values.push([name, value]); }
    }
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '/tmp', _sftpUploadControllers: [] };
    const upload = { id: 'upload-1', sessionId: session.id, path: '/tmp', name: 'large.bin', file: { name: 'large.bin', size: 100 }, total: 100, sent: 0, status: 'queued', xhr: null };
    const sandbox = loadFunctions(
        ['newSftpUploadId', 'runSftpUpload'],
        {
            sessions: [session],
            getSessionById: () => session,
            XMLHttpRequest: FakeXHR,
            FormData: FakeFormData,
            window: { crypto: { randomUUID: () => 'request-id' } },
            renderSftpTransfers: () => {},
            showToast: () => {},
            normalizeSftpDir: (value) => value,
            scheduleSftpUploadRefresh: (_session, value) => { refreshed = value; },
            pumpSftpUploadQueue: () => {},
            Date, Math, JSON,
        },
    );
    sandbox.runSftpUpload(upload);
    assert.equal(upload.status, 'running');
    assert.equal(lastXHR.method, 'POST');
    assert.equal(lastXHR.url, '/file/upload');
    lastXHR.upload.onprogress({ lengthComputable: true, loaded: 55, total: 110 });
    assert.equal(upload.sent, 50);
    lastXHR.upload.onload();
    assert.equal(upload.status, 'processing');
    assert.equal(upload.sent, 100);
    lastXHR.status = 200;
    lastXHR.responseText = JSON.stringify({ Msg: 'success' });
    lastXHR.onload();
    assert.equal(upload.status, 'completed');
    assert.equal(refreshed, '/tmp');
    lastXHR.onloadend();
    assert.equal(upload.xhr, null);
    assert.equal(session._sftpUploadControllers.length, 0);
});

test('SFTP upload queue respects the server per-client limit and advances after completion', () => {
    const xhrs = [];
    class FakeXHR {
        constructor() {
            this.upload = {};
            this.status = 0;
            this.responseText = '';
            xhrs.push(this);
        }
        open(method, url) { this.method = method; this.url = url; }
        send(body) { this.body = body; }
        abort() { if (this.onabort) this.onabort(); if (this.onloadend) this.onloadend(); }
    }
    class FakeFormData {
        append() {}
    }
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '/tmp', _sftpUploadControllers: [], _sftpUploads: [] };
    session._sftpUploads = [1, 2, 3].map((queueOrder) => ({
        id: 'upload-' + queueOrder,
        sessionId: session.id,
        path: '/tmp',
        name: queueOrder + '.bin',
        file: { name: queueOrder + '.bin', size: 100 },
        total: 100,
        sent: 0,
        status: 'queued',
        queueOrder,
        xhr: null,
    }));
    const sandbox = loadFunctions(
        ['sftpActiveUploadCount', 'pumpSftpUploadQueue', 'runSftpUpload'],
        {
            sessions: [session],
            SFTP_UPLOAD_CONCURRENCY: 2,
            getSessionById: () => session,
            newSftpUploadId: () => 'request-id',
            XMLHttpRequest: FakeXHR,
            FormData: FakeFormData,
            renderSftpTransfers: () => {},
            showToast: () => {},
            scheduleSftpUploadRefresh: () => {},
            Date, Math, JSON,
        },
    );

    sandbox.pumpSftpUploadQueue();
    assert.equal(xhrs.length, 2);
    assert.deepEqual(session._sftpUploads.map((upload) => upload.status), ['running', 'running', 'queued']);

    xhrs[0].upload.onload();
    xhrs[0].status = 200;
    xhrs[0].responseText = JSON.stringify({ Msg: 'success' });
    xhrs[0].onload();
    xhrs[0].onloadend();

    assert.equal(xhrs.length, 3);
    assert.deepEqual(session._sftpUploads.map((upload) => upload.status), ['completed', 'running', 'running']);
});

test('late upload events cannot turn a disconnected upload into a success', () => {
    let xhr;
    class FakeXHR {
        constructor() { this.upload = {}; this.status = 0; this.responseText = ''; xhr = this; }
        open() {}
        send() {}
    }
    const upload = { id: 'upload-1', sessionId: 'session-1', path: '/tmp', name: 'file.bin', file: { size: 10 }, total: 10, sent: 0, status: 'queued', xhr: null };
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', _sftpUploadControllers: [], _sftpUploads: [upload] };
    const sandbox = loadFunctions(['runSftpUpload'], {
        sessions: [session],
        getSessionById: () => session,
        newSftpUploadId: () => 'request-id',
        XMLHttpRequest: FakeXHR,
        FormData: class FormData { append() {} },
        renderSftpTransfers: () => {},
        showToast: () => {},
        scheduleSftpUploadRefresh: () => { throw new Error('stale response refreshed the directory'); },
        pumpSftpUploadQueue: () => {},
        Date, Math, JSON,
    });

    sandbox.runSftpUpload(upload);
    upload.abortReason = 'SSH 连接已中断，上传已停止';
    upload.status = 'error';
    upload.error = upload.abortReason;
    xhr.status = 200;
    xhr.responseText = JSON.stringify({ Msg: 'success' });
    xhr.onload();
    assert.equal(upload.status, 'error');
    xhr.onabort();
    assert.equal(upload.status, 'error');
    assert.match(upload.error, /SSH 连接已中断/);
});

test('SFTP download requests preserve file and directory intent', async () => {
    let submitted;
    const session = { id: 'session-1', _connected: true, sshInfo: 'encoded-ssh-info' };
    const sandbox = loadFunctions(
        ['runSftpDownload'],
        {
            getSessionById: () => session,
            renderSftpTransfers: () => { },
            AbortController: class AbortController { constructor() { this.signal = {}; } },
            fetch: (url, options) => {
                submitted = { url, options };
                return Promise.resolve({ ok: false, text: () => Promise.resolve('{"Msg":"expected test stop"}') });
            },
            abortSftpDownloadWriter: () => Promise.resolve(),
            requestSftpArchiveCancel: () => Promise.resolve(),
            requestWasAborted: () => false,
            showToast: () => { },
        },
    );
    const archiveJobId = '01234567-89ab-cdef-0123-456789abcdef';
    const download = { sessionId: session.id, path: '/srv/logs', name: 'logs.tar.gz', isDirectory: true, archiveReady: true, archiveJobId, status: 'queued' };

    await sandbox.runSftpDownload(download);

    assert.equal(submitted.url, '/file/archive/download');
    assert.deepEqual(JSON.parse(submitted.options.body), {
        jobId: archiveJobId,
    });
    assert.equal(download.status, 'error');

    const fileDownload = { sessionId: session.id, path: '/srv/readme.txt', name: 'readme.txt', isDirectory: false, status: 'queued' };
    await sandbox.runSftpDownload(fileDownload);
    assert.deepEqual(JSON.parse(submitted.options.body), {
        sshInfo: session.sshInfo,
        path: fileDownload.path,
        archive: false,
    });
    assert.equal(fileDownload.status, 'error');
});

test('SFTP folder preparation uses a client job id and transitions through the status endpoint', async () => {
    const jobId = '01234567-89ab-cdef-0123-456789abcdef';
    const session = { id: 'session-1', _connected: true, sshInfo: 'encoded-ssh-info' };
    let prepareRequest;
    let pollArguments;
    const sandbox = loadFunctions(
        ['clearSftpArchivePoll', 'newSftpArchiveJobId', 'runSftpArchivePreparation'],
        {
            getSessionById: () => session,
            renderSftpTransfers: () => { },
            crypto: { randomUUID: () => jobId },
            AbortController: class AbortController { constructor() { this.signal = {}; } },
            remoteEditorRequest: (url, body) => {
                prepareRequest = { url, body };
                return Promise.resolve({ jobId });
            },
            pollSftpArchivePreparation: (...args) => { pollArguments = args; return Promise.resolve(true); },
            requestSftpArchiveCancel: () => Promise.resolve(),
            requestWasAborted: () => false,
            showToast: () => { },
            clearTimeout: () => { },
            Math, Promise,
        },
    );
    const download = { sessionId: session.id, path: '/srv/logs', name: 'logs.tar.gz', archiveAttempt: 0 };

    assert.equal(await sandbox.runSftpArchivePreparation(download), true);
    assert.equal(prepareRequest.url, '/file/archive/prepare');
    assert.deepEqual(JSON.parse(JSON.stringify(prepareRequest.body)), { sshInfo: session.sshInfo, path: download.path, jobId });
    assert.equal(download.archiveAttempt, 1);
    assert.equal(download.archiveJobId, jobId);
    assert.equal(pollArguments[0], download);
    assert.equal(pollArguments[1], session);
    assert.equal(pollArguments[2], 1);
    assert.equal(pollArguments[3], jobId);
});

test('SFTP folder status switches from compression to the prepared archive download', async () => {
    const jobId = '01234567-89ab-cdef-0123-456789abcdef';
    const session = { id: 'session-1' };
    let downloads = 0;
    const sandbox = loadFunctions(
        ['applySftpArchiveStatus', 'pollSftpArchivePreparation'],
        {
            AbortController: class AbortController { constructor() { this.signal = {}; } },
            remoteEditorRequest: (url, body) => {
                assert.equal(url, '/file/archive/status');
                assert.deepEqual(JSON.parse(JSON.stringify(body)), { jobId });
                return Promise.resolve({ status: 'ready', percent: 100, totalBytes: 1000, processedBytes: 1000, totalEntries: 8, processedEntries: 8, archiveSize: 420 });
            },
            runSftpDownload: () => { downloads++; return Promise.resolve(true); },
            renderSftpTransfers: () => { },
            requestSftpArchiveCancel: () => Promise.resolve(),
            requestWasAborted: () => false,
            showToast: () => { },
            parseInt, Math, Promise,
        },
    );
    const download = { status: 'preparing', archiveAttempt: 3, archiveJobId: jobId };

    assert.equal(await sandbox.pollSftpArchivePreparation(download, session, 3, jobId), true);
    assert.equal(download.archiveReady, true);
    assert.equal(download.archivePercent, 100);
    assert.equal(download.expectedSize, 420);
    assert.equal(download.total, 420);
    assert.equal(downloads, 1);
});

test('cancelling folder preparation wakes polling and cancels the server task', () => {
    const jobId = '01234567-89ab-cdef-0123-456789abcdef';
    let clearedTimer = 0;
    let pollWoke = 0;
    let aborted = 0;
    let cancelRequest;
    const sandbox = loadFunctions(
        ['clearSftpArchivePoll', 'requestSftpArchiveCancel', 'cancelSftpDownload'],
        {
            fetch: (url, options) => { cancelRequest = { url, options }; return Promise.resolve({ ok: true }); },
            clearTimeout: () => { clearedTimer++; },
            abortSftpDownloadWriter: () => Promise.resolve(),
            renderSftpTransfers: () => { },
            getSessionById: () => ({}),
            Promise,
        },
    );
    const download = {
        sessionId: 'session-1', status: 'preparing', archiveAttempt: 1, archiveJobId: jobId,
        pollTimer: 9, pollResolve: () => { pollWoke++; }, controller: { abort: () => { aborted++; } },
    };

    sandbox.cancelSftpDownload(download);

    assert.equal(download.status, 'cancelled');
    assert.equal(download.archiveAttempt, 2);
    assert.equal(download.pollTimer, null);
    assert.equal(download.pollResolve, null);
    assert.equal(clearedTimer, 1);
    assert.equal(pollWoke, 1);
    assert.equal(aborted, 1);
    assert.equal(cancelRequest.url, '/file/archive/cancel');
    assert.deepEqual(JSON.parse(cancelRequest.options.body), { jobId });
    assert.equal(cancelRequest.options.keepalive, true);
});

test('stale folder archive polling cannot repaint a newer retry', async () => {
    let statusRequests = 0;
    const sandbox = loadFunctions(
        ['applySftpArchiveStatus', 'pollSftpArchivePreparation'],
        {
            remoteEditorRequest: () => { statusRequests++; return Promise.resolve({}); },
            Promise,
        },
    );
    const download = { status: 'preparing', archiveAttempt: 4, archiveJobId: 'new-job' };
    assert.equal(await sandbox.pollSftpArchivePreparation(download, {}, 3, 'old-job'), false);
    assert.equal(statusRequests, 0);
});

test('SFTP deletion requires confirmation, submits once and refreshes the original directory', async () => {
    const request = deferred();
    const modalClasses = new Set();
    const elements = {
        sftpDeleteConfirmModal: { classList: { add: (name) => modalClasses.add(name), remove: (name) => modalClasses.delete(name), contains: (name) => modalClasses.has(name) } },
        sftpDeleteConfirmName: { textContent: '' },
        sftpDeleteConfirmPath: { textContent: '' },
        sftpDeleteConfirmStatus: { textContent: '', className: '' },
        sftpDeleteConfirmButton: { disabled: false, textContent: '', focus: () => {} },
        sftpDeleteCancelButton: { disabled: false },
        sftpDeleteCloseButton: { disabled: false },
    };
    const session = { id: 'session-1', sshInfo: 'ssh', sftpPath: '/tmp', _connected: true, _sftpDeleteController: null };
    let deleteCalls = 0;
    let refreshedPath = '';
    let refreshedSession = null;
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorFor', 'remoteEditorIsDirty', 'setSftpDeleteConfirmBusy', 'setRemoteEditorDeletePending', 'requestSftpDelete', 'hideSftpDeleteConfirm', 'confirmSftpDelete'],
        {
            sessions: [session], remoteEditors: [], sftpDeleteConfirmRequest: null,
            document: { getElementById: (id) => elements[id] || null },
            getActiveSession: () => session, getSessionById: (id) => id === session.id ? session : null,
            showToast: () => {}, restoreRemoteEditor: () => {}, remoteEditorSetStatus: () => {},
            abortSessionController: () => {}, requestWasAborted: (err) => err && err.name === 'AbortError',
            remoteEditorRequest: (url, body) => {
                deleteCalls++;
                assert.equal(url, '/file/delete');
                assert.deepEqual(JSON.parse(JSON.stringify(body)), { sshInfo: 'ssh', path: '/tmp/delete.txt' });
                return request.promise;
            },
            destroyRemoteEditor: () => {},
            sftpLoad: (path, target) => { refreshedPath = path; refreshedSession = target; },
            setTimeout: (fn) => fn(), AbortController, Promise,
        },
    );

    sandbox.requestSftpDelete('/tmp/delete.txt');
    assert.equal(deleteCalls, 0);
    assert.equal(modalClasses.has('show'), true);
    assert.equal(elements.sftpDeleteConfirmPath.textContent, '/tmp/delete.txt');

    const deleting = sandbox.confirmSftpDelete();
    assert.equal(deleteCalls, 1);
    assert.equal(await sandbox.confirmSftpDelete(), false);
    assert.equal(deleteCalls, 1);
    request.resolve({});
    assert.equal(await deleting, true);
    assert.equal(refreshedPath, '/tmp');
    assert.equal(refreshedSession, session);
    assert.equal(modalClasses.has('show'), false);
});

test('cancelling SFTP delete confirmation sends no request and dirty editors are protected', () => {
    const modalClasses = new Set();
    const elements = {
        sftpDeleteConfirmModal: { classList: { add: (name) => modalClasses.add(name), remove: (name) => modalClasses.delete(name) } },
        sftpDeleteConfirmName: { textContent: '' },
        sftpDeleteConfirmPath: { textContent: '' },
        sftpDeleteConfirmStatus: { textContent: '', className: '' },
        sftpDeleteConfirmButton: { disabled: false, textContent: '', focus: () => {} },
        sftpDeleteCancelButton: { disabled: false },
        sftpDeleteCloseButton: { disabled: false },
    };
    const session = { id: 'session-1', _connected: true };
    const editor = { sessionId: session.id, path: '/tmp/dirty.txt', loaded: true, originalContent: 'old', textarea: { value: 'new' } };
    let restored = 0;
    let requests = 0;
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorFor', 'remoteEditorIsDirty', 'setSftpDeleteConfirmBusy', 'requestSftpDelete', 'hideSftpDeleteConfirm'],
        {
            remoteEditors: [], sftpDeleteConfirmRequest: null,
            document: { getElementById: (id) => elements[id] || null },
            getActiveSession: () => session, showToast: () => {}, restoreRemoteEditor: () => { restored++; },
            remoteEditorRequest: () => { requests++; },
            setTimeout: (fn) => fn(),
        },
    );

    sandbox.requestSftpDelete('/tmp/clean.txt');
    sandbox.hideSftpDeleteConfirm();
    assert.equal(requests, 0);
    assert.equal(modalClasses.has('show'), false);

    sandbox.remoteEditors.push(editor);
    sandbox.requestSftpDelete('/tmp/dirty.txt');
    assert.equal(restored, 1);
    assert.equal(sandbox.sftpDeleteConfirmRequest, null);
});

test('SFTP delete refresh is skipped after navigating away from the original directory', () => {
    const source = extractFunction('confirmSftpDelete');
    assert.match(source, /normalizeSftpDir\(session\.sftpPath \|\| '\/'\) === request\.parentPath/);
});

test('SFTP transfer controls support pause, resume and cancellation', () => {
    const pauseSource = extractFunction('pauseSftpDownload');
    const resumeSource = extractFunction('resumeSftpDownload');
    const cancelSource = extractFunction('cancelSftpDownload');
    assert.match(pauseSource, /download\.status = 'paused'/);
    assert.match(resumeSource, /download\.status = 'running'/);
    assert.match(cancelSource, /download\.controller\.abort\(\)/);
});

test('terminal disconnect does not cancel an independent SFTP download', () => {
    const closeHandler = extractFunction('connectSession');
    const cancelSource = extractFunction('cancelSessionSftpRequests');
    assert.match(closeHandler, /cancelSessionSftpRequests\(session, false\)/);
    assert.match(cancelSource, /if \(cancelDownloads\) \{/);
});

test('a minimized remote editor refreshes its dock dirty state after save', () => {
    const source = extractFunction('remoteEditorUpdateMetrics');
    assert.match(source, /workspace && workspace\.minimized/);
    assert.match(source, /renderRemoteEditorDock\(getActiveSession\(\)\)/);
});

test('saving a remote editor refreshes metadata in the normalized visible SFTP directory', async () => {
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '', _remoteEditorControllers: [] };
    const editor = {
        sessionId: session.id, parentPath: '/', path: '/test.txt', name: 'test.txt', version: 'v1',
        targetPath: '/test.txt', originalContent: 'old', saving: false,
        subtitle: { textContent: '' }, textarea: { value: 'new' },
    };
    let refreshedPath = '';
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorPathLabel', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
        {
            sessions: [session], remoteEditors: [editor],
            getSessionById: (id) => id === session.id ? session : null,
            remoteEditorRequest: () => Promise.resolve({ version: 'v2' }),
            remoteEditorUpdateMetrics: () => {}, showToast: () => {}, requestWasAborted: () => false,
            sftpLoad: (path, target) => { refreshedPath = path; assert.equal(target, session); },
            AbortController, Promise,
        },
    );

    assert.equal(await sandbox.saveRemoteEditor(editor, false), true);
    assert.equal(refreshedPath, '/');
});

test('remote editor identity is scoped to the SSH session and normalized path', () => {
    const first = { id: 'first' };
    const second = { id: 'second' };
    const sandbox = loadFunctions(
        ['normalizeRemoteFilePath', 'remoteEditorFor'],
        {
            remoteEditors: [
                { sessionId: 'first', path: '/etc/app.conf' },
                { sessionId: 'second', path: '/etc/app.conf' },
            ],
        },
    );

    assert.equal(sandbox.normalizeRemoteFilePath('\\etc\\app.conf/'), '/etc/app.conf');
    assert.equal(sandbox.remoteEditorFor(first, '//etc//app.conf/').sessionId, 'first');
    assert.equal(sandbox.remoteEditorFor(second, '/etc/app.conf').sessionId, 'second');
});

test('text and media views of the same remote path use separate document identities', () => {
    const first = { id: 'session-1' };
    const sandbox = loadFunctions(
        ['normalizeRemoteFilePath', 'remoteEditorFor'],
        {
            remoteEditors: [
                { sessionId: first.id, path: '/srv/logo.svg', viewMode: 'text' },
                { sessionId: first.id, path: '/srv/logo.svg', viewMode: 'image' },
            ],
        },
    );

    assert.equal(sandbox.remoteEditorFor(first, '/srv/logo.svg', 'text').viewMode, 'text');
    assert.equal(sandbox.remoteEditorFor(first, '/srv/logo.svg', 'image').viewMode, 'image');
});

test('remote workbench uses wrapped tabs instead of overlapping one window per file', () => {
    const createSource = extractFunction('createRemoteEditorElement');
    const workspaceSource = extractFunction('createRemoteEditorWorkspace');
    assert.match(createSource, /createRemoteEditorWorkspace\(session\)/);
    assert.match(createSource, /remote-editor-tab/);
    assert.match(createSource, /workspace\.tabs\.appendChild\(tab\)/);
    assert.match(workspaceSource, /remote-editor-panes/);
    assert.match(styleSource, /\.remote-editor-tabs\{[^}]*flex-wrap:wrap/);
    assert.match(styleSource, /\.remote-editor-document\.is-active\{display:flex\}/);
    assert.match(styleSource, /html\[data-theme="dark"\] \.remote-editor-code-surface \.remote-editor-textarea\{background:transparent!important/);
});

test('remote text workbench detects common languages and escapes highlighted source', () => {
    const sandbox = loadFunctions(
        ['remoteEditorLanguageForName', 'remoteEditorEscapeCode', 'remoteEditorHighlightWithRules', 'remoteEditorHighlightMarkupTag', 'remoteEditorHighlightMarkup', 'remoteEditorHighlightCode'],
        {},
    );
    assert.equal(sandbox.remoteEditorLanguageForName('app.py').label, 'Python');
    assert.equal(sandbox.remoteEditorLanguageForName('Dockerfile').id, 'docker');
    const html = sandbox.remoteEditorHighlightCode('<script>const answer = 42;</script>', 'html');
    assert.match(html, /tok-tag/);
    assert.doesNotMatch(html, /<script>/);
    const python = sandbox.remoteEditorHighlightCode('def hello():\n    return \"world\"', 'python');
    assert.match(python, /tok-keyword/);
    assert.match(python, /tok-string/);
});

test('remote text workbench includes a lightweight synchronized minimap', () => {
    const createSource = extractFunction('createRemoteEditorElement');
    const drawSource = extractFunction('drawRemoteEditorMinimap');
    const scrollSource = extractFunction('scrollRemoteEditorFromMinimap');
    const setupSource = extractFunction('setupRemoteEditorMinimap');
    const destroySource = extractFunction('destroyRemoteEditor');
    assert.match(createSource, /remote-editor-minimap-wrap/);
    assert.match(createSource, /remote-editor-minimap/);
    assert.match(createSource, /remote-editor-minimap-viewport/);
    assert.match(drawSource, /textarea\.scrollTop/);
    assert.match(drawSource, /viewportHeight/);
    assert.match(drawSource, /rowIndex \* rowHeight/);
    assert.match(drawSource, /classList\.toggle\('is-scrollable'/);
    assert.match(scrollSource, /textarea\.scrollTop =/);
    assert.match(setupSource, /setPointerCapture/);
    assert.match(setupSource, /releasePointerCapture/);
    assert.match(setupSource, /event\.key === 'PageDown'/);
    assert.match(createSource, /minimapResizeObserver = new ResizeObserver/);
    assert.match(destroySource, /minimapResizeObserver\.disconnect\(\)/);
    assert.match(styleSource, /\.remote-editor-minimap-wrap\{/);
    assert.match(styleSource, /\.remote-editor-minimap-viewport\{/);
});

test('remote minimap drag maps its visible handle to the editor scroll range', () => {
    const textarea = { scrollHeight: 1000, clientHeight: 200, scrollTop: 0 };
    const sandbox = loadFunctions(
        ['scrollRemoteEditorFromMinimap'],
        {
            syncRemoteEditorCodeScroll: () => {},
            drawRemoteEditorMinimap: () => {},
            isFinite,
        },
    );
    const editor = {
        textarea,
        minimapWrap: { getBoundingClientRect: () => ({ top: 100, height: 200 }) },
    };
    sandbox.scrollRemoteEditorFromMinimap(editor, 200, 20);
    assert.ok(textarea.scrollTop > 390 && textarea.scrollTop < 410);
});

test('remote minimap scrolling reuses its cached drawing for large files', () => {
    const attributes = {};
    const textarea = {
        clientHeight: 200,
        scrollHeight: 1000,
        scrollTop: 400,
        get value() { throw new Error('scrolling reparsed the complete file'); },
    };
    const sandbox = loadFunctions(['drawRemoteEditorMinimap'], {
        window: { devicePixelRatio: 1 },
        Math,
    });
    const editor = {
        textarea,
        _minimapDrawn: true,
        el: { classList: { contains: (name) => name === 'is-active' } },
        minimap: { width: 50, height: 200 },
        minimapWrap: {
            getBoundingClientRect: () => ({ width: 50, height: 200 }),
            classList: { toggle() {} },
            setAttribute: (name, value) => { attributes[name] = value; },
        },
        minimapViewport: { style: {} },
    };

    sandbox.drawRemoteEditorMinimap(editor, false);

    assert.equal(attributes['aria-valuenow'], '50');
    assert.ok(parseFloat(editor.minimapViewport.style.top) > 2);
});

test('large remote files switch to a native low-overhead editing mode', () => {
    const metricsSource = extractFunction('remoteEditorUpdateMetrics');
    const inputSource = extractFunction('remoteEditorHandleLargeFileInput');
    const decorationSource = extractFunction('scheduleRemoteEditorDecorations');
    const createSource = extractFunction('createRemoteEditorElement');
    assert.match(metricsSource, /lines > remoteEditorLargeFileMaxLines/);
    assert.match(metricsSource, /classList\.toggle\('is-large-file'/);
    assert.match(inputSource, /editor\._metricsTimer = setTimeout/);
    assert.match(inputSource, /editor\.highlightCode\.textContent = ''/);
    assert.match(decorationSource, /if \(largeFileMode\)[\s\S]*classList\.add\('highlight-disabled'\)[\s\S]*return;/);
    assert.match(createSource, /drawRemoteEditorMinimap\(editor, false\)/);
    assert.match(styleSource, /\.remote-editor-document\.is-large-file \.remote-editor-gutter/);
    assert.match(styleSource, /\.remote-editor-document\.is-large-file \.remote-editor-minimap-wrap/);
    assert.match(styleSource, /\.remote-editor-document\.highlight-disabled \.remote-editor-highlight\{display:none\}/);
});

test('image, icon and video previews use the authenticated cancellable preview endpoint', () => {
    const kindSource = extractFunction('remotePreviewKindForName');
    const openSource = extractFunction('openRemotePreview');
    const loadSource = extractFunction('loadRemotePreview');
    const destroySource = extractFunction('destroyRemoteEditor');
    assert.match(kindSource, /\.ico/);
    assert.match(kindSource, /\.mp4/);
    assert.match(openSource, /remoteEditorFor\(session, path, kind\)/);
    assert.match(loadSource, /fetch\('\/file\/preview'/);
    assert.match(loadSource, /signal: controller\.signal/);
    assert.match(loadSource, /document\.createElement\('video'\)/);
    assert.match(loadSource, /document\.createElement\('img'\)/);
    assert.match(destroySource, /URL\.revokeObjectURL/);
});

test('closing an SSH tab is deferred while one of its editors is dirty', () => {
    const session = { id: 'session-1' };
    const clean = { sessionId: 'session-1', originalContent: 'same', textarea: { value: 'same' } };
    const dirty = { sessionId: 'session-1', originalContent: 'old', textarea: { value: 'new' } };
    let prompted;
    const sandbox = loadFunctions(
        ['remoteEditorIsDirty', 'requestCloseRemoteEditorsForSession'],
        {
            remoteEditors: [clean, dirty, { sessionId: 'other', originalContent: 'x', textarea: { value: 'y' } }],
            showRemoteEditorClosePrompt: (queue, onComplete) => { prompted = { queue, onComplete }; },
        },
    );
    const afterClose = () => {};

    assert.equal(sandbox.requestCloseRemoteEditorsForSession(session, afterClose), true);
    assert.deepEqual(Array.from(prompted.queue), [dirty]);
    assert.equal(prompted.onComplete, afterClose);
});

test('deferred SSH tab close resolves the original session after tab order changes', () => {
    const source = extractFunction('closeTab');
    assert.match(source, /var requestedSession = sessions\[idx\];/);
    assert.match(source, /var currentIndex = sessions\.indexOf\(requestedSession\);/);
    assert.doesNotMatch(source, /function \(\) \{ closeTab\(idx, true\); \}/);
});

test('saving an editor keeps modifications typed while the request is in flight', async () => {
    const request = deferred();
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', _remoteEditorControllers: [] };
    const editor = {
        sessionId: session.id,
        path: '/tmp/test.txt', targetPath: '/tmp/test.txt', version: 'v1', originalContent: 'old', saving: false,
        subtitle: { textContent: '' },
        textarea: { value: 'sent content' },
    };
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorPathLabel', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
        {
            sessions: [session], remoteEditors: [editor],
            getSessionById: (id) => id === session.id ? session : null,
            remoteEditorRequest: () => request.promise,
            remoteEditorUpdateMetrics: () => {}, showToast: () => {},
            requestWasAborted: () => false, AbortController, Promise,
        },
    );

    const saving = sandbox.saveRemoteEditor(editor, false);
    editor.textarea.value = 'newer content typed during save';
    request.resolve({ version: 'v2' });
    assert.equal(await saving, true);
    assert.equal(editor.originalContent, 'sent content');
    assert.equal(editor.version, 'v2');
    assert.equal(sandbox.remoteEditorIsDirty(editor), true);
});

test('remote editor save endpoint carries the opened version fingerprint', () => {
    const source = extractFunction('saveRemoteEditor');
    assert.match(source, /var sentVersion = editor\.version;/);
    assert.match(source, /version: sentVersion/);
    assert.match(source, /var sentTargetPath = creating \? '' : normalizeRemoteFilePath\(editor\.targetPath \|\| sentPath\);/);
    assert.match(source, /targetPath: sentTargetPath/);
    assert.match(source, /var creating = !!editor\.isNew;/);
    assert.match(source, /create: creating/);
});

test('remote editor keeps the resolved symbolic link target returned while opening', () => {
    const loadSource = extractFunction('loadRemoteEditor');
    assert.match(loadSource, /editor\.targetPath = normalizeRemoteFilePath\(data\.targetPath \|\| editor\.path\);/);
    assert.match(loadSource, /已加载符号链接目标/);

    const sandbox = loadFunctions(
        ['normalizeRemoteFilePath', 'remoteEditorPathLabel'],
        {},
    );
    assert.equal(
        sandbox.remoteEditorPathLabel({ path: '/etc/nginx/dujiao-next.conf', targetPath: '/etc/nginx/sites-available/dujiao-next.conf' }),
        '/etc/nginx/dujiao-next.conf → /etc/nginx/sites-available/dujiao-next.conf',
    );
});

test('remote editor saves a symbolic link through its resolved target without replacing the link path', async () => {
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '/etc/nginx', _remoteEditorControllers: [] };
    const editor = {
        sessionId: session.id, parentPath: '/etc/nginx', path: '/etc/nginx/dujiao-next.conf',
        targetPath: '/etc/nginx/sites-available/dujiao-next.conf', name: 'dujiao-next.conf', version: 'link-v1',
        originalContent: 'old', saving: false, subtitle: { textContent: '' }, textarea: { value: 'new' },
    };
    let sentBody;
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorPathLabel', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
        {
            sessions: [session], remoteEditors: [editor],
            getSessionById: (id) => id === session.id ? session : null,
            remoteEditorRequest: (url, body) => {
                assert.equal(url, '/file/edit/save');
                sentBody = body;
                return Promise.resolve({ version: 'link-v2', targetPath: '/etc/nginx/sites-available/dujiao-next.conf' });
            },
            remoteEditorUpdateMetrics: () => {}, showToast: () => {}, requestWasAborted: () => false,
            sftpLoad: () => {}, AbortController, Promise,
        },
    );

    assert.equal(await sandbox.saveRemoteEditor(editor, false), true);
    assert.equal(sentBody.path, '/etc/nginx/dujiao-next.conf');
    assert.equal(sentBody.targetPath, '/etc/nginx/sites-available/dujiao-next.conf');
    assert.equal(sentBody.version, 'link-v1');
    assert.equal(editor.subtitle.textContent, '/etc/nginx/dujiao-next.conf → /etc/nginx/sites-available/dujiao-next.conf');
});

test('new remote files are created in the active SFTP directory without overwriting', () => {
    const openSource = extractFunction('openNewRemoteFile');
    const saveSource = extractFunction('saveRemoteEditor');
    assert.match(openSource, /normalizeSftpDir\(session\.sftpPath/);
    assert.match(openSource, /isNew: true/);
    assert.match(saveSource, /sanitizeRemoteFileName/);
    assert.match(saveSource, /var creating = !!editor\.isNew;/);
    assert.match(saveSource, /create: creating/);
    assert.match(saveSource, /editor\.isNew = false/);
});

test('recommended scripts persist usage and sort recently used entries first', () => {
    const sortSource = extractFunction('sortedPresetScripts');
    const runSource = extractFunction('runPresetScript');
    assert.match(sortSource, /b\.lastUsed !== a\.lastUsed/);
    assert.match(sortSource, /b\.useCount !== a\.useCount/);
    assert.match(runSource, /recordPresetUsage\(preset\)/);
});

test('version labels use the embedded build version instead of a stale hard-coded release', () => {
    const source = extractFunction('setVersionLabels');
    assert.match(source, /window\.__WEBSSH_APP_VERSION__/);
    assert.doesNotMatch(source, /0\.5\.43/);
    assert.match(appSource, /loadVersionCache/);
});

test('a cached remote version cannot stay below the running release after an update', () => {
    const labels = {
        currentVersionLabel: { textContent: '' },
        remoteVersionLabel: { textContent: '' },
    };
    const sandbox = loadFunctions(
        ['compareAppVersions', 'setVersionLabels'],
        {
            window: { __WEBSSH_APP_VERSION__: '0.5.60' },
            document: { getElementById: (id) => labels[id] || null },
            parseInt, Math,
        },
    );

    sandbox.setVersionLabels({ currentVersion: '0.5.60', latestVersion: '0.5.43' });
    assert.equal(labels.currentVersionLabel.textContent, '0.5.60');
    assert.equal(labels.remoteVersionLabel.textContent, '0.5.60');
    assert.equal(sandbox.compareAppVersions('0.5.60', '0.5.9'), 1);
    assert.equal(sandbox.compareAppVersions('0.5.60', '0.5.60'), 0);
});

test('runtime config keeps a newer cached remote release while refreshing current version', () => {
    const labels = {
        currentVersionLabel: { textContent: '' },
        remoteVersionLabel: { textContent: '' },
    };
    const sandbox = loadFunctions(
        ['compareAppVersions', 'setVersionLabels', 'applyRunningAppVersion'],
        {
            VERSION_CACHE_KEY: 'version-cache',
            window: { __WEBSSH_APP_VERSION__: '0.5.59' },
            document: { getElementById: (id) => labels[id] || null },
            safeStorageGet: () => JSON.stringify({ latestVersion: '0.5.61' }),
            JSON, parseInt, Math,
        },
    );

    sandbox.applyRunningAppVersion('0.5.60');
    assert.equal(sandbox.window.__WEBSSH_APP_VERSION__, '0.5.60');
    assert.equal(labels.currentVersionLabel.textContent, '0.5.60');
    assert.equal(labels.remoteVersionLabel.textContent, '0.5.61');
});

test('version update tracking survives slow builds and service restarts', () => {
    const pollSource = extractFunction('pollVersionUpdateStatus');
    const runSource = extractFunction('runVersionUpdate');
    const accountSource = extractFunction('applyCurrentAccount');
    assert.match(appSource, /ACTIVE_VERSION_UPDATE_KEY = 'webssh_active_version_update'/);
    assert.match(pollSource, /saveActiveVersionUpdate\(task\)/);
    assert.match(pollSource, /setTimeout\(tick, delay\)/);
    assert.match(pollSource, /90 \* 60 \* 1000/);
    assert.doesNotMatch(pollSource, /240000|300000|setInterval/);
    assert.match(runSource, /if \(!updater\)/);
    assert.match(runSource, /pollVersionUpdateStatus\('', task/);
    assert.match(accountSource, /resumeVersionUpdateIfNeeded\(\)/);
});

test('command update builds before switching and verifies or rolls back the container', () => {
    assert.match(updateScriptSource, /docker compose build webssh/);
    assert.match(updateScriptSource, /docker compose up -d --no-deps webssh/);
    assert.match(updateScriptSource, /wait_for_webssh/);
    assert.match(updateScriptSource, /Version: \$expected_version/);
    assert.match(updateScriptSource, /rollback_service/);
    assert.match(updateScriptSource, /previous WebSSH image has been restored/);
});

test('large SFTP downloads use the native save picker and verify bytes before committing', () => {
    const confirmSource = extractFunction('confirmSftpDownload');
    const writerSource = extractFunction('sftpDownloadWriter');
    const runSource = extractFunction('runSftpDownload');
    assert.match(confirmSource, /window\.showSaveFilePicker/);
    assert.match(confirmSource, /startSftpDownload\(session, request\.path, request\.size, request\.name, fileHandle, request\.isDirectory\)/);
    assert.match(writerSource, /fileHandle\.createWritable/);
    assert.ok(runSource.indexOf('verifySftpDownloadSize(download);') < runSource.indexOf('writer.close()'));
    assert.match(runSource, /abortSftpDownloadWriter\(download/);
    assert.match(runSource, /try \{ controller\.abort\(\); \} catch/);
    assert.match(runSource, /if \(download\.controller === controller\) download\.controller = null/);
});

test('native save picker cancellation keeps download confirmation open for retry', () => {
    const source = extractFunction('confirmSftpDownload');
    assert.match(source, /if \(err && err\.name === 'AbortError'\) return;/);
    assert.match(source, /confirmButton\.disabled = false/);
    assert.ok(source.indexOf("err.name === 'AbortError'") < source.indexOf('hideSftpDownloadConfirm();', source.indexOf('.catch')));
});

test('new remote files reveal the editor when SFTP covers a narrow workspace', () => {
    const prepareSource = extractFunction('prepareRemoteEditorWorkspace');
    const newFileSource = extractFunction('openNewRemoteFile');
    const existingFileSource = extractFunction('openRemoteEditor');
    assert.match(prepareSource, /panel\.getBoundingClientRect\(\)\.width >= termMain\.getBoundingClientRect\(\)\.width \* \.9/);
    assert.match(prepareSource, /panel\.classList\.remove\('open'\)/);
    assert.match(prepareSource, /remoteEditorLayerWidth\(\)/);
    assert.match(newFileSource, /prepareRemoteEditorWorkspace\(\)/);
    assert.match(existingFileSource, /prepareRemoteEditorWorkspace\(\)/);
});

test('an untouched new-file draft is still treated as unsaved', () => {
    const sandbox = loadFunctions(['remoteEditorIsDirty'], {});
    assert.equal(sandbox.remoteEditorIsDirty({ isNew: true, originalContent: '', textarea: { value: '' } }), true);
});

test('saving an empty new-file draft creates it and turns it into a normal editor', async () => {
    const request = deferred();
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '/tmp', _remoteEditorControllers: [] };
    const removedClasses = [];
    const editor = {
        sessionId: session.id, parentPath: '/tmp', path: '/tmp/new.txt', name: 'new.txt', isNew: true,
        targetPath: '', version: '', originalContent: '', saving: false, maxBytes: 1024,
        nameInput: { value: 'new.txt', readOnly: false, focus: () => {} }, subtitle: { textContent: '' },
        textarea: { value: '' }, el: { classList: { remove: (value) => removedClasses.push(value) } },
    };
    let sentBody;
    let refreshedPath = '';
    const sandbox = loadFunctions(
        ['utf8ByteLength', 'normalizeSftpDir', 'normalizeRemoteFilePath', 'remoteEditorPathLabel', 'sanitizeRemoteFileName', 'joinRemoteFilePath', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
        {
            sessions: [session], remoteEditors: [editor],
            getSessionById: (id) => id === session.id ? session : null,
            remoteEditorRequest: (url, body) => { sentBody = body; return request.promise; },
            remoteEditorUpdateMetrics: () => {}, showToast: () => {}, requestWasAborted: () => false,
            sftpLoad: (path) => { refreshedPath = path; }, TextEncoder, AbortController, Promise,
        },
    );

    const saving = sandbox.saveRemoteEditor(editor, false);
    assert.equal(sentBody.path, '/tmp/new.txt');
    assert.equal(sentBody.targetPath, '');
    assert.equal(sentBody.create, true);
    assert.equal(editor.nameInput.readOnly, true);
    request.resolve({ version: 'created-v1' });
    assert.equal(await saving, true);
    assert.equal(editor.isNew, false);
    assert.equal(editor.version, 'created-v1');
    assert.equal(editor.nameInput.readOnly, true);
    assert.equal(refreshedPath, '/tmp');
    assert.deepEqual(removedClasses, ['is-new']);
});

test('remote editor blocks oversized content before sending a save request', () => {
    const source = extractFunction('saveRemoteEditor');
    assert.match(source, /sentBytes > editor\.maxBytes/);
    assert.match(source, /return Promise\.resolve\(false\);/);
});

test('remote editor indents selected lines without replacing selected content', () => {
    const sandbox = loadFunctions(
        ['replaceRemoteEditorText', 'indentRemoteEditorSelection'],
        {},
    );
    const textarea = {
        value: 'alpha\nbeta\ngamma',
        selectionStart: 2,
        selectionEnd: 8,
    };

    assert.equal(sandbox.indentRemoteEditorSelection(textarea, false), true);
    assert.equal(textarea.value, '    alpha\n    beta\ngamma');
    assert.equal(textarea.selectionStart, 6);
    assert.equal(textarea.selectionEnd, 16);

    assert.equal(sandbox.indentRemoteEditorSelection(textarea, true), true);
    assert.equal(textarea.value, 'alpha\nbeta\ngamma');
    assert.equal(textarea.selectionStart, 2);
    assert.equal(textarea.selectionEnd, 8);
});

test('remote editor keeps windows inside the resized workspace', () => {
    const layer = { clientWidth: 500, clientHeight: 300 };
    const style = {};
    const el = {
        style,
    };
    Object.defineProperties(el, {
        offsetWidth: { get: () => parseInt(style.width, 10) || 600 },
        offsetHeight: { get: () => parseInt(style.height, 10) || 400 },
        offsetLeft: { get: () => parseInt(style.left, 10) || 120 },
        offsetTop: { get: () => parseInt(style.top, 10) || 80 },
    });
    const sandbox = loadFunctions(
        ['clampRemoteEditorToLayer'],
        { document: { getElementById: () => layer } },
    );

    sandbox.clampRemoteEditorToLayer({ el, maximized: false });
    assert.equal(style.width, '500px');
    assert.equal(style.height, '300px');
    assert.equal(style.left, '0px');
    assert.equal(style.top, '0px');
});

test('remote editor workspace reserves the command input bar and SFTP panel', () => {
    const source = extractFunction('remoteEditorLayerWidth');
    assert.match(source, /commandBar\.getBoundingClientRect\(\)\.height/);
    assert.match(source, /layer\.style\.bottom/);
    assert.match(source, /panel\.getBoundingClientRect\(\)\.width/);
    assert.match(source, /layer\.style\.right/);
});

test('dirty remote editors install a browser close warning', () => {
    assert.match(appSource, /addEventListener\('beforeunload',[\s\S]*remoteEditors\.some\(remoteEditorIsDirty\)[\s\S]*event\.returnValue = '';/);
});

test('the unsaved editor prompt can be cancelled with Escape or its backdrop', () => {
    assert.match(appSource, /e\.key === 'Escape'[\s\S]*remoteEditorCloseModal\.classList\.contains\('show'\)[\s\S]*cancelRemoteEditorClose\(\)/);
    assert.match(appSource, /e\.target === remoteEditorCloseModal[\s\S]*cancelRemoteEditorClose\(\)/);
});

test('remote editor retries an unfinished initial load after SSH reconnects', () => {
    const source = extractFunction('handleRemoteEditorsSessionConnected');
    assert.match(source, /!editor\.loaded && !remoteEditorIsDirty\(editor\)/);
    assert.match(source, /scheduleRemoteEditorInitialLoad\(editor, session\)/);
});

test('reopening a failed remote editor retries its initial load', () => {
    const source = extractFunction('openRemoteEditor');
    assert.match(source, /if \(!existing\.loaded && !existing\.controller && !remoteEditorIsDirty\(existing\)\)/);
    assert.match(source, /loadRemoteEditor\(existing\)/);
});

test('remote editor stays read-only until the remote file loads successfully', () => {
    const createSource = extractFunction('createRemoteEditorElement');
    const loadSource = extractFunction('loadRemoteEditor');
    assert.match(createSource, /editor\.textarea\.readOnly = true;/);
    assert.match(loadSource, /editor\.textarea\.readOnly = true;/);
    assert.match(loadSource, /editor\.textarea\.readOnly = false;/);
    assert.match(loadSource, /再次点击编辑按钮重试/);
});

test('aborted initial loads are retried while the SSH session remains connected', () => {
    const loadSource = extractFunction('loadRemoteEditor');
    assert.match(loadSource, /editor\.retryInitialLoad = aborted;/);
    assert.match(loadSource, /scheduleRemoteEditorInitialLoad\(editor, session\)/);
});

test('duplicate imported script IDs are made unique', () => {
    const sandbox = loadFunctions(
        ['parseScriptUseCount', 'parseScriptLastUsed', 'legacyScriptBookmarkId', 'normalizeImportedScripts'],
        { MAX_SCRIPT_COMMAND_CHARS: 20000, MAX_SCRIPT_BOOKMARKS: 500, Date, isFinite, Math },
    );
    const result = sandbox.normalizeImportedScripts([
        { id: 'same', name: 'one', cmd: 'true' },
        { id: 'same', name: 'two', cmd: 'false' },
    ]);
    assert.equal(result.length, 2);
    assert.notEqual(result[0].id, result[1].id);
});

function loadPersonalBookmarkImportSandbox(currentScripts, currentCategories) {
    return loadFunctions(
        [
            'createScriptCategoryId', 'normalizeScriptCategories', 'cleanScriptCategoryReferences',
            'extractImportedScripts', 'extractImportedCategories', 'parseScriptUseCount',
            'parseScriptLastUsed', 'legacyScriptBookmarkId', 'normalizeImportedScripts',
            'importedScriptBookmarkMatches', 'mergeImportedScriptCategories',
            'scriptBookmarkKey', 'sortScriptBookmarks', 'buildImportedScriptWorkspace',
        ],
        {
            MAX_SCRIPT_COMMAND_CHARS: 20000,
            MAX_SCRIPT_BOOKMARKS: 500,
            MAX_SCRIPT_CATEGORIES: 100,
            SBK: 'webssh_script_bm',
            SCAT: 'webssh_script_categories',
            Date,
            isFinite,
            Math,
            window: { crypto: { randomUUID: () => 'generated-id' } },
            isScriptStorageCorrupt: () => false,
            loadScriptCategories: () => structuredClone(currentCategories),
            loadSortedScriptBookmarks: () => structuredClone(currentScripts),
        },
    );
}

test('personal bookmark import restores changed records with matching IDs and adds missing records', () => {
    const sandbox = loadPersonalBookmarkImportSandbox(
        [
            { id: 'script-1', name: 'Current name', cmd: 'echo current', categoryId: 'category-1' },
            { id: 'local-only', name: 'Local only', cmd: 'echo local' },
        ],
        [{ id: 'category-1', emoji: '🛠️', name: 'Current category', createdAt: 1 }],
    );
    const result = sandbox.buildImportedScriptWorkspace({
        type: 'script_bookmarks',
        scope: 'personal',
        categories: [{ id: 'category-1', emoji: '📦', name: 'Backup category', createdAt: 1 }],
        scripts: [
            { id: 'script-1', name: 'Backup name', cmd: 'echo backup', categoryId: 'category-1', useCount: 4, lastUsed: 20 },
            { id: 'script-2', name: 'Missing script', cmd: 'echo missing', categoryId: 'category-1' },
        ],
    });

    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(result.categoryAdded, 0);
    assert.equal(result.categoryUpdated, 1);
    assert.equal(result.scripts.length, 3);
    assert.equal(result.scripts.find((item) => item.id === 'script-1').cmd, 'echo backup');
    assert.equal(result.scripts.find((item) => item.id === 'script-1').useCount, 4);
    assert.equal(result.scripts.find((item) => item.id === 'local-only').cmd, 'echo local');
    assert.equal(result.categories.find((item) => item.id === 'category-1').name, 'Backup category');
});

test('reimporting an unchanged personal backup is recognized as already present', () => {
    const scripts = [{ id: 'script-1', name: 'Same', cmd: 'echo same', useCount: 2, lastUsed: 10 }];
    const categories = [{ id: 'category-1', emoji: '📦', name: 'Same category', createdAt: 1 }];
    const sandbox = loadPersonalBookmarkImportSandbox(scripts, categories);
    const result = sandbox.buildImportedScriptWorkspace({ scripts, categories });

    assert.equal(result.added, 0);
    assert.equal(result.updated, 0);
    assert.equal(result.categoryAdded, 0);
    assert.equal(result.categoryUpdated, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.categorySkipped, 1);
    assert.equal(result.sourceScriptCount, 1);
    assert.equal(result.sourceCategoryCount, 1);
});

test('the personal import UI reports an unchanged backup as already present instead of invalid', () => {
    const toasts = [];
    function FakeFileReader() { this.result = ''; }
    FakeFileReader.prototype.readAsText = function (file) {
        this.result = file.content;
        this.onload();
    };
    const sandbox = loadFunctions(
        ['classifyScriptBookmarkBackup', 'importScriptBookmarks'],
        {
            SBK: 'webssh_script_bm',
            SCAT: 'webssh_script_categories',
            FileReader: FakeFileReader,
            buildImportedScriptWorkspace: () => ({
                scripts: [{ id: 'script-1', name: 'Same', cmd: 'echo same' }],
                categories: [],
                added: 0,
                updated: 0,
                categoryAdded: 0,
                categoryUpdated: 0,
                capacitySkipped: 0,
                categoryCapacitySkipped: 0,
                sourceScriptCount: 1,
                sourceCategoryCount: 0,
            }),
            showToast: (message, type) => toasts.push({ message, type }),
            preserveScriptDrawerAfterCategoryChange: () => {},
            saveScriptWorkspaceAtomically: () => { throw new Error('unchanged backup must not be saved'); },
        },
    );
    const input = {
        files: [{ content: JSON.stringify({ type: 'script_bookmarks', scope: 'personal', scripts: [{ id: 'script-1', name: 'Same', cmd: 'echo same' }] }) }],
        value: 'selected',
    };

    sandbox.importScriptBookmarks(input);

    assert.equal(toasts.length, 1);
    assert.equal(toasts[0].type, 'info');
    assert.match(toasts[0].message, /已全部存在，无需重复导入/);
    assert.equal(input.value, '');
});

test('personal and site bookmark backup files are classified into separate scopes', () => {
    const sandbox = loadFunctions(
        ['classifyScriptBookmarkBackup'],
        { SBK: 'scripts', SCAT: 'categories' },
    );
    assert.equal(sandbox.classifyScriptBookmarkBackup({ type: 'script_bookmarks', scope: 'personal', scripts: [] }), 'personal');
    assert.equal(sandbox.classifyScriptBookmarkBackup([{ name: 'legacy', cmd: 'true' }]), 'personal');
    assert.equal(sandbox.classifyScriptBookmarkBackup({ type: 'site_script_bookmarks_backup', scope: 'site', users: [] }), 'site');
    assert.equal(sandbox.classifyScriptBookmarkBackup({ users: [{ username: 'admin', scripts: [], categories: [] }] }), 'site');
    assert.equal(sandbox.classifyScriptBookmarkBackup({ hello: 'world' }), 'unknown');
});

test('new personal exports carry an explicit personal scope and cannot be confused with site backups', () => {
    const source = extractFunction('exportScriptBookmarks');
    assert.match(source, /type:\s*'script_bookmarks'/);
    assert.match(source, /scope:\s*'personal'/);
    assert.match(source, /version:\s*3/);
    assert.match(source, /account:\s*scriptAccountName\(currentAccount\)/);
    assert.match(extractFunction('importScriptBookmarks'), /全站书签备份，不能导入到个人书签/);
    assert.match(extractFunction('importScriptBookmarks'), /已全部存在，无需重复导入/);
    assert.match(extractFunction('importScriptBookmarks'), /result\.updated \|\| result\.categoryUpdated/);
    assert.match(extractFunction('importSiteScriptBookmarks'), /个人书签备份，不能用于全站恢复/);
    assert.match(extractFunction('importSiteScriptBookmarks'), /file\.size > MAX_SITE_SCRIPT_BACKUP_BYTES/);
});

test('site bookmark backup controls are administrator-only and include a restore confirmation', () => {
    assert.match(indexSource, /id="siteBookmarkBackupSection" hidden/);
    assert.match(indexSource, /id="siteBookmarkRestoreModal"/);
    assert.match(indexSource, /不会包含密码、会话或 SSH 连接信息/);
    assert.match(indexSource, /只覆盖当前网站中同名用户的书签/);
    const source = extractFunction('updateAccountUI');
    assert.match(source, /siteBackupSection\.hidden = !isAdminAccount/);
    assert.match(extractFunction('confirmSiteScriptRestore'), /cancelPendingScriptSync\(\)/);
    assert.match(extractFunction('confirmSiteScriptRestore'), /\/api\/admin\/bookmarks\/restore/);
});

test('site restore responses force stale clients to adopt the restored cloud workspace', () => {
    const source = extractFunction('syncScriptBookmarks');
    assert.match(source, /err\.code === 'workspace_restored'/);
    assert.match(source, /scriptSyncSnapshotIsCurrent\(snapshot\)/);
    assert.match(source, /saveScriptWorkspaceAtomically\(restoredScripts, restoredCategories, restoredAt, restored\.revision, true\)/);
    assert.match(source, /管理员已恢复全站书签/);
});

test('bookmark manager uses separated sections and a stable statistics grid', () => {
    assert.match(styleSource, /\.script-manager-card\{width:720px/);
    assert.match(styleSource, /\.script-manager-summary\{display:grid;grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
    assert.match(styleSource, /\.site-backup-actions\{grid-template-columns:repeat\(2,1fr\)\}/);
    assert.match(styleSource, /\.site-bookmark-restore-overlay\{z-index:1180\}/);
});
