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

test('login and new-tab entry points authenticate before creating sessions', () => {
    const loginSource = extractFunction('connectFromLogin');
    const addTabSource = extractFunction('addNewTab');
    assert.match(loginSource, /^function connectFromLogin\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
    assert.match(addTabSource, /^function addNewTab\(\) \{\s*if \(!ensureGatewayAccount\(\)\) return;/);
});

test('SFTP download never removes its iframe on an unreliable load event', () => {
    const source = extractFunction('sftpDownload');
    assert.doesNotMatch(source, /iframe\.addEventListener\(['"]load['"]/);
    assert.ok(source.indexOf('form.submit()') < source.indexOf('iframe._websshCleanupTimer = setTimeout'));
    assert.match(source, /24 \* 60 \* 60 \* 1000/);
});

test('terminal disconnect does not cancel an independent SFTP download', () => {
    const closeHandler = extractFunction('connectSession');
    const cancelSource = extractFunction('cancelSessionSftpRequests');
    assert.match(closeHandler, /cancelSessionSftpRequests\(session, false\)/);
    assert.match(cancelSource, /if \(cancelDownloads\) \{/);
});

test('a minimized remote editor refreshes its dock dirty state after save', () => {
    const source = extractFunction('remoteEditorUpdateMetrics');
    assert.match(source, /if \(editor\.minimized\) renderRemoteEditorDock\(getActiveSession\(\)\);/);
});

test('saving a remote editor refreshes metadata in the normalized visible SFTP directory', async () => {
    const session = { id: 'session-1', _connected: true, sshInfo: 'ssh', sftpPath: '', _remoteEditorControllers: [] };
    const editor = {
        sessionId: session.id, parentPath: '/', path: '/test.txt', name: 'test.txt', version: 'v1',
        originalContent: 'old', saving: false, textarea: { value: 'new' },
    };
    let refreshedPath = '';
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
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
        path: '/tmp/test.txt', version: 'v1', originalContent: 'old', saving: false,
        textarea: { value: 'sent content' },
    };
    const sandbox = loadFunctions(
        ['normalizeSftpDir', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
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
    assert.match(source, /var creating = !!editor\.isNew;/);
    assert.match(source, /create: creating/);
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
        version: '', originalContent: '', saving: false, maxBytes: 1024,
        nameInput: { value: 'new.txt', readOnly: false, focus: () => {} }, subtitle: { textContent: '' },
        textarea: { value: '' }, el: { classList: { remove: (value) => removedClasses.push(value) } },
    };
    let sentBody;
    let refreshedPath = '';
    const sandbox = loadFunctions(
        ['utf8ByteLength', 'normalizeSftpDir', 'sanitizeRemoteFileName', 'joinRemoteFilePath', 'remoteEditorSession', 'remoteEditorIsDirty', 'remoteEditorSetStatus', 'removeRemoteEditorController', 'saveRemoteEditor'],
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
