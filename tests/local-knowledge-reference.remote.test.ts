// @vitest-environment node
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { expect, it } from 'vitest'
import { KnowledgeDatabase } from '../src/main/knowledge/knowledge-database'
import { KnowledgeService } from '../src/main/knowledge/knowledge-service'
import type { KnowledgeStoragePort } from '../src/main/knowledge/knowledge-storage-port'
import { KnowledgeMcpGateway } from '../src/main/agent/knowledge-mcp-gateway'

it.skipIf(!process.env.GB_DIRECT_MODEL_HOST || !process.env.GB_DIRECT_MODEL_HOST_NODE)('reads desktop knowledge through the MCP transport from the real Linux Host', async () => {
  const database = new KnowledgeDatabase(':memory:')
  database.initialize()
  const library = database.createKnowledgeBase({ name: 'Remote reference fixture', storageMode: 'managed', graphEnabled: false, graphStrategy: 'rules' })
  const source = database.upsertSource({ knowledgeBaseId: library.id, type: 'file', location: '/desktop-only/report.txt', displayName: 'report.txt' })
  const document = database.upsertDocument({ knowledgeBaseId: library.id, sourceId: source.id, externalId: 'remote-read', title: 'report.txt' }, [
    { ordinal: 0, content: 'Desktop evidence: CEDAR-7391.', location: '1' },
    { ordinal: 1, content: 'Final page: November 18.', location: '2' }
  ])
  const service = new KnowledgeService({ database: database as unknown as KnowledgeStoragePort, managedRoot: '.' })
  const gateway = new KnowledgeMcpGateway(service)
  try {
    await gateway.start()
    const token = gateway.grant('remote-reference', [library.id], new AbortController().signal)!
    const endpoint = gateway.getEndpoint()!
    const port = new URL(endpoint).port
    const program = await build({ stdin: { resolveDir: process.cwd(), contents: `
      import assert from 'node:assert/strict';
      import { Client } from '@modelcontextprotocol/sdk/client/index.js';
      import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
      import { knowledgeScopedDataTools } from './src/shared/scoped-data-tools';
      (async () => {
        assert.equal(process.platform, 'linux');
        const client = new Client({name: 'local-reference-host-probe', version:'1'});
        await client.connect(new StreamableHTTPClientTransport(new URL(${JSON.stringify(endpoint)}), { requestInit: {headers: {authorization: ${JSON.stringify(`Bearer ${token}`)}}} }));
        try {
          const catalog = await client.listTools();
          assert(catalog.tools.some(tool => tool.name === knowledgeScopedDataTools.find(tool => tool.name === 'knowledge_read').name));
          let next = {ordinal:0,offset:0}, text = '', pages = 0;
          do {
            const result = await client.callTool({ name:'knowledge_read', arguments:{documentId:${JSON.stringify(document.id)}, ...next, limit:12} });
            assert(!result.isError, JSON.stringify(result));
            const page = JSON.parse(result.content.find(item => item.type === 'text').text);
            text += page.text; next = page.next; pages++;
          } while(next);
          assert.equal(text, 'Desktop evidence: CEDAR-7391.Final page: November 18.');
          console.log(JSON.stringify({remoteKnowledgeReadPassed:true, pages, platform:process.platform}));
        } finally { await client.close(); }
      })().catch(error => { console.error(error.message); process.exitCode=1; });
    ` }, bundle: true, platform: 'node', format: 'cjs', write: false })
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ExitOnForwardFailure=yes',
      '-R', `${port}:127.0.0.1:${port}`, process.env.GB_DIRECT_MODEL_HOST!, process.env.GB_DIRECT_MODEL_HOST_NODE!, '-'], { stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.stdin.end(program.outputFiles[0]!.contents)
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 45000)
    try {
      const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject) })
      expect(timedOut, output).toBe(false)
      expect(code, output).toBe(0)
      expect(output).toContain('"remoteKnowledgeReadPassed":true')
      process.stdout.write(output)
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  } finally { await gateway.dispose(); await service.dispose(); database.close() }
}, 60000)
