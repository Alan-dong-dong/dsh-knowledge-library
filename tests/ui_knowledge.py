import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('DSH_TEST_URL') or os.environ['LIBRARY_TEST_URL']
origin = '/'.join(base.split('/')[:3])
api = origin + '/knowledge-library/api'
out = Path('test-results')
out.mkdir(exist_ok=True)
native = bool(os.environ.get('DSH_TEST_URL'))
result_path = out / ('knowledge-dsh-result.json' if native else 'knowledge-ui-result.json')
prefix = 'knowledge-dsh' if native else 'knowledge'

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
    if native:
        # Harness keeps a live event connection; application readiness is the sensor.
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

    if os.environ.get('KNOWLEDGE_UI_RESTART'):
        result = json.loads(result_path.read_text(encoding='utf-8'))
        overview = page.request.get(api + '/knowledge').json()
        assert overview['states'][result['sourceId']]['status'] == 'completed'
        assert result['noteId'] in overview['states'][result['sourceId']]['noteIds']
        assert page.request.get(api + '/materials/' + result['noteId']).ok
        assert page.request.get(api + '/materials/' + result['sourceId']).ok
        page.get_by_role('button', name='知识整理', exact=True).click()
        dialog = page.get_by_role('dialog', name='知识整理', exact=True)
        expect(dialog.get_by_text('重启保留草稿', exact=True)).to_be_visible()
        dialog.get_by_role('button').filter(has=page.get_by_text('重启保留草稿', exact=True)).click()
        confirm = page.get_by_role('dialog', name='确认知识笔记', exact=True)
        expect(confirm.get_by_label('笔记正文')).to_contain_text('核心观点')
        result['restartVerified'] = True
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
        print('PASS: knowledge notes, source state and unconfirmed drafts survive real restart.')
        raise SystemExit(0)

    source = post('/capture', {'type': 'text', 'title': '知识转化来源一', 'content': '资料是输入，知识是结合证据形成的理解。\n\n复用结论前应确认适用条件。'})['material']
    second = post('/capture', {'type': 'text', 'title': '知识转化来源二', 'content': '可靠的笔记应保留原文引用，区分事实和推断。'})['material']
    page.reload()
    if native:
        page.get_by_role('button', name='资料库', exact=True).click()
    listing = page.get_by_role('region', name='资料列表')
    listing.get_by_role('heading', name=source['title'], exact=True).click()
    detail = page.get_by_role('region', name='资料详情')
    expect(detail.get_by_text('待整理', exact=True)).to_be_visible()
    detail.get_by_role('button', name='生成知识笔记', exact=True).click()
    start = page.get_by_role('dialog', name='生成知识笔记', exact=True)
    expect(start.get_by_text('1 份来源资料', exact=True)).to_be_visible()
    start.get_by_role('button', name='取消', exact=True).click()
    assert not page.request.get(api + '/knowledge').json()['jobs']
    detail.get_by_role('button', name='生成知识笔记', exact=True).click()
    start.get_by_label('整理主题').fill('单篇知识转化')
    start.get_by_role('button', name='开始整理', exact=True).click()
    confirm = page.get_by_role('dialog', name='确认知识笔记', exact=True)
    expect(confirm).to_be_visible(timeout=30000)
    expect(confirm.get_by_label('笔记正文')).to_contain_text('核心观点')
    assert page.request.get(api + '/stats').json()['notes'] == 0
    confirm.get_by_label('笔记标题').fill('经核对的知识笔记')
    confirm.get_by_label('笔记分类').fill('知识笔记/实践')
    confirm.get_by_label('笔记正文').fill(confirm.get_by_label('笔记正文').input_value() + '\n\n我的判断：保留证据才能复用知识。')
    confirm.get_by_role('button', name='保存草稿', exact=True).click()
    expect(page.get_by_text('草稿已保存，正式知识笔记尚未修改', exact=True)).to_be_visible()
    page.screenshot(path=str(out / (prefix + '-draft-desktop.png')), animations='disabled')
    confirm.get_by_role('button', name='关闭弹窗', exact=True).click()
    detail.get_by_role('button', name='查看整理任务', exact=True).click()
    expect(confirm.get_by_label('笔记标题')).to_have_value('经核对的知识笔记')
    expect(confirm.get_by_label('笔记分类')).to_have_value('知识笔记/实践')
    confirm.get_by_role('button', name='确认保存笔记', exact=True).click()
    expect(confirm).to_have_count(0)
    expect(detail.get_by_role('heading', name='经核对的知识笔记', exact=True)).to_be_visible()
    expect(detail.get_by_text('我的判断：保留证据才能复用知识。', exact=True)).to_be_visible()
    assert Path(source['path']).exists()
    overview = page.request.get(api + '/knowledge').json()
    note_id = overview['states'][source['id']]['noteIds'][0]
    detail.get_by_role('button', name='查看引用 1', exact=True).click()
    expect(detail.get_by_role('heading', name=source['title'], exact=True)).to_be_visible()
    expect(detail.get_by_text('已整理', exact=True)).to_be_visible()
    expect(detail.get_by_role('button', name='查看知识笔记', exact=True)).to_be_visible()
    detail.get_by_role('button', name='关闭阅读', exact=True).click()
    page.get_by_role('button', name='智能整理', exact=True).click()
    page.get_by_label('选择 ' + source['title'], exact=True).check()
    page.get_by_label('选择 ' + second['title'], exact=True).check()
    page.get_by_role('button', name='智能分析分组', exact=True).click()
    page.get_by_role('dialog', name='智能整理', exact=True).get_by_role('radio', name='同主题直接综合', exact=False).check()
    expect(start.get_by_text('2 份来源资料', exact=True)).to_be_visible()
    start.get_by_label('整理主题').fill('多来源共识与差异')
    start.get_by_role('button', name='开始整理', exact=True).click()
    expect(confirm).to_be_visible(timeout=30000)
    expect(confirm.get_by_text('2 条来源引用', exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.emulate_media(color_scheme='dark')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    assert confirm.evaluate('(el) => el.scrollWidth <= el.clientWidth')
    page.screenshot(path=str(out / (prefix + '-draft-mobile-dark.png')), animations='disabled', full_page=True)
    confirm.get_by_role('button', name='舍弃草稿', exact=True).click()
    expect(page.get_by_role('dialog', name='知识整理', exact=True).get_by_text('已舍弃', exact=True)).to_be_visible()
    page.get_by_role('dialog').get_by_role('button', name='关闭弹窗', exact=True).click()
    page.set_viewport_size({'width': 1440, 'height': 1000})
    page.emulate_media(color_scheme='light')

    # Exercise actual provider failures and cancellation through the UI.
    listing.get_by_role('heading', name=second['title'], exact=True).click()
    detail.get_by_role('button', name='生成知识笔记', exact=True).click()
    start.get_by_label('整理主题').fill('故障验证')
    start.get_by_role('button', name='开始整理', exact=True).click()
    tasks = page.get_by_role('dialog', name='知识整理', exact=True)
    expect(tasks.get_by_role('alert')).to_be_visible(timeout=30000)
    expect(tasks.get_by_role('button', name='重新整理', exact=True)).to_be_visible()
    tasks.get_by_role('button', name='重新整理', exact=True).click()
    start.get_by_label('整理主题').fill('慢速验证')
    start.get_by_role('button', name='开始整理', exact=True).click()
    tasks.get_by_role('button', name='取消整理', exact=True).click()
    expect(tasks.get_by_text('已取消', exact=True).first).to_be_visible(timeout=10000)
    tasks.get_by_role('button', name='关闭弹窗', exact=True).click()

    # Leave one unconfirmed draft for a real process restart check.
    created = post('/knowledge/jobs', {'sourceIds': [second['id']], 'topic': '重启保留草稿'})
    page.get_by_role('button', name='知识整理', exact=True).click()
    tasks.get_by_role('button').filter(has_text='重启保留草稿').click()
    expect(confirm).to_be_visible(timeout=30000)
    # Missing-model and older-service responses must not offer a broken action.
    confirm.get_by_role('button', name='关闭弹窗', exact=True).click()
    def missing_model(route):
        response = route.fetch()
        value = response.json()
        value.update(available=False, reason='隔离测试：尚未配置模型')
        route.fulfill(json=value)
    page.route('**/knowledge-library/api/knowledge', missing_model)
    page.reload()
    if native:
        page.get_by_role('button', name='资料库', exact=True).click()
    listing.get_by_role('heading', name=source['title'], exact=True).click()
    detail.get_by_role('button', name='生成知识笔记', exact=True).click()
    expect(start.get_by_text('隔离测试：尚未配置模型', exact=True)).to_be_visible()
    expect(start.get_by_role('button', name='开始整理', exact=True)).to_be_disabled()
    start.get_by_role('button', name='取消', exact=True).click()
    page.unroute('**/knowledge-library/api/knowledge', missing_model)
    page.route('**/knowledge-library/api/knowledge', lambda route: route.fulfill(status=404, json={'error': '接口不存在'}))
    page.reload()
    if native:
        page.get_by_role('button', name='资料库', exact=True).click()
    expect(page.get_by_role('button', name='智能整理', exact=True)).to_be_disabled()
    listing.get_by_role('heading', name=source['title'], exact=True).click()
    expect(detail.get_by_text('请重启资料库服务以启用知识整理。', exact=True)).to_be_visible()
    page.unroute('**/knowledge-library/api/knowledge')
    result = {'passed': True, 'sourceId': source['id'], 'noteId': note_id, 'draftId': created['id'], 'errors': errors, 'verified': ['single generation', 'cancel before request', 'draft editing and save', 'category persistence', 'explicit confirm', 'source retained and citation jump', 'multi-source generation', 'mobile dark layout', 'discard draft', 'provider failure and manual retry', 'cancel running generation', 'missing-model disabled', 'older-service restart guidance']}
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    assert not errors, errors
    browser.close()
    print('PASS: source to draft to confirmed knowledge, batch, failure/cancel and responsive UI.')
