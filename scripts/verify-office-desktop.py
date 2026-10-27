"""Linux Electron + real isolated Office stack. Requires Python Playwright and Node on PATH."""
import argparse
import os
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path
import tempfile
from playwright.sync_api import sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--web', default='http://127.0.0.1:18088')
parser.add_argument('--file-entry', action='store_true', help='Open a file reference through the production store after configuring the connection')
parser.add_argument('--legacy', action='store_true', help='Convert a real DOC and verify saving preserves the original')
parser.add_argument('--native-save', action='store_true', help='Use ONLYOFFICE toolbar Save and verify automatic source writeback')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
(repo / 'temp').mkdir(exist_ok=True)
root = Path(tempfile.mkdtemp(prefix='office-desktop-', dir=repo / 'temp'))
sys.path.insert(0, str(repo.parent / 'goodbuddy-shareserver/scripts/office-e2e'))
from fixtures import docx

esbuild = str(repo / 'node_modules/.bin/esbuild')
for source, output, platform in [
    ('src/main/office-service.ts', 'service.cjs', 'node'),
    ('src/main/office-file-worker.ts', 'office-file-worker.js', 'node'),
    ('src/preload/office-editor.ts', 'office-editor.cjs', 'node'),
    ('tests/support/office-desktop-panel.tsx', 'panel.js', 'browser'),
]:
    subprocess.run([esbuild, source, '--bundle', '--platform=' + platform,
                    '--format=' + ('cjs' if platform == 'node' else 'iife'),
                    '--external:electron', '--jsx=automatic', '--outfile=' + str(root / output)], cwd=repo, check=True)
shutil.copyfile(repo / 'tests/support/office-desktop.html', root / 'index.html')
(root / 'package.json').write_text('{"type":"commonjs"}')
(root / 'source.docx').write_bytes(docx())
if args.legacy:
    subprocess.run(['libreoffice', f'-env:UserInstallation={(root / "lo-profile").as_uri()}', '--headless', '--convert-to', 'doc:MS Word 97', '--outdir', str(root), str(root / 'source.docx')], check=True, timeout=60)
    original_legacy = (root / 'source.doc').read_bytes()
def text(path):
    with zipfile.ZipFile(path) as archive:
        return archive.read('word/document.xml').decode()

with (root / 'electron.log').open('w') as log:
    env = dict(os.environ, TMPDIR=str(root), GB_OFFICE_PROBE_ROOT=str(root), GB_OFFICE_PROBE_WEB=args.web, GB_OFFICE_PROBE_FILENAME='source.doc' if args.legacy else 'source.docx')
    env.pop('ELECTRON_RUN_AS_NODE', None)
    child = subprocess.Popen(['xvfb-run', '-a', str(repo / 'node_modules/electron/dist/electron'),
                              '--no-sandbox', str(repo / 'tests/support/office-desktop-main.cjs')], env=env, stdout=log, stderr=log,
                             start_new_session=True)
    try:
        with sync_playwright() as playwright:
            for _ in range(60):
                try:
                    browser = playwright.chromium.connect_over_cdp('http://127.0.0.1:19222')
                    break
                except Exception:
                    if child.poll() is not None: raise RuntimeError('Electron exited')
                    time.sleep(.5)
            else: raise RuntimeError('CDP unavailable')
            panel = browser.contexts[0].pages[0]
            assert panel.get_by_role('textbox', name='ShareServer 地址').count() == 0
            panel.get_by_role('button', name='编辑文件引用' if args.file_entry else '选择 Office 文件并编辑', exact=True).click()
            editor = None
            observed = set()
            for _ in range(120):
                pages = browser.contexts[0].pages
                for target in pages:
                    if target not in observed:
                        observed.add(target)
                        target.on('pageerror', lambda error: print('Browser error:', error, flush=True))
                        target.on('console', lambda message: print('Browser console:', message.text, flush=True) if message.type == 'error' else None)
                editor = next((page for page in pages if '/office/editor?' in page.url), None)
                if editor and editor.evaluate('document.documentElement.dataset.officeReady === "true"'): break
                panel.wait_for_timeout(500)
            else: raise RuntimeError('Editor not ready: ' + panel.inner_text('body'))
            print('PASS: OfficePanel -> IPC -> upload worker -> real sandboxed editor', flush=True)
            print('Editor URL:', editor.url, flush=True)
            assert panel.get_by_role('button', name='保存回文件', exact=True).count() == 0
            assert panel.get_by_role('button', name='另存为', exact=True).count() == 0
            assert editor.get_by_role('button', name='保存到服务器', exact=True).count() == 0
            bounds = editor.get_by_label('ONLYOFFICE 文档编辑器').bounding_box()
            viewport = editor.evaluate('({width:innerWidth,height:innerHeight})')
            assert bounds['x'] == 0 and bounds['y'] == 0 and abs(bounds['height'] - viewport['height']) <= 1
            print('PASS: inherited connection, no duplicate toolbars, embedded editor fills viewport', flush=True)
            frame = editor.frames[1]
            if frame.get_by_role('button', name='取消', exact=True).count():
                frame.get_by_role('button', name='取消', exact=True).click()
            editor.mouse.click(650, 560)
            editor.keyboard.press('Control+End')
            editor.keyboard.type(' GB_DESKTOP_WRITEBACK_10', delay=40)
            editor.keyboard.press('Control+a')
            selection = None
            selection_error = ''
            for _ in range(20):
                try:
                    selection = editor.evaluate('window.goodbuddyOffice.selection()')
                    break
                except Exception as error:
                    selection_error = str(error)
                    editor.wait_for_timeout(500)
            assert selection and 'GB_DESKTOP_WRITEBACK_10' in selection['text'], (selection, selection_error, [frame.url for frame in editor.frames])
            # Real workflow: expanding the GB panel resizes/defocuses the native editor.
            panel.get_by_role('button', name='编辑文件引用', exact=True).focus()
            editor.evaluate('args => window.goodbuddyOffice.replace(args.selection, args.text)', {
                'selection': selection, 'text': 'GB_DESKTOP_WRITEBACK_10 插件修改'})
            editor.keyboard.press('Control+a')
            changed = editor.evaluate('window.goodbuddyOffice.selection()')
            assert '插件修改' in changed['text']
            editor.keyboard.press('Control+z')
            editor.keyboard.press('Control+a')
            restored = editor.evaluate('window.goodbuddyOffice.selection()')
            assert restored['text'].strip() == selection['text'].strip()
            editor.keyboard.press('ArrowRight')
            try:
                editor.evaluate('args => window.goodbuddyOffice.replace(args.selection, args.text)', {
                    'selection': restored, 'text': 'STALE_REPLACEMENT'})
                raise AssertionError('Stale selection was accepted')
            except Exception as error:
                assert 'Stale selection was accepted' not in str(error)
            print('PASS: production plugin survives GB panel focus/resize; replace, undo and stale-target rejection', flush=True)
            if args.native_save:
                frame.locator('button[aria-label^="保存"]:visible').first.click()
            else:
                panel.evaluate('window.goodbuddy.probeSaveKey(false)')
            try:
                editor.get_by_role('status').filter(has_text='已保存到文件').wait_for(timeout=65000)
            except Exception:
                print('Save diagnostics:', panel.evaluate('window.goodbuddy.probeDiagnostics()'), editor.inner_text('body'), flush=True)
                raise
            assert 'GB_DESKTOP_WRITEBACK_10' in text(root / ('export.docx' if args.legacy else 'source.docx'))
            print('PASS: actual edit -> ' + ('native Save -> automatic' if args.native_save else 'keyboard Save ->') + ' verified revision -> source writeback', flush=True)
            if args.legacy:
                assert (root / 'source.doc').read_bytes() == original_legacy
                print('PASS: legacy DOC original unchanged; edited conversion saved as DOCX', flush=True)
            else:
                # An external writer must survive a subsequent save attempt.
                (root / 'source.docx').write_bytes(docx('external edit'))
                if args.native_save:
                    editor.mouse.click(650, 560)
                    editor.keyboard.press('Control+End')
                    editor.keyboard.type(' SECOND_NATIVE_SAVE', delay=40)
                    frame.locator('button[aria-label^="保存"]:visible').first.click()
                else:
                    panel.evaluate('window.goodbuddy.probeSaveKey(false)')
                panel.wait_for_function('async () => (await window.goodbuddy.probeError()).includes("源文件已被其他程序修改")', timeout=65000)
                assert 'external edit' in text(root / 'source.docx')
                print('PASS: conflict keeps external source and editing view', flush=True)
                panel.evaluate('window.goodbuddy.probeSaveKey(true)')
                for _ in range(130):
                    if (root / 'export.docx').exists(): break
                    panel.wait_for_timeout(500)
                assert (root / 'export.docx').exists(), panel.evaluate('window.goodbuddy.probeDiagnostics()')
                assert 'GB_DESKTOP_WRITEBACK_10' in text(root / 'export.docx')
                print('PASS: save-as recovers edited document after conflict', flush=True)
            instance_id = panel.evaluate('''() => {
              const value = document.querySelector('[data-office-instance]');
              return value.dataset.officeInstance;
            }''')
            assert panel.evaluate('instanceId => window.goodbuddy.office.close({instanceId})', instance_id)
            print('PASS: document closes through real IPC', flush=True)
            panel.evaluate('window.goodbuddy.quitProbe()')
            browser.close()
            child.wait(timeout=15)
    finally:
        import signal
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=15)
        log.flush()
        if sys.exc_info()[0]:
            print((root / 'electron.log').read_text(), file=sys.stderr)
        shutil.rmtree(root)
