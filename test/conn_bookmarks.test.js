const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const appPath = path.join(__dirname, '..', 'public', 'static', 'js', 'app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const functionStarts = new Map(Array.from(
    appSource.matchAll(/^(?:async\s+)?function\s+([\w$]+)\s*\(/gm),
    (match) => [match[1], match.index],
));
const functionScripts = new Map();
const bookmarkApi = [
    'bookmarkProtocol', 'loadConnBookmarks', 'connBookmarkMatches',
    'moveConnBookmark', 'applyConn', 'openConnBookmarkModal', 'saveConnBookmarkEditor',
];

function extractFunction(name) {
    assert.ok(functionStarts.has(name), 'missing app.js function ' + name);
    const start = functionStarts.get(name);
    let end = appSource.indexOf('}', start);
    while (end !== -1) {
        const source = appSource.slice(start, end + 1);
        try {
            return new vm.Script('(' + source + ')', { filename: appPath + ':' + name });
        } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
        }
        end = appSource.indexOf('}', end + 1);
    }
    throw new Error('unterminated app.js function ' + name);
}

function loadFunctions(sandbox) {
    const context = vm.createContext(sandbox);
    for (const name of new Set([...functionStarts.keys(), ...bookmarkApi])) {
        if (Object.hasOwn(sandbox, name)) continue;
        Object.defineProperty(sandbox, name, {
            configurable: true,
            get() {
                if (!functionScripts.has(name)) functionScripts.set(name, extractFunction(name));
                const implementation = functionScripts.get(name).runInContext(context);
                Object.defineProperty(sandbox, name, {
                    configurable: true, writable: true, value: implementation,
                });
                return implementation;
            },
        });
    }
    return sandbox;
}

function clone(value) {
    return structuredClone(value);
}

function bookmark(id, overrides = {}) {
    return {
        id, protocol: 'ssh', hostname: id + '.example', port: 22,
        username: 'root', authType: 'password', note: '', ...overrides,
    };
}

function createHarness(bookmarks = [], options = {}) {
    const state = {
        bookmarks: clone(bookmarks), reads: [], saves: [], events: [],
        connections: [], focused: [], timers: [], toasts: [], renders: 0,
        authType: options.authType || 'password',
    };
    const elements = new Map();
    function element(id) {
        if (!elements.has(id)) {
            let value = '';
            const classes = new Set();
            const attributes = new Map();
            elements.set(id, {
                id, dataset: {}, style: {}, textContent: '', innerHTML: '',
                checked: false, disabled: false, readOnly: false, hidden: false,
                get value() { return value; },
                set value(next) {
                    value = String(next == null ? '' : next);
                    state.events.push({ type: 'field', id, value });
                },
                focus() {
                    state.focused.push(id);
                    state.events.push({ type: 'focus', id });
                },
                classList: {
                    add: (...names) => names.forEach((name) => classes.add(name)),
                    remove: (...names) => names.forEach((name) => classes.delete(name)),
                    contains: (name) => classes.has(name),
                    toggle(name, force) {
                        const enabled = force === undefined ? !classes.has(name) : !!force;
                        if (enabled) classes.add(name); else classes.delete(name);
                        return enabled;
                    },
                },
                setAttribute: (name, value) => attributes.set(name, String(value)),
                getAttribute: (name) => attributes.get(name) ?? null,
                removeAttribute: (name) => attributes.delete(name),
                addEventListener() {},
                reset() { state.events.push({ type: 'reset', id }); },
            });
        }
        return elements.get(id);
    }
    const initialLogin = {
        hostname: 'previous.example', port: '2200', username: 'previous-user',
        password: 'previous-password', privateKey: 'previous-private-key',
        passphrase: 'previous-passphrase',
    };
    for (const [id, value] of Object.entries(initialLogin)) element(id).value = value;
    state.events.length = 0;
    function loginSnapshot() {
        return {
            protocol: sandbox.currentProtocol, authType: state.authType,
            ...Object.fromEntries(Object.keys(initialLogin).map((id) => [id, element(id).value])),
        };
    }
    const sandbox = {
        CBK: 'webssh_conn_bm', savePasswords: options.savePasswords === true,
        currentProtocol: options.currentProtocol || 'ssh', crypto: webcrypto,
        document: {
            getElementById: element,
            querySelector(selector) {
                if (selector === '.auth-tab.active') return { dataset: { tab: state.authType } };
                if (/^#[\w-]+$/.test(selector)) return element(selector.slice(1));
                return null;
            },
            querySelectorAll: () => [],
        },
        loadBM(key) {
            assert.equal(key, sandbox.CBK);
            state.reads.push(key);
            return clone(state.bookmarks);
        },
        saveBM(key, value) {
            assert.equal(key, sandbox.CBK);
            state.saves.push(clone(value));
            if (options.saveSucceeds === false) return false;
            state.bookmarks = clone(value);
            return true;
        },
        switchProtocol(protocol) {
            state.events.push({ type: 'protocol', protocol, before: loginSnapshot() });
            sandbox.currentProtocol = protocol;
            element('hostname').value = protocol + '-draft.example';
            element('port').value = protocol === 'rdp' ? '3389' : '22';
            element('username').value = 'protocol-draft-user';
            element('password').value = 'protocol-draft-password';
        },
        switchAuthTab(authType) {
            state.authType = authType;
            state.events.push({ type: 'auth', authType });
        },
        connectFromLogin() {
            state.connections.push(loginSnapshot());
            state.events.push({ type: 'connect' });
        },
        renderConnBookmarks() { state.renders++; },
        showToast: (...args) => state.toasts.push(args),
        setTimeout(callback, delay) {
            state.timers.push({ callback, delay });
            return state.timers.length;
        },
        clearTimeout() {},
    };
    sandbox.window = sandbox;
    loadFunctions(sandbox);
    return { sandbox, state, element, loginSnapshot };
}

function ids(bookmarks) {
    return Array.from(bookmarks, (entry) => entry.id);
}

async function flushDeferred(state) {
    for (const timer of [...state.timers]) timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
}

function protocolIds(bookmarks, protocol) {
    return ids(bookmarks.filter((entry) => (entry.protocol || 'ssh') === protocol));
}

function fillEditor(harness, values) {
    for (const [name, value] of Object.entries(values)) {
        harness.element('connBookmark' + name[0].toUpperCase() + name.slice(1)).value = value;
    }
}

function assertEditorOpen(harness, expected) {
    assert.equal(harness.element('connBookmarkModal').classList.contains('show'), expected);
}

function assertSaved(harness) {
    assert.equal(harness.state.saves.length, 1);
    assert.equal(harness.state.renders, 1);
    assert.equal(harness.state.connections.length, 0);
    assertEditorOpen(harness, false);
}

function createInteractionHarness(bookmarks = [], options = {}) {
    const harness = createHarness(bookmarks, options);
    const { sandbox, state, element } = harness;
    const visible = options.visibleIds ? bookmarks.filter((entry) => options.visibleIds.includes(entry.id)) : bookmarks;
    const rows = visible.map((entry, index) => {
        const row = element('conn-bookmark-row-' + index);
        row.dataset.bookmarkId = entry.id;
        row.dataset.protocol = entry.protocol || 'ssh';
        row.getBoundingClientRect = () => ({ top: 100, height: 40 });
        row.handle = {
            closest(selector) {
                assert.equal(selector, '.conn-bm-item');
                return row;
            },
        };
        return row;
    });
    sandbox.connBookmarkDragId = '';
    sandbox.connBookmarkDragProtocol = '';
    state.confirmations = [];
    sandbox.confirm = (message) => {
        state.confirmations.push(message);
        return options.confirmed !== false;
    };
    sandbox.document.createElement = (tagName) => {
        assert.equal(tagName, 'div');
        let text = '';
        return {
            get textContent() { return text; },
            set textContent(value) { text = String(value == null ? '' : value); },
            get innerHTML() { return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); },
        };
    };
    sandbox.document.querySelectorAll = (selector) => {
        if (selector === '.conn-bm-item') return rows;
        if (selector === '.conn-bm-item.dragging') return rows.filter((row) => row.classList.contains('dragging'));
        return [];
    };
    return { ...harness, rows, rowById: (id) => rows.find((row) => row.dataset.bookmarkId === id) };
}

function renderBookmarkList(harness) {
    extractFunction('renderConnBookmarks').runInContext(harness.sandbox)();
    return harness.element('connBookmarkList').innerHTML;
}

function renderedGroups(html) {
    return new Map(Array.from(html.matchAll(/<section\b[^>]*\bdata-protocol="(ssh|rdp)"[^>]*>([\s\S]*?)<\/section>/g),
        (match) => [match[1], match[2]]));
}

function decodeHtmlAttribute(value) {
    const entities = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
    return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]);
}

function renderedBookmarkIds(html) {
    return Array.from(html.matchAll(/\bdata-bookmark-id="([^"]*)"/g), (match) => decodeHtmlAttribute(match[1]));
}

function dragEvent(clientY = 110, transfer) {
    const data = new Map();
    return {
        clientY, defaultPrevented: false,
        preventDefault() { this.defaultPrevented = true; },
        dataTransfer: transfer || {
            effectAllowed: 'uninitialized', dropEffect: 'none',
            setData: (type, value) => data.set(type, String(value)),
            getData: (type) => data.get(type) || '',
        },
    };
}

function assertDragCleared(harness) {
    assert.equal(harness.sandbox.connBookmarkDragId, '');
    assert.equal(harness.sandbox.connBookmarkDragProtocol, '');
    for (const row of harness.rows) {
        for (const name of ['dragging', 'drag-over-before', 'drag-over-after']) {
            assert.equal(row.classList.contains(name), false, row.dataset.bookmarkId + ': ' + name);
        }
        assert.equal(Object.hasOwn(row.dataset, 'dropPlacement'), false);
    }
}

test('bookmarkProtocol defaults legacy records to SSH and distinguishes the same host in RDP', () => {
    const { sandbox } = createHarness();
    const legacy = { hostname: 'shared.example' };
    const before = clone(legacy);
    assert.equal(sandbox.bookmarkProtocol(legacy), 'ssh');
    assert.equal(sandbox.bookmarkProtocol({ ...legacy, protocol: 'ssh' }), 'ssh');
    assert.equal(sandbox.bookmarkProtocol({ ...legacy, protocol: 'rdp' }), 'rdp');
    assert.deepEqual(legacy, before);
});

test('loadConnBookmarks migrates once, repairs duplicate IDs, and preserves original order and notes', () => {
    const originals = [
        { hostname: 'z-last.example', username: 'zoe', port: 22, name: 'Zulu', useCount: 1 },
        bookmark('keep-id', { hostname: 'shared.example', note: 'Keep this note', useCount: 5 }),
        { id: 'duplicate-id', hostname: 'a-first.example', username: 'alice', name: 'Alpha', useCount: 90 },
        { id: 'duplicate-id', protocol: 'rdp', hostname: 'shared.example', port: 3389, username: 'alice', note: 'Desktop' },
        { id: '', hostname: 'middle.example', username: 'root', port: 22, useCount: 500 },
    ];
    const { sandbox, state } = createHarness(originals);
    const migrated = clone(sandbox.loadConnBookmarks());
    assert.deepEqual(migrated.map((entry) => entry.hostname), originals.map((entry) => entry.hostname));
    assert.equal(new Set(ids(migrated)).size, originals.length);
    assert.ok(migrated.every((entry) => typeof entry.id === 'string' && entry.id.trim()));
    assert.deepEqual(migrated.map((entry) => entry.protocol), ['ssh', 'ssh', 'ssh', 'rdp', 'ssh']);
    assert.deepEqual(migrated.map((entry) => entry.note), ['', 'Keep this note', '', 'Desktop', '']);
    assert.equal(migrated[1].id, 'keep-id');
    assert.equal(migrated[2].id, 'duplicate-id');
    assert.equal(migrated[0].useCount, 1);
    assert.equal(migrated[2].useCount, 90);
    assert.deepEqual(state.bookmarks, migrated);
    assert.equal(state.saves.length, 1);
    assert.deepEqual(clone(sandbox.loadConnBookmarks()), migrated);
    assert.equal(state.saves.length, 1);
    assert.deepEqual(state.reads, [sandbox.CBK, sandbox.CBK]);
    const reloaded = createHarness(state.bookmarks);
    assert.deepEqual(clone(reloaded.sandbox.loadConnBookmarks()), migrated);
    assert.equal(reloaded.state.saves.length, 0);
});

test('loadConnBookmarks leaves normalized data unsorted and does not rewrite it', () => {
    const originals = [
        bookmark('zulu', { name: 'Zulu', useCount: 0, note: 'First manually' }),
        bookmark('desktop', { protocol: 'rdp', hostname: 'same.example', port: 3389, useCount: 99 }),
        bookmark('alpha', { name: 'Alpha', useCount: 10000 }),
    ];
    const { sandbox, state } = createHarness(originals);
    assert.deepEqual(clone(sandbox.loadConnBookmarks()), originals);
    assert.deepEqual(clone(sandbox.loadConnBookmarks()), originals);
    assert.equal(state.saves.length, 0);
});

test('loadConnBookmarks does not persist an already empty collection', () => {
    const { sandbox, state } = createHarness();
    assert.deepEqual(clone(sandbox.loadConnBookmarks()), []);
    assert.equal(state.saves.length, 0);
});

test('legacy IDs stay stable and usable even when migration cannot be persisted', () => {
    const originals = [
        { hostname: 'legacy.example', port: 22, username: 'root', password: 'legacy-password' },
        { hostname: 'legacy.example', protocol: 'rdp', port: 3389, username: 'Administrator' },
    ];
    const { sandbox, state } = createHarness(originals, { savePasswords: true, saveSucceeds: false });
    const migrated = clone(sandbox.loadConnBookmarks());
    assert.equal(new Set(ids(migrated)).size, 2);
    assert.deepEqual(clone(sandbox.loadConnBookmarks()), migrated);
    const reloaded = createHarness(originals, { savePasswords: true, saveSucceeds: false });
    assert.deepEqual(clone(reloaded.sandbox.loadConnBookmarks()), migrated);
    sandbox.applyConn(migrated[0].id);
    assert.equal(state.connections.length, 1);
    assert.equal(state.connections[0].hostname, 'legacy.example');
    assert.equal(state.connections[0].password, 'legacy-password');
    assert.deepEqual(state.bookmarks, originals);
});

test('migration reserves existing stable IDs before generating IDs for earlier legacy rows', () => {
    const existing = bookmark('legacy-conn-0-0', { hostname: 'already-stable.example', note: 'Preserve this identity' });
    const { sandbox } = createHarness([
        { hostname: 'new-legacy.example', username: 'root', port: 22 },
        existing,
    ]);
    const migrated = clone(sandbox.loadConnBookmarks());
    assert.equal(migrated[1].id, existing.id);
    assert.notEqual(migrated[0].id, existing.id);
    assert.deepEqual(migrated[1], existing);
    assert.deepEqual(migrated.map((entry) => entry.hostname), ['new-legacy.example', existing.hostname]);
});

test('connBookmarkMatches searches only public connection fields using case-insensitive substrings', () => {
    const { sandbox, state } = createHarness();
    const entry = bookmark('opaque-identifier', {
        protocol: 'rdp', hostname: 'Prod-Windows.EXAMPLE', port: 3389,
        username: 'CORP\\Alice', note: 'Finance Maintenance', authType: 'key',
        password: 'hidden-password-token', privateKey: 'hidden-private-token',
    });
    const before = clone(entry);
    for (const query of ['', 'RdP', 'WINDOWS.ex', 'corp\\AL', '389', 'mAINT']) {
        assert.equal(sandbox.connBookmarkMatches(entry, query), true, query);
    }
    for (const query of ['ssh', 'unrelated', 'opaque-identifier', 'hidden-password-token', 'hidden-private-token', 'key']) {
        assert.equal(sandbox.connBookmarkMatches(entry, query), false, query);
    }
    assert.equal(sandbox.connBookmarkMatches({ hostname: 'old.example' }, 'sSh'), true);
    assert.equal(sandbox.connBookmarkMatches({ hostname: 'old.example' }, 'missing'), false);
    assert.deepEqual(entry, before);
    assert.equal(state.saves.length, 0);
});

for (const movement of [
    { source: 'third', target: 'first', placement: 'before', expected: ['third', 'first', 'second'] },
    { source: 'first', target: 'third', placement: 'after', expected: ['second', 'third', 'first'] },
    { source: 'first', target: 'second', placement: 'after', expected: ['second', 'first', 'third'] },
    { source: 'third', target: 'second', placement: 'before', expected: ['first', 'third', 'second'] },
]) {
    test('moveConnBookmark persists ' + movement.source + ' ' + movement.placement + ' ' + movement.target, () => {
        const { sandbox, state } = createHarness(['first', 'second', 'third'].map((id) => bookmark(id)));
        assert.equal(sandbox.moveConnBookmark(movement.source, movement.target, movement.placement), true);
        assert.deepEqual(ids(state.bookmarks), movement.expected);
        assert.equal(state.saves.length, 1);
        assert.deepEqual(ids(sandbox.loadConnBookmarks()), movement.expected);
        assert.equal(state.saves.length, 1);
    });
}

test('moveConnBookmark changes only the chosen protocol group in interleaved storage', () => {
    const originals = [
        bookmark('ssh-z'), bookmark('rdp-z', { protocol: 'rdp', port: 3389 }),
        bookmark('ssh-a'), bookmark('rdp-a', { protocol: 'rdp', port: 3389 }), bookmark('ssh-m'),
    ];
    const { sandbox, state } = createHarness(originals);
    assert.equal(sandbox.moveConnBookmark('rdp-a', 'rdp-z', 'before'), true);
    assert.deepEqual(protocolIds(state.bookmarks, 'ssh'), ['ssh-z', 'ssh-a', 'ssh-m']);
    assert.deepEqual(protocolIds(state.bookmarks, 'rdp'), ['rdp-a', 'rdp-z']);
    for (const index of [0, 2, 4]) assert.deepEqual(state.bookmarks[index], originals[index]);
    const afterRdpMove = clone(state.bookmarks);
    assert.equal(sandbox.moveConnBookmark('ssh-m', 'ssh-z', 'before'), true);
    assert.deepEqual(protocolIds(state.bookmarks, 'ssh'), ['ssh-m', 'ssh-z', 'ssh-a']);
    assert.deepEqual(protocolIds(state.bookmarks, 'rdp'), ['rdp-a', 'rdp-z']);
    for (const index of [1, 3]) assert.deepEqual(state.bookmarks[index], afterRdpMove[index]);
    for (const original of originals) {
        assert.deepEqual(state.bookmarks.find((entry) => entry.id === original.id), original);
    }
    assert.equal(state.saves.length, 2);
});

for (const [source, target, placement] of [
    ['first', 'first', 'before'], ['first', 'first', 'after'],
    ['first', 'second', 'before'], ['second', 'first', 'after'],
    ['missing', 'first', 'before'], ['first', 'missing', 'after'],
    ['missing', 'also-missing', 'before'],
    ['first', 'desktop', 'before'], ['desktop', 'first', 'after'],
]) {
    test('moveConnBookmark rejects without writing: ' + source + ' ' + placement + ' ' + target, () => {
        const originals = [bookmark('first'), bookmark('desktop', { protocol: 'rdp', port: 3389 }), bookmark('second')];
        const { sandbox, state } = createHarness(originals);
        assert.equal(sandbox.moveConnBookmark(source, target, placement), false);
        assert.deepEqual(state.bookmarks, originals);
        assert.equal(state.saves.length, 0);
    });
}

test('filtering and reordering use stable IDs rather than visible or stored indexes', () => {
    const originals = [
        bookmark('visible-first', { note: 'Match', hostname: 'z.example' }),
        bookmark('hidden-middle', { note: 'Hidden', useCount: 10000 }),
        bookmark('rdp-visible', { protocol: 'rdp', note: 'Match', port: 3389 }),
        bookmark('visible-last', { note: 'Match', hostname: 'a.example' }),
    ];
    const { sandbox, state } = createHarness(originals);
    const loaded = sandbox.loadConnBookmarks();
    const visible = loaded.filter((entry) => sandbox.bookmarkProtocol(entry) === 'ssh' && sandbox.connBookmarkMatches(entry, 'mATch'));
    assert.deepEqual(ids(visible), ['visible-first', 'visible-last']);
    assert.deepEqual(ids(loaded), ids(originals));
    assert.equal(state.saves.length, 0);
    assert.equal(sandbox.moveConnBookmark(visible[1].id, visible[0].id, 'before'), true);
    assert.deepEqual(protocolIds(state.bookmarks, 'ssh'), ['visible-last', 'visible-first', 'hidden-middle']);
    assert.deepEqual(protocolIds(state.bookmarks, 'rdp'), ['rdp-visible']);
    assert.deepEqual(new Set(ids(state.bookmarks)), new Set(ids(originals)));
    const reloaded = createHarness(state.bookmarks);
    assert.deepEqual(ids(reloaded.sandbox.loadConnBookmarks()), ids(state.bookmarks));
    assert.equal(reloaded.state.saves.length, 0);
});

test('moveConnBookmark reports a persistence failure instead of claiming success', () => {
    const originals = [bookmark('first'), bookmark('second')];
    const { sandbox, state } = createHarness(originals, { saveSucceeds: false });
    assert.equal(sandbox.moveConnBookmark('second', 'first', 'before'), false);
    assert.deepEqual(state.bookmarks, originals);
    assert.equal(state.saves.length, 1);
});

for (const protocol of ['ssh', 'rdp']) {
    test('applyConn switches to ' + protocol + ' before filling and connects synchronously exactly once', async () => {
        const target = bookmark(protocol + '-stable-id', {
            protocol, hostname: 'shared.example', port: protocol === 'rdp' ? 3390 : 2222,
            username: 'selected-user', password: 'selected-password',
        });
        const other = bookmark('other-protocol-id', {
            protocol: protocol === 'rdp' ? 'ssh' : 'rdp', hostname: target.hostname,
            port: target.port, username: 'wrong-user', password: 'wrong-password',
        });
        const { sandbox, state, loginSnapshot } = createHarness([other, target], {
            savePasswords: true, currentProtocol: other.protocol,
        });
        const before = loginSnapshot();
        sandbox.applyConn(target.id);
        assert.equal(state.connections.length, 1, 'connect must run before applyConn returns to preserve the RDP user gesture');
        assert.equal(state.events[0].type, 'protocol');
        assert.equal(state.events[0].protocol, protocol);
        assert.deepEqual(state.events[0].before, before);
        assert.equal(state.events.filter((event) => event.type === 'protocol').length, 1);
        const connection = state.connections[0];
        assert.equal(connection.protocol, protocol);
        assert.equal(connection.hostname, target.hostname);
        assert.equal(connection.port, String(target.port));
        assert.equal(connection.username, target.username);
        assert.equal(connection.password, target.password);
        assert.equal(connection.authType, 'password');
        if (protocol === 'ssh') {
            assert.equal(connection.privateKey, '');
            assert.equal(connection.passphrase, '');
        }
        assert.equal(state.saves.length, 0);
        await flushDeferred(state);
        assert.equal(state.connections.length, 1, 'no deferred duplicate connection is allowed');
    });

    test('applyConn uses the ' + protocol + ' default port when a bookmark has no port', () => {
        const target = bookmark('default-port-id', { protocol, port: undefined, password: 'saved-password' });
        const { sandbox, state } = createHarness([target], { savePasswords: true });
        sandbox.applyConn(target.id);
        assert.equal(state.connections.length, 1);
        assert.equal(state.connections[0].port, protocol === 'rdp' ? '3389' : '22');
    });

    for (const credential of [
        { label: 'missing password', savePasswords: true },
        { label: 'empty password', savePasswords: true, password: '' },
        { label: 'password saving disabled', savePasswords: false, password: 'must-not-use' },
    ]) {
        test('applyConn ' + protocol + ' focuses the password and does not connect with ' + credential.label, async () => {
            const target = bookmark('selected-id', { protocol, port: protocol === 'rdp' ? 3389 : 22 });
            if (Object.hasOwn(credential, 'password')) target.password = credential.password;
            const { sandbox, state, element } = createHarness([target], {
                savePasswords: credential.savePasswords, currentProtocol: protocol === 'rdp' ? 'ssh' : 'rdp',
            });
            sandbox.applyConn(target.id);
            assert.equal(element('hostname').value, target.hostname);
            assert.equal(element('password').value, '');
            assert.equal(state.focused.at(-1), 'password');
            assert.equal(state.connections.length, 0);
            await flushDeferred(state);
            assert.equal(state.connections.length, 0, 'missing credentials must not schedule a connection either');
        });
    }
}

test('applyConn clears old SSH key material, ignores saved secrets, and focuses privateKey without connecting', async () => {
    const target = bookmark('key-stable-id', {
        authType: 'key', password: 'not-a-key-credential',
        privateKey: 'must-not-restore-private-key', passphrase: 'must-not-restore-passphrase',
    });
    const { sandbox, state, element } = createHarness([target], { savePasswords: true });
    sandbox.applyConn(target.id);
    assert.equal(state.authType, 'key');
    assert.equal(element('password').value, '');
    assert.equal(element('privateKey').value, '');
    assert.equal(element('passphrase').value, '');
    assert.equal(state.focused.at(-1), 'privateKey');
    assert.equal(state.connections.length, 0);
    await flushDeferred(state);
    assert.equal(state.connections.length, 0);
});

test('applyConn treats RDP as password authentication even after an SSH key login', () => {
    const target = bookmark('desktop-key-legacy', {
        protocol: 'rdp', port: 3389, authType: 'key', password: 'desktop-password',
    });
    const { sandbox, state } = createHarness([target], {
        savePasswords: true, currentProtocol: 'ssh', authType: 'key',
    });
    sandbox.applyConn(target.id);
    assert.equal(state.connections.length, 1);
    assert.equal(state.connections[0].protocol, 'rdp');
    assert.equal(state.connections[0].password, 'desktop-password');
    assert.equal(state.events.some((event) => event.type === 'auth' && event.authType === 'key'), false);
    assert.equal(state.focused.includes('privateKey'), false);
});

test('applyConn ignores an unknown stable ID without touching the login form or connecting', () => {
    const { sandbox, state, loginSnapshot } = createHarness([bookmark('known-id')]);
    const before = loginSnapshot();
    sandbox.applyConn('missing-id');
    assert.deepEqual(loginSnapshot(), before);
    assert.equal(state.events.length, 0);
    assert.equal(state.connections.length, 0);
    assert.equal(state.saves.length, 0);
});

test('applyConn accepts the persistent ID assigned to a legacy SSH bookmark', () => {
    const { sandbox, state } = createHarness([
        { hostname: 'legacy.example', port: 2222, username: 'legacy-user', password: 'legacy-password' },
    ], { savePasswords: true, currentProtocol: 'rdp' });
    const migrated = sandbox.loadConnBookmarks();
    sandbox.applyConn(migrated[0].id);
    assert.equal(state.connections.length, 1);
    assert.equal(state.connections[0].protocol, 'ssh');
    assert.equal(state.connections[0].hostname, 'legacy.example');
    assert.equal(state.connections[0].password, 'legacy-password');
    assert.equal(state.saves.length, 1);
});

test('openConnBookmarkModal exposes editable fields without persisting or connecting', () => {
    const original = bookmark('edit-stable-id', { note: 'Existing note', password: 'existing-password' });
    const harness = createHarness([original], { savePasswords: true });
    harness.sandbox.openConnBookmarkModal(original.id);
    for (const name of ['id', 'protocol', 'hostname', 'port', 'username', 'authType', 'password', 'note']) {
        const control = harness.element('connBookmark' + name[0].toUpperCase() + name.slice(1));
        assert.equal(control.value, String(original[name]), name);
        if (['hostname', 'port', 'username', 'note'].includes(name)) {
            assert.equal(control.readOnly, false, name + ' must be editable');
            assert.equal(control.disabled, false, name + ' must be enabled');
        }
    }
    assertEditorOpen(harness, true);
    assert.equal(harness.state.saves.length, 0);
    assert.equal(harness.state.connections.length, 0);
});

for (const savePasswords of [false, true]) {
    test('saveConnBookmarkEditor preserves edit ID, position and note with savePasswords=' + savePasswords, () => {
        const originals = [
            bookmark('before'),
            bookmark('edited', { hostname: 'old.example', note: 'Keep my note', password: 'old-password' }),
            bookmark('after', { protocol: 'rdp', port: 3389 }),
        ];
        const harness = createHarness(originals, { savePasswords });
        harness.sandbox.openConnBookmarkModal('edited');
        fillEditor(harness, { hostname: 'new.example', port: '2222', username: 'new-user', password: 'replacement-password' });
        harness.sandbox.saveConnBookmarkEditor();
        assert.deepEqual(ids(harness.state.bookmarks), ids(originals));
        assert.deepEqual(harness.state.bookmarks[0], originals[0]);
        assert.deepEqual(harness.state.bookmarks[2], originals[2]);
        const saved = harness.state.bookmarks[1];
        assert.equal(saved.hostname, 'new.example');
        assert.equal(String(saved.port), '2222');
        assert.equal(saved.username, 'new-user');
        assert.equal(saved.note, 'Keep my note');
        if (savePasswords) assert.equal(saved.password, 'replacement-password');
        else assert.equal(Object.hasOwn(saved, 'password'), false);
        assertSaved(harness);
    });
}

test('saveConnBookmarkEditor deduplicates a new SSH endpoint without overwriting its RDP twin', () => {
    const endpoint = { hostname: 'shared.example', port: 2222, username: 'shared-user' };
    const originals = [
        bookmark('before'), bookmark('ssh-existing', { ...endpoint, note: 'Old note' }),
        bookmark('rdp-existing', { ...endpoint, protocol: 'rdp', note: 'Desktop note', password: 'desktop-password' }),
        bookmark('after'),
    ];
    const harness = createHarness(originals, { savePasswords: true });
    harness.sandbox.openConnBookmarkModal(undefined, { ...endpoint, protocol: 'ssh', authType: 'password', note: 'Draft note' });
    fillEditor(harness, { note: 'User-edited note', password: 'new-ssh-password' });
    harness.sandbox.saveConnBookmarkEditor();
    assert.deepEqual(ids(harness.state.bookmarks), ids(originals));
    assert.deepEqual(harness.state.bookmarks[2], originals[2]);
    assert.equal(harness.state.bookmarks[1].note, 'User-edited note');
    assert.equal(harness.state.bookmarks[1].password, 'new-ssh-password');
    assertSaved(harness);
});

for (const difference of [
    { label: 'protocol', protocol: 'rdp' },
    { label: 'port', port: 2200 },
    { label: 'username', username: 'another-user' },
]) {
    test('saveConnBookmarkEditor appends instead of overwriting when the endpoint differs by ' + difference.label, () => {
        const original = bookmark('existing-id', { hostname: 'shared.example', port: 2222, username: 'shared-user', note: 'Keep original' });
        const harness = createHarness([original], { savePasswords: false });
        const draft = { ...original, ...difference, id: undefined, note: 'New note' };
        delete draft.label;
        harness.sandbox.openConnBookmarkModal(undefined, draft);
        fillEditor(harness, { password: 'must-not-persist' });
        harness.sandbox.saveConnBookmarkEditor();
        assert.equal(harness.state.bookmarks.length, 2);
        assert.deepEqual(harness.state.bookmarks[0], original);
        const saved = harness.state.bookmarks[1];
        assert.ok(saved.id);
        assert.notEqual(saved.id, original.id);
        assert.equal(saved.protocol, draft.protocol);
        assert.equal(String(saved.port), String(draft.port));
        assert.equal(saved.username, draft.username);
        assert.equal(saved.note, draft.note);
        assert.equal(Object.hasOwn(saved, 'password'), false);
        assertSaved(harness);
    });
}

test('saveConnBookmarkEditor never stores SSH private keys, passphrases or password-mode leftovers for a key bookmark', () => {
    const harness = createHarness([], { savePasswords: true });
    harness.sandbox.openConnBookmarkModal(undefined, {
        hostname: 'key.example', port: 22, username: 'root', protocol: 'ssh', authType: 'key',
        privateKey: 'draft-private-key', passphrase: 'draft-passphrase', note: 'Key login',
    });
    fillEditor(harness, { password: 'leftover-password' });
    harness.sandbox.saveConnBookmarkEditor();
    assert.equal(harness.state.bookmarks.length, 1);
    assert.equal(harness.state.bookmarks[0].authType, 'key');
    for (const name of ['privateKey', 'passphrase', 'password']) {
        assert.equal(Object.hasOwn(harness.state.bookmarks[0], name), false, name);
    }
    assertSaved(harness);
});

test('saveConnBookmarkEditor forces password authentication for RDP drafts inherited from SSH key mode', () => {
    const harness = createHarness([], { savePasswords: true });
    harness.sandbox.openConnBookmarkModal(undefined, {
        hostname: 'desktop.example', port: 3389, username: 'Administrator', protocol: 'rdp', authType: 'key',
    });
    fillEditor(harness, { authType: 'key', password: 'rdp-password' });
    harness.sandbox.saveConnBookmarkEditor();
    assert.equal(harness.state.bookmarks.length, 1);
    assert.equal(harness.state.bookmarks[0].protocol, 'rdp');
    assert.equal(harness.state.bookmarks[0].authType, 'password');
    assert.equal(harness.state.bookmarks[0].password, 'rdp-password');
    assertSaved(harness);
});

for (const invalid of [
    { hostname: '' }, { hostname: '   ' },
    { port: '0' }, { port: '-1' }, { port: '65536' }, { port: '22.5' }, { port: 'not-a-port' },
]) {
    test('saveConnBookmarkEditor keeps the modal open and does not write invalid input ' + JSON.stringify(invalid), () => {
        const original = bookmark('existing-id', { note: 'Original note' });
        const harness = createHarness([original]);
        harness.sandbox.openConnBookmarkModal(original.id);
        fillEditor(harness, invalid);
        harness.sandbox.saveConnBookmarkEditor();
        assert.deepEqual(harness.state.bookmarks, [original]);
        assert.equal(harness.state.saves.length, 0);
        assert.equal(harness.state.renders, 0);
        assert.equal(harness.state.connections.length, 0);
        assertEditorOpen(harness, true);
    });
}

test('saveConnBookmarkEditor leaves edits open without rendering when persistence fails', () => {
    const original = bookmark('existing-id', { note: 'Original note' });
    const harness = createHarness([original], { saveSucceeds: false });
    harness.sandbox.openConnBookmarkModal(original.id);
    fillEditor(harness, { note: 'Unsaved edit' });
    harness.sandbox.saveConnBookmarkEditor();
    assert.deepEqual(harness.state.bookmarks, [original]);
    assert.equal(harness.state.saves.length, 1);
    assert.equal(harness.state.renders, 0);
    assert.equal(harness.element('connBookmarkNote').value, 'Unsaved edit');
    assertEditorOpen(harness, true);
});

test('renderConnBookmarks always includes SSH and RDP groups, including empty groups', () => {
    for (const entries of [[], [bookmark('only-ssh')], [bookmark('only-rdp', { protocol: 'rdp', port: 3389 })]]) {
        const harness = createInteractionHarness(entries, { currentProtocol: 'rdp' });
        const groups = renderedGroups(renderBookmarkList(harness));
        assert.deepEqual([...groups.keys()], ['ssh', 'rdp']);
        for (const protocol of ['ssh', 'rdp']) {
            assert.deepEqual(renderedBookmarkIds(groups.get(protocol)), protocolIds(entries, protocol));
        }
        assert.equal(harness.state.saves.length, 0);
    }
});

test('renderConnBookmarks preserves manual order and filters notes without changing original move boundaries', () => {
    const entries = [
        bookmark('ssh-hidden', { name: 'Zulu', note: 'Unmatched', useCount: 0 }),
        bookmark('rdp-z', { protocol: 'rdp', port: 3389, note: 'Needle desktop' }),
        bookmark('ssh-second', { name: 'Alpha', note: 'Needle maintenance', useCount: 1000 }),
        bookmark('rdp-a', { protocol: 'rdp', port: 3389, note: 'Unmatched desktop' }),
        bookmark('ssh-last', { note: 'NEEDLE final', useCount: 9000 }),
    ];
    const harness = createInteractionHarness(entries);
    let groups = renderedGroups(renderBookmarkList(harness));
    assert.deepEqual(renderedBookmarkIds(groups.get('ssh')), ['ssh-hidden', 'ssh-second', 'ssh-last']);
    assert.deepEqual(renderedBookmarkIds(groups.get('rdp')), ['rdp-z', 'rdp-a']);
    harness.sandbox.connBookmarkDragId = 'ssh-hidden';
    harness.sandbox.connBookmarkDragProtocol = 'ssh';
    harness.element('connBookmarkSearch').value = 'nEeDlE';
    groups = renderedGroups(renderBookmarkList(harness));
    assert.equal(harness.sandbox.connBookmarkDragId, '');
    assert.equal(harness.sandbox.connBookmarkDragProtocol, '');
    assert.deepEqual([...groups.keys()], ['ssh', 'rdp']);
    assert.deepEqual(renderedBookmarkIds(groups.get('ssh')), ['ssh-second', 'ssh-last']);
    assert.deepEqual(renderedBookmarkIds(groups.get('rdp')), ['rdp-z']);
    const buttons = Array.from(groups.get('ssh').matchAll(/<button\b[^>]*>/g), (match) => match[0]);
    const moveUp = buttons.filter((button) => button.includes('moveConnBookmarkStep') && button.includes(',-1)'));
    const moveDown = buttons.filter((button) => button.includes('moveConnBookmarkStep') && button.includes(',1)'));
    assert.equal(moveUp.length, 2);
    assert.doesNotMatch(moveUp[0], /\sdisabled\b/);
    assert.match(moveDown.at(-1), /\sdisabled\b/);
    harness.element('connBookmarkSearch').value = 'no-such-note';
    groups = renderedGroups(renderBookmarkList(harness));
    assert.deepEqual([...groups.keys()], ['ssh', 'rdp']);
    assert.deepEqual(renderedBookmarkIds(groups.get('ssh')), []);
    assert.deepEqual(renderedBookmarkIds(groups.get('rdp')), []);
    assert.deepEqual(harness.state.bookmarks, entries);
    assert.equal(harness.state.saves.length, 0);
});

test('bookmark rendering escapes hostile notes, hosts and IDs and routes actions through stable dataset IDs', () => {
    const entry = bookmark("id');globalThis.bookmarkXss=1;//\"><svg onload=\"globalThis.bookmarkXss=1\">&", {
        hostname: '<img src=x onerror="globalThis.bookmarkXss=1">',
        note: '<script>globalThis.bookmarkXss=1</script> & "note"', password: 'saved-password',
    });
    const harness = createInteractionHarness([entry], { savePasswords: true });
    const itemHtml = harness.sandbox.connBookmarkItemHtml(entry, 1, 3);
    for (const html of [itemHtml, renderBookmarkList(harness)]) {
        assert.doesNotMatch(html, /<script\b|<img\b[^>]*onerror=|<svg\b[^>]*onload=/i);
        assert.ok(html.includes('root@&lt;img src=x onerror="globalThis.bookmarkXss=1"&gt;'));
        assert.ok(html.includes('&lt;script&gt;globalThis.bookmarkXss=1&lt;/script&gt; &amp; "note"'));
        assert.deepEqual(renderedBookmarkIds(html), [entry.id]);
        const encodedId = html.match(/\bdata-bookmark-id="([^"]*)"/)[1];
        assert.doesNotMatch(encodedId, /[<>]/);
        const connectButton = Array.from(html.matchAll(/<button\b[^>]*>/g), (match) => match[0])
            .find((button) => button.includes('conn-bm-connect'));
        const title = connectButton.match(/\btitle="([^"]*)"/)[1];
        assert.ok(decodeHtmlAttribute(title).endsWith('root@' + entry.hostname));
    }
    const actions = [];
    const context = {
        bookmarkXss: 0,
        button: {
            closest(selector) {
                assert.equal(selector, '.conn-bm-item');
                return { dataset: { bookmarkId: entry.id } };
            },
        },
        applyConn: (id) => actions.push(['connect', id]),
        openConnBookmarkModal: (id) => actions.push(['edit', id]),
        delConn: (id) => actions.push(['delete', id]),
        moveConnBookmarkStep: (id, direction) => actions.push(['move', id, direction]),
    };
    for (const [button] of itemHtml.matchAll(/<button\b[^>]*>/g)) {
        const handler = button.match(/\bonclick="([^"]*)"/);
        if (handler) vm.runInNewContext('(function () {' + decodeHtmlAttribute(handler[1]) + '\n}).call(button)', context);
    }
    assert.deepEqual(actions, [
        ['connect', entry.id], ['edit', entry.id], ['delete', entry.id],
        ['move', entry.id, -1], ['move', entry.id, 1],
    ]);
    assert.equal(context.bookmarkXss, 0);
    assert.equal(harness.state.saves.length, 0);
});

for (const movement of [
    { source: 'ssh-last', target: 'ssh-first', clientY: 110, placement: 'before', expected: ['ssh-last', 'rdp-fixed', 'ssh-first', 'ssh-hidden'] },
    { source: 'ssh-first', target: 'ssh-last', clientY: 130, placement: 'after', expected: ['ssh-hidden', 'rdp-fixed', 'ssh-last', 'ssh-first'] },
]) {
    test('drag handlers move filtered stable IDs ' + movement.placement + ' the target and clear drag state', () => {
        const entries = [
            bookmark('ssh-first'), bookmark('rdp-fixed', { protocol: 'rdp', port: 3389 }),
            bookmark('ssh-hidden'), bookmark('ssh-last'),
        ];
        const harness = createInteractionHarness(entries, { visibleIds: ['ssh-first', 'rdp-fixed', 'ssh-last'] });
        const source = harness.rowById(movement.source);
        const target = harness.rowById(movement.target);
        target.classList.add('drag-over-after');
        target.dataset.dropPlacement = 'after';
        const start = dragEvent();
        harness.sandbox.startConnBookmarkDrag(start, source.handle);
        assert.equal(harness.sandbox.connBookmarkDragId, movement.source);
        assert.equal(harness.sandbox.connBookmarkDragProtocol, 'ssh');
        assert.equal(start.dataTransfer.effectAllowed, 'move');
        assert.equal(start.dataTransfer.getData('text/plain'), movement.source);
        assert.equal(source.classList.contains('dragging'), true);
        assert.equal(Object.hasOwn(target.dataset, 'dropPlacement'), false);
        assert.equal(target.classList.contains('drag-over-after'), false);
        const over = dragEvent(movement.clientY, start.dataTransfer);
        harness.sandbox.dragOverConnBookmark(over, target);
        assert.equal(over.defaultPrevented, true);
        assert.equal(over.dataTransfer.dropEffect, 'move');
        assert.equal(target.dataset.dropPlacement, movement.placement);
        assert.equal(target.classList.contains('drag-over-' + movement.placement), true);
        assert.equal(harness.state.saves.length, 0);
        const drop = dragEvent(movement.clientY, start.dataTransfer);
        harness.sandbox.dropConnBookmark(drop, target);
        assert.equal(drop.defaultPrevented, true);
        assert.deepEqual(ids(harness.state.bookmarks), movement.expected);
        assert.deepEqual(harness.state.bookmarks[1], entries[1]);
        assert.equal(harness.state.saves.length, 1);
        assert.equal(harness.state.renders, 1);
        assertDragCleared(harness);
    });
}

for (const kind of ['external', 'cross-protocol']) {
    test('drag handlers reject ' + kind + ' drops even with a valid-looking payload and stale placement', () => {
        const entries = [
            bookmark('ssh-source', { hostname: 'shared.example' }), bookmark('ssh-target'),
            bookmark('rdp-target', { hostname: 'shared.example', protocol: 'rdp', port: 3389 }),
        ];
        const harness = createInteractionHarness(entries);
        const source = harness.rowById('ssh-source');
        const target = harness.rowById(kind === 'external' ? 'ssh-target' : 'rdp-target');
        const start = dragEvent();
        if (kind === 'cross-protocol') harness.sandbox.startConnBookmarkDrag(start, source.handle);
        else start.dataTransfer.setData('text/plain', 'ssh-source');
        target.dataset.dropPlacement = 'before';
        target.classList.add('drag-over-before');
        const over = dragEvent(110, start.dataTransfer);
        harness.sandbox.dragOverConnBookmark(over, target);
        assert.equal(over.defaultPrevented, false);
        assert.equal(over.dataTransfer.dropEffect, 'none');
        assert.equal(Object.hasOwn(target.dataset, 'dropPlacement'), false);
        assert.equal(target.classList.contains('drag-over-before'), false);
        target.dataset.dropPlacement = 'before';
        target.classList.add('drag-over-before');
        const drop = dragEvent(110, start.dataTransfer);
        harness.sandbox.dropConnBookmark(drop, target);
        assert.equal(drop.defaultPrevented, true);
        assert.deepEqual(harness.state.bookmarks, entries);
        assert.equal(harness.state.saves.length, 0);
        assert.equal(harness.state.renders, 0);
        assertDragCleared(harness);
    });
}

test('endConnBookmarkDrag cancels a pending reorder and clears all markers without saving', () => {
    const entries = [bookmark('source'), bookmark('target')];
    const harness = createInteractionHarness(entries);
    const start = dragEvent();
    harness.sandbox.startConnBookmarkDrag(start, harness.rowById('source').handle);
    harness.sandbox.dragOverConnBookmark(dragEvent(130, start.dataTransfer), harness.rowById('target'));
    assert.equal(harness.rowById('target').classList.contains('drag-over-after'), true);
    harness.sandbox.endConnBookmarkDrag();
    assertDragCleared(harness);
    harness.sandbox.endConnBookmarkDrag();
    assertDragCleared(harness);
    assert.deepEqual(harness.state.bookmarks, entries);
    assert.equal(harness.state.saves.length, 0);
    assert.equal(harness.state.renders, 0);
});

test('startConnBookmarkDrag prevents invalid drags without creating state or writing data', () => {
    for (const missing of ['row', 'dataTransfer']) {
        const harness = createInteractionHarness([bookmark('source')]);
        const event = dragEvent();
        const handle = missing === 'row' ? { closest: () => null } : harness.rowById('source').handle;
        if (missing === 'dataTransfer') event.dataTransfer = null;
        harness.sandbox.startConnBookmarkDrag(event, handle);
        assert.equal(event.defaultPrevented, true);
        assertDragCleared(harness);
        assert.equal(harness.state.saves.length, 0);
    }
});

for (const scenario of [
    { label: 'cancellation leaves all records intact', confirmed: false, saveSucceeds: true },
    { label: 'confirmation deletes only the selected stable ID', confirmed: true, saveSucceeds: true },
    { label: 'storage failure reports an error instead of success', confirmed: true, saveSucceeds: false },
]) {
    test('delConn ' + scenario.label, () => {
        const entries = [
            bookmark('before'),
            bookmark('rdp-selected', { protocol: 'rdp', hostname: 'shared.example', port: 2222, username: 'shared-user' }),
            bookmark('ssh-twin', { hostname: 'shared.example', port: 2222, username: 'shared-user' }),
            bookmark('after'),
        ];
        const harness = createInteractionHarness(entries, scenario);
        const deleted = scenario.confirmed && scenario.saveSucceeds;
        assert.equal(harness.sandbox.delConn('rdp-selected'), deleted);
        assert.equal(harness.state.confirmations.length, 1);
        assert.match(harness.state.confirmations[0], /RDP/);
        assert.ok(harness.state.confirmations[0].includes('shared.example'));
        assert.deepEqual(harness.state.bookmarks, deleted ? [entries[0], entries[2], entries[3]] : entries);
        assert.equal(harness.state.saves.length, scenario.confirmed ? 1 : 0);
        assert.equal(harness.state.renders, deleted ? 1 : 0);
        assert.equal(harness.state.connections.length, 0);
        if (!scenario.confirmed) assert.deepEqual(harness.state.toasts, []);
        else if (!scenario.saveSucceeds) {
            assert.equal(harness.state.toasts.length, 1);
            assert.equal(harness.state.toasts[0][1], 'error');
        }
    });
}

for (const scenario of [
    { label: 'successful save', nativeValid: true, fields: {}, saved: true },
    { label: 'native validation failure', nativeValid: false, fields: {}, saved: false },
    { label: 'custom hostname validation failure', nativeValid: true, fields: { hostname: '' }, saved: false },
]) {
    test('saveConnBookmarkEditor prevents default before any form access on ' + scenario.label, () => {
        const original = bookmark('edited-id');
        const harness = createHarness([original]);
        harness.sandbox.openConnBookmarkModal(original.id);
        fillEditor(harness, { note: 'Submitted edit', ...scenario.fields });
        const calls = [];
        const event = {
            defaultPrevented: false,
            preventDefault() {
                calls.push('preventDefault');
                this.defaultPrevented = true;
            },
        };
        harness.element('connBookmarkForm').reportValidity = () => {
            assert.equal(event.defaultPrevented, true);
            calls.push('reportValidity');
            return scenario.nativeValid;
        };
        const getElementById = harness.sandbox.document.getElementById;
        harness.sandbox.document.getElementById = (id) => {
            assert.equal(event.defaultPrevented, true, 'submission must be cancelled before reading ' + id);
            calls.push(id);
            return getElementById(id);
        };
        assert.equal(harness.sandbox.saveConnBookmarkEditor(event), scenario.saved);
        assert.equal(calls[0], 'preventDefault');
        assert.equal(calls.filter((call) => call === 'preventDefault').length, 1);
        assert.equal(calls.filter((call) => call === 'reportValidity').length, 1);
        if (scenario.saved) assertSaved(harness);
        else {
            assert.deepEqual(harness.state.bookmarks, [original]);
            assert.equal(harness.state.saves.length, 0);
            assert.equal(harness.state.renders, 0);
            assertEditorOpen(harness, true);
        }
    });
}
