"""Run knowledge UI and restart checks against an isolated library and local model."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid
from mock_knowledge_model import start_model
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

project = Path(__file__).resolve().parent.parent
runtime = project / '.test-runtime' / ('knowledge-' + uuid.uuid4().hex[:10])
runtime.mkdir(parents=True)
provider = start_model()
env = os.environ.copy()
env.update(KNOWLEDGE_LIBRARY_ROOT=str(runtime / 'library'), PORT='0', KNOWLEDGE_LIBRARY_MODEL_API_KEY='isolated-test-key', KNOWLEDGE_LIBRARY_MODEL='knowledge-fixture', KNOWLEDGE_LIBRARY_MODEL_BASE_URL=f'http://127.0.0.1:{provider.server_port}/v1', PYTHONIOENCODING='utf-8')
creation = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def run(restart=False):
    path = runtime / ('restart.log' if restart else 'server.log')
    with path.open('w', encoding='utf-8') as log:
        proc = subprocess.Popen(['node', 'dist/standalone.js'], cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=creation)
        try:
            for _ in range(100):
                if proc.poll() is not None:
                    raise RuntimeError('Preview exited; inspect ' + str(path))
                match = re.search(r'http://127\.0\.0\.1:\d+', path.read_text(encoding='utf-8', errors='replace'))
                if match:
                    with urllib.request.urlopen(match.group(0) + '/knowledge-library/api/knowledge', timeout=1) as response:
                        assert json.load(response)['available']
                    env['LIBRARY_TEST_URL'] = match.group(0)
                    break
                time.sleep(.1)
            else:
                raise RuntimeError('Preview not ready')
            if restart:
                env['KNOWLEDGE_UI_RESTART'] = '1'
            for script in ['tests/ui_knowledge.py', 'tests/ui_grouping.py']:
                result = subprocess.run([sys.executable, script], cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', creationflags=creation)
                (runtime / (('restart-' if restart else '') + Path(script).stem + '.log')).write_text(result.stdout, encoding='utf-8')
                print(result.stdout, flush=True)
                result.check_returncode()
        finally:
            proc.terminate()
            proc.wait(timeout=15)


try:
    run()
    initial_calls = len(provider.calls)
    run(restart=True)
    assert len(provider.calls) == initial_calls, 'Restart must not repeat paid model calls'
    (project / 'test-results/knowledge-model-calls.json').write_text(json.dumps({'count': len(provider.calls), 'protocol': 'actual HTTP /v1/chat/completions', 'externalProvider': False}), encoding='utf-8')
    print('PASS: isolated knowledge UI, actual compatible HTTP calls and restart persistence.')
finally:
    provider.shutdown()
    provider.server_close()
