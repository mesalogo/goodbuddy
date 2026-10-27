/* Static prototype checks, not a production Electron/IPC acceptance test. */
const path = require('node:path');
const fs = require('node:fs');
const output = path.resolve(__dirname, '../../../../temp/real-data-demo-check');
if (process.argv.includes('--clean')) {
  fs.rmSync(output, {recursive:true, force:true});
} else if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {env, stdio:'inherit', timeout:60000});
  process.exitCode = result.status ?? 1;
} else {
  const {app, BrowserWindow} = require('electron');
  fs.mkdirSync(output, {recursive:true});
  app.setPath('userData', path.join(output, 'user-data'));
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const win = new BrowserWindow({width:1500,height:960,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    const run = code => win.webContents.executeJavaScript(code, true);
    const checks=[];
    const check = async (name, code) => {if(!await run(code))throw new Error(name);checks.push(name);};
    try {
      await win.loadFile(path.join(__dirname,'index.html'));
      await check('metadata totals', 'data.conversations.length===319 && data.messageCount===4906 && data.notes.length===10 && data.tasks.length===47');
      await check('all message states mapped', 'data.conversations.every(c=>c.messages.every(m=>m.state!=="unknown"))');
      await check('conversation pagination', 'document.querySelectorAll("#conversation-rows .object").length===40');
      await run('document.querySelector("[data-action=more-conversations]").click()');
      await check('next conversation batch', 'document.querySelectorAll("#conversation-rows .object").length===80');
      await run(`window.firstConversation=state.conversation;$('#chat-draft').value='draft survives';$('#chat-draft').dispatchEvent(new Event('input',{bubbles:true}));actions.conversation(data.conversations[1].id);actions.conversation(window.firstConversation);`);
      await check('draft survives conversation switch', '$ ("#chat-draft").value==="draft survives"');
      await run(`$('[data-action=boundary]').click()`);
      await check('attachment explanation does not submit form', '$ ("#dialog").open && !state.sent[state.conversation]');
      await run(`$('#dialog').close();switchPage('notes');`);
      await check('all notes represented', 'document.querySelectorAll(".note-card").length===10');
      await run(`actions.note(data.notes[0].id);$('#note-draft').value='note draft';$('#note-draft').dispatchEvent(new Event('input',{bubbles:true}));actions.note(data.notes[1].id);actions.note(data.notes[0].id);`);
      await check('note draft preserved and records continuous', `$('#note-draft').value==='note draft' && document.querySelectorAll('.record').length===data.notes[0].entries.length`);
      await run(`$('#note-form').requestSubmit()`);
      await check('preview note saved in memory', `document.querySelector('.record').textContent.includes('note draft') && state.added[data.notes[0].id].length===1`);
      await run(`switchPage('knowledge');`);
      await check('library document count', `document.querySelectorAll('[data-document-row]').length===data.documents.filter(d=>d.library===state.library).length`);
      await run(`$('#doc-query').value='no such document';$('#doc-query').dispatchEvent(new Event('input',{bubbles:true}));`);
      await check('document search empty state', `!$('#doc-empty').hidden && [...document.querySelectorAll('[data-document-row]')].every(r=>r.hidden)`);
      await run(`actions.tab('tasks');$('#task-filter').value='failed';$('#task-filter').dispatchEvent(new Event('change',{bubbles:true}));`);
      await check('historical failure filtering', `document.querySelectorAll('#knowledge-panel .row').length===data.tasks.filter(t=>t.library===state.library&&t.status==='failed').length`);
      await run(`actions.task(data.tasks.find(t=>t.hasError).id)`);
      await check('failure source boundary', `$('#dialog-body').textContent.includes('不推断失败原因')`);
      await run(`$('#dialog').close();actions.tab('documents');$('#tab-documents').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));`);
      await check('semantic tabs keyboard', `state.tab==='graph' && document.activeElement.id==='tab-graph' && $('#knowledge-panel').getAttribute('aria-labelledby')==='tab-graph'`);
      await run(`settings()`);
      await check('settings reflect real booleans', `Object.keys(data.settings).every(key=>document.querySelector('[data-action="setting"][data-value="'+key+'"]').getAttribute('aria-checked')===String(data.settings[key]))`);
      await run(`$('#dialog').close();state.docQuery='';state.tab='documents';$('#notice').hidden=true;switchPage('chat');`);
      for (const [width,height] of [[1500,960],[1100,800],[640,820],[420,780]]) {
        win.setContentSize(width,height);
        await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        for(const page of ['chat','notes','knowledge']) {
          await run(`switchPage('${page}')`);
          await check(`no viewport overflow ${width} ${page}`, 'document.documentElement.scrollWidth<=innerWidth+1');
          if(page==='knowledge') {
            await check(`readable table columns ${width}`, `document.querySelector('.table-scroll table').getBoundingClientRect().width>=700`);
            await run('settings()');
            await check(`settings fit ${width}`, `$('#dialog').getBoundingClientRect().right<=innerWidth && $('#dialog').scrollWidth<=$('#dialog').clientWidth+1`);
            await run(`$('#dialog').close()`);
          }
        }
        if(width<=640){
          await run(`$('#objects-toggle').click()`);
          await check(`object drawer reachable ${width}`, `getComputedStyle($('#objects')).display!=='none'`);
          await run(`$('#objects-toggle').click();$('#work-toggle').click()`);
          await check(`work area reachable ${width}`, `getComputedStyle($('#workbar')).display!=='none' && getComputedStyle($('#main')).display==='none'`);
          await run(`$('#work-toggle').click()`);
        }
        await run(`setTheme('${width===1100?'dark':'light'}');actions.tab('documents');`);
        await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
        fs.writeFileSync(path.join(output,`knowledge-${width}.png`),(await win.webContents.capturePage()).toPNG());
      }
      win.setContentSize(1500,960);
      await run(`switchPage('chat');setTheme('light');`);
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(output,'chat.png'),(await win.webContents.capturePage()).toPNG());
      await run(`switchPage('notes');actions.note(data.notes.reduce((best,n)=>n.entries.length>best.entries.length?n:best).id);`);
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.join(output,'notes.png'),(await win.webContents.capturePage()).toPNG());
      if(errors.length)throw new Error(errors.join('\n'));
      console.log(JSON.stringify({checks,consoleErrors:errors,screenshots:output},null,2));
    } catch(error) { console.error(error);process.exitCode=1; }
    finally {win.destroy();app.quit();}
  });
}
