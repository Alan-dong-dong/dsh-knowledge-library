"""Verify saved preview preferences after stopping and restarting the Node process."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ['LIBRARY_TEST_URL']
out = Path('test-results')
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 1440, 'height': 1000})
    page.goto(base)
    state = page.request.get(base + '/knowledge-library/api/settings').json()
    assert state['canChangeNetwork'] is True
    assert state['canChange'] is False
    assert state['allowProxyFakeIp'] is True
    assert Path(state['root']) == Path(os.environ['KNOWLEDGE_LIBRARY_ROOT'])
    assert page.request.get(base + '/knowledge-library/api/stats').json()['total'] > 0
    page.get_by_role('button', name='资料库设置', exact=True).click()
    dialog = page.get_by_role('dialog')
    expect(dialog.get_by_role('checkbox')).to_be_enabled()
    expect(dialog.get_by_role('checkbox')).to_be_checked()
    page.screenshot(path=str(out / 'preview-proxy-restarted.png'), animations='disabled')
    page.emulate_media(color_scheme='dark')
    page.screenshot(path=str(out / 'preview-proxy-dark.png'), animations='disabled')
    # Turning the option off after a restart must also save immediately.
    dialog.get_by_role('checkbox').uncheck()
    with page.expect_response(lambda response: response.url.endswith('/settings/network')) as response:
        dialog.get_by_role('button', name='保存采集设置', exact=True).click()
    assert response.value.status == 200
    assert page.request.get(base + '/knowledge-library/api/settings').json()['allowProxyFakeIp'] is False
    page.reload()
    page.get_by_role('button', name='资料库设置', exact=True).click()
    expect(page.get_by_role('dialog').get_by_role('checkbox')).not_to_be_checked()
    (out / 'preview-settings-result.json').write_text(json.dumps({'passed': True, 'verified': ['proxy editable independently of directory', 'process restart restores enabled preference', 'root and materials retained', 'disable saved after restart', 'dark preview settings']}, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: preview proxy mode survives process restart and can be disabled again.')
