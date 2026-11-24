// WEBSSH_PLAYWRIGHT=/path/to/playwright WEBSSH_BROWSER=msedge node test/upload_browser.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '../public');

(async () => {
    const browser = await chromium.launch({ channel: process.env.WEBSSH_BROWSER || undefined, headless: true });
    const errors = [], requests = [], chunks = [];
    let received = 0, dropped = false, completed = false;
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/*', async route => {
            const request = route.request(), url = new URL(request.url());
            if (url.pathname === '/file/upload/resume') {
                const body = request.postDataBuffer().toString('latin1');
                const match = body.match(/name="metadata"\r\n\r\n([^\r]+)\r\n/);
                assert.ok(match, 'metadata field');
                const metadata = JSON.parse(Buffer.from(match[1], 'latin1').toString('utf8'));
                requests.push(metadata.action);
                if (metadata.action === 'chunk') {
                    assert.equal(metadata.offset, received);
                    chunks.push(metadata.offset);
                    received += Math.min(4194304, metadata.size - metadata.offset);
                    if (!dropped) { dropped = true; return route.abort('failed'); }
                }
                if (metadata.action === 'complete') completed = true;
                return route.fulfill({ json: { Msg: 'success', Data: { offset: received, completed, chunkSize: 4194304 } } });
            }
            if (url.pathname === '/file/mkdir' || url.pathname === '/file/rmdir') {
                requests.push({ endpoint: url.pathname, body: request.postDataJSON() });
                return route.fulfill({ json: { Msg: 'success', Data: {} } });
            }
            if (url.pathname === '/file/list') return route.fulfill({ json: { Msg: 'success', Data: { path: '/tmp', list: [{ Name: 'folder', IsDir: true, Downloadable: true, Size: '-' }] } } });
            if (url.pathname === '/config' || url.pathname.startsWith('/api/')) return route.fulfill({ json: url.pathname === '/config' ? { savePass: true, requireAccount: false } : { code: 0, data: null } });
            const filename = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
            try {
                let body = fs.readFileSync(filename);
                if (filename.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
                return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' })[path.extname(filename)] || 'application/octet-stream' });
            } catch { return route.fulfill({ status: 404, body: '' }); }
        });
        await page.goto('http://localhost/?preview=terminal&drawer=none');
        await page.evaluate(() => {
            const BaseWorker = window.Worker; window.hashWorkerCount = 0;
            window.Worker = function (url) { window.hashWorkerCount++; return new BaseWorker(url); };
            document.getElementById('splash')?.remove();
            document.getElementById('terminalContainer').innerHTML = '';
            createSession('test-host', 22, 'test-user', 'test-ssh'); switchTab(0);
            const session = sessions[0]; session._connected = true; session.sshInfo = 'test-ssh'; session.sftpPath = '/tmp';
            document.getElementById('sftpPanel').classList.add('open');
            session._sftpListState = 'ready'; session._sftpList = [{ Name: 'folder', IsDir: true, Downloadable: true, Size: '-' }];
            renderSftpList(session);
        });
        // Real File/Blob slicing, hashing, FormData, XHR progress and retry.
        await page.locator('#sftpUploadInput').setInputFiles({ name: 'large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(4194304 + 37, 17) });
        await page.waitForFunction(() => sessions[0]._sftpUploads[0]?.status === 'completed', null, { timeout: 30000 });
        assert.deepEqual(chunks, [0, 4194304], 'lost chunk response must resume from server offset');
        assert.equal(received, 4194304 + 37);
        assert.ok(requests.includes('complete'));
        assert.ok(await page.evaluate(() => hashWorkerCount > 0), 'upload fingerprint must run in a worker');
        assert.equal(await page.evaluate(() => sessions[0]._sftpUploads[0].chunkHashes.length), 2);
        page.once('dialog', dialog => dialog.accept('new folder'));
        await page.getByRole('button', { name: '新建文件夹', exact: true }).click();
        await page.waitForResponse(response => response.url().endsWith('/file/list'));
        await page.locator('.sftp-row .sftp-delete').first().click();
        assert.match(await page.locator('#sftpDeleteConfirmDescription').textContent(), /全部子文件夹和文件/);
        await page.locator('#sftpDeleteConfirmButton').click();
        await page.waitForFunction(() => !document.getElementById('sftpDeleteConfirmModal').classList.contains('show'));
        const deletion = requests.find(item => item.endpoint === '/file/rmdir');
        assert.equal(deletion.body.confirmed, true); assert.equal(deletion.body.path, '/tmp/folder');
        assert.equal(requests.find(item => item.endpoint === '/file/mkdir').body.name, 'new folder');
        for (const width of [1440, 390]) {
            await page.setViewportSize({ width, height: 900 });
            await page.waitForTimeout(350);
            const bounds = await page.locator('.sftp-header').evaluate(header => ({ width: header.clientWidth, scroll: header.scrollWidth, controls: [...header.querySelectorAll('button')].map(button => ({ left: button.getBoundingClientRect().left, right: button.getBoundingClientRect().right })), viewport: innerWidth }));
            assert.ok(bounds.scroll <= bounds.width + 1, JSON.stringify(bounds));
            assert.ok(bounds.controls.every(button => button.left >= 0 && button.right <= bounds.viewport + 1), JSON.stringify(bounds));
            if (process.env.WEBSSH_UI_OUTPUT) { fs.mkdirSync(process.env.WEBSSH_UI_OUTPUT, { recursive: true }); await page.screenshot({ path: path.join(process.env.WEBSSH_UI_OUTPUT, 'upload-' + width + '.png') }); }
        }
        assert.deepEqual(errors, []);
        console.log('PASS: browser chunk retry, directory create/delete confirmation, desktop/mobile layout');
    } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
