import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'
import type { KnowledgeService } from '../src/main/knowledge/knowledge-service'
import type { BrowserService } from '../src/main/browser/browser-service'
import type { BrowserTabId } from '../src/shared/contracts'

const python = `import json,sys,urllib.request
config=json.load(sys.stdin)
headers={'Content-Type':'application/json','Accept':'application/json, text/event-stream','Authorization':'Bearer '+config['token']}
counter=0
def call(method,params,notification=False):
 global counter
 counter+=1
 data={'jsonrpc':'2.0','method':method,'params':params}
 if not notification: data['id']=counter
 request=urllib.request.Request(config['url'],data=json.dumps(data).encode(),headers=headers)
 with urllib.request.urlopen(request,timeout=30) as response:
  session=response.headers.get('Mcp-Session-Id')
  if session: headers['Mcp-Session-Id']=session
  text=response.read().decode()
 if not text: return None
 if text.startswith('event:') or text.startswith('data:'):
  text=[line[5:].strip() for line in text.splitlines() if line.startswith('data:')][-1]
 result=json.loads(text)
 assert 'error' not in result, result
 return result.get('result')
call('initialize',{'protocolVersion':'2025-03-26','capabilities':{},'clientInfo':{'name':'goodbuddy-real-host-browser-check','version':'1'}})
call('notifications/initialized',{},True)
names=[tool['name'] for tool in call('tools/list',{})['tools']]
assert 'browser_action' in names and 'browser_tabs' in names,names
snapshot=call('tools/call',{'name':'browser_snapshot','arguments':{}})
assert not snapshot.get('isError'),snapshot
page=json.loads(snapshot['content'][0]['text'])
ref=next(node['ref'] for node in page['nodes'] if node['name']=='姓名')
result=call('tools/call',{'name':'browser_action','arguments':{'action':{'kind':'fill','ref':ref,'text':'real Linux Host'}}})
assert not result.get('isError'),result
tabs=call('tools/call',{'name':'browser_tabs','arguments':{'action':'list'}})
assert not tabs.get('isError'),tabs
print(json.dumps({'hostTools':len(names),'remoteSnapshot':True,'remoteFill':True,'remoteTabList':True,'externalModelCalls':0}))
`
export async function runRemoteBrowserProbe(browser: BrowserService, tabId: BrowserTabId, host: string): Promise<void> {
  const gateway = new KnowledgeMcpGateway({ database: { listKnowledgeBases: () => [] } } as unknown as KnowledgeService, { browserService: browser })
  try {
    const signal = AbortSignal.timeout(60_000)
    await gateway.start()
    const token = gateway.grant('remote-browser-test', [], signal, 'none', undefined, 'browser-ui-e2e', tabId)
    assert(token)
    const endpoint = new URL(gateway.getEndpoint()!)
    const command = `python3 -c '${python.replaceAll("'", "'\"'\"'")}'`
    await new Promise<void>((resolve, reject) => {
      const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes', '-R', `127.0.0.1:${endpoint.port}:127.0.0.1:${endpoint.port}`, host, command], { stdio: ['pipe', 'pipe', 'pipe'] })
      child.stdout.pipe(process.stdout)
      child.stderr.pipe(process.stderr)
      const timer = setTimeout(() => { child.kill(); reject(new Error('Remote browser check timed out')) }, 45_000)
      child.once('error', reject)
      child.once('exit', (code) => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(`Remote check exit ${code}`)) })
      child.stdin.end(JSON.stringify({ url: endpoint.href, token }))
    })
    assert.match((await browser.snapshot('browser-ui-e2e', signal, tabId)).tree ?? '', /real Linux Host/u)
    gateway.revoke(token)
    console.log('PASS current desktop MCP gateway and native Playwright page operated from the real Host over SSH forwarding')
  } finally {
    await gateway.dispose()
  }
}
