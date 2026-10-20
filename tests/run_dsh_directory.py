"""Run the directory UI checks and restart checks without using the user's DSH profile."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.request
import uuid

project = Path(__file__).resolve().parent.parent
runtime = project / '.test-runtime' / ('directory-' + uuid.uuid4().hex[:10])
runtime.mkdir(parents=True)
env = os.environ.copy()
env.update(DSH_HOME=str(runtime / 'harness'), DSH_DIRECTORY_BASE=str(runtime / 'libraries'), PYTHONIOENCODING='utf-8')
cli = ['node', str(project / 'node_modules/@deepseek-ai/dsh/lib/bin.js')]
creation = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
subprocess.run(cli + ['plugin', '--profile', 'web', 'add', 'link:' + project.as_posix(), '--prefer-offline'], cwd=project, env=env, check=True, creationflags=creation)
patch = Path(env['DSH_HOME']) / 'profiles/web/cordis.patch.yml'
patch.write_text('- id: knowledge-library\n  config:\n    root: ' + json.dumps((runtime / 'libraries/initial').as_posix()) + '\n- id: directory-picker\n  disabled: true\n- insert:\n    - id: test-directory-picker\n      name: "@deepseek-ai/dsh-host-directory-picker-browse"\n', encoding='utf-8')

def run_host(restart=False):
    log_path = runtime / ('restart.log' if restart else 'server.log')
    with log_path.open('w', encoding='utf-8') as log:
        host = subprocess.Popen(cli + ['--profile', 'web', '--no-open', '--port', '0'], cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=creation)
        try:
            for _ in range(450):
                if host.poll() is not None:
                    raise RuntimeError('Isolated Harness exited; inspect ' + str(log_path))
                text = log_path.read_text(encoding='utf-8', errors='replace')
                urls = re.findall(r'http://(?:127\.0\.0\.1|localhost):\d+[^\s\x1b]*', text)
                if urls:
                    origin = re.match(r'https?://[^/]+', urls[-1]).group(0)
                    try:
                        with urllib.request.urlopen(origin + '/knowledge-library/api/stats', timeout=1) as response:
                            if response.status == 200:
                                env['DSH_TEST_URL'] = urls[-1]
                                break
                    except OSError:
                        pass
                time.sleep(.2)
            else:
                raise RuntimeError('Isolated Harness not ready; inspect ' + str(log_path))
            if restart:
                env['DSH_DIRECTORY_RESTART'] = '1'
            result = subprocess.run([sys.executable, 'tests/dsh_directory.py'], cwd=project, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', errors='replace', creationflags=creation)
            (runtime / ('restart-test.log' if restart else 'test.log')).write_text(result.stdout, encoding='utf-8')
            print(re.sub(r'(http://(?:127\.0\.0\.1|localhost):\d+)[^\s]*', r'\1/[redacted]', result.stdout), flush=True)
            result.check_returncode()
        finally:
            if host.poll() is None:
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(host.pid), '/T', '/F'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False, creationflags=creation)
                else:
                    host.terminate()
                host.wait(timeout=15)

run_host()
run_host(restart=True)
print('PASS: isolated Harness directory flow and full restart verification.')
