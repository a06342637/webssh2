const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'public', 'static', 'js', 'app.js'), 'utf8');

function extractFunction(name) {
    const start = appSource.indexOf('function ' + name + '(');
    assert.notEqual(start, -1, 'missing function ' + name);
    const open = appSource.indexOf('{', start);
    let depth = 0;
    let quote = '';
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
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

test('successful connection consumes every one-shot host-key decision', () => {
    const connectSource = extractFunction('connectSession');
    assert.match(connectSource, /if \(session\.hostKeyDecision\) clearHostKeyDecision\(session\);/);
    assert.doesNotMatch(connectSource, /hostKeyDecision === ['"]replace['"]/);
});

test('terminal close marks the session offline and cancels dependent work', () => {
    const connectSource = extractFunction('connectSession');
    assert.match(connectSource, /session\._connected = false;/);
    assert.match(connectSource, /session\.ws = null;/);
    assert.match(connectSource, /stopServerInfoNetStream\(session\);/);
    assert.match(connectSource, /cancelSessionSftpRequests\(session\);/);
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

test('login and new-tab entry points authenticate before creating sessions', () => {
    const loginSource = extractFunction('connectFromLogin');
    const addTabSource = extractFunction('addNewTab');
    assert.match(loginSource, /^function connectFromLogin\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
    assert.match(addTabSource, /^function addNewTab\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
});

test('SFTP download installs cleanup before form submission', () => {
    const source = extractFunction('sftpDownload');
    assert.ok(source.indexOf("iframe.addEventListener('load'") < source.indexOf('form.submit()'));
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
