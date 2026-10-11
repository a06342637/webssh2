// Build the server first, then set WEBSSH_TEST_BINARY to its absolute path.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { randomBytes } = require('node:crypto');
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');

(async () => {
  assert.ok(process.env.WEBSSH_TEST_BINARY, 'WEBSSH_TEST_BINARY is required');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-registration-'));
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const adminPassword = randomBytes(16).toString('hex');
  let server, browser;
  async function stopServer() {
    if (server && server.exitCode === null) {
      const exited = once(server, 'exit'); server.kill(); await exited;
    }
  }
  async function startServer() {
    server = spawn(path.resolve(process.env.WEBSSH_TEST_BINARY), ['-p', String(port)], {
      windowsHide: true,
      env: { ...process.env, WEBSSH_DATA_DIR: dataDir, WEBSSH_ADMIN_USER: 'testadmin', WEBSSH_ADMIN_PASSWORD: adminPassword,
        WEBSSH_ADMIN_RESET: 'false', WEBSSH_ALLOW_REGISTRATION: '', WEBSSH_ENABLE_SELF_UPDATE: 'false', AUTH_INFO: '', authInfo: '' },
      stdio: 'ignore',
    });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (server.exitCode !== null) throw new Error('Test server exited');
      try { if ((await fetch(origin + '/healthz')).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('Test server did not start');
  }
  try {
    await startServer();
    browser = await chromium.launch({ channel: process.env.WEBSSH_BROWSER || undefined, headless: true });
    const errors = [];
    async function pageFor(context) {
      const page = await context.newPage();
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(origin);
      await page.waitForFunction(() => document.getElementById('authRegistrationStatus').textContent !== '正在读取注册设置…');
      return page;
    }
    const admin = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const login = await admin.request.post(origin + '/api/auth/login', { data: { username: 'testadmin', password: adminPassword } });
    assert.equal(login.status(), 200);
    const adminPage = await pageFor(admin);
    await adminPage.waitForFunction(() => currentAccount && currentAccount.isAdmin);
    await adminPage.evaluate(() => openAccountAdminModal());
    const setting = adminPage.locator('#managedAllowRegistration');
    const settingLabel = adminPage.locator('label[for="managedAllowRegistration"]');
    const save = adminPage.locator('#saveRegistrationSettings');
    await setting.waitFor({ state: 'attached' });
    await adminPage.waitForFunction(() => !document.getElementById('managedAllowRegistration').disabled);
    assert.equal(await setting.isChecked(), true, 'default is open');

    const guest = await browser.newContext();
    const guestPage = await pageFor(guest);
    await guestPage.evaluate(() => openAuthModal('register'));
    assert.equal(await guestPage.locator('#authRegisterTab').isVisible(), true);
    await guestPage.locator('#authUsername').fill('guestfirst');
    await guestPage.locator('#authPassword').fill('GuestPass123!');
    await guestPage.locator('#authLoggedOut .auth-submit-btn').click();
    await guestPage.waitForFunction(() => currentAccount && currentAccount.username === 'guestfirst');
    assert.equal(await guestPage.evaluate(() => currentAccount.isAdmin), false);
    assert.equal((await guest.request.put(origin + '/api/admin/registration', { data: { allowRegistration: false } })).status(), 403);

    const visitor = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const visitorPage = await pageFor(visitor);
    await visitorPage.evaluate(() => openAuthModal('register'));
    await visitorPage.locator('#authUsername').fill('guestsecond');
    await visitorPage.locator('#authPassword').fill('GuestPass123!');
    await settingLabel.click(); await save.click();
    await adminPage.waitForFunction(() => !registrationSettingsSaving && !allowRegistration);
    assert.equal((await (await visitor.request.get(origin + '/config')).json()).allowRegistration, false);
    await visitorPage.locator('#authLoggedOut .auth-submit-btn').click();
    await visitorPage.waitForFunction(() => !allowRegistration && authMode === 'login');
    assert.equal(await visitorPage.locator('#authRegisterTab').isVisible(), false, 'stale registration form handles closure');
    assert.equal((await visitor.request.put(origin + '/api/admin/registration', { data: { allowRegistration: true } })).status(), 401);
    assert.equal((await guest.request.get(origin + '/api/auth/me')).status(), 200, 'existing user still works');

    await stopServer(); await startServer();
    assert.equal((await (await visitor.request.get(origin + '/api/auth/registration')).json()).data.allowRegistration, false, 'restart preserves closure');
    await adminPage.reload();
    await adminPage.waitForFunction(() => currentAccount && currentAccount.isAdmin);
    await adminPage.evaluate(() => openAccountAdminModal());
    await adminPage.waitForFunction(() => !document.getElementById('managedAllowRegistration').disabled);
    assert.equal(await setting.isChecked(), false);
    await settingLabel.click(); await save.click();
    await adminPage.waitForFunction(() => !registrationSettingsSaving && allowRegistration);
    // A failed save must restore the checkbox to the effective policy.
    await adminPage.route('**/api/admin/registration', route => route.fulfill({ status: 500, json: { ok: false, msg: '测试保存失败' } }));
    await settingLabel.click(); await save.click();
    await adminPage.waitForFunction(() => !registrationSettingsSaving && document.getElementById('managedAllowRegistration').checked);
    await adminPage.unroute('**/api/admin/registration');
    await visitorPage.evaluate(() => { hideAuthModal(); openAuthModal(); });
    await visitorPage.waitForFunction(() => allowRegistration);
    await visitorPage.locator('#authRegisterTab').click();
    if (process.env.WEBSSH_REGISTRATION_SCREENSHOT_DIR) {
      const dir = process.env.WEBSSH_REGISTRATION_SCREENSHOT_DIR;
      fs.mkdirSync(dir, { recursive: true });
      await adminPage.locator('.account-admin-card').screenshot({ path: path.join(dir, 'registration-admin.png') });
      await visitorPage.locator('.auth-card').screenshot({ path: path.join(dir, 'registration-guest.png') });
    }
    await visitorPage.locator('#authLoggedOut .auth-submit-btn').click();
    await visitorPage.waitForFunction(() => currentAccount && currentAccount.username === 'guestsecond');
    assert.equal(await visitorPage.evaluate(() => currentAccount.isAdmin), false);
    await visitorPage.evaluate(() => {
      createSession('192.0.2.1', 22, 'test', ''); switchTab(0);
      showAddTab(); switchAddTabAuth('key'); hideAddTab(); showAddTab();
    });
    assert.equal(await visitorPage.locator('#newTabPasswordPane').isVisible(), true);
    assert.equal(await visitorPage.locator('#newTabKeyPane').isVisible(), false);
    assert.equal(await visitorPage.locator('#newTabPass').getAttribute('type'), 'password');
    assert.deepEqual(errors, []);
    console.log('Registration browser checks passed: guest signup, ordinary roles, admin-only setting, failed-save rollback, live closure/reopening, restart persistence, mobile UI, default SSH password mode.');
  } finally {
    if (browser) await browser.close();
    await stopServer();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
