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
        page.get_by_role('button', name='关闭弹窗', exact=True).click()
        page.set_viewport_size({'width': 1440, 'height': 1000})
        page.emulate_media(color_scheme='light')
        # Show a classified verification failure, then use real capture APIs for recovery.
        source = 'https://mp.weixin.qq.com/s/test-article'
        job.update(id='job_verification_fixture', url=source, errorCode='PAGE_REQUIRES_BROWSER', error='微信返回了验证页面，尚未获取文章正文。请在浏览器打开原网页，完成验证后粘贴正文，或导入保存的 HTML。后台采集不共享浏览器的验证状态。')
        page.reload()
        page.get_by_role('button', name='资料库', exact=True).click()
        page.get_by_role('button', name='采集任务', exact=True).click()
        dialog = page.get_by_role('dialog', name='采集任务', exact=True)
        expect(dialog.get_by_text('需浏览器验证', exact=True)).to_be_visible()
        expect(dialog.get_by_role('link', name='打开原网页', exact=True)).to_have_attribute('href', source)
        expect(dialog.get_by_role('link', name='打开原网页', exact=True)).to_have_attribute('rel', 'noopener noreferrer')
        page.screenshot(path=str(out / 'verification-task.png'), animations='disabled')
        page.set_viewport_size({'width': 390, 'height': 844})
        assert dialog.evaluate('(el) => el.scrollWidth <= el.clientWidth + 1')
        page.screenshot(path=str(out / 'verification-task-mobile.png'), animations='disabled')
        dialog.get_by_role('button', name='粘贴正文', exact=True).click()
        dialog = page.get_by_role('dialog', name='收集一份资料', exact=True)
        expect(dialog.get_by_role('tab', name='文本摘录', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(dialog.get_by_label('来源网页', exact=True)).to_have_value(source)
        dialog.get_by_label('标题').fill('微信正文人工导入验证')
        dialog.get_by_label('正文', exact=True).fill('这是在浏览器完成验证后，由用户明确粘贴保存的实际文章正文。保存时保留原网页链接，后续可以按来源回溯、检索和引用，不将环境异常页面当成文章。')
        dialog.get_by_role('button', name='保存资料', exact=True).click()
        expect(page.get_by_role('dialog')).to_have_count(0)
        expect(page.get_by_role('region', name='资料详情').get_by_role('heading', name='微信正文人工导入验证', exact=True)).to_be_visible()
        material = page.request.get(api + '/materials?query=微信正文人工导入验证').json()['items'][0]
        assert material['sourceUrl'] == source
        assert material['kind'] == 'text'
        page.screenshot(path=str(out / 'verification-manual.png'), animations='disabled')
        assert not errors, errors
        (out / 'proxy-result.json').write_text(json.dumps({'passed': True, 'errors': errors, 'jobPresentation': 'fixture', 'settingsAndManualCapture': 'real Harness API', 'verified': ['off by default', 'cancel does not save', 'error entry and return to retry', 'enable and disable persistence', 'failed save preserves old mode', 'root preserved', 'type and same-origin validation', 'dark and mobile settings', 'verification page recovery actions', 'manual text capture retains source URL']}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('PASS: proxy settings, verification recovery actions and manual capture with source URL.')
    finally:
        page.screenshot(path=str(out / 'proxy-last.png'), animations='disabled')
        browser.close()
