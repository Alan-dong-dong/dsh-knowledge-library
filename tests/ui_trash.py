"""Deletion, cancellation, errors and recovery against the isolated preview."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ['LIBRARY_TEST_URL']
api = base + '/knowledge-library/api'
out = Path('test-results')
title = '收件箱删除验证'
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.emulate_media(color_scheme='light')
    page.goto(base)
    page.wait_for_load_state('networkidle')
    (out / 'trash-initial-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
    page.get_by_role('button', name='收集资料', exact=True).click()
    dialog = page.get_by_role('dialog')
    dialog.get_by_role('tab', name='文本摘录').click()
    dialog.get_by_label('标题').fill(title)
    dialog.get_by_label('正文', exact=True).fill('删除后保留原始正文与段落标识。\n\n恢复后仍然可以按原分类和来源继续整理。')
    dialog.get_by_role('button', name='保存资料', exact=True).click()
    detail = page.get_by_role('region', name='资料详情')
    expect(detail.get_by_role('heading', name=title, exact=True)).to_be_visible()
    expect(detail.get_by_role('button', name='删除资料', exact=True)).to_be_visible()
    item = page.request.get(api + '/materials?query=' + title).json()['items'][0]
    material_id = item['id']
    root = page.request.get(api + '/settings').json()['root']
    before = page.request.get(api + '/stats').json()['total']
    page.get_by_role('button', name='关闭阅读', exact=True).click()
    nav = page.get_by_role('navigation', name='资料导航')
    nav.get_by_role('button', name='收件箱', exact=True).click()
    listing = page.get_by_role('region', name='资料列表')
    remove = listing.get_by_role('button', name='删除 ' + title, exact=True)
    remove.click()
    dialog = page.get_by_role('dialog', name='删除资料', exact=True)
    expect(dialog.get_by_text(title, exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'trash-confirm-desktop.png'), animations='disabled')
    dialog.get_by_role('button', name='取消', exact=True).click()
    expect(remove).to_be_focused()
    assert page.request.get(api + '/stats').json()['total'] == before

    # An API failure leaves the dialog and real material intact.
    route_pattern = '**/knowledge-library/api/materials/' + material_id
    def fail_delete(route):
        if route.request.method == 'DELETE':
            route.fulfill(status=400, content_type='application/json', body=json.dumps({'error': '模拟删除失败'}))
        else:
            route.continue_()
    page.route(route_pattern, fail_delete)
    remove.click()
    dialog.get_by_role('button', name='移入回收站', exact=True).click()
    expect(dialog.get_by_role('alert')).to_have_text('模拟删除失败')
    assert page.request.get(api + '/stats').json()['total'] == before
    dialog.get_by_role('button', name='取消', exact=True).click()
    page.unroute(route_pattern, fail_delete)

    remove.click()
    dialog.get_by_role('button', name='移入回收站', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(listing.get_by_role('heading', name=title, exact=True)).to_have_count(0)
    assert page.request.get(api + '/stats').json()['total'] == before - 1
    assert page.request.get(api + '/materials?query=' + title).json()['total'] == 0
    nav.get_by_role('button', name='回收站', exact=True).click()
    expect(listing.get_by_role('heading', name=title, exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'trash-list-desktop.png'), animations='disabled')
    listing.get_by_role('heading', name=title, exact=True).click()
    expect(detail.get_by_text('这份资料在回收站', exact=True)).to_be_visible()
    expect(detail.get_by_role('button', name='编辑信息', exact=True)).to_have_count(0)
    detail.get_by_role('button', name='恢复资料', exact=True).click()
    expect(listing.get_by_role('heading', name=title, exact=True)).to_have_count(0)
    nav.get_by_role('button', name='收件箱', exact=True).click()
    expect(listing.get_by_role('heading', name=title, exact=True)).to_be_visible()

    # The detail action supports both Escape cancellation and confirmed deletion.
    listing.get_by_role('heading', name=title, exact=True).click()
    detail.get_by_role('button', name='删除资料', exact=True).click()
    page.keyboard.press('Escape')
    expect(dialog).to_have_count(0)
    assert page.request.get(api + '/stats').json()['total'] == before
    detail.get_by_role('button', name='删除资料', exact=True).click()
    dialog.get_by_role('button', name='移入回收站', exact=True).click()
    expect(dialog).to_have_count(0)
    nav.get_by_role('button', name='回收站', exact=True).click()
    expect(listing.get_by_role('heading', name=title, exact=True)).to_be_visible()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=str(out / 'trash-mobile-dark.png'), full_page=True, animations='disabled')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    listing.get_by_role('button', name='恢复 ' + title, exact=True).click()
    expect(listing.get_by_role('heading', name=title, exact=True)).to_have_count(0)
    nav.get_by_role('button', name='收件箱', exact=True).click()
    listing.get_by_role('button', name='删除 ' + title, exact=True).click()
    expect(dialog).to_be_visible()
    page.screenshot(path=str(out / 'trash-confirm-mobile.png'), full_page=True, animations='disabled')
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth')
    dialog.get_by_role('button', name='取消', exact=True).click()
    assert 'deletedAt' not in page.request.get(api + '/materials/' + material_id).json()

    # Leave one known trashed item for a separate browser after process restart.
    created = page.request.post(api + '/capture', headers={'X-Knowledge-Library': '1'}, data={'type': 'text', 'title': '回收站重启验证', 'content': '删除状态应在进程重启和索引重建之后继续保留。'}).json()['material']
    assert page.request.delete(api + '/materials/' + created['id'], headers={'X-Knowledge-Library': '1'}, data={'expectedRoot': root}).ok
    assert not errors, errors
    result = {'passed': True, 'errors': errors, 'restartId': created['id'], 'verified': ['list and detail delete', 'cancel and Escape preserve data', 'delete failure preserves data', 'inbox/search/stats hide trashed items', 'trash viewing and detail restore', 'mobile dark list restore', 'mobile confirmation layout']}
    (out / 'trash-ui-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: trash confirmation, cancellation, failure recovery, deletion and restoration on desktop/mobile.')
