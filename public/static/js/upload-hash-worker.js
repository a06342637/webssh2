// File bytes and digest calculations stay off the UI thread.
importScripts('/static/js/upload.js' + self.location.search);
self.onmessage = async function (event) {
    try {
        var file = event.data.file, chunkSize = 4 * 1024 * 1024;
        var hashes = [], digests = new Uint8Array(Math.ceil(file.size / chunkSize) * 32);
        for (var offset = 0; offset < file.size; offset += chunkSize) {
            var digest = await sftpUploadDigest(await file.slice(offset, offset + chunkSize).arrayBuffer());
            digests.set(digest, offset / chunkSize * 32);
            hashes.push(sftpUploadHex(digest));
            self.postMessage({ processed: Math.min(file.size, offset + chunkSize) });
        }
        self.postMessage({ fingerprint: sftpUploadHex(await sftpUploadDigest(digests)), hashes: hashes });
    } catch (error) { self.postMessage({ error: error.message || '文件校验失败' }); }
};
