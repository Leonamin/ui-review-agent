import type { JSHandle, Page } from 'playwright';
import { z } from 'zod';
import type { Rect } from './types.js';

const cssSelector = z.string().trim().min(1).max(500);
export const alignmentContractSchema = z.object({
    groupSelector: cssSelector,
    itemSelector: cssSelector.optional(),
    crossSize: z.enum(['equal', 'mixed']).optional(),
    alignment: z.enum(['start', 'center', 'end']).optional(),
}).strict().refine(contract => contract.crossSize !== undefined || contract.alignment !== undefined, {
    message: 'Specify equal or mixed cross sizes, or a cross-axis alignment.',
});
export const alignmentContractsSchema = z.array(alignmentContractSchema).max(20);
export type AlignmentContract = z.infer<typeof alignmentContractSchema>;

interface MeasuredMember {
    hitBox: Rect;
    visualBox: Rect;
    visualSource: 'element' | 'before' | 'after';
    elementRef?: string;
    formRole?: 'text-field' | 'select' | 'action-button';
}

export interface GroupAlignmentCheck {
    status: 'passed' | 'violation' | 'candidate' | 'unverified';
    groupIndex: number | null;
    contractIndex?: number;
    axis?: 'row' | 'column';
    line?: number;
    groupBox?: Rect;
    formPair?: 'field-select' | 'field-action';
    evidenceId?: string;
    materialityThreshold?: number;
    members: MeasuredMember[];
    differences: { kind: 'cross-size' | 'alignment'; spread: number; signedTopOffset?: number }[];
    reason?: string;
}

export interface GroupAlignmentReport {
    tolerance: number;
    checks: GroupAlignmentCheck[];
}

export async function measureGroupAlignment(page: Page, contracts: readonly AlignmentContract[] = []): Promise<GroupAlignmentReport> {
    return measureAlignment(page, {configured: contracts});
}

export async function measureFormRowAlignment(page: Page, candidateElements: JSHandle<Element[]>): Promise<GroupAlignmentReport> {
    return measureAlignment(page, {configured: [], candidateElements});
}

function measureAlignment(page: Page, args: {configured: readonly AlignmentContract[]; candidateElements?: JSHandle<Element[]>}) {
    return page.evaluate(({configured, candidateElements}) => {
        const semanticGroups = '[role="group"], [role="toolbar"]';
        const button = 'button, [role="button"]';
        const controls = `${button}, a[href], [role="tab"], [role="switch"], [role="radio"], [role="checkbox"]`;
        const sensitive = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
        const excluded = '[aria-hidden="true"], [inert], dialog:not([open])';
        const maxGroups = 40;
        const maxMembers = 40;
        // Allow one device pixel for rounding. Product dimensions come from the rendered page.
        const tolerance = 1 / Math.max(devicePixelRatio, 1);
        const checks: GroupAlignmentCheck[] = [];
        const groups = new Map<Element, number>();
        const explicitGroups = new Set<Element>();
        let remainingGroups = maxGroups;

        // Method syntax keeps the browser callback self-contained under the dev transpiler.
        const ops = {
            rect(element: Element): Rect {
                const { x, y, width, height } = element.getBoundingClientRect();
                return { x, y, width, height };
            },

            px(value: string): number | undefined {
                return /^-?(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value) ? Number.parseFloat(value) : undefined;
            },

            length(value: string, extent: number): number | undefined {
                const percent = /^-?(?:\d+(?:\.\d+)?|\.\d+)%$/.test(value) ? Number.parseFloat(value) : undefined;
                return percent === undefined ? ops.px(value) : percent * extent / 100;
            },

            hasColor(value: string): boolean {
                return value !== 'transparent' && !/(?:rgba\(.+,\s*0(?:\.0+)?\s*\)|\/\s*0(?:\.0+)?%?\s*\))$/.test(value);
            },

            hasSurface(css: CSSStyleDeclaration): boolean {
                return (css.backgroundClip === 'border-box' && ops.hasColor(css.backgroundColor)) || [
                    [css.borderTopStyle, css.borderTopWidth, css.borderTopColor],
                    [css.borderRightStyle, css.borderRightWidth, css.borderRightColor],
                    [css.borderBottomStyle, css.borderBottomWidth, css.borderBottomColor],
                    [css.borderLeftStyle, css.borderLeftWidth, css.borderLeftColor],
                ].every(([style, width, color]) => style !== 'none' && style !== 'hidden' && (ops.px(width) ?? 0) > 0 && ops.hasColor(color));
            },

            isVisible(element: Element): boolean {
                if (element.closest(excluded) || !element.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
                const { x, y, width, height } = ops.rect(element);
                return width > 0 && height > 0 && x < innerWidth && y < innerHeight && x + width > 0 && y + height > 0;
            },

            translation(css: CSSStyleDeclaration, box: Rect): [number, number] | undefined {
                const hasIdentityScale = css.scale === 'none' || /^1(?: 1){0,2}$/.test(css.scale);
                if (css.rotate !== 'none' || !hasIdentityScale || css.perspective !== 'none' || Number(css.zoom) !== 1) return;
                const matrix = new DOMMatrixReadOnly(css.transform === 'none' ? undefined : css.transform);
                if (!matrix.is2D || matrix.a !== 1 || matrix.b !== 0 || matrix.c !== 0 || matrix.d !== 1) return;
                if (css.translate === 'none') return [matrix.e, matrix.f];
                const components = css.translate.split(/\s+/);
                if (components.length > 2) return;
                const [x, y] = [box.width, box.height].map((extent, index) => ops.length(components[index] ?? '0px', extent));
                if (x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
                return [matrix.e + x, matrix.f + y];
            },

            hasSimpleShape(css: CSSStyleDeclaration): boolean {
                return css.clipPath === 'none' && css.maskImage === 'none' && css.clip === 'auto' && css.opacity !== '0';
            },

            isFullyVisible(element: Element, box: Rect): boolean {
                if (box.x < -tolerance || box.y < -tolerance ||
                    box.x + box.width > innerWidth + tolerance || box.y + box.height > innerHeight + tolerance) return false;
                for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
                    const css = getComputedStyle(ancestor);
                    if (!ops.hasSimpleShape(css) || !ops.translation(css, ops.rect(ancestor))) return false;
                    if (ancestor === document.documentElement || (css.overflowX === 'visible' && css.overflowY === 'visible')) continue;
                    const clip = ops.rect(ancestor);
                    // The scrollport starts inside the border and excludes scrollbars.
                    const x = clip.x + ancestor.clientLeft;
                    const y = clip.y + ancestor.clientTop;
                    if (css.overflowX !== 'visible' && (box.x < x - tolerance || box.x + box.width > x + ancestor.clientWidth + tolerance)) return false;
                    if (css.overflowY !== 'visible' && (box.y < y - tolerance || box.y + box.height > y + ancestor.clientHeight + tolerance)) return false;
                }
                return true;
            },

            dimension(
                extent: number, startValue: string, endValue: string, sizeValue: string,
                marginStartValue: string, marginEndValue: string, extraSize: number,
            ): [offset: number, size: number] | undefined {
                const start = ops.length(startValue, extent);
                const end = ops.length(endValue, extent);
                const size = ops.length(sizeValue, extent);
                const marginStart = ops.px(marginStartValue);
                const marginEnd = ops.px(marginEndValue);
                if ((start === undefined && end === undefined) || marginStart === undefined || marginEnd === undefined) return;
                const borderBoxSize = size === undefined
                    ? start !== undefined && end !== undefined ? extent - start - end - marginStart - marginEnd : undefined
                    : size + extraSize;
                if (borderBoxSize === undefined || borderBoxSize <= 0) return;
                const offset = start !== undefined ? start + marginStart : extent - end! - marginEnd - borderBoxSize;
                return [offset, borderBoxSize];
            },

            absoluteBox(css: CSSStyleDeclaration, owner: CSSStyleDeclaration, hitBox: Rect): Rect | undefined {
                if (css.position !== 'absolute' || owner.position === 'static' || !ops.hasSimpleShape(css)) return;
                if (![css.minWidth, css.minHeight].every(value => value === '0px' || value === 'auto') ||
                    css.maxWidth !== 'none' || css.maxHeight !== 'none' || css.aspectRatio !== 'auto') return;
                const borderLeft = ops.px(owner.borderLeftWidth) ?? 0;
                const borderTop = ops.px(owner.borderTopWidth) ?? 0;
                const containingWidth = hitBox.width - borderLeft - (ops.px(owner.borderRightWidth) ?? 0);
                const containingHeight = hitBox.height - borderTop - (ops.px(owner.borderBottomWidth) ?? 0);
                const extraX = css.boxSizing === 'border-box' ? 0
                    : [css.paddingLeft, css.paddingRight, css.borderLeftWidth, css.borderRightWidth].reduce((sum, value) => sum + (ops.px(value) ?? 0), 0);
                const extraY = css.boxSizing === 'border-box' ? 0
                    : [css.paddingTop, css.paddingBottom, css.borderTopWidth, css.borderBottomWidth].reduce((sum, value) => sum + (ops.px(value) ?? 0), 0);
                const x = ops.dimension(containingWidth, css.left, css.right, css.width, css.marginLeft, css.marginRight,
                    extraX);
                const y = ops.dimension(containingHeight, css.top, css.bottom, css.height, css.marginTop, css.marginBottom,
                    extraY);
                if (!x || !y) return;
                const box = { x: hitBox.x + borderLeft + x[0], y: hitBox.y + borderTop + y[0], width: x[1], height: y[1] };
                const offset = ops.translation(css, box);
                if (!offset) return;
                return { ...box, x: box.x + offset[0], y: box.y + offset[1] };
            },

            cornerProfile(css: CSSStyleDeclaration, box: Rect): string {
                const corners = [css.borderTopLeftRadius, css.borderTopRightRadius, css.borderBottomLeftRadius, css.borderBottomRightRadius];
                const radius = Math.min(box.width, box.height) / 2;
                const hasCapsuleCorners = corners.every(corner => {
                    const [horizontal, vertical = horizontal] = corner.split(/\s+/);
                    return (ops.length(horizontal, box.width) ?? 0) >= radius && (ops.length(vertical, box.height) ?? 0) >= radius;
                });
                return hasCapsuleCorners ? 'capsule' : corners.join(' ');
            },

            measure(element: Element): { member: MeasuredMember; cornerProfile: string } | undefined {
                const hitBox = ops.rect(element);
                const own = getComputedStyle(element);
                if (!ops.hasSimpleShape(own) || !ops.translation(own, hitBox)) return;
                const surfaces = (['before', 'after'] as const).flatMap(kind => {
                    const css = getComputedStyle(element, `::${kind}`);
                    return css.content !== 'none' && css.content !== 'normal' && css.display !== 'none' &&
                        css.visibility === 'visible' && (ops.hasSurface(css) || css.backgroundImage !== 'none') ? [{ kind, css }] : [];
                });
                const hasOwnPaint = ops.hasSurface(own);
                if (surfaces.length > 1 || (hasOwnPaint && surfaces.length)) return;
                const source = surfaces[0];
                const visualBox = source ? ops.absoluteBox(source.css, own, hitBox) : hasOwnPaint ? hitBox : undefined;
                if (!visualBox || !ops.isFullyVisible(element, visualBox)) return;
                const css = source?.css ?? own;
                return {
                    member: { hitBox, visualBox, visualSource: source?.kind ?? 'element' },
                    cornerProfile: ops.cornerProfile(css, visualBox),
                };
            },

            branches(group: Element, selector: string): Map<Element, Element[]> | undefined {
                const candidates = group.querySelectorAll(selector);
                if (candidates.length > maxMembers * 5) return;
                const members = new Map<Element, Element[]>();
                for (const candidate of candidates) {
                    if (candidate.closest(sensitive) || candidate.querySelector(sensitive) || !ops.isVisible(candidate)) continue;
                    let item = candidate;
                    let current = item.parentElement;
                    while (current && current !== group) {
                        const role = current.getAttribute('role');
                        if (!current.matches('div, span') || (role && role !== 'none' && role !== 'presentation') || current.matches(controls)) break;
                        const css = getComputedStyle(current);
                        if (ops.hasSurface(css) || css.backgroundImage !== 'none' || css.position === 'absolute' || css.position === 'fixed') break;
                        if (css.display !== 'contents') item = current;
                        current = current.parentElement;
                    }
                    if (current !== group) continue;
                    const marked = members.get(item) ?? [];
                    marked.push(candidate);
                    members.set(item, marked);
                    if (members.size > maxMembers) break;
                }
                return members;
            },

            groupIndex(group: Element): number {
                const index = groups.get(group) ?? groups.size + 1;
                groups.set(group, index);
                return index;
            },

            reportGroup(group: Element, contract?: AlignmentContract, contractIndex?: number) {
                const css = getComputedStyle(group);
                const base = { groupIndex: ops.groupIndex(group), contractIndex, groupBox: ops.rect(group), members: [], differences: [] };
                const output = {
                    unverified(reason: string) { if (contract) checks.push({ ...base, status: 'unverified', reason }); },
                };
                if (!ops.isVisible(group)) return output.unverified('group-not-visible');
                if (!['flex', 'inline-flex'].includes(css.display) || css.writingMode !== 'horizontal-tb')
                    return output.unverified('unsupported-group-layout');
                const axis = css.flexDirection.startsWith('row') ? 'row' : 'column';
                // A centered row of similarly painted buttons is a candidate only; length-fit column widths are common.
                if (!contract && (axis !== 'row' || !['center', 'safe center'].includes(css.alignItems))) return;
                const candidateBranches = ops.branches(group, contract?.itemSelector ?? (contract ? controls : button));
                if (!candidateBranches || candidateBranches.size > maxMembers) return output.unverified('member-limit-reached');
                if (candidateBranches.size < 2) return output.unverified('fewer-than-two-visible-members');
                if ([...candidateBranches.values()].some(items => items.length !== 1)) return output.unverified('ambiguous-nested-members');
                const measured = [...candidateBranches].map(([branch, [item]]) => ({ branchBox: ops.rect(branch), measurement: ops.measure(item) }));
                if (measured.some(({ measurement }) => !measurement)) return output.unverified('visible-surface-could-not-be-measured');
                const surfaces = measured.flatMap(({ branchBox, measurement }) => measurement ? [{ branchBox, ...measurement }] : []);
                if (!contract && new Set(surfaces.map(({ cornerProfile }) => cornerProfile)).size !== 1) return;

                const hasReversedCrossAxis = (axis === 'column' && css.direction === 'rtl') !== (css.flexWrap === 'wrap-reverse');
                const alignment = contract ? contract.alignment : 'center';
                const cross = {
                    start(box: Rect) { return axis === 'row' ? box.y : box.x; },
                    size(box: Rect) { return axis === 'row' ? box.height : box.width; },
                    end(box: Rect) { return cross.start(box) + cross.size(box); },
                    coordinate(box: Rect) {
                        if (alignment === 'center') return cross.start(box) + cross.size(box) / 2;
                        return (alignment === 'start') !== hasReversedCrossAxis ? cross.start(box) : cross.end(box);
                    },
                    spread(values: number[]) { return Math.max(...values) - Math.min(...values); },
                };
                const lines: (typeof surfaces)[] = [];
                if (css.flexWrap === 'nowrap') {
                    lines.push(surfaces);
                } else {
                    let lastEnd = -Infinity;
                    for (const surface of surfaces.sort((left, right) => cross.start(left.branchBox) - cross.start(right.branchBox))) {
                        if (cross.start(surface.branchBox) >= lastEnd - tolerance) {
                            lines.push([]);
                            lastEnd = -Infinity;
                        }
                        lines.at(-1)!.push(surface);
                        lastEnd = Math.max(lastEnd, cross.end(surface.branchBox));
                    }
                }
                let hasComparableLine = false;
                for (const [index, line] of lines.entries()) {
                    if (line.length < 2) continue;
                    hasComparableLine = true;
                    const members = line.map(surface => surface.member);
                    const differences: GroupAlignmentCheck['differences'] = [];
                    if (!contract || contract.crossSize === 'equal')
                        differences.push({ kind: 'cross-size', spread: cross.spread(members.map(({ visualBox }) => cross.size(visualBox))) });
                    if (alignment)
                        differences.push({ kind: 'alignment', spread: cross.spread(members.map(({ visualBox }) => cross.coordinate(visualBox))) });
                    const material = differences.filter(difference => difference.spread > tolerance);
                    if (material.length || contract) {
                        checks.push({
                            ...base, axis, line: index + 1, members, differences: material,
                            status: material.length ? contract ? 'violation' : 'candidate' : 'passed',
                        });
                    }
                }
                if (!hasComparableLine) output.unverified('no-layout-line-with-two-visible-members');
            }
        };

        if (candidateElements) {
            const controlsInRow = 'input:not([type="hidden" i]), textarea, select, button, [role="button"], [role="combobox"], [role="textbox"], a[href]';
            const textField = 'input:not([type]), input:is([type="text" i], [type="password" i], [type="search" i], [type="email" i], [type="url" i], [type="tel" i], [type="number" i]), textarea';
            const formSelector = 'form, [role="form"]';
            const references = new Map(candidateElements.map((element, index) => [element, `e${index}`]));
            const inspected = new Set<Element>();
            const form = {
                owner(element: Element): Element | null {
                    if (element instanceof HTMLInputElement || element instanceof HTMLButtonElement ||
                        element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement)
                        return element.form ?? element.closest(formSelector);
                    return element.closest(formSelector);
                },

                isInFlow(css: CSSStyleDeclaration) {
                    return !['absolute', 'fixed', 'sticky'].includes(css.position) && !css.alignSelf.includes('baseline');
                },

                isUsable(element: Element) {
                    const box = ops.rect(element);
                    return box.width >= 16 && box.height >= 16 && ops.isVisible(element);
                },

                hasPaintAtCenter(element: Element, box: Rect) {
                    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                    return Boolean(hit && element.contains(hit));
                },

                hasVisibleLabel(element: Element, branch: Element) {
                    const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/).slice(0, 8) ?? [];
                    const ariaLabels = ids.map(id => document.getElementById(id));
                    const nativeLabels = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
                        ? Array.from(element.labels ?? []).slice(0, 8) : [];
                    return [...nativeLabels, ...ariaLabels].some(label =>
                        Boolean(label && branch.contains(label) && ops.isVisible(label)));
                },

                member(branch: Element, owner: Element): MeasuredMember | undefined {
                    const candidates = branch.matches(controlsInRow) ? [branch] : branch.querySelectorAll(controlsInRow);
                    if (candidates.length > 24 || !form.isInFlow(getComputedStyle(branch))) return;
                    let element: Element | undefined;
                    for (const candidate of candidates) {
                        if (!form.isUsable(candidate)) continue;
                        if (element) return;
                        element = candidate;
                    }
                    if (!element) return;
                    const elementRef = references.get(element);
                    if (!elementRef || form.owner(element) !== owner || !form.isInFlow(getComputedStyle(element))) return;
                    const formRole = element.matches('select:not([multiple]), [role="combobox"]') ? 'select'
                        : element.matches(textField) ? 'text-field'
                        : element === branch && element.matches('button[type="button"], [role="button"]') ? 'action-button'
                        : undefined;
                    if (!formRole) return;
                    if (formRole !== 'action-button' && !form.hasVisibleLabel(element, branch)) return;
                    const geometry = ops.measure(element)?.member;
                    if (!geometry || !form.hasPaintAtCenter(element, geometry.visualBox)) return;
                    return {...geometry, elementRef, formRole};
                },

                report(group: Element) {
                    const css = getComputedStyle(group);
                    if (!['flex', 'inline-flex', 'grid', 'inline-grid'].includes(css.display) ||
                        (css.display.includes('flex') && !css.flexDirection.startsWith('row')) ||
                        css.writingMode !== 'horizontal-tb' || css.alignItems.includes('baseline')) return;
                    const owner = group.closest(formSelector);
                    if (!owner || group.closest('[role="toolbar"], [role="navigation"]')) return;
                    if (group.children.length > 16) return;
                    const children = Array.from(group.children).filter(ops.isVisible);
                    if (children.length !== 2 || children.some(child => !child.matches('div, span, label, input, textarea, select, button, [role="button"], [role="combobox"]'))) return;
                    const members = children.map(child => form.member(child, owner));
                    const field = members.find(member => member?.formRole === 'text-field');
                    const companion = members.find(member => member?.formRole === 'select' || member?.formRole === 'action-button');
                    if (!field || !companion) return;
                    const a = field.visualBox, b = companion.visualBox;
                    const isSideBySide = a.x + a.width <= b.x + tolerance || b.x + b.width <= a.x + tolerance;
                    const overlap = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
                    if (!isSideBySide || Math.abs(a.height - b.height) > tolerance ||
                        overlap < Math.min(a.height, b.height) * .65) return;
                    const signedTopOffset = b.y - a.y;
                    const spread = Math.abs(signedTopOffset);
                    const materialityThreshold = Math.max(2, tolerance * 2);
                    const hasDifference = spread > materialityThreshold;
                    checks.push({
                        status: hasDifference ? 'candidate' : 'passed',
                        groupIndex: ops.groupIndex(group), groupBox: ops.rect(group), axis: 'row',
                        formPair: companion.formRole === 'select' ? 'field-select' : 'field-action',
                        materialityThreshold,
                        members: [field, companion],
                        differences: hasDifference ? [{kind: 'alignment', spread, signedTopOffset}] : [],
                    });
                },
            };
            for (const field of candidateElements) {
                if (checks.length >= maxGroups || inspected.size >= maxGroups * 4) break;
                if (!field.matches(textField) || !form.isUsable(field)) continue;
                let group = field.parentElement;
                for (let depth = 0; group && depth < 3; depth++, group = group.parentElement) {
                    if (!inspected.has(group)) {
                        inspected.add(group);
                        form.report(group);
                    }
                    if (group.matches(formSelector)) break;
                }
            }
            return {tolerance, checks};
        }

        for (const [index, contract] of configured.entries()) {
            const contractIndex = index + 1;
            try {
                if (contract.itemSelector) document.documentElement.matches(contract.itemSelector);
                const matched = Array.from(document.querySelectorAll(contract.groupSelector));
                const inspected = matched.slice(0, remainingGroups);
                remainingGroups -= inspected.length;
                for (const group of inspected) {
                    explicitGroups.add(group);
                    ops.reportGroup(group, contract, contractIndex);
                }
                const reason = !matched.length ? 'group-not-found' : matched.length > inspected.length ? 'group-limit-reached' : undefined;
                if (reason) checks.push({ status: 'unverified', groupIndex: null, contractIndex, reason, members: [], differences: [] });
            } catch {
                checks.push({ status: 'unverified', groupIndex: null, contractIndex, reason: 'group-query-or-measurement-failed', members: [], differences: [] });
            }
        }
        for (const group of document.querySelectorAll(semanticGroups)) {
            if (remainingGroups <= 0) break;
            if (explicitGroups.has(group)) continue;
            remainingGroups--;
            ops.reportGroup(group);
        }
        return { tolerance, checks };
    }, args);
}
