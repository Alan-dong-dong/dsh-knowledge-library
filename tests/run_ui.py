"""Launch an isolated library and run the browser smoke test without changing user data."""
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request
import uuid

project = Path(__file__).resolve().parent.parent
runtime = project / ".test-runtime" / ("ui-" + uuid.uuid4().hex[:10])
runtime.mkdir(parents=True)
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
env = os.environ.copy()
env.update(KNOWLEDGE_LIBRARY_ROOT=str(runtime / "library"), KNOWLEDGE_LIBRARY_ALLOW_FAKE_IP="0", PORT=str(port), LIBRARY_TEST_URL=f"http://127.0.0.1:{port}")
for script, log_name in [("ui_smoke.py", "server.log"), ("ui_trash.py", "trash-server.log"), ("ui_trash_restart.py", "trash-restart-server.log"), ("preview_restart.py", "restart-server.log")]:
    with (runtime / log_name).open("w", encoding="utf-8") as log:
        server = subprocess.Popen(["node", "dist/standalone.js"], cwd=project, env=env, stdout=log, stderr=subprocess.STDOUT,
                                  creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError(f"Preview exited early; see {runtime / log_name}")
                try:
                    with urllib.request.urlopen(env["LIBRARY_TEST_URL"] + "/knowledge-library/api/stats", timeout=1) as response:
                        if response.status == 200:
                            break
                except OSError:
                    time.sleep(0.2)
            else:
                raise RuntimeError("Preview did not become ready")
            result = subprocess.run([sys.executable, str(project / "tests" / script)], cwd=project, env=env)
            if result.returncode:
                sys.exit(result.returncode)
        finally:
            server.terminate()
            try:
                server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                server.kill()
                server.wait()
