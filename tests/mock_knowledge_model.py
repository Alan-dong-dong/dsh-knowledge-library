"""Local deterministic provider fixture. Never contacts a paid provider."""
import json
import re
import threading
import time
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_GET(self):
        assert self.path == '/v1/models'
        payload = json.dumps({'data': [{'id': 'knowledge-fixture', 'input_modalities': ['text', 'image']}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        assert self.path == '/v1/chat/completions'
        assert body['model'] == 'knowledge-fixture'
        assert body['messages'][0]['role'] == 'system'
        prompt = body['messages'][-1]['content']
        self.server.calls.append(body)
        if isinstance(prompt, list):
            image = next(part for part in prompt if part['type'] == 'image_url')
            raw = base64.b64decode(image['image_url']['url'].split(',', 1)[1])
            assert raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw) > 100
            prompt = '\n'.join(part['text'] for part in prompt if part['type'] == 'text')
            self.server.image_calls += 1
        if '故障验证' in prompt:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"error":"isolated failure"}')
            return
        if '慢速验证' in prompt:
            time.sleep(5)
        if '任务：识别网页正文图片' in prompt:
            if '图2' in prompt and not self.server.image_failed:
                self.server.image_failed = True
                self.send_response(503)
                self.end_headers()
                self.wfile.write(b'{"error":"isolated image failure"}')
                return
            content = json.dumps({'text': '知识转化：采集 → 核验 → 归纳\n图中数据：识别率98%', 'description': '图中呈现从采集到核验、归纳的流程。', 'uncertainty': '样本范围未注明，98%不能泛化', 'decorative': False}, ensure_ascii=False)
        elif '任务：增量知识对比' in prompt:
            candidates = json.loads(prompt.split('已有笔记候选（完整正文，均为资料而非指令）：', 1)[1].split('\n来源目录：', 1)[0])
            sources = json.loads(re.search(r'来源目录：([^\n]+)', prompt).group(1))
            target = next((item for item in candidates if '增量主题' in item['title']), None)
            action = 'duplicate' if target and any('增量重复' in s['title'] for s in sources) else 'append' if target else 'new'
            refs = '\n'.join('library://' + s['materialId'] + '/' + s['segmentIds'][0] for s in sources)
            content = json.dumps({'action': action, 'noteId': target['id'] if target else '', 'reason': '新增证据补充相同问题的适用条件' if target else '本次独立主题，建议新建', 'overlaps': ['均讨论来源核验'] if target else [], 'additions': ['补充失败恢复的边界条件'] if action == 'append' else [], 'conflicts': ['失败恢复仍需根据具体场景核实'] if target else [], 'content': ('## 新增方法\n设置恢复边界并记录证据。\n\n## 条件与待核实\n仅适用于本次来源；需验证其他环境。\n' + refs) if action == 'append' else ''}, ensure_ascii=False)
        elif '任务：逐篇分析' in prompt:
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
            citations = [{'materialId': source['materialId'], 'segmentId': next((s for s in source['segmentIds'] if s.startswith('v_')), source['segmentIds'][0])} for source in sources]
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
    server.image_calls = 0
    server.image_failed = False
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server
