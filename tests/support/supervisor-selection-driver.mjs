import assert from 'node:assert/strict'

// Real production components, native keyboard and mouse input; only the bridge data is simulated.
export async function validateSupervisorSelection(win, js, wait, url) {
  win.show(); win.focus(); win.setContentSize(1440, 1100)
  await win.loadURL(url + '?windowed=1&recap=1')
  await wait('document.querySelector(".supervisor-workspace")?.getAttribute("aria-busy") === "false"')
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).graph'), 0)
  const frames = () => js('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))')
  const click = async selector => {
    win.focus(); win.webContents.focus()
    const point = await js(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({block:'nearest'}); const r=e.getBoundingClientRect(); return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)} })()`)
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point})
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point})
    await frames()
  }
  const key = async (keyCode, modifiers = []) => {
    win.focus(); win.webContents.focus()
    await wait('document.hasFocus()')
    win.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers})
    if (keyCode === 'Enter') win.webContents.sendInputEvent({type:'char',keyCode:'\r'})
    win.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers})
    await frames()
  }
  const panel = '.supervisor-workspace__selection-list'
  await click('#supervisor-tab-graph')
  await wait(`!!document.querySelector('${panel}') && document.querySelector('.supervisor-workspace').getAttribute('aria-busy') === 'false'`)
  for (const kind of ['event', 'entity', 'relation']) {
    await js(`document.querySelector('.supervisor-workspace__category').value='${kind}';document.querySelector('.supervisor-workspace__category').dispatchEvent(new Event('change',{bubbles:true}))`)
    await wait(`document.querySelector('${panel}')?.id.endsWith('-${kind}')`)
    // Select a middle record so selection/focus pins cannot accidentally keep either endpoint.
    await js(`(() => {const p=document.querySelector('${panel}'); p.scrollTop=(p.scrollHeight-p.clientHeight)/2;p.dispatchEvent(new Event('scroll'))})()`)
    await wait(`(() => {const button=document.querySelector('[data-list-window-row="${kind}-300"] button');if(!button)return false;button.click();return true})()`)
    await wait(`document.querySelector('[data-list-window-row="${kind}-300"] button')?.getAttribute('aria-pressed') === 'true'`)
    await frames()
    await js(`(() => {
      const p=document.querySelector('${panel}');
      const stops=[...document.querySelectorAll('button,input,select,textarea,a[href],[tabindex],summary')]
        .filter(e=>e.tabIndex>=0 && !e.disabled && e.getClientRects().length && !e.closest('[hidden],[inert]'));
      const index=stops.indexOf(p);
      window.selectionEntryBefore=stops[index-1];
      window.selectionEntryAfter=stops.slice(index+1).find(e=>!p.contains(e));
      window.selectionEntryBefore.focus();
      p.scrollTop=(p.scrollHeight-p.clientHeight)/2;p.dispatchEvent(new Event('scroll'));
    })()`)
    await frames()
    assert(await js(`document.querySelector('${panel}').scrollTop > 1000`), 'Forward entry starts with the viewport in the middle')
    await key('Tab')
    assert(await js(`document.activeElement===document.querySelector('${panel}')`), 'Forward Tab reaches the panel first')
    await key('Tab')
    const forwardEntry = await js("document.activeElement.closest('[data-list-window-row]')?.dataset.listWindowRow")
    const forwardVisible = await js(`(() => {const p=document.querySelector('${panel}').getBoundingClientRect(),r=document.activeElement.getBoundingClientRect();return r.top>=p.top-1 && r.bottom<=p.bottom+1})()`)
    await key('Tab', ['shift']); await key('Tab', ['shift'])
    const backwardExit = await js('document.activeElement===window.selectionEntryBefore')
    await js(`(() => {window.selectionEntryAfter.focus();const p=document.querySelector('${panel}');p.scrollTop=(p.scrollHeight-p.clientHeight)/2;p.dispatchEvent(new Event('scroll'))})()`)
    await frames()
    assert(await js(`document.querySelector('${panel}').scrollTop > 1000`), 'Backward entry starts with the viewport in the middle')
    await key('Tab', ['shift'])
    const backwardEntry = await js("document.activeElement.closest('[data-list-window-row]')?.dataset.listWindowRow")
    const backwardVisible = await js(`(() => {const p=document.querySelector('${panel}').getBoundingClientRect(),r=document.activeElement.getBoundingClientRect();return r.top>=p.top-1 && r.bottom<=p.bottom+1})()`)
    await key('Tab')
    const forwardExit = await js('document.activeElement===window.selectionEntryAfter')
    assert.deepEqual({ forwardEntry, backwardEntry, backwardExit, forwardExit, forwardVisible, backwardVisible },
      { forwardEntry: `${kind}-0`, backwardEntry: `${kind}-599`, backwardExit: true, forwardExit: true, forwardVisible: true, backwardVisible: true },
      'External sequential entry/exit follows the full logical list without a focus trap')
    await js(`document.querySelector('${panel}').focus()`)
    await key('End')
    await wait(`document.activeElement?.closest('[data-list-window-row]')?.dataset.listWindowRow === '${kind}-599'`)
    assert(await js(`document.querySelectorAll('${panel} button').length <= 123`), 'DOM must be bounded')
    const focusedBounds = await js(`(() => {const panel=document.querySelector('${panel}'),p=panel.getBoundingClientRect(),r=document.activeElement.getBoundingClientRect();return {top:r.top,bottom:r.bottom,panelTop:p.top,panelBottom:p.bottom,scrollTop:panel.scrollTop,scrollHeight:panel.scrollHeight}})()`)
    assert(focusedBounds.top >= focusedBounds.panelTop - 1 && focusedBounds.bottom <= focusedBounds.panelBottom + 1, `End must focus a visible last row: ${kind} ${JSON.stringify(focusedBounds)}`)
    await key('Enter')
    assert(await js(`document.querySelector('[data-list-window-row="${kind}-599"] button').getAttribute('aria-pressed')==='true'`))
    await js(`document.querySelector('${panel}').focus()`)
    await key('Home')
    await wait(`document.activeElement?.closest('[data-list-window-row]')?.dataset.listWindowRow === '${kind}-0'`)
    for (let i=0;i<65;i++) await key('Tab')
    assert.equal(await js("document.activeElement.closest('[data-list-window-row]').dataset.listWindowRow"), `${kind}-65`, 'Tab traverses unmounted rows')
    await key('Tab', ['shift'])
    assert.equal(await js("document.activeElement.closest('[data-list-window-row]').dataset.listWindowRow"), `${kind}-64`)
    // A focused row stays mounted during scrollbar jumps; the new viewport must fill too.
    await js(`document.querySelector('${panel}').scrollTop=20000;document.querySelector('${panel}').dispatchEvent(new Event('scroll'))`)
    await frames()
    assert.equal(await js("document.activeElement.closest('[data-list-window-row]').dataset.listWindowRow"), `${kind}-64`)
    assert(await js(`(() => {const p=document.querySelector('${panel}'),r=p.getBoundingClientRect();return [...p.querySelectorAll('[data-list-window-row]')].some(e=>{const b=e.getBoundingClientRect();return b.bottom>r.top && b.top<r.bottom})})()`), 'Scrolled viewport must have rows')
    assert(await js(`document.querySelectorAll('${panel} button').length <= 123`))
  }
  // Metadata does not trigger body reads. Opening the source still shows its complete saved snapshot.
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).source'), 0)
  await js(`document.querySelector('.supervisor-workspace__category').value='event';document.querySelector('.supervisor-workspace__category').dispatchEvent(new Event('change',{bubbles:true}))`)
  await frames()
  await click('.supervisor-workspace__detail > button.link-button')
  await wait('document.querySelector(".supervisor-workspace__source-content") || document.body.textContent.includes("视觉 fixture，不是真实用户数据。")')
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).source'), 1)
  await click('#supervisor-tab-overview')
  await click('#supervisor-tab-graph')
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).graph'), 1, 'Warm tab switch keeps the graph')
  await click('.supervisor-workspace__result-navigation button')
  await click('.supervisor-workspace__history-menu button[value="older-result"]')
  await wait('document.querySelector(".supervisor-workspace").getAttribute("aria-busy")==="false"')
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).graph'), 2)
  assert(!await js('document.body.textContent.includes("视觉 fixture，不是真实用户数据。")'), 'History clears the old source')
  await js(`document.querySelector('.supervisor-workspace__category').value='entity';document.querySelector('.supervisor-workspace__category').dispatchEvent(new Event('change',{bubbles:true}))`)
  await frames()
  await js(`document.querySelector('${panel}').focus()`)
  await key('End'); await key('Enter')
  await click('.supervisor-workspace__detail > .supervisor-workspace__actions button:nth-child(2)')
  await click('.supervisor-workspace__detail form input')
  await key('a', ['control'])
  for (const character of 'Edited entity') win.webContents.sendInputEvent({type:'char',keyCode:character})
  await click('.supervisor-workspace__detail form button')
  await wait('JSON.parse(document.documentElement.dataset.supervisorCalls).edits===1 && document.querySelector(".supervisor-workspace").getAttribute("aria-busy")==="false"')
  assert.equal(await js('JSON.parse(document.documentElement.dataset.supervisorCalls).graph'), 3)
  assert(await js('document.querySelector("[data-list-window-row=entity-599]").textContent.includes("Edited entity")'))
  // Narrow layout still fills the scroll viewport without clipping full labels.
  win.setContentSize(390, 800)
  await frames()
  await js(`document.querySelector('${panel}').focus()`)
  await key('End')
  assert(await js('document.documentElement.scrollWidth <= innerWidth'))
  assert(await js(`document.querySelectorAll('${panel} button').length <= 123`))
  win.setContentSize(1440, 1100)
}
