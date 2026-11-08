const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
// Run: node test/server_info_browser.cjs (or set WEBSSH_PLAYWRIGHT and WEBSSH_BROWSER).
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '../public');
const output = path.resolve(__dirname, '../tmp');
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/config' || url.pathname.startsWith('/api/')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify(url.pathname === '/config' ? { savePass: false, requireAccount: false } : { code: 0, data: null }));
    }
    const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
    try {
        res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream');
        let body = fs.readFileSync(file);
        if (file.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
        res.end(body);
    } catch { res.statusCode = 404; res.end(); }
});
(async () => {
    fs.mkdirSync(output, { recursive: true });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const browser = await chromium.launch({ channel: process.env.WEBSSH_BROWSER || undefined, headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${server.address().port}/?preview=terminal&drawer=none&theme=dark`);
        await page.evaluate(async () => {
            document.getElementById('splash').remove();
            await document.fonts.ready;
            const data = {
                cpuModel: 'AMD EPYC 7551 32-Core Processor', cpuCores: '2', cpuUsage: '28.4', arch: 'x86_64',
                os: 'Debian GNU/Linux 13 (trixie)', kernelVersion: '6.12.107+deb13-cloud-amd64', hostname: 'test-server', uptime: '3180600', load: '0.32 0.28 0.19',
                memTotal: String(1024 ** 3), memUsed: String(340 * 1024 ** 2), memAvailable: String(684 * 1024 ** 2),
                swapTotal: '0', swapUsed: '0', diskTotal: String(50 * 1024 ** 3), diskUsed: String(12 * 1024 ** 3), diskFree: String(38 * 1024 ** 3),
                tcpCount: '7', udpCount: '3', processCount: '89', mainIface: 'eth0', rxRate: '2000000', txRate: '900000', rxTotal: '12000000000', txTotal: '8000000000', updatedAt: new Date().toISOString(),
                interfaces: ['eth0', 'eth1'].map((name, i) => ({ name, main: String(i === 0), rxRate: String(2000000 / (i + 1)), txRate: '900000', rxTotal: '12000000000', txTotal: '8000000000' })),
                processes: Array.from({ length: 16 }, (_, i) => ({ pid: String(1000 + i), user: 'root', rss: '24000', cpu: String(9 - i / 2), name: `process-${i}`, cmd: `/usr/bin/process-${i} --configuration /etc/test/really-long-config-file.conf` })),
                filesystems: Array.from({ length: 24 }, (_, i) => ({ name: `/dev/device-${i}`, mount: i === 0 ? '/' : `/mnt/filesystem-${i}`, size: '50000000000', used: '12000000000', avail: '38000000000', pct: '24%' }))
            };
            const session = { id: 'monitor-test', hostname: '192.0.2.10', _lastMetrics: data, _connected: false };
            sessions.push(session); activeIdx = 0;
            const now = Date.now();
            session._resourceHistory = Array.from({ length: 37 }, (_, i) => ({ t: now - (36 - i) * 5000, cpu: 20 + Math.sin(i / 3) * 10, mem: 30 + i / 10, disk: 24, tcp: 7 + i % 3, udp: 3, conn: 10 + i % 3, processes: 89 + i % 2, load: 0.32, swap: 0 }));
            session._lastResourceUpdatedAt = now;
            session._netHistory = {};
            for (const name of ['eth0', 'eth1']) session._netHistory[name] = Array.from({ length: 181 }, (_, i) => ({ t: now - (180 - i) * 1000, rx: (1.2 + Math.sin(i / 15) * .8) * 1000000, tx: (.8 + Math.cos(i / 11) * .6) * 1000000 }));
            openServerInfoModal(0);
        });
        assert.equal(await page.locator('.monitor-resource').count(), 6);
        assert.equal(await page.locator('.monitor-usage-bar').count(), 3);
        assert.equal(await page.locator('[data-server-key="processes"] tbody tr').count(), 16);
        assert.equal(await page.locator('[data-server-key="filesystems"] tbody tr').count(), 24);
        await page.screenshot({ path: path.join(output, 'server-info-desktop.png') });
        const scrollCheck = await page.evaluate(async () => {
            const body = document.getElementById('serverInfoBody');
            const wraps = [...body.querySelectorAll('.server-table-wrap')];
            body.scrollTop = body.scrollHeight;
            wraps.forEach(el => { el.scrollTop = 150; el.scrollLeft = 70; });
            const positions = [body, ...wraps].map(el => [el.scrollTop, el.scrollLeft]);
            const firstRow = wraps[0].querySelector('tbody tr');
            for (let i = 0; i < 8; i++) {
                const session = sessions[0], data = session._lastMetrics;
                data.rxRate = String(1000000 + i * 100000);
                // Exercise both one-second network messages and full snapshots.
                if (i % 2) { data.processes[0].cpu = String(i); data.processes.reverse(); recordResourceSample(session, data); }
                recordNetworkSample(session, data);
                renderServerInfo(data, session);
                await new Promise(resolve => requestAnimationFrame(resolve));
            }
            return { positions, after: [body, ...wraps].map(el => [el.scrollTop, el.scrollLeft]), retained: wraps.every(el => el.isConnected), rowRetained: firstRow.isConnected };
        });
        assert.deepEqual(scrollCheck.after, scrollCheck.positions, 'both tables and outer drawer retain vertical/horizontal scroll through network and resource refreshes');
        assert.ok(scrollCheck.retained && scrollCheck.rowRetained, 'scroll containers and keyed process rows retain DOM identity');
        await page.screenshot({ path: path.join(output, 'server-info-tables.png') });
        // The focused interface selector must survive updates without freezing the charts.
        const focusCheck = await page.evaluate(() => {
            const select = document.querySelector('.server-iface-select'); select.focus();
            sessions[0]._lastMetrics.cpuUsage = '37'; renderServerInfo(sessions[0]._lastMetrics, sessions[0]);
            return { retained: select === document.activeElement, value: document.querySelector('[data-server-key="resource-cpu"] .monitor-resource-value').textContent };
        });
        assert.deepEqual(focusCheck, { retained: true, value: '37.0%' });
        await page.locator('.server-iface-select').selectOption('eth1');
        assert.equal(await page.locator('.server-iface-select').inputValue(), 'eth1');
        for (const type of ['processes', 'filesystems', 'disk']) {
            await page.evaluate(type => openServerInfoDetailModal(type), type);
            const detailCheck = await page.evaluate(async () => {
                const body = document.getElementById('serverInfoDetailBody'), wrap = body.querySelector('.server-table-wrap');
                body.scrollTop = body.scrollHeight; wrap.scrollTop = 100; wrap.scrollLeft = 65;
                const before = [body.scrollTop, wrap.scrollTop, wrap.scrollLeft];
                for (let i = 0; i < 3; i++) { sessions[0]._lastMetrics.processes[0].cpu = String(i); renderServerInfo(sessions[0]._lastMetrics, sessions[0]); await new Promise(resolve => requestAnimationFrame(resolve)); }
                return { before, after: [body.scrollTop, wrap.scrollTop, wrap.scrollLeft], retained: wrap.isConnected };
            });
            assert.deepEqual(detailCheck.after, detailCheck.before, `${type} expanded view preserves scroll`);
            assert.ok(detailCheck.retained);
            await page.evaluate(() => hideServerInfoDetailModal());
        }
        await page.evaluate(() => { document.getElementById('serverInfoBody').scrollTop = 0; });
        await page.getByRole('button', { name: '10 分钟', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '10 分钟', exact: true }).getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: '趋势图', exact: true }).click();
        assert.equal(await page.locator('.chart-style-lines .net-line').count(), 2);
        await page.getByRole('button', { name: 'bits/s', exact: true }).click();
        assert.match(await page.locator('.net-stat.rx b').textContent(), /bps/);
        await page.getByRole('button', { name: '条形图', exact: true }).click();
        assert.ok(await page.locator('.net-bar-pair').count() > 0);
        await page.getByRole('button', { name: '30 分钟', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '30 分钟', exact: true }).getAttribute('aria-pressed'), 'true');
        await page.evaluate(() => { changeServerInfoChart(3, 'bars'); changeServerNetUnit('bytes'); });
        await page.locator('.monitor-resource.cpu .resource-hover .chart-hover-hit').nth(15).hover();
        assert.ok(await page.locator('.monitor-resource.cpu .chart-hover-tip').nth(15).isVisible(), 'resource chart hover shows the sample time and value');
        // Long ranges use averages without changing the underlying samples.
        const aggregation = await page.evaluate(() => {
            const samples = [{t: 1000, rx: 10, tx: 2}, {t: 2000, rx: 30, tx: 4}, {t: 10000, rx: 100, tx: 20}];
            const grouped = aggregateNetworkHistory(samples, {span: 1800000});
            return {grouped, original: samples[0].rx};
        });
        assert.equal(aggregation.grouped.length, 2);
        assert.equal(aggregation.grouped[0].rx, 20);
        assert.equal(aggregation.grouped[0].tx, 3);
        assert.equal(aggregation.original, 10);
        // Unit/counter data and process command text remain escaped.
        await page.evaluate(() => {
            const data = sessions[0]._lastMetrics;
            data.hostname = '<img src=x onerror=alert(1)>';
            data.processes[0].cmd = '<script>window.monitorInjection=true</script>';
            renderServerInfo(data, sessions[0]);
        });
        assert.equal(await page.locator('.monitor-dashboard img, .monitor-dashboard script').count(), 0);
        await page.evaluate(() => { sessions[0]._lastMetrics.hostname = 'test-server'; sessions[0]._lastMetrics.processes[0].cmd = '/usr/bin/test'; renderServerInfo(sessions[0]._lastMetrics, sessions[0]); });
        for (const width of [768, 390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            await page.evaluate(() => document.getElementById('serverInfoBody').scrollTop = 0);
            const dimensions = await page.locator('#serverInfoBody').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
            assert.equal(dimensions.scroll, dimensions.client, `no drawer horizontal overflow at ${width}px`);
            if (width === 390) {
                await page.screenshot({ path: path.join(output, 'server-info-mobile.png') });
                await page.locator('.monitor-resource.cpu').scrollIntoViewIfNeeded();
                await page.screenshot({ path: path.join(output, 'server-info-mobile-charts.png') });
            }
        }
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.evaluate(() => applyTheme('light'));
        await page.screenshot({ path: path.join(output, 'server-info-light.png') });
        // Error states retain the last good data; the next render recovers.
        await page.evaluate(() => renderServerInfoError('临时错误'));
        assert.equal(await page.locator('.monitor-dashboard').count(), 1);
        assert.equal(await page.locator('.monitor-refresh-error').count(), 1);
        const recovery = await page.evaluate(() => {
            const dashboard = document.querySelector('.monitor-dashboard');
            const wrap = document.querySelector('.server-table-wrap'); wrap.scrollTop = 120;
            renderServerInfo(sessions[0]._lastMetrics, sessions[0]);
            return {retained: dashboard.isConnected && wrap.isConnected, top: wrap.scrollTop};
        });
        assert.deepEqual(recovery, {retained: true, top: 120}, 'transient errors recover without replacing the dashboard or resetting tables');
        assert.equal(await page.locator('.monitor-refresh-error').count(), 0);
        await page.evaluate(() => { sessions.push({ id: 'other', hostname: '192.0.2.11', _lastMetrics: sessions[0]._lastMetrics }); openServerInfoModal(1); });
        assert.equal(await page.locator('#serverInfoBody').evaluate(el => el.scrollTop), 0, 'switching machines starts at the top');
        assert.deepEqual(errors, []);
        console.log('Machine dashboard checks passed: repeated refresh/scroll preservation, keyed rows, expanded tables, focused selector, interface/unit/chart controls, dark/light themes, 768/390/320px layouts, escaping, retry and machine switching.');
    } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
