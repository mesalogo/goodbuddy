const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')

async function main() {
  const executable = resolve(process.argv[2])
  await stat(executable)
  const root = await mkdtemp(join(tmpdir(), 'goodbuddy-obsidian-packaged-'))
  const profile = join(root, 'profile')
  const vault = join(root, 'Packaged Vault')
  await mkdir(profile)
  await mkdir(vault)
  const audit = join(root, 'node-audit.jsonl')
  const guard = join(root, 'offline.cjs')
  await writeFile(guard, `
const fs = require('node:fs');
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const options = net._normalizeArgs(args)[0];
  const host = options.host || 'localhost';
  if (!options.path && !['localhost','127.0.0.1','::1'].includes(host)) throw new Error('Offline acceptance blocked network');
  return original.apply(this,args);
};
globalThis.fetch = async () => { throw new Error('Offline acceptance blocked fetch'); };
require('node:module').syncBuiltinESMExports();
fs.appendFileSync(${JSON.stringify(audit)}, JSON.stringify({entry:process.argv[1],exe:process.execPath,electron:process.versions.electron})+'\\n');
`)
  const env = { ...process.env, NODE_OPTIONS: `--require ${JSON.stringify(guard)}`,
    PATH: join(process.env.SystemRoot, 'System32') }
  delete env.Path
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(executable, [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--inspect=0',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>'], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  let diagnostic = ''
  child.stderr.on('data', chunk => { diagnostic += chunk.toString() })
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
  let socket
  let mainSocket
  try {
    let port
    for (let i=0;i<100;i++) {
      try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]; break } catch { await wait(200) }
    }
    assert(port, 'Packaged app must expose debugging only in the isolated profile')
    const mainEndpoint = diagnostic.match(/ws:\/\/127\.0\.0\.1:\d+\/[-a-f0-9]+/u)?.[0]
    assert(mainEndpoint, 'The isolated Main inspector must be available')
    mainSocket = new WebSocket(mainEndpoint)
    await new Promise((resolve, reject) => { mainSocket.onopen=resolve;mainSocket.onerror=reject })
    // Packaged Electron strips NODE_OPTIONS at startup. Restore it only for this
    // disposable Main so its real MCPVault child receives the offline guard.
    await new Promise((resolve,reject) => {
      const timer=setTimeout(()=>reject(new Error('Main inspector timed out')),10_000)
      mainSocket.onmessage=message=>{const value=JSON.parse(message.data);if(value.id===1){clearTimeout(timer);if(value.error || value.result?.exceptionDetails)reject(new Error('Unable to set child network guard'));else resolve()}}
      mainSocket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:`process.env.NODE_OPTIONS=${JSON.stringify(env.NODE_OPTIONS)}`}}))
    })
    mainSocket.close()
    let target
    for (let i=0;i<100;i++) {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === 'page' && item.url.includes('index.html'))
      if (target) break
      await wait(200)
    }
    assert(target, 'Packaged production renderer must load')
    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
    let id = 0
    const pending = new Map()
    socket.onmessage = message => { const value = JSON.parse(message.data); if (pending.has(value.id)) { const {resolve,reject}=pending.get(value.id); pending.delete(value.id); if (value.error) reject(new Error(value.error.message)); else resolve(value.result) } }
    const send = (method, params={}) => new Promise((resolve,reject) => {
      const key=++id
      const timer=setTimeout(()=>{pending.delete(key);reject(new Error(`CDP timed out: ${method}`))},10_000)
      pending.set(key,{
        resolve: value=>{clearTimeout(timer);resolve(value)},
        reject: error=>{clearTimeout(timer);reject(error)}
      })
      socket.send(JSON.stringify({id:key,method,params}))
    })
    const js = async expression => { const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert(!result.exceptionDetails,JSON.stringify(result.exceptionDetails));return result.result.value }
    const poll = async expression => { for(let i=0;i<100;i++){ if(await js(expression))return;await wait(200) } throw new Error(`Timeout: ${expression}`) }
    const click = async expression => {
      await js(`(()=>{const e=${expression};if(!e)throw new Error('Missing control');e.scrollIntoView({block:'center'});e.focus();e.click()})()`)
      await wait(500)
    }
    await poll('Boolean(window.goodbuddy && document.querySelector("button"))')
    await stat(join(profile,'assistant.sqlite'))
    assert.equal(await js('typeof require'), 'undefined')
    await click(`document.querySelector('button[aria-label="\u8bbe\u7f6e"]')`)
    await poll(`Array.from(document.querySelectorAll('button')).some(b=>b.innerText.startsWith('\u80fd\u529b\u4e0e\u5de5\u5177'))`)
    await click(`Array.from(document.querySelectorAll('button')).find(b=>b.innerText.startsWith('\u80fd\u529b\u4e0e\u5de5\u5177'))`)
    await click(`Array.from(document.querySelectorAll('[role="tab"]')).find(b=>b.innerText==='MCP' && b.getClientRects().length)`)
    const card=`Array.from(document.querySelectorAll('.capability-card')).find(c=>c.querySelector('strong')?.textContent==='Obsidian')`
    await poll(`Boolean(${card})`)
    await js(`{const e=(${card}).querySelector('select');e.value='folder';e.dispatchEvent(new Event('change',{bubbles:true}));}`)
    await poll(`Boolean((${card}).querySelector('input:not([type="checkbox"])'))`)
    await click(`(${card}).querySelector('input:not([type="checkbox"])')`)
    await send('Input.insertText',{text:vault})
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[1]`)
    await poll(`Boolean((${card}).querySelector('[role="status"]'))`)
    assert.match(await js(`(${card}).querySelector('[role="status"]').textContent`),/18/)
    await click(`(${card}).querySelectorAll('.capability-card__actions button')[2]`)
    await poll(`!(${card}).querySelector('.primary-button').disabled`)
    assert.equal((await js('window.goodbuddy.capabilities.getSnapshot()')).obsidian.vaultPath,vault)
    const bin=join(profile,'tool-environment','bin')
    const shims=(await readdir(bin,{recursive:true})).filter(name=>name.endsWith('node.cmd'))
    assert(shims.length>0)
    assert((await readFile(join(bin,shims[0]),'utf8')).includes(executable))
    console.log('PASS: packaged app.asar UI -> real IPC -> packaged MCPVault (18 tools), save, managed packaged Electron shim, PATH=System32, Chromium dead proxy')
    const records=(await readFile(audit,'utf8')).trim().split('\n').map(line=>JSON.parse(line))
    assert(records.some(item=>item.entry?.includes('app.asar.unpacked') && item.entry.endsWith('server.js') && item.exe===executable && item.electron))
    console.log('PASS: packaged MCPVault child loaded Node network guards; audited packaged executable and unpacked server entry')
    console.log('Boundary: MCPVault Node API guards + Chromium proxy; no OS firewall, physical disconnection, or installer execution')
  } finally {
    socket?.close()
    mainSocket?.close()
    if (child.exitCode === null) {
      const killer=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'ignore'})
      await new Promise(resolve=>killer.once('exit',resolve))
    }
    await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
