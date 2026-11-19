import type { Page } from 'playwright';
import sharp from 'sharp';
import type { Rect } from './types.js';

type Rgb = [number, number, number];
interface TextSample {
  tag: string;
  rects: Rect[];
  colors?: { foreground: Rgb; background: Rgb };
  expectedRatio: number;
}
export interface VisibleTextContrast {
  target: { tag: string; bounds: Rect };
  expectedRatio: number;
  observedRatio?: number;
  foreground?: string;
  background?: string;
  status: 'passed' | 'violation' | 'incomplete';
}
export interface VisibleTextContrastResult {
  measurements: VisibleTextContrast[];
  hasReachedLimit: boolean;
}

async function collectTextSamples(page: Page): Promise<{
  samples: TextSample[];
  viewport: { width: number; height: number };
  hasReachedLimit: boolean;
}> {
  return page.evaluate(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const colors = new Map<string, [number, number, number, number] | undefined>();
    const paint = {
      resolve(color: string) {
        if (colors.has(color)) return colors.get(color);
        if (!context || !CSS.supports('color', color) || color === 'currentcolor') return undefined;
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        const normalized: [number, number, number, number] = [pixel[0], pixel[1], pixel[2], pixel[3]];
        colors.set(color, normalized);
        return normalized;
      },
      hasSupportedCompositing(style: CSSStyleDeclaration) {
        return style.opacity === '1' && style.filter === 'none' && style.backdropFilter === 'none' &&
          style.mixBlendMode === 'normal' && style.maskImage === 'none' && style.clipPath === 'none';
      },
      resolveColors(element: Element, textStyle: CSSStyleDeclaration): TextSample['colors'] {
        const foreground = paint.resolve(textStyle.webkitTextFillColor || textStyle.color);
        if (!foreground || foreground[3] !== 255 || textStyle.textShadow !== 'none' ||
            Number.parseFloat(textStyle.webkitTextStrokeWidth) > 0) return;
        let background: Rgb | undefined;
        for (let ancestor: Element | null = element; ancestor; ancestor = ancestor.parentElement) {
          const style = getComputedStyle(ancestor);
          if (!paint.hasSupportedCompositing(style)) return;
          if (background) continue;
          if (style.backgroundImage !== 'none' || style.backgroundClip !== 'border-box' ||
              ['::before', '::after'].some(pseudo => {
                const pseudoStyle = getComputedStyle(ancestor, pseudo);
                return !['none', 'normal'].includes(pseudoStyle.content) && pseudoStyle.display !== 'none';
              })) return;
          const color = paint.resolve(style.backgroundColor);
          if (!color || (color[3] !== 0 && color[3] !== 255)) return;
          if (color[3] === 255) background = [color[0], color[1], color[2]];
        }
        if (background) return { foreground: [foreground[0], foreground[1], foreground[2]], background };
      },
    };
    const privateOrInactive = 'input,select,textarea,script,style,noscript,[contenteditable]:not([contenteditable="false"]),[inert],:disabled,[aria-disabled="true"],[aria-hidden="true"]';
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const samples: TextSample[] = [];
    let scanned = 0;
    let hasReachedLimit = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++scanned > 4000 || samples.length >= 240) {
        hasReachedLimit = true;
        break;
      }
      const element = node.parentElement;
      if (!element || !/\p{L}|\p{N}/u.test(node.textContent ?? '') || element.closest(privateOrInactive)) continue;
      if (!element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = Array.from(range.getClientRects())
        .filter(rect => rect.width > 0 && rect.height > 0)
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      if (!rects.length || rects.length > 8 || rects.some(rect => rect.x < 0 || rect.y < 0 ||
          rect.x + rect.width > viewport.width || rect.y + rect.height > viewport.height)) continue;
      // Hit-test actual painted text positions. A zero-height root is not the viewport's paint clip.
      if (!rects.every(rect => [.2, .5, .8].every(fraction => {
        const hit = document.elementFromPoint(rect.x + rect.width * fraction, rect.y + rect.height / 2);
        return hit === element || (hit != null && element.contains(hit));
      }))) continue;
      const textStyle = getComputedStyle(element);
      const fontSize = Number.parseFloat(textStyle.fontSize);
      const hasLargeText = fontSize >= 24 || (fontSize >= 56 / 3 && Number.parseFloat(textStyle.fontWeight) >= 700);
      samples.push({ tag: element.localName, rects, colors: paint.resolveColors(element, textStyle), expectedRatio: hasLargeText ? 3 : 4.5 });
    }
    return { samples, viewport, hasReachedLimit };
  });
}

function luminosity(rgb: Rgb): number {
  const linear = rgb.map(channel => {
    const value = channel / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

/** Require evidence of both paints in the saved screenshot, including on pointer-events:none overlays. */
export async function measureVisibleTextContrast(page: Page, screenshot: Buffer): Promise<VisibleTextContrastResult> {
  const { samples, viewport, hasReachedLimit } = await collectTextSamples(page);
  if (!samples.length) return { measurements: [], hasReachedLimit };
  const { data, info } = await sharp(screenshot, { limitInputPixels: 40_000_000 })
    .toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const scaleX = info.width / viewport.width;
  const scaleY = info.height / viewport.height;
  const matches = (offset: number, rgb: Rgb) =>
    Math.abs(data[offset] - rgb[0]) <= 1 && Math.abs(data[offset + 1] - rgb[1]) <= 1
    && Math.abs(data[offset + 2] - rgb[2]) <= 1;
  const hex = (rgb: Rgb) => '#' + rgb.map(component => component.toString(16).padStart(2, '0')).join('');
  const measurements = samples.map(({ tag, rects, colors, expectedRatio }): VisibleTextContrast => {
    const x = Math.min(...rects.map(rect => rect.x)), y = Math.min(...rects.map(rect => rect.y));
    const right = Math.max(...rects.map(rect => rect.x + rect.width));
    const bottom = Math.max(...rects.map(rect => rect.y + rect.height));
    const base = { target: { tag, bounds: { x, y, width: right - x, height: bottom - y } }, expectedRatio };
    if (!colors || Math.abs(scaleX - scaleY) > .01) return { ...base, status: 'incomplete' };
    const { foreground, background } = colors;
    const a = luminosity(foreground), b = luminosity(background);
    const observedRatio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    const hasVisiblePaints = observedRatio !== 1 && rects.every(rect => {
      const left = Math.max(0, Math.ceil(rect.x * scaleX)), right = Math.min(info.width, Math.floor((rect.x + rect.width) * scaleX));
      const top = Math.max(0, Math.ceil(rect.y * scaleY)), bottom = Math.min(info.height, Math.floor((rect.y + rect.height) * scaleY));
      const area = (right - left) * (bottom - top);
      const stride = Math.max(1, Math.floor(Math.sqrt(area / 24_000)));
      let foregroundCount = 0;
      let backgroundCount = 0;
      let outsideCount = 0;
      let scanned = 0;
      for (let y = top; y < bottom; y += stride) {
        for (let x = left; x < right; x += stride) {
          const offset = (y * info.width + x) * info.channels;
          scanned++;
          if (matches(offset, foreground)) foregroundCount++;
          else if (matches(offset, background)) backgroundCount++;
          else if (foreground.some((component, channel) => data[offset + channel] < Math.min(component, background[channel]) - 3
              || data[offset + channel] > Math.max(component, background[channel]) + 3)) outsideCount++;
        }
      }
      return foregroundCount >= 2 && backgroundCount >= 2 && outsideCount / scanned < .1;
    });
    if (!hasVisiblePaints) return { ...base, status: 'incomplete' };
    return {
      ...base,
      foreground: hex(foreground),
      background: hex(background),
      observedRatio,
      status: observedRatio < expectedRatio ? 'violation' : 'passed',
    };
  });
  return { measurements, hasReachedLimit };
}
