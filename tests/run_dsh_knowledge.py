"""Exercise the native Harness UI and LlmRuntime with an isolated fixture provider."""
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
runtime = project / '.test-runtime' / ('knowledge-dsh-' + uuid.uuid4().hex[:10])
runtime.mkdir(parents=True)
provider = start_model()
env = os.environ.copy()
env.update(DSH_HOME=str(runtime / 'harness'), KNOWLEDGE_TEST_PROVIDER=f'http://127.0.0.1:{provider.server_port}', PYTHONIOENCODING='utf-8')
cli = ['node', str(project / 'node_modules/@deepseek-ai/dsh/lib/bin.js')]
creation = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def run(restart=False):
    log_path = runtime / ('restart.log' if restart else 'server.log')
    with log_path.open('w', encoding='utf-8') as log:
        proc = subprocess.Popen(cli + ['--profile', 'web', '--no-open', '--port', '0'], cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=creation)
        try:
            for _ in range(450):
                if proc.poll() is not None:
                    raise RuntimeError('Isolated Harness exited; inspect ' + str(log_path))
                urls = re.findall(r'http://(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*', log_path.read_text(encoding='utf-8', errors='replace'))
                if urls:
                    origin = re.match(r'https?://[^/]+', urls[-1]).group(0)
                    try:
                        with urllib.request.urlopen(origin + '/knowledge-library/api/knowledge', timeout=1) as response:
                            status = json.load(response)
                        if status['available'] and status.get('model') == 'knowledge-test / knowledge-fixture':
                            env['DSH_TEST_URL'] = urls[-1]
                            break
                    except OSError:
                        pass
                time.sleep(.2)
            else:
                raise RuntimeError('Native knowledge model not ready; inspect ' + str(log_path))
            if restart:
                env['KNOWLEDGE_UI_RESTART'] = '1'
            for script in (['tests/ui_images.py'] if env.get('IMAGE_UI_ONLY') else ['tests/ui_knowledge.py', 'tests/ui_grouping.py', 'tests/ui_incremental.py']):
                result = subprocess.run([sys.executable, script], cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', creationflags=creation)
                (runtime / (('restart-' if restart else '') + Path(script).stem + '.log')).write_text(result.stdout, encoding='utf-8')
                print(result.stdout, flush=True)
                result.check_returncode()
        finally:
            if proc.poll() is None:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(proc.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, creationflags=creation)
                else:
                    proc.terminate()
                proc.wait(timeout=15)


try:
    setup = subprocess.run(cli + ['plugin', '--profile', 'web', 'add', 'link:' + project.as_posix(), '--prefer-offline'], cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', creationflags=creation)
    (runtime / 'setup.log').write_text(setup.stdout, encoding='utf-8')
    setup.check_returncode()
    patch = Path(env['DSH_HOME']) / 'profiles/web/cordis.patch.yml'
    patch.write_text('- id: knowledge-library\n  config:\n    root: ' + json.dumps((runtime / 'library').as_posix()) + '\n- id: agent-default-model\n  config:\n    provider: knowledge-test\n    model: knowledge-fixture\n- insert:\n    - id: knowledge-model-fixture\n      name: ' + json.dumps((project / 'tests/fixtures/knowledge-host-model.mjs').as_posix()) + '\n', encoding='utf-8')
    run()
    initial_calls = len(provider.calls)
    assert initial_calls > 0 and all(call.get('max_tokens') == 48_000 for call in provider.calls), 'All stages must inherit the fixture model default'
    if env.get('IMAGE_UI_ONLY'):
        assert provider.image_calls == 3, f'Expected 2 first attempts + 1 explicit retry, got {provider.image_calls}'
    run(restart=True)
    assert len(provider.calls) == initial_calls, 'Restart must not repeat model calls'
    print('PASS: native Harness model service, knowledge UI and full host restart; local model fixture only.')
finally:
    provider.shutdown()
    provider.server_close()
