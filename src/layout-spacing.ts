import type { Page } from 'playwright';
import type { Rect } from './types.js';

type Axis = 'row' | 'column';
type Edge = 'top' | 'right' | 'bottom' | 'left';

export type LayoutSpacingCheck =
  | { kind: 'control-gap'; axis: Axis; bounds: Rect; targetBounds: Rect[]; observed: number; threshold: number }
  | { kind: 'card-inset'; edge: Edge; bounds: Rect; targetBounds: Rect[]; observed: number; threshold: number };

export interface LayoutSpacingReport {
  checks: LayoutSpacingCheck[];
  inspectedPairs: number;
  inspectedCards: number;
  isLimited?: boolean;
}

/** Near-contact evidence for independent controls and visibly bounded cards. */
export async function measureLayoutSpacing(
  page: Page,
  expected?: { x: number; y: number; width: number },
): Promise<LayoutSpacingReport | undefined> {
  return page.evaluate<LayoutSpacingReport | undefined, typeof expected>(position => {
    if (position && (scrollX !== position.x || scrollY !== position.y || innerWidth !== position.width)) return;
    const buttonSelector = 'button, [role="button"]';
    const inaccessible = '[aria-hidden="true"], [inert], dialog:not([open])';
    const intentionalGroup = 'nav, [role="navigation"], [role="menu"], [role="tablist"], [role="radiogroup"], [role="listbox"]';
    const cardSelector = 'article, [role="article"], [data-slot="card"], [class*="card" i], [class*="panel" i]';
    const headingSelector = 'h1, h2, h3, h4, h5, h6, [role="heading"]';
    const textSelector = `${headingSelector}, p, [data-slot="card-description"]`;
    const maskedInputs = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
    const media = 'img, picture, svg, video, canvas, iframe';
    const maxNodes = 6000;
    const maxCardNodes = 100;
    const maxChecks = 24;
    const deadline = performance.now() + 120;
    // These thresholds identify near-contact candidates, not a design or accessibility standard.
    const minGap = 2;
    const minInset = 4;
    const checks: LayoutSpacingCheck[] = [];
    const counts = { inspectedPairs: 0, inspectedCards: 0 };
    let isLimited = false;
    const openModal = document.querySelector('dialog:modal, [aria-modal="true"]:not([aria-hidden="true"])');
    const scope = openModal?.checkVisibility({ visibilityProperty: true, opacityProperty: true }) ? openModal : document.body;
    if (!scope) return { checks, ...counts };

    const ops = {
      rect({x, y, width, height}: DOMRect): Rect { return {x, y, width, height}; },

      hasArea(box: Rect) {
        return box.width > 0 && box.height > 0;
      },

      isUnobscured(element: Element, x: number, y: number) {
        const hit = document.elementFromPoint(x, y);
        return !!hit && (element.contains(hit) || (element.matches(textSelector) && hit.contains(element)));
      },

      hasKnownCardShape(element: Element) {
        return element.matches('article, [role="article"], [data-slot="card"]') ||
          Array.from(element.classList).some(name => /(?:^|[-_])(card|panel)$/i.test(name));
      },

      isSimpleAndVisible(element: Element, box: Rect) {
        if (!ops.hasArea(box) || box.x < 0 || box.y < 0 || box.x + box.width > innerWidth ||
            box.y + box.height > innerHeight || element.closest(inaccessible) ||
            !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
        for (let ancestor: Element | null = element, depth = 0; ancestor; ancestor = ancestor.parentElement) {
          if (++depth > 32) return false;
          const css = getComputedStyle(ancestor);
          if (css.transform !== 'none' || css.rotate !== 'none' || css.scale !== 'none' ||
              css.translate !== 'none' || css.clipPath !== 'none' || css.maskImage !== 'none' ||
              css.perspective !== 'none' || Number(css.zoom) !== 1) return false;
          if (ancestor === element || ancestor === document.body || ancestor === document.documentElement) continue;
          const ancestorBox = ancestor.getBoundingClientRect();
          const left = ancestorBox.x + ancestor.clientLeft;
          const top = ancestorBox.y + ancestor.clientTop;
          if (css.overflowX !== 'visible' && (box.x < left || box.x + box.width > left + ancestor.clientWidth)) return false;
          if (css.overflowY !== 'visible' && (box.y < top || box.y + box.height > top + ancestor.clientHeight)) return false;
        }
        return true;
      },

      hasColor(color: string) {
        return color !== 'transparent' && !/(?:rgba\(.+,\s*0(?:\.0+)?\s*\)|\/\s*0(?:\.0+)?%?\s*\))$/.test(color);
      },

      border(css: CSSStyleDeclaration, edge: Edge) {
        const style = css.getPropertyValue(`border-${edge}-style`);
        const width = Number.parseFloat(css.getPropertyValue(`border-${edge}-width`));
        return style !== 'none' && style !== 'hidden' && ops.hasColor(css.getPropertyValue(`border-${edge}-color`)) ? width : 0;
      },

      buttonBox(element: Element) {
        const box = ops.rect(element.getBoundingClientRect());
        if (!ops.isSimpleAndVisible(element, box)) return;
        const css = getComputedStyle(element);
        if (['absolute', 'fixed', 'sticky'].includes(css.position)) return;
        if (css.backgroundClip !== 'border-box' || !ops.hasColor(css.backgroundColor)) {
          if (![ops.border(css, 'top'), ops.border(css, 'right'), ops.border(css, 'bottom'), ops.border(css, 'left')].every(width => width > 0)) return;
        }
        return { box, css };
      },

      isIndependentButton(element: Element) {
        return element.matches(buttonSelector) &&
          !element.closest(`${intentionalGroup}, ${maskedInputs}`) &&
          !/(?:^|[-_\s])(segmented|joined|split|toggle-group)(?:$|[-_\s])/i.test(element.parentElement?.getAttribute('class') ?? '');
      },

      pair(first: Element, second: Element) {
        if (!ops.isIndependentButton(first) || !ops.isIndependentButton(second)) return;
        const a = ops.buttonBox(first);
        const b = ops.buttonBox(second);
        if (!a || !b || a.css.order !== '0' || b.css.order !== '0') return;
        const {box: firstBox} = a;
        const {box: secondBox} = b;
        for (const axis of ['row', 'column'] as const) {
          const isRow = axis === 'row';
          const start = isRow ? 'x' : 'y';
          const size = isRow ? 'width' : 'height';
          const crossStart = isRow ? 'y' : 'x';
          const crossSize = isRow ? 'height' : 'width';
          const [left, right] = firstBox[start] <= secondBox[start] ? [a, b] : [b, a];
          const gap = right.box[start] - (left.box[start] + left.box[size]);
          const crossEnd = Math.min(left.box[crossStart] + left.box[crossSize], right.box[crossStart] + right.box[crossSize]);
          const crossBegin = Math.max(left.box[crossStart], right.box[crossStart]);
          const overlap = crossEnd - crossBegin;
          if (gap < 0 || overlap < Math.min(left.box[crossSize], right.box[crossSize]) * 0.75) continue;
          // Flat adjoining edges are ambiguous, including rounded groups with square interior corners.
          const radii = isRow
            ? [left.css.borderTopRightRadius, left.css.borderBottomRightRadius, right.css.borderTopLeftRadius, right.css.borderBottomLeftRadius]
            : [left.css.borderBottomLeftRadius, left.css.borderBottomRightRadius, right.css.borderTopLeftRadius, right.css.borderTopRightRadius];
          if (radii.some(radius => !(Number.parseFloat(radius) > 0))) continue;
          const crossCenter = (crossBegin + crossEnd) / 2;
          const sampleFirst = firstBox[start] + firstBox[size] / 2;
          const sampleSecond = secondBox[start] + secondBox[size] / 2;
          if (!ops.isUnobscured(first, isRow ? sampleFirst : crossCenter, isRow ? crossCenter : sampleFirst) ||
              !ops.isUnobscured(second, isRow ? sampleSecond : crossCenter, isRow ? crossCenter : sampleSecond)) continue;
          counts.inspectedPairs++;
          if (gap >= minGap) return;
          const x = Math.min(firstBox.x, secondBox.x);
          const y = Math.min(firstBox.y, secondBox.y);
          const width = Math.max(firstBox.x + firstBox.width, secondBox.x + secondBox.width) - x;
          const height = Math.max(firstBox.y + firstBox.height, secondBox.y + secondBox.height) - y;
          checks.push({kind:'control-gap', axis, bounds:{x,y,width,height}, targetBounds:[left.box,right.box], observed:gap, threshold:minGap});
          return;
        }
      },

      inset(card: Element) {
        if (card.matches('a, button, [role="button"], [role="link"]') || card.closest(intentionalGroup)) return;
        const bounds = ops.rect(card.getBoundingClientRect());
        if (bounds.width < 64 || bounds.height < 40 || !ops.isSimpleAndVisible(card, bounds)) return;
        const css = getComputedStyle(card);
        const border = {
          top: ops.border(css, 'top'), right: ops.border(css, 'right'),
          bottom: ops.border(css, 'bottom'), left: ops.border(css, 'left'),
        };
        if (Object.values(border).some(width => !(width > 0))) return;
        const cardWalker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
          acceptNode(node) {
            if (!(node instanceof Element)) return NodeFilter.FILTER_ACCEPT;
            if (node.matches(`${media}, ${maskedInputs}`) || (node.matches(cardSelector) && ops.hasKnownCardShape(node))) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          },
        });
        let hasHeading = false;
        let smallest: { edge: Edge; box: Rect; observed: number } | undefined;
        let scanned = 0;
        for (let node = cardWalker.nextNode(); node; node = cardWalker.nextNode()) {
          if (++scanned > maxCardNodes || performance.now() >= deadline) { isLimited = true; return; }
          const isControl = node instanceof Element && node.matches(buttonSelector);
          const owner = node instanceof Element ? node : node.parentElement?.closest(textSelector);
          if (!owner || owner === card || !card.contains(owner)) continue;
          const isText = node instanceof Text && Boolean(node.data.trim()) && !owner.closest(buttonSelector);
          if (!isText && !isControl) continue;
          const boxes: Rect[] = [];
          if (isControl) {
            const button = ops.buttonBox(owner);
            if (button) boxes.push(button.box);
          } else {
            const range = document.createRange();
            // Ignore indentation whitespace and use glyph-run geometry rather than the stretched paragraph/heading box.
            const text = node as Text;
            const value = text.data;
            range.setStart(text, value.length - value.trimStart().length);
            range.setEnd(text, value.trimEnd().length);
            const rects = range.getClientRects();
            if (rects.length > 16) { isLimited = true; continue; }
            for (const rect of rects) {
              const box = ops.rect(rect);
              if (ops.isSimpleAndVisible(owner, box)) boxes.push(box);
            }
          }
          for (const box of boxes) {
            if (!ops.isUnobscured(owner, box.x + box.width / 2, box.y + box.height / 2)) continue;
            if (owner.matches(headingSelector)) hasHeading = true;
            const distances = {
              top: box.y - bounds.y - border.top,
              right: bounds.x + bounds.width - box.x - box.width - border.right,
              bottom: bounds.y + bounds.height - box.y - box.height - border.bottom,
              left: box.x - bounds.x - border.left,
            };
            if (Object.values(distances).some(value => value < 0)) continue;
            for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
              if (!smallest || distances[edge] < smallest.observed) smallest = {edge,box,observed:distances[edge]};
            }
          }
        }
        if (!hasHeading || !smallest) return;
        counts.inspectedCards++;
        if (smallest.observed < minInset) {
          checks.push({kind:'card-inset',edge:smallest.edge,bounds,targetBounds:[smallest.box],observed:smallest.observed,threshold:minInset});
        }
      },
    };

    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_ELEMENT, {
      acceptNode(node) {
        return (node as Element).matches(`${inaccessible}, ${intentionalGroup}, ${maskedInputs}, ${media}`) ?
          NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    let visited = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (++visited > maxNodes || checks.length >= maxChecks || performance.now() >= deadline) { isLimited = true; break; }
      const element = node as Element;
      const next = element.nextElementSibling;
      if (next && element.matches(buttonSelector) && next.matches(buttonSelector)) ops.pair(element, next);
      if (element.matches(cardSelector) && ops.hasKnownCardShape(element)) ops.inset(element);
    }
    return {checks, ...counts, ...(isLimited ? {isLimited} : {})};
  }, expected);
}
