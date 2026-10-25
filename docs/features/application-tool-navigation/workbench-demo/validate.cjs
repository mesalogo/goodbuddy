/* Preview validation only; no production services or portable data are opened. */
const path = require('node:path');
const fs = require('node:fs');
const output = path.resolve(__dirname, '../../../../temp/workbench-demo-check');
if (process.argv.includes('--clean')) {
  fs.rmSync(output, {recursive:true, force:true});
} else if (!process.versions.electron) {
  const {spawnSync} = require('node:child_process');
  const env = {...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], {env,stdio:'inherit',timeout:60000});
  process.exitCode = result.status ?? 1;
} else {
  const {app,BrowserWindow} = require('electron');
  fs.mkdirSync(output,{recursive:true});
  app.setPath('userData',path.join(output,'user-data'));app.disableHardwareAcceleration();
  app.whenReady().then(async()=>{
    const win=new BrowserWindow({width:1500,height:960,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});
    const errors=[];win.webContents.on('console-message',e=>{if(e.level==='error')errors.push(e.message);});
    const run=code=>win.webContents.executeJavaScript(code,true);
    const checks=[];
    const check=async(name,code)=>{if(!await run(code))throw Error(name);checks.push(name);};
    const frame=()=>run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const screenshot=async name=>{await frame();await new Promise(r=>setTimeout(r,150));fs.writeFileSync(path.join(output,name+'.png'),(await win.webContents.capturePage()).toPNG());};
    try{
      await win.loadFile(path.join(__dirname,'index.html'));await frame();
      await check('snapshot counts','data.conversations.length===319 && data.notes.length===10 && data.tasks.length===47');
      await check('bounded initial conversation list','document.querySelectorAll("#conversation-list .object-row").length===24');
      await screenshot('chat-light');
      await run('applyTheme("dark")');await screenshot('chat-dark');await run('applyTheme("light")');
      await run('actions.more()');await check('conversation pagination','document.querySelectorAll("#conversation-list .object-row").length===48');
      await run(`$('#conversation-search').value='不存在的搜索';$('#conversation-search').dispatchEvent(new Event('input',{bubbles:true}))`);
      await check('conversation empty state','$("#conversation-list").textContent.includes("没有匹配")');
      await run(`state.query='';renderObjects();window.original=state.conversation;$('#chat-draft').value='保留我的草稿';$('#chat-draft').dispatchEvent(new Event('input',{bubbles:true}));actions.conversation(data.conversations[1].id);actions.conversation(window.original);`);
      await check('per-conversation draft','$("#chat-draft").value==="保留我的草稿"');
      await run('actions.work();actions.work();setShare(57)');
      await check('panel toggles retain draft and resize','$("#chat-draft").value==="保留我的草稿" && $("#resize").getAttribute("aria-valuenow")==="57"');
      await run(`$('#chat-form').requestSubmit()`);
      await check('preview send','state.sent[state.conversation][0]==="保留我的草稿" && !$("#chat-draft").value');
      await run(`page('notes');$('#toast').hidden=true`);await check('all notes present','document.querySelectorAll(".note-card").length===10');await screenshot('notes-light');
      await run(`actions.note(data.notes[0].id)`);await check('real entry counts','document.querySelectorAll(".record").length===data.notes[0].entries.length');await screenshot('note-detail');
      await run(`$('#note-draft').value='新的一条记录';$('#note-draft').dispatchEvent(new Event('input',{bubbles:true}));actions.note(data.notes[1].id);actions.note(data.notes[0].id);`);
      await check('note draft survives','$("#note-draft").value==="新的一条记录"');
      await run(`$('#note-form').requestSubmit()`);await check('append record','state.added[state.note][0]==="新的一条记录"');
      await run(`page('knowledge');$('#toast').hidden=true`);await check('source rows match selected library','document.querySelectorAll("[data-doc]").length===data.documents.filter(d=>d.library===state.library).length');await screenshot('knowledge-light');
      await run(`$('#knowledge-documents').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))`);
      await check('tab keyboard and focus','state.tab==="graph" && document.activeElement.id==="knowledge-graph"');
      await run(`actions.tab('tasks');state.filter='failed';renderMain()`);
      await check('task state filter','document.querySelectorAll(".task-row").length===data.tasks.filter(t=>t.library===state.library&&t.status==="failed").length');
      await run(`actions.task(data.tasks.find(t=>t.hasError).id)`);await check('failure explanation','$("#work").textContent.includes("不能从状态推断失败原因")');
      await run(`settings();$('#theme-select').value='dark';$('#theme-select').dispatchEvent(new Event('change',{bubbles:true}));`);
      await check('settings theme applies','document.documentElement.dataset.theme==="dark"');await screenshot('settings-dark');await run(`$('#dialog').close();applyTheme('light')`);
      for(const width of [1500,1100,640,420]){
        win.setContentSize(width,900);await frame();
        for(const p of ['chat','notes','knowledge']){
          await run(`state.note=null;state.tab='documents';state.filter='all';page('${p}')`);await frame();
          await check(`viewport fits ${width} ${p}`,'document.documentElement.scrollWidth<=innerWidth+1');
        }
        if(width<=640){
          await run(`page('chat');actions.objects()`);await check(`drawer opens ${width}`,'getComputedStyle($("#objects")).display!=="none"');
          await run(`actions.objects();actions['open-document']()`);await check(`work reachable ${width}`,'getComputedStyle($("#main")).display==="none" && $("#work").clientWidth>200');
          await screenshot('document-'+width);
          await run('actions.work()');await screenshot('chat-'+width);
        }
      }
      await check('no browser errors',JSON.stringify(errors.length===0));
      console.log(JSON.stringify({checks:checks.length,passed:checks,screenshots:output,errors},null,2));
    }catch(error){console.error(error);process.exitCode=1;}finally{win.destroy();app.quit();}
  });
}
