"""Full built GB + real Docs + deterministic local model. No external model requests."""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
import uuid
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', default='http://127.0.0.1:18088')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
root = Path(tempfile.mkdtemp(prefix='office-chat-', dir=repo / 'temp'))
sys.path.insert(0, str(repo.parent / 'goodbuddy-shareserver/scripts/office-e2e'))
from fixtures import docx
(root / 'source.docx').write_bytes(docx('Office unsaved selection'))
(root / 'user-data').mkdir(mode=0o700)
requests = []
reply = 'GB_AI_REPLY 已完成润色'

class Model(BaseHTTPRequestHandler):
    def do_POST(self):
        request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(request)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        for delta, finish in [({'role': 'assistant', 'content': reply}, None), ({}, 'stop')]:
            value = {'id': 'office-test-response', 'object': 'chat.completion.chunk', 'created': 1,
                     'model': 'office-test', 'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            self.wfile.write(('data: ' + json.dumps(value) + '\n\n').encode())
        self.wfile.write(b'data: [DONE]\n\n')
        self.wfile.flush()
    def log_message(self, *_):
        pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Model)
threading.Thread(target=server.serve_forever, daemon=True).start()
# Use a public, tool-free fixture profile; do not copy or decrypt user credentials.
settings = {
    'version': 2, 'provider': 'model',
    'modelProfiles': [{'id': '10000000-0000-4000-8000-000000000001', 'name': 'Office test',
                       'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'modelName': 'office-test',
                       'protocol': 'openai-chat-completions', 'authentication': 'none', 'supportsImageInput': False}],
    'defaultModelProfileId': '10000000-0000-4000-8000-000000000001',
    'knowledgeEmbeddingEnabled': False, 'knowledgeRerankEnabled': False,
}
with (root / 'electron.log').open('w') as log:
    env = dict(os.environ, TMPDIR=str(root), GB_OFFICE_PROBE_ROOT=str(root))
    env.pop('ELECTRON_RUN_AS_NODE', None)
    child = subprocess.Popen(['xvfb-run', '-a', str(repo / 'node_modules/electron/dist/electron'),
                              '--no-sandbox', str(repo / 'tests/support/office-chat-main.cjs')],
                             env=env, stdout=log, stderr=log, start_new_session=True)
    try:
        with sync_playwright() as p:
            for _ in range(80):
                try:
                    with urllib.request.urlopen('http://127.0.0.1:19223/json/list') as response:
                        targets = json.load(response)
                    if not any(target.get('url', '').endswith('/renderer/index.html') for target in targets):
                        time.sleep(.25)
                        continue
                    browser = p.chromium.connect_over_cdp('http://127.0.0.1:19223')
                    break
                except Exception:
                    if child.poll() is not None: raise RuntimeError('GB exited')
                    time.sleep(.25)
            else: raise RuntimeError('GB debugger unavailable')
            for _ in range(80):
                pages = [page for context in browser.contexts for page in context.pages]
                if pages and pages[0].evaluate('Boolean(window.goodbuddy?.office)'):
                    break
                time.sleep(.25)
            if not pages:
                print(browser.new_browser_cdp_session().send('Target.getTargets'), file=sys.stderr)
                raise RuntimeError('No main page target')
            app = pages[0]
            assert app.evaluate('Boolean(window.goodbuddy?.office)'), 'Production preload did not initialize'
            try:
                app.locator('.release-notes-backdrop .primary-button').click(timeout=5000)
            except Exception:
                pass
            app.evaluate('''async args => {
              const saved = await window.goodbuddy.settings.getRuntime();
              const keys = ['provider','modelBaseUrl','modelName','modelProtocol','modelAuthentication',
                'imageGenerationQuality','opencodeBaseUrl','opencodeEmbedded','opencodeBinaryPath',
                'opencodeConfigPath','continueBinaryPath','continueConfigPath','continueMode',
                'knowledgeEmbeddingEnabled','knowledgeEmbeddingBaseUrl','knowledgeEmbeddingModel',
                'knowledgeRerankEnabled','knowledgeRerankEndpoint','knowledgeRerankModel','workspacePath'];
              const input = Object.fromEntries(keys.map(key => [key, saved[key]]));
              Object.assign(input, {provider:'model',modelBaseUrl:args.url,modelName:'office-test',
                modelProtocol:'openai-chat-completions',modelAuthentication:'none',apiKey:{action:'clear'},
                workspacePath:args.root,knowledgeEmbeddingEnabled:false,knowledgeRerankEnabled:false,
                modelProfiles:[{id:args.id,name:'Office test',baseUrl:args.url,modelName:'office-test',
                  protocol:'openai-chat-completions',authentication:'none',apiKey:{action:'clear'},
                  supportsImageInput:false,imageGenerationQuality:'auto'}],defaultModelProfileId:args.id});
              await window.goodbuddy.settings.updateRuntime(input);
            }''', {'url': f'http://127.0.0.1:{server.server_port}/v1', 'root': str(root), 'id': settings['defaultModelProfileId']})
            # Settings were configured through IPC, outside the settings UI's
            # renderer refresh path. Reload before resolving the conversation Runtime.
            app.reload()
            app.wait_for_function('Boolean(window.goodbuddy?.office)')
            app.wait_for_timeout(1000)
            # Create the conversation via the production API; user operations below use the real UI.
            conversation = {'id': str(uuid.uuid4()), 'title': 'Office integration', 'updatedAt': int(time.time() * 1000)}
            app.evaluate('(header) => window.goodbuddy.conversations.saveLocal([{header, messages:[]}])', conversation)
            print('conversation created', flush=True)
            toggle = app.locator('.assistant-sidebar-toggle')
            if toggle.get_attribute('aria-expanded') != 'true': toggle.click()
            app.get_by_role('button', name='打开工作栏应用', exact=True).click()
            app.get_by_text('文档', exact=True).last.click()
            app.get_by_role('textbox', name='ShareServer 地址').fill(args.web)
            app.get_by_role('button', name='选择 DOCX 并编辑', exact=True).click()
            editor = None
            for _ in range(120):
                editor = next((page for context in browser.contexts for page in context.pages if '/office/editor?' in page.url), None)
                if editor and editor.evaluate('document.documentElement.dataset.officeReady === "true"'):
                    break
                app.wait_for_timeout(500)
            else: raise RuntimeError('editor not ready: ' + str([page.url for context in browser.contexts for page in context.pages]))
            frame = editor.frames[1]
            if frame.get_by_role('button', name='取消', exact=True).count():
                frame.get_by_role('button', name='取消', exact=True).click()
            editor.mouse.click(editor.evaluate('window.innerWidth / 2'), 400)
            editor.keyboard.press('Control+a')
            # Call the same narrow IPC as the panel, then inspect the actual queue/model/result.
            instance_id = app.evaluate('JSON.parse(localStorage.getItem("goodbuddy.workbar-layout.v1")).instances.filter(x=>x.appId==="document").at(-1).id')
            result = app.evaluate('(args) => window.goodbuddy.office.ask(args)', {
                'instanceId': instance_id, 'conversationId': conversation['id'], 'instruction': '润色选区'})
            for _ in range(120):
                outcome = app.evaluate('(instanceId) => window.goodbuddy.office.result({instanceId})', instance_id)
                if outcome['state'] != 'pending': break
                time.sleep(.5)
            assert outcome['state'] == 'complete', outcome
            assert reply in outcome['text'], outcome
            assert any('Office unsaved selection' in json.dumps(request, ensure_ascii=False) for request in requests)
            app.evaluate('(args) => window.goodbuddy.office.apply(args)', {'instanceId': instance_id, 'text': outcome['text']})
            app.get_by_role('button', name='保存回文件', exact=True).click()
            app.get_by_role('status').filter(has_text='已保存到文件').wait_for(timeout=65000)
            with zipfile.ZipFile(root / 'source.docx') as document:
                assert reply in document.read('word/document.xml').decode()
            print('PASS: full GB queue -> configured local Model Runtime -> original selection -> source file; model requests:', len(requests), flush=True)
            browser.close()
    finally:
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=15)
        server.shutdown()
        server.server_close()
        log.flush()
        if sys.exc_info()[0]:
            print((root / 'electron.log').read_text()[-12000:], file=sys.stderr)
            for diagnostic in (root / 'user-data/diagnostics').glob('*'):
                if diagnostic.is_file() and diagnostic.suffix in ('.json', '.jsonl', '.log'):
                    print(diagnostic.name, diagnostic.read_text()[-6000:], file=sys.stderr)
        shutil.rmtree(root)
