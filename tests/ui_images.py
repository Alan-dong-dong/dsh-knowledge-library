"""Actual capture/settings/retry/citation UI, local PNG transport and local vision only."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ.get('DSH_TEST_URL') or os.environ['LIBRARY_TEST_URL']
origin = '/'.join(base.split('/')[:3])
api = origin + '/knowledge-library/api'
native = bool(os.environ.get('DSH_TEST_URL'))
out = Path('test-results')
out.mkdir(exist_ok=True)
prefix = 'images-dsh' if native else 'images-preview'
result_path = out / (prefix + '.json')
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
    root = page.request.get(api + '/settings').json()['root']
    assert '.test-runtime' in str(Path(root).resolve())
    if os.environ.get('KNOWLEDGE_UI_RESTART'):
        result = json.loads(result_path.read_text(encoding='utf-8'))
        source = page.request.get(api + '/materials/' + result['sourceId']).json()
        assert all(image['status'] == 'completed' for image in source['images'])
        assert source['images'][0]['segmentId'] == result['segmentId']
        assert page.request.get(api + '/settings/images').json()['enabled']
        assert page.request.get(api + '/materials/' + result['noteId']).ok
        assert page.request.get(api + '/materials?query=识别率').json()['total'] >= 1
        result['restartVerified'] = True
        result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        browser.close()
        print('PASS: image originals, OCR citations and settings survive process restart.')
        raise SystemExit(0)
    assert not page.request.get(api + '/settings/images').json()['enabled']
    page.get_by_role('button', name='资料库设置', exact=True).click()
    settings = page.get_by_role('dialog', name='你的资料，由你保管')
    option = settings.get_by_role('checkbox', name='采集网页时自动识别正文图片', exact=True)
    expect(option).not_to_be_checked()
    option.check()
    settings.get_by_label('每页最多识别图片数').fill('2')
    save = settings.get_by_role('button', name='保存图片识别设置', exact=True)
    expect(save).to_be_disabled()
    settings.get_by_role('checkbox', name='确认使用', exact=False).check()
    save.click()
    expect(settings.get_by_text('已保存，对后续网页采集生效；已有资料可保留原样。', exact=True)).to_be_visible()
    page.screenshot(path=str(out / (prefix + '-settings.png')), animations='disabled')
    settings.get_by_role('button', name='关闭弹窗', exact=True).click()
    page.get_by_role('button', name='收集资料', exact=True).click()
    capture = page.get_by_role('dialog', name='收集一份资料')
    expect(capture.get_by_text('图片识别已开启：', exact=False)).to_be_visible()
    capture.get_by_label('网页地址').fill('https://dsh-image-fixture.example/article')
    capture.get_by_role('button', name='开始采集', exact=True).click()
    jobs = page.get_by_role('dialog', name='采集任务', exact=True)
    expect(jobs.get_by_text('图片：1 张已识别 · 1 张未完成 · 0 张跳过', exact=True)).to_be_visible(timeout=30000)
    job = page.request.get(api + '/jobs').json()[0]
    jobs.get_by_role('button', name='查看资料', exact=False).click()
    detail = page.get_by_role('region', name='资料详情')
    expect(detail.get_by_text('图中数据：识别率98%', exact=False)).to_be_visible()
    detail.get_by_role('button', name='重试失败图片', exact=True).click()
    retry = page.get_by_role('dialog', name='重试失败图片', exact=True)
    expect(retry.get_by_text('已成功图片不会重复识别。', exact=False)).to_be_visible()
    retry.get_by_role('button', name='取消', exact=True).click()
    detail.get_by_role('button', name='重试失败图片', exact=True).click()
    retry.get_by_role('button', name='确认重试 1 张图片', exact=True).click()
    expect(detail.get_by_text('图片 2 · 已识别', exact=True)).to_be_visible(timeout=30000)
    source = page.request.get(api + '/materials/' + job['materialId']).json()
    assert [image['attempts'] for image in source['images']] == [1, 2]
    image_id = source['images'][0]['id']
    original = page.request.get(api + '/materials/' + source['id'] + '/images/' + image_id)
    assert original.ok and original.headers['content-type'] == 'image/png'
    expect(detail.get_by_role('img').first).to_be_visible()
    assert detail.get_by_role('img').first.evaluate('(img) => img.complete && img.naturalWidth > 0')
    detail.get_by_role('button', name='查看识别文字', exact=True).first.click()
    expect(detail.locator('.kl-cited')).to_be_visible()
    page.screenshot(path=str(out / (prefix + '-detail.png')), animations='disabled')
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=str(out / (prefix + '-dark.png')), animations='disabled')
    page.set_viewport_size({'width': 430, 'height': 900})
    page.screenshot(path=str(out / (prefix + '-mobile.png')), animations='disabled')
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.set_viewport_size({'width': 1440, 'height': 1000})
    detail.get_by_role('button', name='生成知识笔记', exact=True).click()
    start = page.get_by_role('dialog', name='生成知识笔记', exact=True)
    start.get_by_role('button', name='开始整理', exact=True).click()
    confirm = page.get_by_role('dialog', name='确认知识笔记', exact=True)
    expect(confirm).to_be_visible(timeout=30000)
    expect(confirm.get_by_label('笔记正文')).to_have_value(__import__('re').compile(r'v_[a-f0-9]+_1'))
    confirm.get_by_role('button', name='确认保存笔记', exact=True).click()
    expect(confirm).to_have_count(0)
    notes = page.request.get(api + '/materials?kind=note').json()['items']
    assert any(c['segmentId'].startswith('v_') for c in notes[0]['citations'])
    assert not errors, errors
    result_path.write_text(json.dumps({'sourceId': source['id'], 'segmentId': source['images'][0]['segmentId'], 'noteId': notes[0]['id'], 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: opt-in, automatic webpage images, native/inline vision, original preview, explicit retry, responsive UI and OCR knowledge citations.')
