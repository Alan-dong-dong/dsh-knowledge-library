"""Compare with the native UI after dsh_smoke.py has seeded an isolated profile.

Keep the profile's appearance at its default "system" setting.
"""
import json
import os
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

out = Path("test-results")
out.mkdir(exist_ok=True)

def appearance(locator):
    return locator.evaluate("""el => {
      const s = getComputedStyle(el);
      return {font: s.fontFamily, size: s.fontSize, weight: s.fontWeight,
              color: s.color, background: s.backgroundColor};
    }""")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1680, "height": 1000}, color_scheme="light")
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.add_locator_handler(page.get_by_text("开始使用", exact=True), lambda: page.keyboard.press("Escape"))
    try:
        page.goto(os.environ["DSH_TEST_URL"])
        if page.get_by_text("预览版说明", exact=True).is_visible():
            page.get_by_role("button", name="继续", exact=True).click()
        page.get_by_role("button", name="自动化任务", exact=True).click()
        native_heading = page.get_by_role("heading", name="自动化任务", exact=True)
        expect(native_heading).to_be_visible()
        native_light = appearance(native_heading)
        native_button_light = appearance(page.get_by_role("button", name="新建", exact=True))
        page.screenshot(path=str(out / "style-native-reference.png"), full_page=True, animations="disabled")
        page.get_by_role("button", name="资料库", exact=True).click()
        heading = page.locator(".kl-header h1")
        expect(heading).to_be_visible()
        assert appearance(heading) == native_light, (appearance(heading), native_light)
        primary = page.get_by_role("button", name="收集资料", exact=True)
        assert appearance(primary)["background"] == native_button_light["background"]
        assert appearance(primary)["color"] == native_button_light["color"]
        # Force the real empty state through search without deleting any test data.
        page.get_by_label("搜索资料").fill("没有此条资料的空状态验证")
        expect(page.get_by_role("heading", name="没有找到匹配的资料", exact=True)).to_be_visible()
        page.screenshot(path=str(out / "style-empty.png"), full_page=True, animations="disabled")
        page.get_by_label("搜索资料").fill("")
        item = page.get_by_role("region", name="资料列表").get_by_role("heading").first
        expect(item).to_be_visible()
        item.click()
        expect(page.get_by_role("region", name="资料详情")).to_be_visible()
        page.screenshot(path=str(out / "style-harness-light.png"), full_page=True, animations="disabled")
        primary.click()
        dialog = page.get_by_role("dialog")
        expect(dialog).to_be_visible()
        page.screenshot(path=str(out / "style-harness-dialog.png"), full_page=True, animations="disabled")
        page.keyboard.press("Escape")
        expect(primary).to_be_focused()
        # Default Harness appearance is "system"; emulate a real OS theme change.
        page.emulate_media(color_scheme="dark")
        expect(page.locator("body")).to_have_attribute("data-ds-dark-theme", "")
        page.get_by_role("button", name="自动化任务", exact=True).click()
        expect(native_heading).to_be_visible()
        native_dark = appearance(native_heading)
        native_button_dark = appearance(page.get_by_role("button", name="新建", exact=True))
        page.get_by_role("button", name="资料库", exact=True).click()
        expect(heading).to_be_visible()
        assert appearance(heading) == native_dark, (appearance(heading), native_dark)
        assert native_dark["color"] != native_light["color"]
        assert appearance(primary)["background"] == native_button_dark["background"]
        assert appearance(primary)["color"] == native_button_dark["color"], (appearance(primary), native_button_dark)
        item.click()
        expect(page.get_by_role("region", name="资料详情")).to_be_visible()
        page.screenshot(path=str(out / "style-harness-dark.png"), full_page=True, animations="disabled")
        primary.click()
        expect(dialog).to_be_visible()
        page.screenshot(path=str(out / "style-harness-dark-dialog.png"), full_page=True, animations="disabled")
        page.keyboard.press("Escape")
        page.emulate_media(color_scheme="light")
        # 1180px viewport leaves about 900px for the plugin beside Harness's sidebar.
        page.set_viewport_size({"width": 1180, "height": 760})
        expect(page.get_by_role("region", name="资料详情")).to_be_visible()
        expect(page.get_by_role("region", name="资料列表")).to_be_hidden()
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.screenshot(path=str(out / "style-harness-compact.png"), full_page=True, animations="disabled")
        page.get_by_role("button", name="关闭阅读", exact=True).click()
        expect(page.get_by_role("region", name="资料列表")).to_be_visible()
        page.get_by_role("button", name="分类与专题", exact=True).click()
        directory = page.get_by_role("complementary", name="分类与专题")
        expect(directory).to_be_visible()
        assert directory.bounding_box()["width"] <= 260
        page.screenshot(path=str(out / "style-harness-directory.png"), full_page=True, animations="disabled")
        page.get_by_role("button", name="关闭分类导航", exact=True).click()
        # Short windows must scroll the contents, not clip the page below a forced min-height.
        page.set_viewport_size({"width": 1180, "height": 520})
        expect(primary).to_be_visible()
        primary.click()
        expect(dialog).to_be_visible()
        assert dialog.bounding_box()["height"] <= 496
        dialog.get_by_role("button", name="取消", exact=True).click()
        assert not errors, errors
        (out / "style-result.json").write_text(json.dumps({
            "passed": True, "hostVersion": "0.2.1-rc.2", "errors": errors,
            "nativeLight": native_light, "nativeDark": native_dark,
            "verified": ["native heading/font/color match", "native primary button match",
                         "system theme switching", "themed dialogs", "container width response",
                         "directory access", "short window scrolling", "keyboard focus restoration"]
        }, ensure_ascii=False, indent=2), encoding="utf-8")
        print("PASS: native style parity, light/dark themes, dialogs, compact and short windows.")
    finally:
        browser.close()
