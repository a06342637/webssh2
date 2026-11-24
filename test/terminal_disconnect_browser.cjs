// Install playwright and ws, or set WEBSSH_PLAYWRIGHT / WEBSSH_WS to their package paths.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const { WebSocketServer } = require(process.env.WEBSSH_WS || 'ws');
const root = path.resolve(__dirname, '../public');
const sockets = new Map(), attempts = new Map(), input = [];
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/config' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/file/')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(url.pathname === '/config' ? { savePass: false, requireAccount: false } : { code: 0, data: null, Msg: 'success', Data: { path: '/', list: [] } }));
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
        let body = fs.readFileSync(file);
        if (file.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
        res.end(body);
    } catch { res.statusCode = 404; res.end(); }
});
const wss = new WebSocketServer({ server, path: '/term' });
wss.on('connection', socket => {
    let id;
    socket.on('message', (data, binary) => {
        if (!id) {
            id = data.toString();
            const attempt = (attempts.get(id) || 0) + 1;
            attempts.set(id, attempt); sockets.set(id, socket);
            if (id === 'test-a' && attempt === 2) {
                setTimeout(() => {
                    socket.send('\x1b[31mfailed to connect: i/o timeout\x1b[0m');
                    socket.close();
                }, 250);
                return;
            }
            socket.send('__WEBSSH_CONTROL__:' + JSON.stringify({ type: 'connection-ready' }));
            socket.send(Buffer.from('\x1b[?2004hroot@oci-worker-a:~# '));
            return;
        }
        if (binary) input.push({ id, data: Buffer.from(data) });
    });
});

(async () => {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ headless: true, channel: process.env.WEBSSH_BROWSER || undefined });
    try {
        const origin = `http://127.0.0.1:${server.address().port}`;
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
        const page = await context.newPage(), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/?preview=terminal&drawer=none');
        await page.evaluate(async () => {
            document.getElementById('splash')?.remove();
            await document.fonts.ready;
            startTopbarMetricsPolling = () => {};
            maybeShowFirstServerInfoGuide = () => {};
            sessions.slice().forEach((_, index) => closeTab(index, true));
            const first = createSession('161.153.42.132', 22, 'root', 'test-a');
            const second = createSession('132.226.106.208', 22, 'root', 'test-b');
            switchTab(0);
            connectSession(first); connectSession(second);
        });
        await page.waitForFunction(() => sessions.every(session => session._connected));
        await page.evaluate(async () => {
            await new Promise(resolve => sessions[0].term.write(Array.from({ length: 80 }, (_, i) => 'history ' + i).join('\r\n') + '\r\nroot@oci-worker-a:~# ', resolve));
        });
        sockets.get('test-a').terminate();
        await page.waitForFunction(() => sessions[0]._connectionState === 'disconnected');
        await page.waitForFunction(() => {
            const buffer = sessions[0].term.buffer.active;
            let count = 0;
            for (let i = 0; i < buffer.length; i++) if (buffer.getLine(i).translateToString(true).includes('当前 SSH 已断开')) count++;
            return count === 3;
        });
        const state = await page.evaluate(() => {
            const terminal = sessions[0].term, buffer = terminal.buffer.active, rows = [];
            for (let i = 0; i < buffer.length; i++) {
                const line = buffer.getLine(i);
                if (line.translateToString(true).includes('当前 SSH 已断开')) rows.push({ text: line.translateToString(true), color: line.getCell(0).getFgColor() });
            }
            return { rows, otherConnected: sessions[1]._connected, offlineTab: document.querySelectorAll('.ssh-tab')[0].className, label: document.querySelector('.ssh-disconnected .ssh-state-label').textContent };
        });
        assert.equal(state.rows.length, 3); assert.ok(state.rows.every(row => row.color === 0xff4d4f));
        assert.equal(state.otherConnected, true); assert.equal(state.label, '已断开');
        async function selectPrompt() {
            await page.evaluate(() => {
                const terminal = sessions[0].term, buffer = terminal.buffer.active;
                for (let row = buffer.length - 1; row >= 0; row--) {
                    const line = buffer.getLine(row).translateToString(true);
                    if (line.includes('root@oci-worker-a:~#')) { terminal.select(0, row, 'root@oci-worker-a:~#'.length); break; }
                }
                terminal.focus();
            });
        }
        await selectPrompt();
        await page.keyboard.press('Control+c');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'root@oci-worker-a:~#');
        // Hold/repeat Enter during the failed attempt: only one socket starts.
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => sessions[0]._connectionState === 'disconnected');
        assert.equal(attempts.get('test-a'), 2);
        await selectPrompt();
        await page.keyboard.press('Control+Shift+c');
        assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'root@oci-worker-a:~#', 'copy must survive a failed reconnect');
        // No local Enter is forwarded into the failed SSH connection.
        assert.equal(input.filter(frame => frame.id === 'test-a').length, 0);
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => sessions[0]._connected && sessions[0].term.modes.bracketedPasteMode);
        assert.equal(attempts.get('test-a'), 3);
        assert.equal(await page.locator('.ssh-disconnected').count(), 0);
        // A paste larger than the backend's single-frame limit still keeps
        // Unicode and bracketed paste intact and yields for browser rendering.
        const measure = await page.evaluate(async () => {
            const text = '中文🙂\n'.repeat(500000);
            let ticks = 0, running = true;
            function frame() { ticks++; if (running) requestAnimationFrame(frame); }
            requestAnimationFrame(frame);
            const start = performance.now();
            pasteTextToSshSession(sessions[0], text);
            sendTerminalInput(sessions[0], 'tail\r');
            await new Promise(resolve => { const timer = setInterval(() => { if (!sessions[0]._inputQueue) { clearInterval(timer); resolve(); } }, 10); });
            running = false;
            return { elapsed: performance.now() - start, ticks };
        });
        const expected = Buffer.from('\x1b[200~' + '中文🙂\r'.repeat(500000) + '\x1b[201~tail\r');
        await new Promise(resolve => setTimeout(resolve, 100));
        const frames = input.filter(frame => frame.id === 'test-a');
        assert.deepEqual(Buffer.concat(frames.map(frame => frame.data)), expected);
        assert.ok(frames.every(frame => frame.data.length <= 65536));
        assert.ok(measure.ticks >= 2, JSON.stringify(measure));
        assert.deepEqual(errors, []);
        sockets.get('test-a').terminate();
        await page.waitForFunction(() => sessions[0]._connectionState === 'disconnected');
        if (process.env.WEBSSH_UI_SCREENSHOT) {
            await page.evaluate(() => document.querySelectorAll('.toast,.copy-toast').forEach(item => item.remove()));
            await page.screenshot({ path: process.env.WEBSSH_UI_SCREENSHOT });
        }
        console.log(`PASS: offline notices, copied history, Enter reconnect, failed reconnect copy, ${expected.length} paste bytes in ${frames.length} frames; rendering continued for ${measure.ticks} frames`);
    } finally {
        await browser.close();
        for (const socket of wss.clients) socket.terminate();
        await new Promise(resolve => wss.close(resolve));
        await new Promise(resolve => server.close(resolve));
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
