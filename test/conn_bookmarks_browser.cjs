// Run with Playwright installed, or set WEBSSH_PLAYWRIGHT to its package directory.
// WEBSSH_BROWSER selects an installed Chromium channel; WEBSSH_UI_OUTPUT saves previews.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '../public');
const entries = [
  { id: 'ssh-1', protocol: 'ssh', hostname: '192.0.2.10', port: 22, username: 'root', authType: 'password' },
  { id: 'ssh-2', protocol: 'ssh', hostname: 'dev.example.com', port: 2222, username: 'deploy', authType: 'password', password: 'test-only', note: '开发环境 · 应用服务' },
  { id: 'rdp-1', protocol: 'rdp', hostname: '192.0.2.30', port: 3389, username: 'Administrator', authType: 'password', note: 'Windows 工作站' },
];

(async () => {
  const browser = await chromium.launch({ channel: process.env.WEBSSH_BROWSER || undefined, headless: true });
  const errors = [];
  try {
    async function openPage(options = {}) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...options });
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.pathname === '/config' || url.pathname.startsWith('/api/')) {
          return route.fulfill({ json: url.pathname === '/config' ? { savePass: true, requireAccount: false } : { code: 0, data: null } });
        }
        const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
        try {
          let body = fs.readFileSync(file);
          if (file.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
          return route.fulfill({ body, contentType: ({ '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.woff2': 'font/woff2' })[path.extname(file)] || 'application/octet-stream' });
        } catch { return route.fulfill({ status: 404, body: '' }); }
      });
      await page.goto('http://localhost/');
      await page.evaluate(async bookmarks => {
        document.getElementById('splash')?.remove();
        await document.fonts.ready;
        localStorage.setItem('webssh_conn_bm', JSON.stringify(bookmarks));
        renderConnBookmarks();
        toggleConnDrawer();
      }, entries);
      return page;
    }
    async function screenshot(page, name) {
      if (!process.env.WEBSSH_UI_OUTPUT) return;
      fs.mkdirSync(process.env.WEBSSH_UI_OUTPUT, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WEBSSH_UI_OUTPUT, name + '.png'), animations: 'disabled' });
    }
    async function checkBounds(page) {
      const bounds = await page.locator('#connDrawer').evaluate(drawer => {
        const list = drawer.querySelector('.drawer-list');
        const footer = drawer.querySelector('.conn-bm-footer');
        return { drawer: drawer.getBoundingClientRect().toJSON(), footer: footer.getBoundingClientRect().toJSON(), overflow: list.scrollWidth - list.clientWidth, listHeight: list.clientHeight, rowHeights: [...list.querySelectorAll('.conn-bm-connect')].map(row => row.getBoundingClientRect().height), viewport: { width: innerWidth, height: innerHeight } };
      });
      assert.ok(bounds.drawer.left >= 0 && bounds.drawer.right <= bounds.viewport.width, JSON.stringify(bounds));
      assert.ok(bounds.footer.bottom <= bounds.viewport.height && bounds.footer.top > 0, JSON.stringify(bounds));
      assert.equal(bounds.overflow, 0);
      assert.ok(bounds.listHeight > 80);
      assert.ok(bounds.rowHeights.every(height => height >= 44 && height <= 52), 'bookmark rows stay compact even with long hosts and notes');
    }
    const page = await openPage();
    const drawer = page.locator('#connDrawer');
    const menu = id => drawer.locator(`[data-bookmark-id="${id}"] .conn-bm-menu`);
    await checkBounds(page);
    await screenshot(page, 'bookmarks-dark');
    assert.equal(await drawer.getByRole('button', { name: '编辑书签', exact: true }).count(), 0, 'actions are tucked away initially');
    await menu('ssh-1').locator('summary').click();
    assert.equal(await menu('ssh-1').getByRole('button', { name: '上移书签' }).isDisabled(), true);
    await screenshot(page, 'bookmarks-menu');
    await page.keyboard.press('Escape');
    assert.equal(await drawer.locator('.conn-bm-menu[open]').count(), 0);
    assert.equal(await menu('ssh-1').locator('summary').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Enter');
    await menu('ssh-1').getByRole('button', { name: '下移书签' }).click();
    assert.equal(await drawer.evaluate(el => el.classList.contains('open')), true, 'redrawing the clicked row must not dismiss the drawer');
    assert.deepEqual(await drawer.locator('.conn-bm-group[data-protocol="ssh"] .conn-bm-item').evaluateAll(els => els.map(el => el.dataset.bookmarkId)), ['ssh-2', 'ssh-1']);
    assert.equal(await menu('ssh-1').locator('summary').evaluate(el => document.activeElement === el), true, 'keyboard focus follows the moved bookmark');
    await menu('ssh-2').locator('summary').click();
    await menu('ssh-2').getByRole('button', { name: '编辑书签' }).click();
    await page.locator('#connBookmarkNote').fill('更新后的开发环境');
    await page.locator('#connBookmarkForm button[type=submit]').click();
    assert.equal(await drawer.locator('.conn-bm-note').first().textContent(), '更新后的开发环境');
    await page.locator('#connBookmarkSearch').fill('工作站');
    assert.equal(await drawer.locator('.conn-bm-item').count(), 1);
    assert.equal(await drawer.locator('.conn-bm-item').getAttribute('data-protocol'), 'rdp');
    await page.locator('#connBookmarkSearch').fill('no-such-bookmark');
    assert.equal(await drawer.locator('.bm-empty').count(), 2);
    await page.locator('#connBookmarkSearch').fill('');
    await menu('ssh-2').locator('summary').click();
    await menu('ssh-1').locator('summary').click();
    assert.equal(await drawer.locator('.conn-bm-menu[open]').count(), 1, 'only one action group opens at a time');
    await page.locator('#connBookmarkSearch').click();
    assert.equal(await drawer.locator('.conn-bm-menu[open]').count(), 0, 'clicking outside an action group closes it');
    await page.reload();
    await page.evaluate(async () => { document.getElementById('splash')?.remove(); await document.fonts.ready; toggleConnDrawer(); });
    assert.deepEqual(await drawer.locator('.conn-bm-group[data-protocol="ssh"] .conn-bm-item').evaluateAll(els => els.map(el => el.dataset.bookmarkId)), ['ssh-2', 'ssh-1']);
    assert.equal(await drawer.locator('.conn-bm-note').first().textContent(), '更新后的开发环境');
    await page.evaluate(() => applyTheme('light'));
    await screenshot(page, 'bookmarks-light');
    assert.equal(await drawer.locator('.drawer-body').evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(247, 248, 250)');

    const mobile = await openPage({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
    assert.equal(await mobile.locator('.conn-bm-drag').first().isVisible(), false);
    await checkBounds(mobile);
    await mobile.locator('.global-footer').waitFor({ state: 'hidden' });
    assert.equal(await mobile.locator('.global-footer').isVisible(), false, 'page footer cannot cover the drawer actions');
    await screenshot(mobile, 'bookmarks-mobile');
    for (const viewport of [{ width: 320, height: 568 }, { width: 667, height: 375 }]) {
      await mobile.setViewportSize(viewport);
      await checkBounds(mobile);
      await mobile.locator('.conn-bm-menu summary').first().click();
      await mobile.locator('.conn-bm-menu[open]').getByRole('button', { name: '下移书签' }).click();
      assert.equal(await mobile.locator('#connDrawer').evaluate(el => el.classList.contains('open')), true);
    }
    await mobile.evaluate(() => {
      localStorage.setItem('webssh_conn_bm', JSON.stringify([{ id: 'long-host', protocol: 'ssh', hostname: '2001:db8:1234:5678:abcd:abcd:abcd:abcd', username: 'a-long-administrator-name', port: 2222, note: '一段较长的连接说明'.repeat(80) }]));
      renderConnBookmarks();
    });
    await mobile.setViewportSize({ width: 320, height: 568 });
    await mobile.locator('#connBookmarkList').evaluate(el => { el.scrollTop = 0; });
    await checkBounds(mobile);
    await screenshot(mobile, 'bookmarks-long-host');
    await mobile.locator('.conn-bm-menu summary').click();
    mobile.once('dialog', dialog => dialog.accept());
    await mobile.getByRole('button', { name: '删除书签', exact: true }).click();
    assert.equal(await mobile.locator('#connDrawer .conn-bm-item').count(), 0);
    assert.equal(await mobile.locator('#connDrawer .bm-empty').count(), 2);
    await screenshot(mobile, 'bookmarks-empty');
    assert.deepEqual(errors, []);
    console.log('Connection bookmarks: keyboard/menu/edit/search/persistence, touch reordering, empty states and layout checks passed.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
