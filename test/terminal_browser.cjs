const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('node:assert/strict');
// Install Playwright, or set WEBSSH_PLAYWRIGHT to an existing package directory.
// Run: node test/terminal_browser.cjs (WEBSSH_BROWSER defaults to Chromium).
const { chromium } = require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root = path.resolve(__dirname, '../public');
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/config' || url.pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(url.pathname === '/config' ? {savePass:false, requireAccount:false} : {code:0, data:null}));
  }
  const file = path.join(root, url.pathname === '/' ? 'index.html' : url.pathname);
  try {
    res.setHeader('Content-Type', ({'.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.woff2':'font/woff2'})[path.extname(file)] || 'application/octet-stream');
    let body = fs.readFileSync(file);
    if (file.endsWith('index.html')) body = body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__', '""').replaceAll('__TERMINAL_PRECONNECT__', '').replaceAll('__APP_VERSION__', 'test');
    res.end(body);
  } catch { res.statusCode = 404; res.end(); }
});
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({channel:process.env.WEBSSH_BROWSER || undefined, headless:true});
  try {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?preview=terminal&drawer=none`);
    await page.evaluate(async () => {
      document.getElementById('splash').remove();
      document.getElementById('terminalContainer').innerHTML = '';
      await document.fonts.ready;
      for (let i=0;i<2;i++) createSession('192.0.2.'+(i+1),22,'test','');
      switchTab(0);
      await new Promise(r => setTimeout(r,250));
      await new Promise(r => sessions[0].term.write(Array.from({length:24}, (_,i)=>'ROW'+String(i+1).padStart(2,'0')+' abcdefghijklmnopqrstuvwxyz').join('\r\n'),r));
    });
    async function checkFirstRowAlignment() {
      const centers = await page.evaluate(() => {
        const center = selector => { const rect = document.querySelector(selector).getBoundingClientRect(); return rect.y + rect.height / 2; };
        return {dots:center('.term-dots'),tab:center('.ssh-tab'),tools:center('.topbar-right .tb-btn')};
      });
      assert.ok(Math.abs(centers.dots-centers.tab)<1, 'dots must align with the first tab: '+JSON.stringify(centers));
      assert.ok(Math.abs(centers.tools-centers.tab)<1, 'toolbar must align with the first tab: '+JSON.stringify(centers));
    }
    await checkFirstRowAlignment();
    for (const zoom of [50,80,90,100,110,125,150,200]) {
      await page.evaluate(z=>applyPageZoom(z),zoom);
      await page.waitForTimeout(200);
      const pos = await page.evaluate(() => {
        const t=sessions[0].term, el=t.element.querySelector('.xterm-screen'), r=el.getBoundingClientRect();
        const d=t._core._renderService.dimensions.css;
        const scale=r.width/parseFloat(getComputedStyle(el).width);
        const row = Math.min(10, t.rows - 1);
        return {x:r.x+d.cell.width*2.5*scale,y:r.y+d.cell.height*(row+.5)*scale,
          expected:t.buffer.active.getLine(t.buffer.active.viewportY+row).translateToString(true).split(' ')[0]};
      });
      await page.mouse.dblclick(pos.x,pos.y);
      const selection = await page.evaluate(()=>sessions[0].term.getSelection());
      if (selection !== pos.expected) {
        console.log('geometry', zoom, pos, await page.evaluate(()=>{ const t=sessions[0].term, el=t.element.querySelector('.xterm-screen'); return {rows:t.rows,rect:el.getBoundingClientRect().toJSON(),offset:[el.offsetWidth,el.offsetHeight],dims:t._core._renderService.dimensions.css,viewport:t.buffer.active.viewportY}; }));
        await page.screenshot({path:path.resolve(__dirname,'../tmp/terminal-failure.png')});
      }
      assert.equal(selection,pos.expected,'selection at '+zoom+'%');
    }
    await page.evaluate(()=>applyPageZoom(100));
    await page.waitForTimeout(200);
    await page.evaluate(()=>{for (let i=2;i<14;i++) createSession('192.0.2.'+(i+1),22,'test','');renderTabs();});
    await page.locator('[onclick="toggleScriptDrawer()"]').first().click();
    await page.locator('.ssh-tab').nth(1).click();
    assert.equal(await page.locator('#scriptDrawer').evaluate(el=>el.classList.contains('open')),true);
    await page.locator('.term-instance.active .xterm-screen').click({position:{x:25,y:20}});
    assert.equal(await page.locator('#scriptDrawer').evaluate(el=>el.classList.contains('open')),true,'drawer stays open during terminal use');
    const desktop = await page.locator('#tabBar').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,wrap:getComputedStyle(el).flexWrap,rows:new Set([...el.querySelectorAll('.ssh-tab')].map(el=>el.offsetTop)).size}));
    assert.equal(desktop.wrap,'wrap');
    assert.ok(desktop.rows>1);
    assert.equal(desktop.scroll,desktop.client);
    await checkFirstRowAlignment();
    await page.locator('[onclick="toggleScriptDrawer()"]').first().click();
    assert.equal(await page.locator('#scriptDrawer').evaluate(el=>el.classList.contains('open')),false,'explicit toggle closes drawer');
    await page.locator('.ssh-tab').first().click();
    await page.waitForTimeout(400);
    if (process.env.WEBSSH_UI_SCREENSHOT) await page.screenshot({path:process.env.WEBSSH_UI_SCREENSHOT});
    await page.evaluate(() => {
      window.sftpTestLoads = [];
      sftpLoad = (path, session) => window.sftpTestLoads.push(session.id);
      window.sftpTestController = new AbortController();
      sessions[0]._sftpListController = window.sftpTestController;
    });
    await page.locator('[onclick="toggleSftp()"]').first().click();
    await page.locator('.ssh-tab').first().click();
    assert.equal(await page.locator('#sftpPanel').evaluate(el=>el.classList.contains('open')),true,'same SSH tab keeps SFTP open');
    const loadCount = await page.evaluate(()=>window.sftpTestLoads.length);
    await page.locator('.ssh-tab').nth(1).click();
    assert.equal(await page.locator('#sftpPanel').evaluate(el=>el.classList.contains('open')),false,'different SSH tab closes SFTP');
    assert.equal(await page.evaluate(()=>window.sftpTestController.signal.aborted),true,'switch cancels the old directory listing');
    assert.equal(await page.evaluate(()=>window.sftpTestLoads.length),loadCount,'switch does not automatically load the new host');
    await page.locator('[onclick="toggleSftp()"]').first().click();
    assert.equal(await page.evaluate(()=>window.sftpTestLoads.at(-1)===sessions[1].id),true,'reopening SFTP uses the new host');
    await page.evaluate(()=>closeTab(activeIdx));
    assert.equal(await page.locator('#sftpPanel').evaluate(el=>el.classList.contains('open')),false,'closing the active SSH tab closes its SFTP panel');
    for (const size of [{width:390,height:844},{width:1024,height:768}]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(200);
      assert.deepEqual(await page.locator('#tabBar').evaluate(el=>({direction:getComputedStyle(el).flexDirection,wrap:getComputedStyle(el).flexWrap})),
        {direction:size.width===390?'column':'row',wrap:'nowrap'});
    }
    // iPad Pro exceeds the desktop width breakpoint but remains a touch layout.
    const ipad = await browser.newPage({viewport:{width:1366,height:1024},isMobile:true,hasTouch:true});
    await ipad.goto(`http://127.0.0.1:${server.address().port}/?preview=terminal&drawer=none`);
    assert.equal(await ipad.locator('#tabBar').evaluate(el=>getComputedStyle(el).flexWrap),'nowrap');
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: 8 zoom levels, first-row alignment, tab wrapping, persistent scripts, SFTP tab isolation, phone/tablet/iPad Pro layouts.');
  } finally { await browser.close(); server.close(); }
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
