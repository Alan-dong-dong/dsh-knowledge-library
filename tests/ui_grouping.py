"""Heterogeneous sources -> editable grouping -> classified sources and separate drafts."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('DSH_TEST_URL') or os.environ['LIBRARY_TEST_URL']
origin = '/'.join(base.split('/')[:3])
api = origin + '/knowledge-library/api'
native = bool(os.environ.get('DSH_TEST_URL'))
out = Path('test-results')
prefix = 'grouping-dsh' if native else 'grouping'
result_file = out / (prefix + '-result.json')

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
    assert '.test-runtime' in str(Path(root).resolve()), 'Refuse writes outside isolated test runtime'
    headers = {'X-Knowledge-Library': '1'}

    def post(path, data):
        response = page.request.post(api + path, headers=headers, data={'expectedRoot': root, **data})
        assert response.ok, response.text()
        return response.json()

    def capture(title, content):
        return post('/capture', {'type': 'text', 'title': title, 'content': content, 'tags': ['保留标签']})['material']

    if os.environ.get('KNOWLEDGE_UI_RESTART'):
        result = json.loads(result_file.read_text(encoding='utf-8'))
        overview = page.request.get(api + '/knowledge').json()
        parent = next(j for j in overview['jobs'] if j['id'] == result['parentId'])
        waiting = next(j for j in overview['jobs'] if j['id'] == result['waitingPlanId'])
        assert len(parent['children']) == 3 and waiting['status'] == 'grouping'
        assert len(waiting['analyses']) == 2
        assert overview['states'][result['sourceIds'][0]]['status'] == 'completed'
        assert overview['states'][result['unassignedId']]['status'] == 'pending'
        note = page.request.get(api + '/materials/' + result['noteId']).json()
        assert set(c['materialId'] for c in note['citations']) == set(result['sourceIds'][:2])
        page.get_by_role('button', name='知识整理', exact=True).click()
        page.get_by_role('dialog', name='知识整理', exact=True).get_by_role('button').filter(has_text='重启智能分组方案').click()
        expect(page.get_by_role('dialog', name='确认智能分组', exact=True)).to_be_visible()
        result['restartVerified'] = True
        result_file.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
        print('PASS: grouping plans, analysis, classified sources and independent notes survive real restart.')
        raise SystemExit(0)

    sources = [
        capture('智能Agent证据', 'Agent可靠性需要保留工具执行证据，并核验结果。'),
        capture('智能Agent恢复', 'Agent失败恢复应有停止条件，适用于多步骤任务。'),
        capture('智能理财笔记', '理财产品需要与风险承受能力、资金期限匹配。'),
        capture('智能食谱教程', '做菜前准备食材，按火候和时间逐步烹饪。'),
        capture('智能孤立片段', '只有一个孤立片段，缺少理解上下文。'),
    ]
    baseline_notes = page.request.get(api + '/stats').json()['notes']
    page.reload()
    if native:
        page.get_by_role('button', name='资料库', exact=True).click()
    page.get_by_role('button', name='智能整理', exact=True).click()
    for source in sources:
        page.get_by_label('选择 ' + source['title'], exact=True).check()
    page.get_by_role('button', name='智能分析分组', exact=True).click()
    start = page.get_by_role('dialog', name='智能整理', exact=True)
    expect(start.get_by_role('radio', name='智能分组', exact=False)).to_be_checked()
    start.get_by_label('整理主题', exact=True).fill('零散资料智能测试')
    start.get_by_role('button', name='开始分析分组', exact=True).click()
    plan = page.get_by_role('dialog', name='确认智能分组', exact=True)
    expect(plan).to_be_visible(timeout=30000)
    expect(plan.get_by_text('3 个分组', exact=True)).to_be_visible()
    expect(plan.get_by_text('1 份待整理', exact=True)).to_be_visible()
    overview = page.request.get(api + '/knowledge').json()
    parent = next(j for j in overview['jobs'] if j.get('topic') == '零散资料智能测试')
    assert len(parent['analyses']) == 5
    for source in sources:
        current = page.request.get(api + '/materials/' + source['id']).json()
        assert current['path'] == source['path'] and current['tags'] == ['保留标签']
        assert Path(source['path']).exists()
    page.screenshot(path=str(out / (prefix + '-plan-desktop.png')), animations='disabled')
    ai_index, ai_group = next((index + 1, group) for index, group in enumerate(parent['plan']['groups']) if group['category'] == '技术/AI')
    plan.get_by_label(f'分组名称 {ai_index}', exact=True).fill('可靠性专题')
    region = plan.get_by_role('region', name=f'分组 {ai_index}', exact=True)
    region.locator('summary').click()
    plan.get_by_label(f'来源分类 {ai_index}', exact=True).fill('技术/Agent可靠性')
    plan.get_by_label(f'分组标签 {ai_index}', exact=True).fill('实践，验证')
    # Deliberate membership adjustment, then split the unrelated finance source again.
    finance = plan.get_by_label('所属分组 ' + sources[2]['title'], exact=True)
    finance.select_option(ai_group['id'])
    finance.select_option('__new__')
    plan.get_by_role('checkbox', name='同步来源分类和标签', exact=True).uncheck()
    plan.get_by_role('button', name='保存分组方案', exact=True).click()
    expect(page.get_by_text('分组方案已保存，来源分类尚未修改', exact=True)).to_be_visible()
    plan.get_by_role('button', name='关闭弹窗', exact=True).click()
    page.get_by_role('button', name='知识整理', exact=True).click()
    page.get_by_role('dialog', name='知识整理', exact=True).get_by_role('button').filter(has_text='零散资料智能测试').click()
    expect(plan.get_by_role('checkbox', name='同步来源分类和标签', exact=True)).not_to_be_checked()
    for source in sources:
        assert page.request.get(api + '/materials/' + source['id']).json()['path'] == source['path']
    plan.get_by_role('checkbox', name='同步来源分类和标签', exact=True).check()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.emulate_media(color_scheme='dark')
    plan.evaluate('(el) => el.scrollTop = 0')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert plan.evaluate('(el) => el.scrollWidth <= el.clientWidth')
    page.screenshot(path=str(out / (prefix + '-plan-mobile-dark.png')), animations='disabled', full_page=True)
    plan.get_by_role('button', name='确认归类并生成 3 份草稿', exact=True).click()
    expect(plan).to_have_count(0)
    tasks = page.get_by_role('dialog', name='知识整理', exact=True)
    expect(tasks.get_by_text('保留待整理', exact=True)).to_be_visible()
    assert page.request.get(api + '/stats').json()['notes'] == baseline_notes
    for source in sources[:2]:
        current = page.request.get(api + '/materials/' + source['id']).json()
        assert current['category'] == '技术/Agent可靠性'
        assert current['content'] == source['content'] and Path(current['path']).exists()
        assert set(['保留标签', '实践', '验证']).issubset(current['tags'])
    assert page.request.get(api + '/materials/' + sources[4]['id']).json()['category'] == '收件箱'
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.emulate_media(color_scheme='light')
    tasks.get_by_role('button').filter(has_text='可靠性专题').click()
    draft = page.get_by_role('dialog', name='确认知识笔记', exact=True)
    expect(draft).to_be_visible(timeout=30000)
    expect(draft.get_by_text('2 条来源引用', exact=True)).to_be_visible()
    draft.get_by_label('笔记标题', exact=True).fill('智能分组后的Agent知识')
    draft.get_by_role('button', name='确认保存笔记', exact=True).click()
    expect(draft).to_have_count(0)
    overview = page.request.get(api + '/knowledge').json()
    parent = next(j for j in overview['jobs'] if j['id'] == parent['id'])
    assert len(parent['children']) == 3
    note_id = overview['states'][sources[0]['id']]['noteIds'][0]
    note = page.request.get(api + '/materials/' + note_id).json()
    assert set(c['materialId'] for c in note['citations']) == set(s['id'] for s in sources[:2])
    assert overview['states'][sources[4]['id']]['status'] == 'pending'
    pending_sources = [capture('重启智能来源A', '独立保留分组建议供后续确认。'), capture('重启智能来源B', '另一份资料也应保留逐篇分析。')]
    waiting = post('/knowledge/jobs', {'sourceIds': [s['id'] for s in pending_sources], 'topic': '重启智能分组方案', 'mode': 'smart'})
    page.get_by_role('button', name='知识整理', exact=True).click()
    tasks.get_by_role('button').filter(has_text='重启智能分组方案').click()
    expect(plan).to_be_visible(timeout=30000)
    assert not errors, errors
    result_file.write_text(json.dumps({'passed': True, 'parentId': parent['id'], 'waitingPlanId': waiting['id'], 'noteId': note_id, 'sourceIds': [s['id'] for s in sources], 'unassignedId': sources[4]['id'], 'errors': errors, 'verified': ['individual analysis of unrelated sources', 'three distinct groups and pending uncertain source', 'plan edit and membership split', 'classification checkbox persists', 'no folder/tag changes before confirmation', 'confirmed folders and tags with original text retained', 'three independent child drafts', 'note cites only its related group', 'unassigned remains pending', 'desktop and mobile dark grouping UI']}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: heterogeneous smart analysis, editable grouping, confirmed classification and independent notes.')
