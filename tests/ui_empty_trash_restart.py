import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

base = os.environ['LIBRARY_TEST_URL']
out = Path('test-results')
result = json.loads((out / 'empty-trash-result.json').read_text(encoding='utf-8'))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    page.goto(base)
    page.wait_for_load_state('networkidle')
    api = base + '/knowledge-library/api'
    assert Path(page.request.get(api + '/settings').json()['root']).resolve() == Path(os.environ['KNOWLEDGE_LIBRARY_ROOT']).resolve()
    for material_id in result['purgedIds']:
        assert page.request.get(api + '/materials/' + material_id).status == 400
    for material_id in result['retainedIds']:
        assert page.request.get(api + '/materials/' + material_id).ok
    page.get_by_role('navigation', name='资料导航').get_by_role('button', name='回收站', exact=True).click()
    expect(page.get_by_role('button', name='清空回收站', exact=True)).to_be_disabled()
    result['verified'].append('permanent deletion and retained records survive a real process restart')
    (out / 'empty-trash-result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    browser.close()
    print('PASS: permanently cleared materials stay absent after a real server restart.')
