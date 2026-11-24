const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/static/js/upload.js'), 'utf8');

function harness(extra = {}) {
    const store = new Map();
    const sandbox = {
        Uint8Array, Int32Array, DataView, TextEncoder, Blob, Number, Math, JSON, Date,
        setTimeout, clearTimeout, crypto: webcrypto,
        localStorage: { getItem: key => store.get(key), setItem: (key, value) => store.set(key, value), removeItem: key => store.delete(key) },
        renderSftpTransfers() {}, showToast() {}, scheduleSftpUploadRefresh() {}, pumpSftpUploadQueue() {},
        ...extra,
    };
    vm.createContext(sandbox); vm.runInContext(source, sandbox);
    return { sandbox, store };
}

test('SHA-256 fallback matches native digests on HTTP including padding boundaries', async () => {
    const { sandbox } = harness({ crypto: {} });
    for (const length of [0, 1, 55, 56, 63, 64, 65, 127, 128, 4194304]) {
        const bytes = Buffer.alloc(length, 219);
        const actual = sandbox.sftpUploadHex(await sandbox.sftpUploadDigest(bytes));
        assert.equal(actual, createHash('sha256').update(bytes).digest('hex'), 'length ' + length);
    }
});

test('reselected file restores upload ID, changed contents and account do not reuse it', async () => {
    const { sandbox } = harness({ currentAccount: { username: 'alice' } });
    const session = { hostname: 'server', port: 22, username: 'root' };
    function upload(contents) { return { file: new Blob([contents]), total: contents.length, name: 'file', path: '/tmp' }; }
    const first = upload('abc');
    await sandbox.prepareSftpResume(first, session, {});
    const reselected = upload('abc');
    await sandbox.prepareSftpResume(reselected, session, {});
    assert.equal(reselected.resumeId, first.resumeId);
    const changed = upload('abd');
    await sandbox.prepareSftpResume(changed, session, {});
    assert.notEqual(changed.resumeId, first.resumeId);
    sandbox.currentAccount = { username: 'bob' };
    const otherAccount = upload('abc');
    await sandbox.prepareSftpResume(otherAccount, session, {});
    assert.notEqual(otherAccount.resumeId, first.resumeId);
});

test('resumption sends only remaining bytes and commits before success', async () => {
    const size = 4 * 1024 * 1024 + 7;
    const session = { id: 's', _connected: true, _sftpUploadControllers: [] };
    const { sandbox, store } = harness({ getSessionById: () => session });
    const upload = { resumable: true, sessionId: 's', status: 'queued', name: 'file', file: new Blob([new Uint8Array(size)]), total: size, resumeId: 'a'.repeat(64), fingerprint: 'b'.repeat(64), resumeKey: 'key' };
    store.set('key', upload.resumeId);
    const calls = [];
    sandbox.sftpResumeRequest = async (item, sess, operation, action, chunk) => {
        calls.push(action);
        if (action === 'status') return { offset: 4 * 1024 * 1024, chunkSize: 4 * 1024 * 1024, completed: false };
        if (action === 'chunk') { assert.equal(chunk.size, 7); assert.equal(item.confirmed, 4 * 1024 * 1024); return { offset: size }; }
        if (action === 'complete') { assert.equal(item.status, 'processing'); return { offset: size, completed: true }; }
        return {};
    };
    await sandbox.runSftpResumableUpload(upload);
    assert.deepEqual(calls, ['status', 'chunk', 'complete', 'discard']);
    assert.equal(upload.status, 'completed'); assert.equal(upload.sent, size);
    assert.equal(upload.xhr, null); assert.equal(session._sftpUploadControllers.length, 0); assert.equal(store.has('key'), false);
});

test('pause during status never starts a chunk and retains resume identity', async () => {
    const session = { _connected: true, _sftpUploadControllers: [] };
    const { sandbox, store } = harness({ getSessionById: () => session });
    const upload = { status: 'queued', total: 10, file: new Blob(['0123456789']), resumeId: 'a'.repeat(64), fingerprint: 'b'.repeat(64), resumeKey: 'key' };
    store.set('key', upload.resumeId);
    sandbox.sftpResumeRequest = async (item, sess, operation, action) => {
        assert.equal(action, 'status'); item.status = 'cancelled'; operation.abort();
        return { offset: 0, chunkSize: 4 * 1024 * 1024 };
    };
    await sandbox.runSftpResumableUpload(upload);
    assert.equal(upload.status, 'cancelled'); assert.equal(store.get('key'), upload.resumeId); assert.equal(upload.xhr, null);
});

test('oversized uploads never read the file or start a request', async () => {
    const session = { _connected: true };
    const { sandbox } = harness({ getSessionById: () => session });
    const upload = { status: 'queued', total: 10 * 1024 ** 3 + 1 };
    await sandbox.runSftpResumableUpload(upload);
    assert.equal(upload.status, 'error'); assert.match(upload.error, /10 GiB/);
});

test('folder selection preserves nested and empty directories and queues resumable files', async () => {
    const file = new Blob(['hello']); file.name = 'hello.txt';
    function directory(name, children) { return { kind: 'directory', name, async *values() { yield* children; } }; }
    const root = directory('parent', [directory('empty', []), directory('nested', [{ kind: 'file', name: file.name, getFile: async () => file }])]);
    const session = { id: 's', _connected: true, sftpPath: '/tmp', sshInfo: 'ssh', _sftpUploads: [] };
    const created = [];
    const { sandbox } = harness({
        window: { showDirectoryPicker: async () => root }, sessions: [session], getActiveSession: () => session,
        normalizeSftpDir: value => value, sftpUploadSequence: 0, newSftpUploadId: () => 'id',
        remoteEditorRequest: async (endpoint, body) => { created.push([endpoint, body.path, body.name, body.existingOK]); },
    });
    await sandbox.selectSftpUploadFolder();
    assert.deepEqual(created, [['/file/mkdir', '/tmp', 'parent', true], ['/file/mkdir', '/tmp/parent', 'empty', true], ['/file/mkdir', '/tmp/parent', 'nested', true]]);
    assert.equal(session._sftpUploads.length, 1);
    assert.equal(session._sftpUploads[0].dir, 'parent/nested');
    assert.equal(session._sftpUploads[0].resumable, true);
});

test('an established upload may finish after its terminal disconnects', async () => {
    const session = { _connected: false, sshInfo: 'ssh', _sftpUploadControllers: [] };
    const { sandbox } = harness({ getSessionById: () => session });
    const upload = { status: 'queued', total: 0, file: new Blob([]), fingerprint: 'b'.repeat(64), resumeId: 'a'.repeat(64) };
    sandbox.sftpResumeRequest = async (item, sess, operation, action) => ({ offset: 0, chunkSize: 4194304, completed: action === 'complete' });
    await sandbox.runSftpResumableUpload(upload);
    assert.equal(upload.status, 'completed');
});

test('invalid upload JSON settles as a rejection, including null and arrays', async () => {
    for (const text of ['null', '[]', '1', '{broken']) {
        let xhr;
        const { sandbox } = harness({
            XMLHttpRequest: class { constructor() { this.upload = {}; xhr = this; } open() {} send() {} },
            FormData: class { append() {} },
        });
        const pending = sandbox.sftpResumeRequest({ name: 'file', path: '/tmp', total: 1 }, {}, {}, 'status');
        xhr.responseText = text; xhr.status = 200;
        assert.doesNotThrow(() => xhr.onload());
        await assert.rejects(pending, /上传失败/);
    }
});

test('renamed folder keeps the same remote checkpoint and restores it after reselection', async () => {
    const session = { id: 's', hostname: 'server', port: 22, username: 'root', _sftpUploads: [] };
    const { sandbox, store } = harness({
        normalizeSftpDir: value => value, normalizeRemoteFilePath: value => value,
        remotePathIsWithin: (value, root) => value === root || value.startsWith(root + '/'),
        replaceRemotePathPrefix: (value, oldPath, newPath) => newPath + value.slice(oldPath.length),
    });
    const upload = { file: new Blob(['abc']), total: 3, name: 'file', path: '/tmp', dir: 'old/nested', resumable: true, status: 'cancelled' };
    session._sftpUploads.push(upload);
    await sandbox.prepareSftpResume(upload, session, {});
    const id = upload.resumeId, oldKey = upload.resumeKey;
    const affected = await sandbox.pauseSftpUploadsForRename(session, '/tmp/old', true);
    await sandbox.updateSftpUploadsAfterRename(session, '/tmp/old', '/tmp/new', true, affected);
    sandbox.releaseSftpUploadsAfterRename(session, affected);
    assert.equal(sandbox.sftpUploadDestination(upload), '/tmp/new/nested/file');
    assert.equal(upload.originPath, '/tmp/old/nested/file'); assert.equal(upload.status, 'cancelled');
    assert.equal(store.has(oldKey), false);
    const selected = { file: new Blob(['abc']), total: 3, name: 'file', path: '/tmp', dir: 'new/nested' };
    await sandbox.prepareSftpResume(selected, session, {});
    assert.equal(selected.resumeId, id); assert.equal(selected.originPath, '/tmp/old/nested/file');
});

test('precomputed chunk digests are reused during upload', async () => {
    const session = { _connected: true, _sftpUploadControllers: [] };
    const { sandbox } = harness({ getSessionById: () => session });
    let reads = 0;
    const file = { size: 3, slice() { return { size: 3, arrayBuffer: async () => { reads++; return new TextEncoder().encode('abc').buffer; } }; } };
    const upload = { status: 'queued', name: 'file', path: '/tmp', total: 3, file };
    sandbox.sftpResumeRequest = async (item, sess, operation, action, chunk, hash) => {
        if (action === 'status') return { offset: 0, chunkSize: 4194304 };
        if (action === 'chunk') { assert.equal(hash, createHash('sha256').update('abc').digest('hex')); return { offset: 3 }; }
        return { offset: 3, completed: true };
    };
    await sandbox.runSftpResumableUpload(upload);
    assert.equal(upload.status, 'completed'); assert.equal(reads, 1);
});
