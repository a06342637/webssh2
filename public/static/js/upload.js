// Incremental file fingerprinting keeps memory bounded to one 4 MiB chunk.
// The local SHA-256 fallback also supports deployments opened over plain HTTP.
async function sftpUploadDigest(input) {
    var bytes = new Uint8Array(input);
    if (globalThis.crypto && globalThis.crypto.subtle) return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
    var constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    var state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    var padded = new Uint8Array(Math.ceil((bytes.length + 9) / 64) * 64);
    padded.set(bytes); padded[bytes.length] = 128;
    var view = new DataView(padded.buffer);
    view.setUint32(padded.length - 8, Math.floor(bytes.length / 0x20000000));
    view.setUint32(padded.length - 4, (bytes.length * 8) >>> 0);
    var words = new Int32Array(64);
    function rotate(n, bits) { return (n >>> bits) | (n << (32 - bits)); }
    for (var offset = 0; offset < padded.length; offset += 64) {
        for (var i = 0; i < 16; i++) words[i] = view.getInt32(offset + i * 4);
        for (i = 16; i < 64; i++) {
            var x = words[i - 15], y = words[i - 2];
            words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) | 0;
        }
        var a = state[0], b = state[1], c = state[2], d = state[3], e = state[4], f = state[5], g = state[6], h = state[7];
        for (i = 0; i < 64; i++) {
            var t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) | 0;
            var t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        var values = [a,b,c,d,e,f,g,h];
        for (i = 0; i < 8; i++) state[i] = (state[i] + values[i]) | 0;
    }
    var result = new Uint8Array(32), output = new DataView(result.buffer);
    state.forEach(function (value, index) { output.setInt32(index * 4, value); });
    return result;
}

function sftpUploadHex(bytes) {
    return Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
}

async function prepareSftpResume(upload, session, operation) {
    var chunkSize = 4 * 1024 * 1024;
    if (!upload.fingerprint) {
        upload.phase = '正在检查本地文件，准备断点续传…';
        var digests = new Uint8Array(Math.ceil(upload.total / chunkSize) * 32);
        for (var offset = 0; offset < upload.total; offset += chunkSize) {
            if (operation.cancelled) throw new Error('上传已暂停');
            var digest = await sftpUploadDigest(await upload.file.slice(offset, offset + chunkSize).arrayBuffer());
            digests.set(digest, offset / chunkSize * 32);
            upload.phase = '检查本地文件 ' + Math.round(Math.min(upload.total, offset + chunkSize) / upload.total * 100) + '%';
            renderSftpTransfers(session);
            // Yield for painting/cancellation even on the HTTP digest fallback.
            await new Promise(function (resolve) { setTimeout(resolve, 0); });
        }
        upload.fingerprint = sftpUploadHex(await sftpUploadDigest(digests));
    }
    if (operation.cancelled) throw new Error('上传已暂停');
    if (!upload.resumeId) {
        var account = typeof currentAccount !== 'undefined' && currentAccount ? currentAccount.username : '';
        var key = JSON.stringify([account, session.hostname, session.port, session.username, upload.path, upload.dir || '', upload.name, upload.total, upload.fingerprint]);
        upload.resumeKey = 'webssh.upload.v1.' + sftpUploadHex(await sftpUploadDigest(new TextEncoder().encode(key)));
        try { upload.resumeId = localStorage.getItem(upload.resumeKey); } catch (e) { }
        if (!/^[a-f0-9]{64}$/.test(upload.resumeId || '')) {
            var random = new Uint8Array(32);
            if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(random);
            else random = await sftpUploadDigest(new TextEncoder().encode(newSftpUploadId('resume') + Math.random()));
            upload.resumeId = sftpUploadHex(random);
            try { localStorage.setItem(upload.resumeKey, upload.resumeId); } catch (e) { }
        }
    }
    upload.phase = '正在查询已上传进度…';
}

function sftpResumeRequest(upload, session, operation, action, chunk, hash) {
    return new Promise(function (resolve, reject) {
        if (operation.cancelled) { reject(new Error('上传已暂停')); return; }
        var xhr = new XMLHttpRequest();
        operation.request = xhr;
        var metadata = { sshInfo: session.sshInfo, id: upload.resumeId, path: upload.path, dir: upload.dir || '', name: upload.name, size: upload.total, fingerprint: upload.fingerprint, action: action, offset: upload.confirmed || 0, hash: hash || '' };
        var body = new FormData();
        body.append('metadata', JSON.stringify(metadata));
        if (chunk) body.append('file', chunk, upload.name);
        xhr.open('POST', '/file/upload/resume', true);
        xhr.withCredentials = true;
        xhr.timeout = 0;
        xhr.upload.onprogress = function (event) {
            if (upload.xhr !== operation || operation.cancelled || action !== 'chunk') return;
            if (event.lengthComputable && event.total > 0) upload.sent = Math.min(upload.total, upload.confirmed + Math.round(chunk.size * event.loaded / event.total));
            renderSftpTransfers(session);
        };
        xhr.upload.onload = function () {
            if (upload.xhr !== operation || operation.cancelled || action !== 'chunk') return;
            upload.phase = '正在保存当前分块…';
            renderSftpTransfers(session);
        };
        xhr.onload = function () {
            if (operation.cancelled) { reject(new Error('上传已暂停')); return; }
            var response;
            try { response = JSON.parse(xhr.responseText); } catch (e) { response = {}; }
            if (xhr.status >= 200 && xhr.status < 300 && response.Msg === 'success' && response.Data) resolve(response.Data);
            else {
                var error = new Error(response.Msg || '上传失败（HTTP ' + xhr.status + '）');
                error.retryable = xhr.status === 0 || xhr.status === 408 || xhr.status === 409 || xhr.status === 429 || xhr.status >= 500;
                reject(error);
            }
        };
        xhr.onerror = function () { var error = new Error('网络中断，已保留上传进度'); error.retryable = true; reject(error); };
        xhr.onabort = function () { reject(new Error(upload.abortReason || '上传已暂停')); };
        xhr.onloadend = function () { if (operation.request === xhr) operation.request = null; };
        try { xhr.send(body); } catch (error) { reject(error); }
    });
}

async function runSftpResumableUpload(upload) {
    if (!upload || upload.xhr || upload.status !== 'queued') return;
    var session = getSessionById(upload.sessionId);
    if (!session || (!session._connected && !session.sshInfo)) { upload.status = 'error'; upload.error = 'SSH 连接已断开，重连后可继续上传'; if (session) renderSftpTransfers(session); return; }
    if (upload.total > 10 * 1024 * 1024 * 1024) { upload.status = 'error'; upload.error = '单个文件最大支持 10 GiB'; renderSftpTransfers(session); return; }
    var operation = { resumable: true, cancelled: false, request: null, wake: null, abort: function () {
        this.cancelled = true;
        if (this.request) this.request.abort();
        if (this.wake) this.wake();
    } };
    upload.xhr = operation;
    (session._sftpUploadControllers || (session._sftpUploadControllers = [])).push(operation);
    upload.status = 'running'; upload.error = ''; upload.abortReason = ''; upload.finishedAt = 0;
    upload.startedAt = Date.now(); upload.startedOffset = upload.confirmed || 0;
    try {
        await prepareSftpResume(upload, session, operation);
        var failures = 0;
        while (!operation.cancelled) {
            try {
                var state = await sftpResumeRequest(upload, session, operation, 'status');
                if (!Number.isSafeInteger(state.offset) || state.offset < 0 || state.offset > upload.total || state.chunkSize !== 4 * 1024 * 1024) throw new Error('服务器返回了无效续传进度');
                upload.confirmed = state.offset; upload.sent = state.offset;
                upload.startedAt = Date.now(); upload.startedOffset = state.offset;
                while (!state.completed && upload.confirmed < upload.total && !operation.cancelled) {
                    upload.phase = ''; upload.status = 'running';
                    var chunk = upload.file.slice(upload.confirmed, Math.min(upload.total, upload.confirmed + state.chunkSize));
                    var hash = sftpUploadHex(await sftpUploadDigest(await chunk.arrayBuffer()));
                    var nextOffset = upload.confirmed + chunk.size;
                    state = await sftpResumeRequest(upload, session, operation, 'chunk', chunk, hash);
                    if (state.offset !== nextOffset) throw new Error('服务器返回了无效续传进度');
                    upload.confirmed = state.offset; upload.sent = state.offset; failures = 0;
                    renderSftpTransfers(session);
                }
                if (operation.cancelled) break;
                if (!state.completed) {
                    upload.status = 'processing'; upload.phase = '正在校验完整文件并保存到目标目录…'; renderSftpTransfers(session);
                    state = await sftpResumeRequest(upload, session, operation, 'complete');
                }
                if (!state.completed) throw new Error('服务器尚未确认上传完成');
                if (operation.cancelled || upload.status === 'error') break;
                upload.status = 'completed'; upload.sent = upload.total; upload.confirmed = upload.total;
                try { localStorage.removeItem(upload.resumeKey); } catch (e) { }
                // The commit receipt is kept until success is acknowledged, so a
                // lost response can be retried safely. Discard never deletes the destination.
                try { await sftpResumeRequest(upload, session, operation, 'discard'); } catch (e) { }
                showToast('上传成功: ' + upload.name, 'success'); scheduleSftpUploadRefresh(session, upload.path);
                break;
            } catch (error) {
                if (operation.cancelled || !error.retryable || ++failures > 3) throw error;
                upload.status = 'running'; upload.phase = '连接中断，正在重试续传（' + failures + '/3）…'; renderSftpTransfers(session);
                await new Promise(function (resolve) {
                    var timer = setTimeout(resolve, Math.pow(2, failures - 1) * 1000);
                    operation.wake = function () { clearTimeout(timer); resolve(); };
                });
                operation.wake = null;
            }
        }
    } catch (error) {
        if (upload.status !== 'completed') {
            upload.status = operation.cancelled && !upload.abortReason ? 'cancelled' : 'error';
            upload.error = upload.abortReason || error.message || '上传失败，可继续上传';
        }
    } finally {
        upload.phase = ''; upload.finishedAt = Date.now();
        if (upload.status !== 'completed') upload.sent = upload.confirmed || 0;
        var index = session._sftpUploadControllers.indexOf(operation);
        if (index >= 0) session._sftpUploadControllers.splice(index, 1);
        if (upload.xhr === operation) upload.xhr = null;
        renderSftpTransfers(session); pumpSftpUploadQueue();
    }
}

async function discardSftpUpload(id) {
    var upload = findSftpUpload(id);
    if (!upload || upload.xhr) return;
    var session = getSessionById(upload.sessionId);
    if (!session || !session._connected) { showToast('请先连接服务器，再删除上传进度', 'error'); return; }
    if (!confirm('放弃此上传并删除已上传的临时数据？')) return;
    var operation = { cancelled: false };
    upload.xhr = operation;
    try {
        if (upload.resumeId) await sftpResumeRequest(upload, session, operation, 'discard');
        try { localStorage.removeItem(upload.resumeKey); } catch (e) { }
        dismissSftpUpload(id);
    } catch (error) { showToast(error.message || '删除上传进度失败', 'error'); }
    finally { if (upload.xhr === operation) upload.xhr = null; renderSftpTransfers(session); pumpSftpUploadQueue(); }
}

async function selectSftpUploadFolder() {
    // File System Access includes empty directories. Keep webkitdirectory as
    // a fallback for browsers/HTTP origins without this API.
    if (typeof window.showDirectoryPicker !== 'function') { document.getElementById('sftpUploadFolderInput').click(); return; }
    var session = getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    var destination = normalizeSftpDir(session.sftpPath || '/');
    try {
        var root = await window.showDirectoryPicker({ mode: 'read' });
        var files = [], directories = [];
        async function collect(handle, relative, depth) {
            if (depth > 128 || files.length + directories.length >= 500000) throw new Error('文件夹层级或项目数量过多');
            directories.push(relative);
            for await (var child of handle.values()) {
                if (child.kind === 'directory') await collect(child, relative + '/' + child.name, depth + 1);
                else files.push({ file: await child.getFile(), dir: relative });
            }
        }
        await collect(root, root.name, 0);
        for (var relative of directories) {
            if (!session._connected || sessions.indexOf(session) < 0) throw new Error('SSH 连接已断开');
            var slash = relative.lastIndexOf('/');
            await remoteEditorRequest('/file/mkdir', { sshInfo: session.sshInfo, path: slash < 0 ? destination : (destination === '/' ? '' : destination) + '/' + relative.substring(0, slash), name: relative.substring(slash + 1), existingOK: true });
        }
        var uploads = files.map(function (entry) {
            return { id: newSftpUploadId('upload'), sessionId: session.id, path: destination, name: entry.file.name, file: entry.file, dir: entry.dir, resumable: true, total: entry.file.size, sent: 0, status: 'queued', queueOrder: ++sftpUploadSequence, xhr: null };
        });
        session._sftpUploads = uploads.concat(session._sftpUploads || []);
        renderSftpTransfers(session); pumpSftpUploadQueue(); scheduleSftpUploadRefresh(session, destination);
        if (!files.length) showToast('空文件夹已上传', 'success');
    } catch (error) {
        if (error.name !== 'AbortError') showToast(error.msg || error.message || '上传文件夹失败', 'error');
    }
}

function openNewRemoteFolder() {
    var session = getActiveSession();
    if (!session || !session._connected) { showToast('SSH 连接尚未就绪', 'error'); return; }
    var name = prompt('新建文件夹名称');
    if (name === null) return;
    var path = normalizeSftpDir(session.sftpPath || '/');
    remoteEditorRequest('/file/mkdir', { sshInfo: session.sshInfo, path: path, name: name })
        .then(function () { showToast('文件夹已创建', 'success'); invalidateSftpDirectoryCache(session, path, false); sftpLoad(path, session, { force: true }); })
        .catch(function (error) { showToast(error.msg || '新建文件夹失败', 'error'); });
}
