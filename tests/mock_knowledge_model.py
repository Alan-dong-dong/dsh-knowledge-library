"""Local deterministic provider fixture. Never contacts a paid provider."""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/v1/chat/completions'
        assert body['model'] == 'knowledge-fixture'
        assert body['messages'][0]['role'] == 'system'
        prompt = body['messages'][-1]['content']
        self.server.calls.append(body)
        if '故障验证' in prompt:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"error":"isolated failure"}')
            return
        if '慢速验证' in prompt:
            time.sleep(5)
        if '不超过1500字' in prompt:
            references = sorted(set(re.findall(r'library://r_[a-f0-9-]+/p\d+', prompt)))
            content = '证据提炼：采集保留原文，整理保留引用。' + '\n'.join(references)
        else:
            sources = json.loads(re.search(r'来源目录：([^\n]+)', prompt).group(1))
            citations = [{'materialId': source['materialId'], 'segmentId': source['segmentIds'][0]} for source in sources]
            refs = '\n'.join('library://' + c['materialId'] + '/' + c['segmentId'] for c in citations)
            content = json.dumps({
                'title': '从资料到可复用知识',
                'content': '## 核心观点\n知识整理应保留证据和来源。\n\n## 关键概念\n资料是输入，知识笔记记录理解。\n\n## 可复用方法\n先采集，再核验，最后归纳。\n\n## 适用条件与局限\n结论仅适用于所选资料的情境。\n\n## 待验证问题\n其他主题是否适用？\n\n## 共识与差异\n共同强调证据；具体应用条件需核实。\n\n' + refs,
                'tags': ['知识管理', '证据'], 'citations': citations,
            }, ensure_ascii=False)
        payload = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': content}}]}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        try:
            self.wfile.write(payload)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def start_model():
    server = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
    server.calls = []
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
