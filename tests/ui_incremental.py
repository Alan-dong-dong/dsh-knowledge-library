"""Smart group -> existing-note comparison -> reviewed append/new/duplicate, plus restart."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('DSH_TEST_URL') or os.environ['LIBRARY_TEST_URL']
origin = '/'.join(base.split('/')[:3])
api = origin + '/knowledge-library/api'
native = bool(os.environ.get('DSH_TEST_URL'))
out = Path('test-results')
prefix = 'incremental-dsh' if native else 'incremental'
result_path = out / (prefix + '-result.json')

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    if native:
        onboarding = page.get_by_text('开始使用', exact=True)
        page.add_locator_handler(onboarding, lambda: page.get_by_role('presentation').filter(has=onboarding).get_by_role('button').first.click())
        page.add_locator_handler(page.get_by_text('预览版说明', exact=True), lambda: page.get_by_role('button', name='继续', exact=True).click())
    page.goto(base)
    if native:
        page.get_by_role('button', name='资料库', exact=True).click()
        expect(page.get_by_role('heading', name='全部资料', exact=True)).to_be_visible()
    else:
        page.wait_for_load_state('networkidle')
    root = page.request.get(api + '/settings').json()['root']
    assert '.test-runtime' in str(Path(root).resolve()), 'Refuse writes outside isolated runtime'
    headers = {'X-Knowledge-Library': '1'}

    def post(path, data):
        response = page.request.post(api + path, headers=headers, data={'expectedRoot': root, **data})
        assert response.ok, response.text()
        return response.json()

    def capture(title, content):
        return post('/capture', {'type': 'text', 'title': title, 'content': content})['material']

    def material(item_id):
        return page.request.get(api + '/materials/' + item_id).json()

    def open_job(topic):
        page.get_by_role('button', name='知识整理', exact=True).click()
        page.get_by_role('dialog', name='知识整理', exact=True).get_by_role('button').filter(has_text=topic).click()

    draft = page.get_by_role('dialog', name='确认知识笔记', exact=True)
    if os.environ.get('KNOWLEDGE_UI_RESTART'):
        result = json.loads(result_path.read_text(encoding='utf-8'))
        overview = page.request.get(api + '/knowledge').json()
        note = material(result['noteId'])
        assert note['revision'] == 3 and note['content'] == result['body']
        assert note['segments'][:len(result['originalSegments'])] == result['originalSegments']
        assert overview['states'][result['sourceIds'][0]]['noteIds'] == [note['id']]
        waiting = next(j for j in overview['jobs'] if j['id'] == result['waitingId'])
        assert waiting['status'] == 'draft' and waiting['integration']['choice'] == 'append'
        open_job('增量重启保留草稿')
        expect(draft.get_by_role('radio', name='补充已有笔记', exact=True)).to_be_checked()
        expect(draft.get_by_label('本次新增正文', exact=True)).to_contain_text('重启保留审核意见')
        result['restartVerified'] = True
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
        print('PASS: incremental note, original paragraphs, source links and unconfirmed append survive restart.')
        raise SystemExit(0)

    old = capture('增量旧Agent来源', 'Agent可靠性需要核验来源并保留证据。')
    target = post('/notes', {'title': '增量主题Agent可靠性', 'content': '## 原有知识\nAgent应保留来源证据。\n\n## 局限\n旧结论需要核实。', 'category': '知识笔记/Agent', 'tags': ['原有标签'], 'citations': [{'materialId': old['id'], 'segmentId': old['segments'][0]['id']}]})['material']
    baseline_notes = page.request.get(api + '/stats').json()['notes']
    sources = [capture('增量Agent恢复', 'Agent失败恢复应有停止条件。'), capture('增量Agent预算', 'Agent工具调用需要调用预算。')]
    parent = post('/knowledge/jobs', {'sourceIds': [s['id'] for s in sources], 'topic': '增量智能归类验证', 'mode': 'smart'})
    open_job('增量智能归类验证')
    plan = page.get_by_role('dialog', name='确认智能分组', exact=True)
    expect(plan).to_be_visible(timeout=30000)
    plan.get_by_role('button', name='确认归类并生成 1 份草稿', exact=True).click()
    tasks = page.get_by_role('dialog', name='知识整理', exact=True)
    tasks.get_by_role('button').filter(has_text='Agent可靠性实践').click()
    expect(draft).to_be_visible(timeout=30000)
    expect(draft.get_by_text('建议补充已有笔记', exact=True)).to_be_visible()
    expect(draft.get_by_text('重复内容', exact=True)).to_be_visible()
    assert material(target['id'])['content'] == target['content']
    draft.get_by_role('radio', name='另存为新笔记', exact=True).check()
    expect(draft.get_by_label('笔记正文', exact=True)).to_be_visible()
    draft.get_by_role('radio', name='补充已有笔记', exact=True).check()
    addition = draft.get_by_label('本次新增正文', exact=True)
    addition.fill(addition.input_value() + '\n\n人工核对：保留预算与停止条件。')
    draft.get_by_text('查看已有笔记原文', exact=True).click()
    expect(draft.get_by_role('region', name='已有知识对比', exact=True).locator('pre')).to_be_visible()
    page.screenshot(path=str(out / (prefix + '-desktop.png')), animations='disabled')
    draft.get_by_role('button', name='保存草稿', exact=True).click()
    expect(page.get_by_text('草稿已保存，正式知识笔记尚未修改', exact=True)).to_be_visible()
    draft.get_by_role('button', name='关闭弹窗', exact=True).click()
    overview = page.request.get(api + '/knowledge').json()
    parent = next(j for j in overview['jobs'] if j['id'] == parent['id'])
    child_id = parent['children'][0]['jobId']
    open_job('Agent可靠性实践')
    expect(draft.get_by_label('本次新增正文', exact=True)).to_contain_text('人工核对')
    page.set_viewport_size({'width': 390, 'height': 844})
    page.emulate_media(color_scheme='dark')
    draft.evaluate('(el) => el.scrollTop = 0')
    assert draft.evaluate('(el) => el.scrollWidth <= el.clientWidth')
    page.screenshot(path=str(out / (prefix + '-mobile-dark.png')), animations='disabled', full_page=True)
    assert material(target['id'])['revision'] == 1
    draft.get_by_role('button', name='确认补充已有笔记', exact=True).click()
    expect(draft).to_have_count(0)
    saved = material(target['id'])
    assert saved['revision'] == 2 and saved['content'].startswith(target['content'])
    assert saved['segments'][:len(target['segments'])] == target['segments']
    assert set(c['materialId'] for c in saved['citations']) == {old['id'], *(s['id'] for s in sources)}
    assert page.request.get(api + '/stats').json()['notes'] == baseline_notes
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.emulate_media(color_scheme='light')

    separate = capture('增量另存来源', '来源核验与新的适用情境。')
    post('/knowledge/jobs', {'sourceIds': [separate['id']], 'topic': '增量另存验证', 'mode': 'compose'})
    open_job('增量另存验证')
    expect(draft.get_by_role('radio', name='补充已有笔记', exact=True)).to_be_checked(timeout=30000)
    draft.get_by_role('radio', name='另存为新笔记', exact=True).check()
    draft.get_by_label('笔记标题', exact=True).fill('增量对比后独立笔记')
    draft.get_by_role('button', name='确认保存笔记', exact=True).click()
    expect(draft).to_have_count(0)
    assert page.request.get(api + '/stats').json()['notes'] == baseline_notes + 1
    assert material(target['id'])['revision'] == 2

    duplicate = capture('增量重复来源', 'Agent仍然需要保留证据与来源。')
    post('/knowledge/jobs', {'sourceIds': [duplicate['id']], 'topic': '增量重复验证', 'mode': 'compose'})
    open_job('增量重复验证')
    expect(draft.get_by_role('button', name='确认仅关联来源', exact=True)).to_be_visible(timeout=30000)
    draft.get_by_role('button', name='确认仅关联来源', exact=True).click()
    expect(draft).to_have_count(0)
    linked = material(target['id'])
    assert linked['revision'] == 3 and linked['content'] == saved['content']
    assert duplicate['id'] in [c['materialId'] for c in linked['citations']]

    pending = capture('增量后续Agent来源', 'Agent更新也需要审核与适用条件。')
    waiting = post('/knowledge/jobs', {'sourceIds': [pending['id']], 'topic': '增量重启保留草稿', 'mode': 'compose'})
    open_job('增量重启保留草稿')
    addition = draft.get_by_label('本次新增正文', exact=True)
    expect(addition).to_be_visible(timeout=30000)
    addition.fill(addition.input_value() + '\n重启保留审核意见。')
    draft.get_by_role('button', name='保存草稿', exact=True).click()
    expect(page.get_by_text('草稿已保存，正式知识笔记尚未修改', exact=True)).to_be_visible()
    assert not errors, errors
    result_path.write_text(json.dumps({'passed': True, 'noteId': target['id'], 'sourceIds': [s['id'] for s in sources], 'childId': child_id, 'waitingId': waiting['id'], 'body': linked['content'], 'originalSegments': target['segments'], 'errors': errors, 'verified': ['smart-group child matches an existing note', 'comparison and old-body preview', 'append/new switch and draft persistence', 'no note changes before confirmation', 'append retains ID and old paragraph citations', 'new note alternative', 'duplicate only links sources', 'mobile dark layout']}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: smart grouping plus incremental append, new-note alternative and duplicate-source linking.')
