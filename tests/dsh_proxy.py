"""Verify manual proxy compatibility settings against a real isolated Harness profile."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

url = os.environ['DSH_TEST_URL']
out = Path('test-results')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(base_url=url, viewport={'width': 1440, 'height': 1000})
    errors = []
    page.on('pageerror', lambda error: errors.append(str(error)))
    # Only the job presentation is a fixture; saving settings uses real host APIs.
    job = {'id': 'job_proxy_fixture', 'url': 'https://example.com/', 'status': 'failed', 'createdAt': '2026-10-20T00:00:00Z', 'error': '检测到代理 fake-IP DNS。请启用代理兼容。'}
    page.route('**/knowledge-library/api/jobs', lambda route: route.fulfill(json=[job]))
    page.add_locator_handler(page.get_by_text('开始使用', exact=True), lambda: page.keyboard.press('Escape'))
    page.add_locator_handler(page.get_by_text('预览版说明', exact=True), lambda: page.get_by_role('button', name='继续', exact=True).click())
    page.goto(url)
    page.get_by_role('button', name='资料库', exact=True).click(timeout=30000)
    api = '/knowledge-library/api'
    def state():
        response = page.request.get(api + '/settings')
        assert response.ok, response.text()
        return response.json()
    def open_settings():
        page.get_by_role('button', name='资料库设置', exact=True).click()
        dialog = page.get_by_role('dialog')
        expect(dialog.get_by_role('checkbox')).to_be_enabled()
        return dialog
    def save(dialog, expected_status=200):
        with page.expect_response(lambda response: response.url.endswith('/settings/network'), timeout=30000) as response:
            dialog.get_by_role('button', name='保存采集设置', exact=True).click()
        assert response.value.status == expected_status, response.value.text()
    try:
        baseline = state()
        assert baseline['allowProxyFakeIp'] is False
        invalid = page.request.post(api + '/settings/network', headers={'X-Knowledge-Library': '1'}, data={'allowProxyFakeIp': 'true', 'expected': False, 'expectedRoot': baseline['root']})
        assert invalid.status == 400
        unmarked = page.request.post(api + '/settings/network', data={'allowProxyFakeIp': True, 'expected': False, 'expectedRoot': baseline['root']})
        assert unmarked.status == 403
        dialog = open_settings()
        expect(dialog.get_by_role('checkbox')).not_to_be_checked()
        dialog.get_by_role('checkbox').check()
        dialog.get_by_role('button', name='关闭弹窗', exact=True).click()
        assert state()['allowProxyFakeIp'] is False, 'draft must not enable proxy compatibility'
        page.get_by_role('button', name='采集任务', exact=True).click()
        page.get_by_role('button', name='代理兼容设置', exact=True).click()
        dialog = page.get_by_role('dialog')
        dialog.get_by_role('checkbox').check()
        save(dialog)
        expect(page.get_by_role('dialog', name='采集任务', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='重新采集', exact=True)).to_be_visible()
        assert state()['allowProxyFakeIp'] is True
        assert state()['root'] == baseline['root']
        page.get_by_role('button', name='关闭弹窗', exact=True).click()
        dialog = open_settings()
        expect(dialog.get_by_role('checkbox')).to_be_checked()
        page.screenshot(path=str(out / 'proxy-settings.png'), animations='disabled')
        dialog.get_by_role('checkbox').uncheck()
        save(dialog)
        assert state()['allowProxyFakeIp'] is False
        page.reload()
        page.get_by_role('button', name='资料库', exact=True).click()
        dialog = open_settings()
        expect(dialog.get_by_role('checkbox')).not_to_be_checked()
        # A failed response must keep the draft editable without claiming success.
        page.route('**/knowledge-library/api/settings/network', lambda route: route.fulfill(status=400, json={'error': '测试保存失败'}))
        dialog.get_by_role('checkbox').check()
        save(dialog, expected_status=400)
        expect(dialog.get_by_role('alert')).to_have_text('测试保存失败')
        assert state()['allowProxyFakeIp'] is False
        page.unroute('**/knowledge-library/api/settings/network')
        save(dialog)
        assert state()['allowProxyFakeIp'] is True
        page.emulate_media(color_scheme='dark')
        page.screenshot(path=str(out / 'proxy-settings-dark.png'), animations='disabled')
        page.set_viewport_size({'width': 390, 'height': 844})
        expect(dialog.get_by_role('checkbox')).to_be_visible()
        assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
        page.screenshot(path=str(out / 'proxy-settings-mobile.png'), animations='disabled')
        assert not errors, errors
        (out / 'proxy-result.json').write_text(json.dumps({'passed': True, 'errors': errors, 'jobPresentation': 'fixture', 'settingsPersistence': 'real Harness API', 'verified': ['off by default', 'cancel does not save', 'error entry and return to retry', 'enable and disable persistence', 'failed save preserves old mode', 'root preserved', 'type and same-origin validation', 'dark and mobile settings']}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS: proxy settings, opt-in, job recovery entry, persistence and failure handling.')
    finally:
        page.screenshot(path=str(out / 'proxy-last.png'), animations='disabled')
        browser.close()
