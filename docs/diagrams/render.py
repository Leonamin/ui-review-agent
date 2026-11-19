"""Render both themes from the self-contained HTML using Chromium.
Requires Python Playwright and an installed Chromium browser.
"""
from pathlib import Path
from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--no-sandbox", "--font-render-hinting=none"])
    for theme, suffix in [("light", ""), ("dark", "-dark")]:
        # Separate pages and a full-canvas viewport avoid offscreen SVG paint omissions.
        page = browser.new_page(viewport={"width": 1500, "height": 1200}, device_scale_factor=2)
        page.goto((root / "engine-flow.html").as_uri())
        page.evaluate("theme => document.documentElement.dataset.theme = theme", theme)
        page.evaluate("document.fonts.ready")
        page.wait_for_timeout(1500)
        page.add_style_tag(content=".scroller{border-radius:0!important;border:none!important}.canvas{border-radius:0!important}")
        page.locator(".canvas").screenshot(path=str(root / f"engine-flow{suffix}.png"))
        page.close()
    browser.close()
