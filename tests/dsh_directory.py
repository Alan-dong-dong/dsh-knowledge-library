"""Exercise directory selection and persistent config edits in an isolated DSH Web host."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

url = os.environ['DSH_TEST_URL']
base = Path(os.environ['DSH_DIRECTORY_BASE']).resolve()
target = base / 'chosen-library'
target.mkdir(parents=True, exist_ok=True)
out = Path('test-results')
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(base_url=url, viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    onboarding = page.get_by_text('开始使用', exact=True)
    page.add_locator_handler(onboarding, lambda: page.get_by_role('presentation').filter(has=onboarding).get_by_role('button').first.click())
    page.add_locator_handler(page.get_by_text('预览版说明', exact=True), lambda: page.get_by_role('button', name='继续', exact=True).click())
    page.goto(url)
    if page.get_by_text('预览版说明', exact=True).is_visible():
        page.get_by_role('button', name='继续', exact=True).click()
    page.get_by_role('button', name='资料库', exact=True).click(timeout=30000)
    expect(page.get_by_role('heading', name='全部资料', exact=True)).to_be_visible()
    api = '/knowledge-library/api'
    def stats():
        result = page.request.get(api + '/stats')
        assert result.ok, (result.status, result.text())
        return result.json()
    def save(title):
        result = page.request.post(api + '/capture', headers={'X-Knowledge-Library': '1'}, data={'type': 'text', 'content': title + '正文', 'title': title})
        assert result.ok, result.text()
        return result.json()['material']['id']
    def settings():
        page.get_by_role('button', name='资料库设置', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('button', name='选择目录', exact=True)).to_be_enabled()
        return dialog
    try:
        if os.environ.get('DSH_DIRECTORY_RESTART') == '1':
            assert Path(stats()['root']) == target
            result = page.request.get(api + '/materials?query=新库验证').json()
            assert result['total'] == 1
            assert page.request.get(api + '/settings').json()['allowProxyFakeIp'] is True
            print('PASS: selected library and saved materials survive full host restart.')
        else:
            initial = stats()['root']
            saved = save('旧库验证')
            dialog = settings()
            expect(dialog.get_by_label('资料库目录', exact=True)).to_have_value(initial)
            # Browsing cancellation must leave both the config and draft untouched.
            dialog.get_by_role('button', name='选择目录', exact=True).click()
            expect(dialog.get_by_role('button', name='选择此目录', exact=True)).to_be_enabled()
            dialog.get_by_role('button', name='取消选择', exact=True).click()
            expect(dialog.get_by_label('资料库目录', exact=True)).to_have_value(initial)
            assert stats()['root'] == initial
            # Navigate through actual host listing data, then cancel the proposed edit.
            def choose():
                dialog.get_by_role('button', name='选择目录', exact=True).click()
                dialog.get_by_label('浏览目录路径').fill(str(base))
                dialog.get_by_role('button', name='前往', exact=True).click()
                dialog.get_by_role('button', name='chosen-library', exact=True).click()
                expect(dialog.get_by_role('button', name='选择此目录', exact=True)).to_be_enabled()
                page.screenshot(path=str(out / 'directory-browser.png'), animations='disabled')
                dialog.get_by_role('button', name='选择此目录', exact=True).click()
            choose()
            expect(dialog.get_by_label('资料库目录', exact=True)).to_have_value(str(target))
            expect(dialog.get_by_text('原目录的资料会保留', exact=False)).to_be_visible()
            dialog.get_by_role('button', name='取消修改', exact=True).click()
            expect(dialog.get_by_label('资料库目录', exact=True)).to_have_value(initial)
            # Preflight failure must keep the current library online.
            blocked = base / 'not-a-directory'
            blocked.write_text('file', encoding='utf-8')
            dialog.get_by_label('资料库目录', exact=True).fill(str(blocked))
            with page.expect_response(lambda r: r.url.endswith('/settings/root')) as response:
                dialog.get_by_role('button', name='切换资料库', exact=True).click()
            assert response.value.status == 400
            expect(dialog.get_by_role('alert')).to_be_visible()
            assert stats()['root'] == initial
            # The host must also roll back a failure after preflight (invalid queue).
            broken = base / 'invalid-library'
            (broken / '.system').mkdir(parents=True, exist_ok=True)
            (broken / '.system' / 'jobs.json').write_text('not json', encoding='utf-8')
            dialog.get_by_label('资料库目录', exact=True).fill(str(broken))
            with page.expect_response(lambda r: r.url.endswith('/settings/root'), timeout=30000) as response:
                dialog.get_by_role('button', name='切换资料库', exact=True).click()
            assert response.value.status == 400
            expect(dialog.get_by_role('alert')).to_be_visible(timeout=30000)
            assert stats()['root'] == initial
            assert page.request.get(api + '/materials/' + saved).ok
            # Successful edit reloads tools and HTTP handlers onto the same new root.
            dialog.get_by_role('button', name='取消修改', exact=True).click()
            choose()
            page.screenshot(path=str(out / 'directory-confirm.png'), animations='disabled')
            with page.expect_response(lambda r: r.url.endswith('/settings/root'), timeout=30000) as response:
                dialog.get_by_role('button', name='切换资料库', exact=True).click()
            assert response.value.status == 200, response.value.text()
            expect(dialog.get_by_label('资料库目录', exact=True)).to_have_value(str(target), timeout=30000)
            assert Path(stats()['root']) == target
            assert stats()['total'] == 0
            assert list(Path(initial).glob('materials/**/' + saved + '/metadata.json'))
            assert not (Path(initial) / '.system' / 'writer.lock').exists()
            save('新库验证')
            page.reload()
            page.get_by_role('button', name='资料库', exact=True).click()
            expect(page.get_by_role('region', name='资料列表').get_by_role('heading', name='新库验证', exact=True)).to_be_visible()
            page.get_by_role('button', name='删除 新库验证', exact=True).click()
            page.get_by_role('dialog', name='删除资料', exact=True).get_by_role('button', name='移入回收站', exact=True).click()
            expect(page.get_by_role('region', name='资料列表').get_by_role('heading', name='新库验证', exact=True)).to_have_count(0)
            page.get_by_role('navigation', name='资料导航').get_by_role('button', name='回收站', exact=True).click()
            expect(page.get_by_role('region', name='资料列表').get_by_role('heading', name='新库验证', exact=True)).to_be_visible()
            page.screenshot(path=str(out / 'trash-dsh.png'), animations='disabled')
            page.get_by_role('button', name='恢复 新库验证', exact=True).click()
            expect(page.get_by_role('region', name='资料列表').get_by_role('heading', name='新库验证', exact=True)).to_have_count(0)
            page.get_by_role('navigation', name='资料导航').get_by_role('button', name='全部资料', exact=True).click()
            expect(page.get_by_role('region', name='资料列表').get_by_role('heading', name='新库验证', exact=True)).to_be_visible()
            settings()
            page.screenshot(path=str(out / 'directory-settings.png'), animations='disabled')
            page.emulate_media(color_scheme='dark')
            page.screenshot(path=str(out / 'directory-settings-dark.png'), animations='disabled')
            page.set_viewport_size({'width': 390, 'height': 844})
            expect(page.get_by_role('button', name='选择目录', exact=True)).to_be_visible()
            assert page.locator('[role=dialog]').evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
            page.screenshot(path=str(out / 'directory-settings-mobile.png'), animations='disabled')
            assert not errors, errors
            (out / 'directory-result.json').write_text(json.dumps({'passed': True, 'errors': errors, 'verified': ['host directory browsing', 'cancel selection and draft', 'invalid target rejection', 'host reload rollback', 'persistent switch', 'source preservation', 'theme and mobile layout']}, ensure_ascii=False, indent=2), encoding='utf-8')
            print('PASS: host directory browsing, cancellation, rollback, switch and source preservation.')
    finally:
        page.screenshot(path=str(out / 'directory-last.png'), animations='disabled')
        browser.close()
