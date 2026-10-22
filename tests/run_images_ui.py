"""Run image UI in preview and real Harness using isolated libraries and local models."""
import os
from pathlib import Path
import subprocess
import sys
env = os.environ.copy()
project = Path(__file__).resolve().parent.parent
env.update(IMAGE_UI_ONLY='1', IMAGE_NETWORK_FIXTURE='1', NODE_OPTIONS='--import=' + (project / 'tests/fixtures/image-network.mjs').as_uri())
for script in ['tests/run_knowledge_ui.py', 'tests/run_dsh_knowledge.py']:
    subprocess.run([sys.executable, script], cwd=project, env=env, check=True)
