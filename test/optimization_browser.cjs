const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '../public');

(async () => {
    const browser = await chromium.launch({ channel: process.env.WEBSSH_BROWSER || undefined, headless: true });
    const errors = [], nativeRequests = [];
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', route => {
            const request = route.request(), url = new URL(request.url());
            if (url.pathname === '/file/download' || url.pathname === '/file/archive/download') {
                const fields = Object.fromEntries(new URLSearchParams(request.postData()));
                nativeRequests.push({ path: url.pathname, fields, search: url.search });
                if (fields.path === '/denied') return route.fulfill({ status: 403, json: { Msg: 'permission denied' } });
                if (fields.path === '/null-response') return route.fulfill({ status: 200, body: 'null', contentType: 'application/json' });
                return route.fulfill({ body: 'native-stream-body', contentType: 'application/octet-stream', headers: { 'Content-Disposition': 'attachment; filename="native.bin"' } });
            }
            if (url.pathname === '/config' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/file/')) return route.fulfill({ json: url.pathname === '/config' ? { savePass: false, requireAccount: false } : { code: 0, data: null, Msg: 'success', Data: { path: '/', list: [] } } });
            const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
            try {
                let body = fs.readFileSync(file);
                if (file.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
                return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });
            } catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await page.goto('http://localhost/?preview=terminal&drawer=none');
        const timings = await page.evaluate(async () => {
            document.getElementById('splash')?.remove(); await document.fonts.ready;
            createSession('audit-host', 22, 'root', 'synthetic-credential'); switchTab(sessions.length - 1);
            const session = getActiveSession(); session._connected = true; session._sftpListState = 'ready'; session._sftpListPath = '/';
            session._sftpList = Array.from({ length: 2000 }, (_, id) => ({ Name: 'file-' + id, Editable: true, Downloadable: true, Size: '1K' }));
            document.getElementById('sftpPanel').classList.add('open');
            const start = performance.now(); renderSftpList(session); document.getElementById('sftpBody').getBoundingClientRect();
            return { milliseconds: performance.now() - start, nodes: document.getElementById('sftpBody').querySelectorAll('*').length };
        });
        assert.equal(await page.locator('.sftp-row').count(), 100);
        await page.getByRole('button', { name: '下一页', exact: true }).click();
        assert.match(await page.locator('.sftp-row .sftp-name').first().textContent(), /file-100/);
        await page.locator('#sftpSearchInput').fill('file-1999');
        assert.equal(await page.locator('.sftp-row').count(), 1);
        await page.evaluate(() => {
            const session = getActiveSession();
            session._sftpUploads = Array.from({ length: 500 }, (_, id) => ({ id: 'task-' + id, name: 'file-' + id, total: 100, sent: 20, status: 'running', startedAt: Date.now() - 1000 }));
            renderSftpTransfersNow(session); window.firstTransfer = document.querySelector('.sftp-transfer-item');
            session._sftpUploads[0].sent = 60; renderSftpTransfersNow(session);
            renderSftpTransfers({ id: 'background', _sftpUploads: [{}] });
        });
        assert.equal(await page.locator('.sftp-transfer-item').count(), 20);
        assert.equal(await page.evaluate(() => firstTransfer === document.querySelector('.sftp-transfer-item')), true, 'progress preserves the existing card node');
        assert.equal(await page.locator('.sftp-transfer-item .sftp-transfer-progress i').first().evaluate(node => node.style.width), '60%');
        await page.evaluate(() => {
            window.transferSwitchFirst = getActiveSession();
            renderSftpTransfers(transferSwitchFirst);
            const other = createSession('other-host', 22, 'root', 'test'); other._connected = true;
            other._sftpUploads = [{ id: 'other-task', name: 'other-file', total: 100, sent: 10, status: 'running', startedAt: Date.now() - 1000 }];
            switchTab(sessions.indexOf(other));
            other._sftpUploads[0].sent = 80; renderSftpTransfers(other);
        });
        await page.waitForFunction(() => document.querySelector('.sftp-transfer-item .sftp-transfer-progress i').style.width === '80%');
        await page.evaluate(() => switchTab(sessions.indexOf(transferSwitchFirst)));
        // Use a real click and a real browser download. A large expected size
        // must not force page-memory buffering or leak SSH data into the URL.
        await page.evaluate(() => {
            const button = document.createElement('button'); button.id = 'native-download-test'; button.textContent = 'native-test';
            Object.assign(button.style, { position: 'fixed', right: '20px', bottom: '60px', zIndex: '999999' });
            button.onclick = () => startSftpDownload(getActiveSession(), '/large', 6 * 1024 ** 3, 'native.bin', null, false);
            document.body.appendChild(button);
        });
        const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#native-download-test').click()]);
        assert.equal(fs.readFileSync(await download.path(), 'utf8'), 'native-stream-body');
        assert.deepEqual(nativeRequests[0], { path: '/file/download', fields: { sshInfo: 'synthetic-credential', path: '/large', archive: 'false' }, search: '' });
        assert.equal(await page.evaluate(() => getActiveSession()._sftpDownloads[0].status), 'native');
        await page.evaluate(() => {
            document.getElementById('native-download-test').onclick = function () {
                const session = getActiveSession();
                const task = { id: 'native-archive', sessionId: session.id, isDirectory: true, archiveReady: true, archiveJobId: 'archive-job', name: 'folder.tar.gz', expectedSize: 400 * 1024 ** 2 };
                session._sftpDownloads.unshift(task); runSftpDownload(task);
            };
        });
        const [archive] = await Promise.all([page.waitForEvent('download'), page.locator('#native-download-test').click()]);
        assert.equal(fs.readFileSync(await archive.path(), 'utf8'), 'native-stream-body');
        assert.deepEqual(nativeRequests[1], { path: '/file/archive/download', fields: { jobId: 'archive-job' }, search: '' });
        await page.evaluate(() => startSftpDownload(getActiveSession(), '/denied', 300 * 1024 ** 2, 'denied.bin', null, false));
        await page.waitForFunction(() => getActiveSession()._sftpDownloads[0].status === 'error');
        await page.evaluate(() => startSftpDownload(getActiveSession(), '/null-response', 300 * 1024 ** 2, 'invalid.bin', null, false));
        await page.waitForFunction(() => getActiveSession()._sftpDownloads[0].status === 'error');
        assert.deepEqual(errors, []);
        console.log(`PASS: paged directory render ${timings.milliseconds.toFixed(1)} ms / ${timings.nodes} DOM nodes, paged incremental progress, background isolation, native large download and HTTP error handling`);
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
