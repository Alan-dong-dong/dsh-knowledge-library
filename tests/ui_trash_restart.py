"""Observe and restore the same trashed material after a real server restart."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ['LIBRARY_TEST_URL']
out = Path('test-results')
result = json.loads((out / 'trash-ui-result.json').read_text(encoding='utf-8'))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(base)
    page.wait_for_load_state('networkidle')
    api = base + '/knowledge-library/api'
    assert page.request.get(api + '/materials?query=回收站重启验证').json()['total'] == 0
    entries = page.request.get(api + '/materials?trashed=1').json()['items']
    assert any(item['id'] == result['restartId'] for item in entries)
    page.get_by_role('navigation', name='资料导航').get_by_role('button', name='回收站', exact=True).click()
    listing = page.get_by_role('region', name='资料列表')
    expect(listing.get_by_role('heading', name='回收站重启验证', exact=True)).to_be_visible()
    listing.get_by_role('button', name='恢复 回收站重启验证', exact=True).click()
    expect(listing.get_by_role('heading', name='回收站重启验证', exact=True)).to_have_count(0)
    restored = page.request.get(api + '/materials?query=回收站重启验证').json()['items'][0]
    assert restored['id'] == result['restartId']
    result['verified'].append('real process restart preserves deletion and restoration keeps the same ID')
    (out / 'trash-ui-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: trash state survives a real process restart and is restorable with the original ID.')
