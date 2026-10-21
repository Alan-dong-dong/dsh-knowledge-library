"""Permanently clear only the explicitly isolated test library."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ['LIBRARY_TEST_URL']
api = base + '/knowledge-library/api'
out = Path('test-results')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto(base)
    page.wait_for_load_state('networkidle')
    (out / 'empty-trash-initial-dom.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
    root = page.request.get(api + '/settings').json()['root']
    assert Path(root).resolve() == Path(os.environ['KNOWLEDGE_LIBRARY_ROOT']).resolve()
    headers = {'X-Knowledge-Library': '1'}
    def capture(title, content):
        response = page.request.post(api + '/capture', headers=headers, data={'type': 'text', 'title': title, 'content': content})
        assert response.ok, response.text()
        return response.json()['material']
    def trash(item):
        response = page.request.delete(api + '/materials/' + item['id'], headers=headers, data={'expectedRoot': root})
        assert response.ok, response.text()
    source = capture('永久清空文本验证', '将永久移除的来源正文。\n\n引用段落仍然可在笔记中被标记为已删除。')
    attachment_response = page.request.post(api + '/upload', headers=headers, data={'name': '永久清空附件.md', 'base64': '5Y6f5aeL6ZmE5Lu2', 'title': '永久清空附件验证'})
    assert attachment_response.ok, attachment_response.text()
    attachment = attachment_response.json()['material']
    keep = capture('清空后保留的活动资料', '这份活动资料不可被清空回收站影响。')
    note_response = page.request.post(api + '/notes', headers=headers, data={'title': '清空后保留的笔记', 'content': '这份笔记正文应始终保留。', 'citations': [{'materialId': source['id'], 'segmentId': 'p0001'}], 'category': '知识笔记'})
    assert note_response.ok, note_response.text()
    note = note_response.json()['material']
    trash(source); trash(attachment)
    page.reload()
    page.wait_for_load_state('networkidle')
    nav = page.get_by_role('navigation', name='资料导航')
    nav.get_by_role('button', name='回收站', exact=True).click()
    listing = page.get_by_role('region', name='资料列表')
    expect(listing.get_by_role('heading', name=source['title'], exact=True)).to_be_visible()
    page.get_by_label('搜索资料').fill('永久清空文本验证')
    page.get_by_label('按类型筛选').select_option('text')
    expect(listing.get_by_role('heading')).to_have_count(1)
    clear = page.get_by_role('button', name='清空回收站', exact=True)
    clear.click()
    dialog = page.get_by_role('dialog', name='清空回收站', exact=True)
    expect(dialog.get_by_text('将永久删除回收站中的全部 2 份资料。', exact=True)).to_be_visible()
    page.screenshot(path=str(out / 'empty-trash-confirm.png'), animations='disabled')
    dialog.get_by_role('button', name='取消', exact=True).click()
    assert Path(source['path']).exists() and Path(attachment['path']).exists()
    # A real concurrent restore invalidates the confirmation without deleting anything.
    clear.click()
    expect(dialog.get_by_role('button', name='永久清空', exact=True)).to_be_enabled()
    assert page.request.post(api + '/materials/' + source['id'] + '/restore', headers=headers, data={'expectedRoot': root}).ok
    dialog.get_by_role('button', name='永久清空', exact=True).click()
    expect(dialog.get_by_role('alert')).to_contain_text('回收站内容已改变')
    expect(dialog.get_by_role('button', name='永久清空', exact=True)).to_be_disabled()
    assert Path(source['path']).exists() and Path(attachment['path']).exists()
    dialog.get_by_role('button', name='取消', exact=True).click()
    trash(source)
    clear.click()
    expect(dialog.get_by_text('将永久删除回收站中的全部 2 份资料。', exact=True)).to_be_visible()
    dialog.get_by_role('button', name='永久清空', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(listing.get_by_role('heading', name=source['title'], exact=True)).to_have_count(0)
    expect(clear).to_be_disabled()
    assert not Path(source['path']).exists() and not Path(attachment['path']).exists()
    assert page.request.get(api + '/materials/' + keep['id']).ok
    page.get_by_label('搜索资料').fill('')
    page.get_by_label('按类型筛选').select_option('')
    nav.get_by_role('button', name='知识笔记', exact=True).click()
    listing.get_by_role('heading', name=note['title'], exact=True).click()
    detail = page.get_by_role('region', name='资料详情')
    expect(detail.get_by_text('来源已永久删除', exact=True)).to_be_visible()
    expect(detail.get_by_role('button', name='查看引用 1', exact=True)).to_be_disabled()
    assert '来源已永久删除' in page.request.get(api + '/materials/' + note['id'] + '/export').text()
    page.screenshot(path=str(out / 'empty-trash-missing-source.png'), animations='disabled')
    mobile = capture('手机清空验证', '手机上确认清空回收站的测试资料。')
    trash(mobile)
    page.reload()
    page.set_viewport_size({'width': 390, 'height': 844})
    page.emulate_media(color_scheme='dark')
    nav.get_by_role('button', name='回收站', exact=True).click()
    clear.click()
    expect(dialog.get_by_text('将永久删除回收站中的全部 1 份资料。', exact=True)).to_be_visible()
    assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth')
    assert page.evaluate('document.documentElement.scrollWidth <= window.innerWidth')
    page.screenshot(path=str(out / 'empty-trash-mobile-dark.png'), full_page=True, animations='disabled')
    dialog.get_by_role('button', name='永久清空', exact=True).click()
    expect(dialog).to_have_count(0)
    expect(clear).to_be_disabled()
    assert not Path(mobile['path']).exists()
    # A new frontend over an older backend must ask for restart, not offer a broken action.
    def old_stats(route):
        response = route.fetch()
        data = response.json()
        data.pop('canEmptyTrash', None)
        route.fulfill(json=data)
    page.route('**/knowledge-library/api/stats', old_stats)
    page.reload()
    nav.get_by_role('button', name='回收站', exact=True).click()
    expect(page.get_by_text('请重启资料库服务以启用清空回收站。', exact=True)).to_be_visible()
    expect(clear).to_be_disabled()
    page.unroute('**/knowledge-library/api/stats', old_stats)
    assert not errors, errors
    (out / 'empty-trash-result.json').write_text(json.dumps({'passed': True, 'purgedIds': [source['id'], attachment['id'], mobile['id']], 'retainedIds': [keep['id'], note['id']], 'errors': errors, 'verified': ['all-trash scope despite search/type filter', 'cancel keeps files', 'changed snapshot blocks deletion', 'real files and index removed', 'active material and note retained', 'missing-source marker and export', 'mobile dark confirmation', 'empty button disabled', 'old backend restart message']}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: confirmed permanent clear, cancellation, stale scope, retained notes, mobile and old-service behavior.')
