import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import AxeBuilder from '@axe-core/playwright';
import { chromium, type Browser, type Page } from 'playwright';
import { measureVisibleTextContrast } from '../src/contrast-fallback.js';
import { collectThemeContrast } from '../src/theme-review.js';

let browser: Browser;
before(async () => { browser = await chromium.launch(); });
after(async () => { await browser?.close(); });

const layout = `<!doctype html>
<html lang="en"><head><title>Fixed viewport</title><style>
html { overflow: hidden; background: white; }
body { position: fixed; inset: 0; margin: 0; overflow: hidden; font: 16px Arial; color: #1c2633; }
section { background: white; width: 38rem; height: 100%; padding: 16px; }
h2 { font-size: 16px; margin: 0; }
@media (prefers-color-scheme: dark) {
  section { background: lab(7.78673 1.82345 -15.0537); }
  .readable { color: #f1f5f9; }
}
</style></head><body><section aria-label="Results">
  <h2>Discover Seoul</h2>
  <p class="readable">Search results</p>
</section></body></html>`;

async function review(page: Page) {
  const axe = await new AxeBuilder({ page }).setLegacyMode(true)
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const screenshot = await page.screenshot();
  return { axe, contrast: await collectThemeContrast(page, axe, async () => screenshot) };
}

test('fixed-body dark viewport recovers a low-contrast heading while readable text passes', async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 520 }, colorScheme: 'light' });
  try {
    await page.setContent(layout);
    const light = await review(page);
    assert.equal(light.contrast.summary.status, 'passed');
    assert.equal(light.contrast.summary.passed, 2);
    assert.equal(light.contrast.summary.source, 'visible-text');
    await page.emulateMedia({ colorScheme: 'dark' });
    const root = await page.evaluate(() => ({
      height: document.documentElement.getBoundingClientRect().height,
      overflow: getComputedStyle(document.documentElement).overflow,
      bodyPosition: getComputedStyle(document.body).position,
    }));
    assert.deepEqual(root, { height: 0, overflow: 'hidden', bodyPosition: 'fixed' });
    const dark = await review(page);
    assert(dark.axe.inapplicable.some(result => result.id === 'color-contrast'));
    assert.equal(dark.contrast.summary.status, 'violation');
    assert.equal(dark.contrast.summary.violations, 1);
    assert.equal(dark.contrast.summary.passed, 1);
    const heading = dark.contrast.summary.examples?.[0];
    assert.equal(heading?.target?.tag, 'h2');
    assert.equal(heading?.foreground, '#1c2633');
    assert.equal(heading?.background, '#0f172b');
    assert.equal(heading?.expectedRatio, 4.5);
    assert.ok(Math.abs((heading?.observedRatio ?? 0) - 1.17) < .02);
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden');
  } finally { await page.close(); }
});

test('fallback leaves gradients and click-through covering paint unmeasured, excluding wholly clipped text', async () => {
  const page = await browser.newPage({ viewport: { width: 820, height: 520 }, colorScheme: 'dark' });
  try {
    await page.setContent(layout);
    await page.addStyleTag({ content: `
      section { position: relative; }
      .visual-cover { position: absolute; inset: 5px 0 auto; height: 30px; background: white; z-index: 2; pointer-events: none; }
      .readable { background: linear-gradient(90deg, red, navy); }
    ` });
    await page.locator('section').evaluate(section => {
      const cover = document.createElement('div');
      cover.className = 'visual-cover';
      section.append(cover);
      const clip = document.createElement('div');
      clip.style.cssText = 'height:0; overflow:hidden;';
      const clipped = document.createElement('h3');
      clipped.textContent = 'Clipped text';
      clip.append(clipped);
      section.append(clip);
    });
    const measured = await measureVisibleTextContrast(page, await page.screenshot());
    assert.deepEqual(measured.measurements.map(({ target, status }) => [target.tag, status]), [['h2', 'incomplete'], ['p', 'incomplete']]);
    assert(measured.measurements.every(item => item.observedRatio === undefined));
  } finally { await page.close(); }
});

test('ordinary axe coverage does not activate the supplemental scan', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html lang="en"><body style="color:black;background:white"><p>Readable text</p></body></html>');
    const axe = await new AxeBuilder({ page }).setLegacyMode(true).withRules('color-contrast').analyze();
    const contrast = await collectThemeContrast(page, axe, async () => { throw new Error('must not read screenshot'); });
    assert.equal(contrast.summary.source, undefined);
    assert.equal(contrast.summary.status, 'passed');
  } finally { await page.close(); }
});
