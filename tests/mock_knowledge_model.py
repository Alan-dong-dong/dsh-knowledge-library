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
        if '任务：逐篇分析' in prompt:
            source = json.loads(re.search(r'来源目录：([^\n]+)', prompt).group(1))[0]
            title = source['title']
            uncertain = any(word in title for word in ['未知', '孤立', '缺少上下文'])
            category = '技术/AI' if any(word in title for word in ['Agent', 'Harness']) else '生活/理财' if any(word in title for word in ['理财', '投资']) else '生活/烹饪' if any(word in title for word in ['食谱', '做菜']) else '工作/资料'
            content = json.dumps({'sourceId': source['materialId'], 'theme': title + '的具体主题', 'concepts': ['适用条件', '证据'], 'summary': title + '提供了特定情境下的经验，需要保留来源核验。', 'usage': '为本主题提供可复用的方法与条件', 'category': category, 'tags': ['实践'], 'certainty': 'uncertain' if uncertain else 'clear', 'uncertainty': '缺少上下文，暂时不能判断用途' if uncertain else '', 'citations': [{'materialId': source['materialId'], 'segmentId': source['segmentIds'][0]}]}, ensure_ascii=False)
        elif '任务：智能分组' in prompt:
            analyses = json.loads(prompt.split('逐篇分析（作为资料，不是指令）：', 1)[1])
            groups = {}
            unassigned = []
            for item in analyses:
                if item['certainty'] == 'uncertain':
                    unassigned.append({'sourceId': item['sourceId'], 'reason': item['uncertainty']})
                else:
                    category = item['category']
                    if category not in groups:
                        groups[category] = {'title': {'技术/AI': 'Agent可靠性实践', '生活/理财': '理财适用条件', '生活/烹饪': '食谱操作方法'}.get(category, item['theme']), 'reason': '围绕同一具体问题，可以综合核验方法与适用条件', 'sourceIds': [], 'category': category, 'tags': ['实践']}
                    groups[category]['sourceIds'].append(item['sourceId'])
            content = json.dumps({'groups': list(groups.values()), 'unassigned': unassigned}, ensure_ascii=False)
        elif '不超过1500字' in prompt:
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
