"""Verify the installed client bundle inside a real, isolated DSH Web host."""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect, TimeoutError as PlaywrightTimeout

url = os.environ["DSH_TEST_URL"]
out = Path("test-results")
out.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1000})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    # An unconfigured isolated host may show this dismissible account invitation
    # asynchronously after any reload. No model account is needed for the library.
    page.add_locator_handler(page.get_by_text("开始使用", exact=True), lambda: page.keyboard.press("Escape"))
    page.goto(url)
    # DSH keeps event streams open, so networkidle is not its readiness signal.
    try:
        page.wait_for_load_state("networkidle", timeout=5000)
    except PlaywrightTimeout:
        page.wait_for_load_state("domcontentloaded")
    (out / "dsh-initial-dom.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
    page.screenshot(path=str(out / "dsh-initial.png"), full_page=True)
    try:
        if page.get_by_text("预览版说明", exact=True).is_visible():
            page.get_by_role("button", name="继续", exact=True).click()
        if page.get_by_text("开始使用", exact=True).is_visible():
            page.keyboard.press("Escape")
            expect(page.get_by_text("开始使用", exact=True)).to_be_hidden()
        page.screenshot(path=str(out / "dsh-after-notice.png"), full_page=True)
        (out / "dsh-after-notice-dom.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
        entry = page.get_by_role("button", name="资料库", exact=True)
        expect(entry).to_be_visible(timeout=30000)
        entry.click()
        expect(page.get_by_role("heading", name="全部资料", exact=True)).to_be_visible()
        page.get_by_role("button", name="收集资料", exact=True).click()
        dialog = page.get_by_role("dialog")
        dialog.get_by_role("tab", name="文本摘录").click()
        dialog.get_by_label("标题").fill("Harness 原生插件集成验证")
        dialog.get_by_label("正文", exact=True).fill("这份资料通过 DeepSeek Harness 的原生资料库面板保存。\n\n切换聊天和重启插件后，稳定 ID 与原文引用仍然可用。")
        dialog.get_by_label("分类", exact=True).fill("验证/原生插件")
        dialog.get_by_role("button", name="保存资料", exact=True).click()
        expect(page.get_by_role("dialog")).to_have_count(0)
        expect(page.get_by_role("region", name="资料详情").get_by_role("heading", name="Harness 原生插件集成验证")).to_be_visible()
        page.reload()
        page.wait_for_load_state("domcontentloaded")
        page.get_by_role("button", name="资料库", exact=True).click()
        expect(page.get_by_role("region", name="资料列表").get_by_role("heading", name="Harness 原生插件集成验证")).to_be_visible()
        page.get_by_role("region", name="资料列表").get_by_role("heading", name="Harness 原生插件集成验证").click()
        expect(page.get_by_role("region", name="资料详情").get_by_text("p0002", exact=True)).to_be_visible()
        page.screenshot(path=str(out / "dsh-integrated.png"), full_page=True)
        if os.environ.get("DSH_LIVE_WEB") == "1":
            page.get_by_role("button", name="收集资料", exact=True).click()
            dialog = page.get_by_role("dialog")
            dialog.get_by_label("网页地址").fill("https://example.com")
            dialog.get_by_label("标题").fill("公开网页采集验证")
            dialog.get_by_role("button", name="开始采集", exact=True).click()
            jobs_dialog = page.get_by_role("dialog", name="采集任务", exact=True)
            expect(jobs_dialog.get_by_role("button", name="查看资料").first).to_be_visible(timeout=45000)
            jobs_dialog.get_by_role("button", name="查看资料").first.click()
            expect(page.get_by_role("region", name="资料详情").get_by_role("heading", name="公开网页采集验证")).to_be_visible()
            expect(page.get_by_role("region", name="资料详情").get_by_role("link", name="example.com")).to_be_visible()
        assert not errors, errors
        (out / "dsh-result.json").write_text(json.dumps({"passed": True, "errors": errors, "dshVersion": "0.2.1-rc.2", "liveWebCapture": os.environ.get("DSH_LIVE_WEB") == "1", "verified": ["package activation", "lazy client factory", "native sidebar entry", "API capture", "reload and retrieval"]}, ensure_ascii=False, indent=2), encoding="utf-8")
        print("PASS: DSH native sidebar, client activation, capture and reload.")
    finally:
        (out / "dsh-errors.json").write_text(json.dumps(errors, ensure_ascii=False, indent=2), encoding="utf-8")
        browser.close()
