const fs=require('node:fs'), path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require(process.env.WEBSSH_PLAYWRIGHT || 'playwright');
const root=path.resolve(__dirname,'../public');
(async()=>{
 const browser=await chromium.launch({channel:process.env.WEBSSH_BROWSER || undefined,headless:true});
 try {
  async function pageFor(origin='http://localhost') {
   const page=await browser.newPage({viewport:{width:1440,height:900}});
   await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/config'||url.pathname.startsWith('/api/')) return route.fulfill({json:url.pathname==='/config'?{savePass:false,requireAccount:false}:{code:0,data:null}});
    const file=path.join(root,url.pathname==='/'?'index.html':url.pathname);
    try {let body=fs.readFileSync(file);if(file.endsWith('index.html'))body=body.toString().replaceAll('__TERMINAL_WEBSOCKET_URL__','""').replaceAll('__TERMINAL_PRECONNECT__','').replaceAll('__APP_VERSION__','audit');return route.fulfill({body,contentType:({'.html':'text/html','.css':'text/css','.js':'text/javascript','.woff2':'font/woff2'})[path.extname(file)]||'application/octet-stream'});}catch{return route.fulfill({status:404,body:''});}
   });
   await page.goto(origin+'/?preview=terminal&drawer=none');
   await page.evaluate(async()=>{document.getElementById('splash')?.remove();document.getElementById('terminalContainer').innerHTML='';await document.fonts.ready;createSession('audit-host',22,'audit','');switchTab(0);});
   await page.waitForTimeout(300);
   return page;
  }
  const editorPage=await pageFor();
  await editorPage.evaluate(()=>{sessions[0]._connected=true;openNewRemoteFile();});
  for(const zoom of [200,50,100,125,150]) {
   for(const panelId of ['scriptDrawer','sftpPanel',null]) {
    await editorPage.evaluate(({zoom,panelId})=>{
     document.getElementById('scriptDrawer').classList.toggle('open',panelId==='scriptDrawer');
     document.getElementById('sftpPanel').classList.toggle('open',panelId==='sftpPanel');
     applyPageZoom(zoom);
    },{zoom,panelId});
    await editorPage.waitForTimeout(400);
    const bounds=await editorPage.evaluate(panelId=>{
     const layer=document.getElementById('remoteEditorLayer');
     const rect=layer.getBoundingClientRect();
     const parent=layer.offsetParent.getBoundingClientRect();
     const panel=panelId?document.getElementById(panelId).getBoundingClientRect():null;
     const bar=document.querySelector('.cmd-bar').getBoundingClientRect();
     const dock=document.getElementById('remoteEditorDock').getBoundingClientRect();
     const editor=sessions[0]._remoteEditorWorkspace.el.getBoundingClientRect();
     return {right:rect.right,expectedRight:panel?panel.left:parent.right,bottom:rect.bottom,expectedBottom:bar.top,dockRight:dock.right,editorRight:editor.right,editorBottom:editor.bottom};
    },panelId);
    assert.ok(Math.abs(bounds.right-bounds.expectedRight)<3,JSON.stringify({zoom,panelId,bounds}));
    assert.ok(Math.abs(bounds.bottom-bounds.expectedBottom)<3,JSON.stringify({zoom,panelId,bounds}));
    assert.ok(Math.abs(bounds.dockRight-bounds.expectedRight)<3,JSON.stringify({zoom,panelId,bounds}));
    assert.ok(bounds.editorRight<=bounds.right+3 && bounds.editorBottom<=bounds.bottom+3,JSON.stringify({zoom,panelId,bounds}));
   }
   // Real pointer movement must move the editor by the same displayed distance.
   const start=await editorPage.evaluate(()=>{
    const workspace=sessions[0]._remoteEditorWorkspace;
    Object.assign(workspace.el.style,{left:'10px',top:'10px',width:'400px',height:'280px'});
    const rect=workspace.el.getBoundingClientRect(),header=workspace.header.getBoundingClientRect();
    return {left:rect.left,top:rect.top,x:header.left+20,y:header.top+20};
   });
   await editorPage.mouse.move(start.x,start.y);
   await editorPage.mouse.down();
   await editorPage.mouse.move(start.x+80,start.y+40,{steps:4});
   await editorPage.mouse.up();
   const end=await editorPage.evaluate(()=>{const r=sessions[0]._remoteEditorWorkspace.el.getBoundingClientRect();return {left:r.left,top:r.top};});
   assert.ok(Math.abs(end.left-start.left-80)<3,JSON.stringify({zoom,start,end}));
   assert.ok(Math.abs(end.top-start.top-40)<3,JSON.stringify({zoom,start,end}));
  }
  await editorPage.setViewportSize({width:1280,height:600});
  await editorPage.evaluate(()=>{document.getElementById('sftpPanel').classList.add('open');applyPageZoom(200);});
  await editorPage.waitForTimeout(400);
  const narrow=await editorPage.evaluate(()=>{
   const layer=document.getElementById('remoteEditorLayer').getBoundingClientRect();
   const editor=sessions[0]._remoteEditorWorkspace.el.getBoundingClientRect();
   return {layerWidth:layer.width,layerHeight:layer.height,editorWidth:editor.width,editorHeight:editor.height};
  });
  assert.ok(narrow.editorWidth<=narrow.layerWidth+3 && narrow.editorHeight<=narrow.layerHeight+3,JSON.stringify(narrow));
  await editorPage.evaluate(()=>remoteEditors.slice().forEach(destroyRemoteEditor));
  const paths=await editorPage.evaluate(()=>{
   const path='/tmp/dir\\name/a\\b.txt';
   requestSftpDelete(path);
   const deletion={path:sftpDeleteConfirmRequest.path,parent:sftpDeleteConfirmRequest.parentPath};
   hideSftpDeleteConfirm();
   requestSftpRename(path,false);
   const rename={path:sftpRenameConfirmRequest.path,parent:sftpRenameConfirmRequest.parentPath};
   hideSftpRenameConfirm();
   sftpDownload(path,10,false);
   return {deletion,rename,download:sftpDownloadConfirmRequest.path};
  });
  const literalPath='/tmp/dir\\name/a\\b.txt';
  assert.deepEqual(paths,{deletion:{path:literalPath,parent:'/tmp/dir\\name'},rename:{path:literalPath,parent:'/tmp/dir\\name'},download:literalPath});
  await editorPage.close();
  const page=await pageFor();
  await page.evaluate(()=>{
   window.auditSent=[];
   sessions[0].ws={readyState:1,send:data=>window.auditSent.push(typeof data==='string'?data:new TextDecoder().decode(data))};
   sessions[0].term.onData(data=>sendTerminalInput(sessions[0],data));
   window.auditClipboardReads=0;
   Object.defineProperty(navigator,'clipboard',{value:{readText:()=>{window.auditClipboardReads++;return Promise.resolve('AUDIT_PASTE\n');}},configurable:true});
   openAddScriptModal();
  });
  await page.locator('#editScriptContent').click();
  await page.keyboard.press('Control+Shift+V');
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(()=>({sent:window.auditSent,reads:window.auditClipboardReads})),{sent:[],reads:0},'editor paste must never reach SSH');
  assert.equal(await page.locator('#editScriptContent').evaluate(el=>el.dispatchEvent(new KeyboardEvent('keydown',{key:'V',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))),true,'editor retains the default paste action');
  await page.evaluate(()=>{hideEditScriptModal(); document.getElementById('cmdInput').focus();});
  await page.keyboard.press('Control+Shift+V');
  assert.equal(await page.evaluate(()=>window.auditClipboardReads),0,'command draft must not paste into the live shell');
  await page.evaluate(()=>document.querySelector('.tb-btn').dispatchEvent(new KeyboardEvent('keydown',{key:'V',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true})));
  await page.waitForTimeout(100);
  assert.deepEqual(await page.evaluate(()=>window.auditSent),['AUDIT_PASTE\r'],'explicit terminal paste remains available');
  await page.evaluate(()=>{hideEditScriptModal();for(let i=1;i<14;i++)createSession('192.0.2.'+i,22,'audit','');renderTabs();applyPageZoom(200);});
  await page.waitForTimeout(300);
  const layout=await page.evaluate(()=>({height:innerHeight,toolbarBottom:document.querySelector('.term-topbar').getBoundingClientRect().bottom,terminalTop:document.querySelector('.term-instance.active .xterm-screen').getBoundingClientRect().top,rows:sessions[0].term.rows,scroll:document.getElementById('tabBar').scrollWidth,width:document.getElementById('tabBar').clientWidth}));
  assert.ok(layout.toolbarBottom<layout.height/2 && layout.rows>=10,JSON.stringify(layout));
  assert.equal(layout.scroll,layout.width,'desktop tabs still wrap without horizontal scrolling');
  if(process.env.WEBSSH_BOUNDARY_SCREENSHOT) await page.screenshot({path:process.env.WEBSSH_BOUNDARY_SCREENSHOT});
  const fallback=await page.evaluate(async()=>{
    const copied=[];
    document.execCommand=()=>{copied.push(document.activeElement.value);return true;};
    Object.defineProperty(navigator,'clipboard',{value:{writeText:()=>{throw new Error('permission denied');}},configurable:true});
    await copyTextToClipboard('sync failure');
    navigator.clipboard.writeText=()=>Promise.reject(new Error('permission denied'));
    await copyTextToClipboard('async failure');
    return copied;
  });
  assert.deepEqual(fallback,['sync failure','async failure']);
  await page.close();
  const insecure=await pageFor('http://webssh-audit.test');
  const copy=await insecure.evaluate(async()=>{
   const copied=[],notices=[];
   document.execCommand=()=>{copied.push(document.activeElement.value);return true;};
   showCopyToast=()=>notices.push('success');
   showToast=()=>notices.push('error');
   const draft=document.getElementById('cmdInput');draft.value='unfinished draft';draft.focus();draft.setSelectionRange(2,5);
   sessions[0].term.getSelection=()=> 'audit selection';
   termCopy(); await copyIP('192.0.2.1');
   let selectionChanged;setupAutoCopy({term:{getSelection:()=> 'audit selection',onSelectionChange:fn=>{selectionChanged=fn;return {dispose(){}};}}});selectionChanged();
   document.execCommand=()=>false;
   const failed=await copyTextToClipboard('must not report success');
   return {secure:isSecureContext,clipboard:typeof navigator.clipboard,copied,notices,failed,focus:document.activeElement===draft,selection:[draft.selectionStart,draft.selectionEnd]};
  });
  assert.deepEqual(copy,{secure:false,clipboard:'undefined',copied:['audit selection','192.0.2.1','audit selection'],notices:['success','success','success','error'],failed:false,focus:true,selection:[2,5]});
  await insecure.close();
  const shared=await pageFor();
  await shared.evaluate(()=>{
    const source={hostname:'192.0.2.99',port:22,username:'audit',password:'audit',logintype:0,proxyHost:'192.0.2.77',proxyPort:1080,proxyUser:'relay-user',proxyPass:'relay-pass'};
    window.auditShareSource=source;
    const payload=buildConnectionSharePayload({kind:'ssh',sshInfo:btoa(JSON.stringify(source))});
    window.auditSharedPayload=payload.data;
    connectFromLogin=()=>{window.auditReconnected=decodeSSHInfoPayload(buildSSHInfoFromForm());};
    connectionShareApplyPayload(payload);
  });
  await shared.waitForTimeout(700);
  assert.deepEqual(await shared.evaluate(()=>({host:auditReconnected.proxyHost,port:auditReconnected.proxyPort,user:auditReconnected.proxyUser,pass:auditReconnected.proxyPass})),{host:'192.0.2.77',port:1080,user:'relay-user',pass:'relay-pass'});
  await shared.evaluate(()=>{
    safeStorageSet(PROXY_KEY,JSON.stringify({host:'saved-proxy',port:1080}));
    window.auditSavedProxy=safeStorageGet(PROXY_KEY);
    connectionShareApplyPayload({kind:'ssh',data:{hostname:'192.0.2.10',username:'audit',privateKey:'audit key',passphrase:'audit phrase',logintype:1}});
  });
  await shared.waitForTimeout(700);
  assert.deepEqual(await shared.evaluate(()=>({proxy:auditReconnected.proxyHost||'',key:auditReconnected.privateKey,phrase:auditReconnected.passphrase,remember:document.getElementById('rememberProxy').checked,unchanged:safeStorageGet(PROXY_KEY)===auditSavedProxy})),{proxy:'',key:'audit key',phrase:'audit phrase',remember:false,unchanged:true});
  await shared.close();
  console.log('Boundary browser checks passed: literal SFTP paths, editor bounds and dragging at 5 zoom levels, clipboard isolation and fallback, shared proxy/password/key routes, many tabs at 200% zoom.');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
