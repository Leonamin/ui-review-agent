import type { Page } from 'playwright';
import sharp from 'sharp';
import type { Rect } from './types.js';
import type AxeBuilder from '@axe-core/playwright';
import {measureVisibleTextContrast, type VisibleTextContrast, type VisibleTextContrastResult} from './contrast-fallback.js';
import { z } from 'zod';

const themeSelector = z.string().trim().min(1).max(500);
export const themeReviewSchema = z.object({
  mode: z.literal('both'),
  selectors: z.object({ light: themeSelector, dark: themeSelector }).strict()
    .refine(selectors => selectors.light !== selectors.dark, 'Theme markers must be distinct').optional(),
}).strict();

export type ThemeReviewOptions = z.infer<typeof themeReviewSchema>;
export type ThemeMode = 'light' | 'dark';
export interface ThemeRegionEvidence {
  role: string;
  bounds: Rect;
  background: string;
}

export interface ThemeObservation {
  requested: ThemeMode;
  status: 'verified' | 'unverified';
  reason: string;
  scope?: 'page' | 'region';
  regions?: ThemeRegionEvidence[];
}

export interface ThemeContrastSummary {
  status: 'passed' | 'violation' | 'incomplete' | 'inapplicable';
  passed: number;
  violations: number;
  incomplete: number;
  source?: 'visible-text';
  hasReachedLimit?: boolean;
  examples?: (Pick<VisibleTextContrast, 'observedRatio' | 'foreground' | 'background'> & {
    status: 'violation' | 'incomplete';
    expectedRatio?: number;
    target?: VisibleTextContrast['target'];
  })[];
}

type AxeResult = Awaited<ReturnType<AxeBuilder['analyze']>>;
type AxeNode = AxeResult['violations'][number]['nodes'][number];
type ContrastExample = NonNullable<ThemeContrastSummary['examples']>[number];

function contrastData(node: AxeNode) {
  return node.any.find(check => check.id === 'color-contrast')?.data as
    { contrastRatio?: number; expectedContrastRatio?: string; messageKey?: string } | undefined;
}

/** Recover axe's equal-color check only for unoccluded text on a proven solid background. */
async function verifySolidEqualColor(page: Page, selectors: string[]): Promise<boolean[]> {
  if (!selectors.length) return [];
  return page.evaluate(targets => targets.map(selector => {
    let el: Element | null;
    try { el = document.querySelector(selector); } catch { return false; }
    if (!el || el.closest('input,textarea,select,[contenteditable],:disabled,[aria-disabled="true"],[aria-hidden="true"],[inert]')) return false;
    const textStyle = getComputedStyle(el);
    const foreground = textStyle.webkitTextFillColor || textStyle.color;
    if (!/^rgb\(/.test(foreground) || textStyle.textShadow !== 'none' || parseFloat(textStyle.webkitTextStrokeWidth) > 0) return false;
    const rects = [...el.childNodes].flatMap(node => {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent?.trim()) return [];
      const range = document.createRange();
      range.selectNodeContents(node);
      return [...range.getClientRects()];
    }).filter(rect => rect.width > 0 && rect.height > 0);
    if (!rects.length || !rects.every(rect => {
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit && el.contains(hit);
    })) return false;
    let background: string | undefined;
    for (let ancestor: Element | null = el; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.opacity !== '1' || style.filter !== 'none' || style.backdropFilter !== 'none'
          || style.mixBlendMode !== 'normal' || style.visibility !== 'visible') return false;
      if (['::before', '::after'].some(pseudo => {
        const content = getComputedStyle(ancestor!, pseudo).content;
        return content !== 'none' && content !== 'normal';
      })) return false;
      if (background) continue;
      if (style.backgroundImage !== 'none') return false;
      if (/^rgb\(/.test(style.backgroundColor)) background = style.backgroundColor;
      else if (style.backgroundColor !== 'rgba(0, 0, 0, 0)') return false;
    }
    return foreground === background;
  }), selectors);
}

export async function collectThemeContrast(page: Page, result: AxeResult, readScreenshot?: () => Promise<Buffer>): Promise<{
  summary: ThemeContrastSummary; equalColorNodes: AxeNode[]; fallback?: VisibleTextContrastResult;
}> {
  const ruleId = 'color-contrast';
  const passed = result.passes.find(rule => rule.id === ruleId)?.nodes
    .filter(node => contrastData(node)?.messageKey !== 'hidden').length ?? 0;
  const failed = result.violations.find(rule => rule.id === ruleId)?.nodes ?? [];
  const pending = result.incomplete.find(rule => rule.id === ruleId)?.nodes ?? [];
  if (!passed && !failed.length && !pending.length && readScreenshot) {
    const fallback = await measureVisibleTextContrast(page, await readScreenshot());
    const violations = fallback.measurements.filter(measurement => measurement.status === 'violation')
      .sort((a, b) => Number(/^h[1-6]$/.test(b.target.tag)) - Number(/^h[1-6]$/.test(a.target.tag)));
    const incomplete = fallback.measurements.filter(measurement => measurement.status === 'incomplete');
    const fallbackPasses = fallback.measurements.length - violations.length - incomplete.length;
    const examples = [...violations.slice(0, 6), ...incomplete.slice(0, 6)]
      .map((measurement): ContrastExample => ({ ...measurement, status: measurement.status === 'violation' ? 'violation' : 'incomplete' }));
    return { equalColorNodes: [], fallback, summary: {
      status: violations.length ? 'violation' : incomplete.length || fallback.hasReachedLimit ? 'incomplete' : fallbackPasses ? 'passed' : 'inapplicable',
      source: 'visible-text', passed: fallbackPasses, violations: violations.length, incomplete: incomplete.length,
      ...(fallback.hasReachedLimit ? { hasReachedLimit: true } : {}), ...(examples.length ? { examples } : {}),
    } };
  }
  const equal = pending.flatMap(node => {
    const selector = node.target.length === 1 && node.target[0];
    return typeof selector === 'string' && contrastData(node)?.messageKey === 'equalRatio' ? [{ selector, node }] : [];
  }).slice(0, 40);
  const confirmed = await verifySolidEqualColor(page, equal.map(item => item.selector));
  const equalColorNodes = equal.filter((_item, index) => confirmed[index]).map(item => item.node);
  const examples: ContrastExample[] = [];
  const addExample = (node: AxeNode, status: ContrastExample['status']) => {
    const data = contrastData(node);
    const expected = Number.parseFloat(data?.expectedContrastRatio ?? '');
    examples.push({ status, ...(typeof data?.contrastRatio === 'number' && Number.isFinite(data.contrastRatio)
      ? { observedRatio: data.contrastRatio } : {}), ...(Number.isFinite(expected) ? { expectedRatio: expected } : {}) });
  };
  for (const node of [...failed, ...equalColorNodes].slice(0, 6)) addExample(node, 'violation');
  for (const node of pending.filter(node => !equalColorNodes.includes(node)).slice(0, 6)) addExample(node, 'incomplete');
  const violations = failed.length + equalColorNodes.length;
  const incomplete = pending.length - equalColorNodes.length;
  return { equalColorNodes, summary: {
    status: violations ? 'violation' : incomplete ? 'incomplete' : passed ? 'passed' : 'inapplicable',
    passed, violations, incomplete, ...(examples.length ? { examples } : {}),
  } };
}

type RgbColor = [number, number, number];
interface PaintPoint { x: number; y: number; }
interface ThemePaint {
  key: string;
  role: string;
  bounds: Rect;
  background: RgbColor;
  isPageSurface: boolean;
  points: PaintPoint[];
}

/** Page text, DOM paths and sample points stay in memory. */
export interface ThemeProbe {
  preference: ThemeMode;
  marker: ThemeMode | 'ambiguous' | 'missing' | 'invalid' | null;
  state: string;
  paints: ThemePaint[];
}

export interface ThemeCapture {
  data: Buffer;
  viewport: { width: number; height: number };
  masks?: Rect[];
}

export function probeTheme(page: Page, selectors: ThemeReviewOptions['selectors']): Promise<ThemeProbe> {
  return page.evaluate(markers => {
    let marker: ThemeProbe['marker'] = null;
    if (markers) {
      try {
        const hasLight = Boolean(document.querySelector(markers.light));
        const hasDark = Boolean(document.querySelector(markers.dark));
        marker = hasLight && hasDark ? 'ambiguous' : hasLight ? 'light' : hasDark ? 'dark' : 'missing';
      } catch {
        marker = 'invalid';
      }
    }

    const paints: ThemePaint[] = [];
    if (!markers) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      const regions = 'html,body,main,section,article,aside,header,footer,nav,[role="main"],[role="region"],[role="complementary"],[role="navigation"],[role="banner"],[role="contentinfo"]';
      const candidates = new Set([
        ...Array.from(document.querySelectorAll(regions)).slice(0, 200),
        ...Array.from(document.querySelectorAll('div')).slice(0, 400),
      ]);
      const palette = new Map<string, RgbColor | null>();
      for (const element of candidates) {
        if (!context || element.closest('input,textarea,select,[contenteditable],dialog,[role="dialog"],[aria-modal="true"],[aria-hidden="true"],[inert]')) continue;
        const css = getComputedStyle(element);
        if (css.visibility !== 'visible' || css.opacity !== '1' || css.backgroundImage !== 'none') continue;
        const box = element.getBoundingClientRect();
        const x = Math.max(0, box.left);
        const y = Math.max(0, box.top);
        const width = Math.min(innerWidth, box.right) - x;
        const height = Math.min(innerHeight, box.bottom) - y;
        // A small accent or status indicator cannot substantiate a region-wide theme.
        if (width <= 0 || height <= 0 || width * height < innerWidth * innerHeight * .03) continue;

        const cssColor = css.backgroundColor;
        if (!palette.has(cssColor)) {
          // Blink converts supported CSS colors, including lab(), into the screenshot's sRGB space.
          context.clearRect(0, 0, 1, 1);
          if (CSS.supports('color', cssColor)) {
            context.fillStyle = cssColor;
            context.fillRect(0, 0, 1, 1);
          }
          const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
          palette.set(cssColor, alpha === 255 ? [r, g, b] : null);
        }
        const background = palette.get(cssColor);
        if (!background) continue;

        const points = [.1, .25, .5, .75, .9].flatMap(vertical =>
          [.1, .25, .5, .75, .9].flatMap(horizontal => {
            const point = { x: x + width * horizontal, y: y + height * vertical };
            return document.elementsFromPoint(point.x, point.y).includes(element) ? [point] : [];
          }));
        if (points.length < 3) continue;

        const path: string[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) {
          const parent: Element | null = node.parentElement;
          path.push(node.tagName + ':' + (parent ? Array.prototype.indexOf.call(parent.children, node) : 0));
        }
        // Keep author text outside the stored evidence. Only report known semantic roles or tag names.
        const knownRole = element.getAttribute('role');
        const role = knownRole && ['main', 'region', 'complementary', 'navigation', 'banner', 'contentinfo'].includes(knownRole)
          ? knownRole : element.localName;
        paints.push({ key: path.reverse().join('/'), role, bounds: { x, y, width, height }, background,
          isPageSurface: element.matches('html,body,main,[role="main"]'), points });
      }
    }
    const modalCount = [...document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')]
      .filter(el => el.checkVisibility({ opacityProperty: true, visibilityProperty: true })).length;
    const state = JSON.stringify([location.href, scrollX, scrollY, modalCount, document.title,
      document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 16000)]);
    return { preference: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      marker, state, paints };
  }, selectors);
}

async function openCapture(capture: ThemeCapture) {
  const { data, info } = await sharp(capture.data).toColourspace('srgb').removeAlpha()
    .raw().toBuffer({ resolveWithObject: true });
  return (point: PaintPoint, color: RgbColor) => {
    if (point.x < 0 || point.y < 0 || point.x >= capture.viewport.width || point.y >= capture.viewport.height ||
        capture.masks?.some(mask => point.x >= mask.x && point.x < mask.x + mask.width &&
          point.y >= mask.y && point.y < mask.y + mask.height)) return false;
    const x = Math.floor(point.x * info.width / capture.viewport.width);
    const y = Math.floor(point.y * info.height / capture.viewport.height);
    const offset = (y * info.width + x) * info.channels;
    return color.every((channel, index) => Math.abs(data[offset + index] - channel) <= 2);
  };
}

function luminance(color: RgbColor) {
  const [r, g, b] = color.map(channel => {
    const s = channel / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  });
  return .2126 * r + .7152 * g + .0722 * b;
}

function regionEvidence(paint: ThemePaint): ThemeRegionEvidence {
  return { role: paint.role, bounds: paint.bounds,
    background: '#' + paint.background.map(channel => channel.toString(16).padStart(2, '0')).join('') };
}

export async function verifyThemePair(light: ThemeProbe | undefined, dark: ThemeProbe | undefined,
  options: ThemeReviewOptions, captures?: { light: ThemeCapture; dark: ThemeCapture }): Promise<Record<ThemeMode, ThemeObservation>> {
  const hasSameState = Boolean(light && dark && light.state === dark.state);
  const changedSurfaces: { light: ThemePaint; dark: ThemePaint }[] = [];
  if (!options.selectors && hasSameState && captures && light!.preference === 'light' && dark!.preference === 'dark') {
    const [sampleLight, sampleDark] = await Promise.all([openCapture(captures.light), openCapture(captures.dark)]);
    const earlier = new Map(light!.paints.map(paint => [paint.key, paint]));
    for (const surface of dark!.paints) {
      const previous = earlier.get(surface.key);
      if (!previous || previous.role !== surface.role || luminance(previous.background) - luminance(surface.background) < .08) continue;

      // Require the same shared screen area, plus evidence that the surface's paint
      // reached both captures. A covered surface may still be present in a hit stack.
      const { bounds } = previous;
      const left = Math.max(bounds.x, surface.bounds.x);
      const top = Math.max(bounds.y, surface.bounds.y);
      const right = Math.min(bounds.x + bounds.width, surface.bounds.x + surface.bounds.width);
      const bottom = Math.min(bounds.y + bounds.height, surface.bounds.y + surface.bounds.height);
      const commonArea = Math.max(0, right - left) * Math.max(0, bottom - top);
      if (commonArea < .8 * Math.max(bounds.width * bounds.height, surface.bounds.width * surface.bounds.height)) continue;
      const matches = surface.points.filter(point =>
        point.x >= left && point.x < right && point.y >= top && point.y < bottom &&
        sampleLight(point, previous.background) && sampleDark(point, surface.background));
      if (matches.length >= 3) changedSurfaces.push({ light: previous, dark: surface });
    }
  }
  const scope = changedSurfaces.some(change => change.dark.isPageSurface) ? 'page' : 'region';

  function verify(requested: ThemeMode, probe: ThemeProbe | undefined): ThemeObservation {
    const result = (status: ThemeObservation['status'], reason: string): ThemeObservation => ({ requested, status, reason });
    if (!probe) return result('unverified', '안정적인 캡처와 테마 측정 근거를 함께 확보하지 못했습니다.');
    if (probe.preference !== requested) return result('unverified', '요청한 브라우저 색상 선호도가 적용되지 않았습니다.');
    if (light && dark && !hasSameState) return result('unverified', '테마 전환 중 화면 상태가 바뀌어 같은 조건으로 비교하지 못했습니다.');
    if (options.selectors) return probe.marker === requested
      ? { ...result('verified', '브라우저 색상 선호도와 지정한 테마 표시가 일치합니다.'), scope: 'page' }
      : result('unverified', probe.marker === 'invalid' ? '테마 표시 선택자가 올바른 CSS 선택자가 아닙니다.'
        : '요청한 테마 표시를 단독으로 확인하지 못했습니다.');
    if (!changedSurfaces.length) return result('unverified', '브라우저 색상 선호도는 적용됐으나 비교 가능한 페이지 영역에서 색상 전환을 확인하지 못했습니다.');
    const regions = changedSurfaces.slice(0, 8).map(change => regionEvidence(change[requested]));
    return { ...result('verified', scope === 'page' ? '페이지 바탕의 색상 전환을 캡처에서 확인했습니다.'
      : '화면에 노출된 영역의 배경색 전환을 캡처에서 확인했습니다.'), scope, regions };
  }
  return { light: verify('light', light), dark: verify('dark', dark) };
}
