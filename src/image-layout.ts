import {z} from 'zod';
import type {EvaluationInput, EvaluationResult, ImageLayout, Rect, ReviewFinding} from './types.js';

const MAX_REGIONS = 20;
const MAX_LAYOUTS = 30;
const id = z.string().min(1).max(200);
const bounds = z.object({x:z.number(),y:z.number(),width:z.number(),height:z.number()}).strict();
export const imageLayoutBoundsSchema = bounds.refine(({x,y,width,height}) =>
 x >= 0 && y >= 0 && width > 0 && height > 0 && x + width <= 1 && y + height <= 1,
);
const region = z.object({label:z.string().trim().min(1).max(100),bounds}).strict();
const ordinaryFocus = z.object({findingId:id,bounds}).strict();
const occlusionFocus = z.object({findingId:id,occlusion:z.object({occluderBounds:bounds,occludedBounds:bounds}).strict()}).strict();
const focus = z.union([ordinaryFocus,occlusionFocus]);
const screenshotRef = z.object({observationId:id,evidenceId:id}).strict();

const structuralRegions = z.array(region).min(1).max(MAX_REGIONS);
const focusAreas = z.array(focus).max(MAX_REGIONS);
export const structuralImageLayoutSchema = z.array(screenshotRef.extend({
 regions:structuralRegions,
 focusAreas,
})).min(1).max(MAX_LAYOUTS);
export const collectionImageLayoutSchema = z.array(screenshotRef.extend({
 regions:structuralRegions,
 focusAreas:focusAreas.max(0),
})).min(1).max(MAX_LAYOUTS);
export const focusImageLayoutSchema = z.array(screenshotRef.extend({
 regions:z.array(region).max(0),
 focusAreas,
})).max(MAX_LAYOUTS);

export const IMAGE_LAYOUT_GEOMETRY = 'The imageLayouts field is display metadata. Reference the exact observationId and screenshot evidenceId. Estimate visible rectangles relative to the full supplied oriented screenshot: top-left is (0,0), bottom-right is (1,1). Use fractional x, y, width and height, with positive size and the entire box inside the image. Ignore app and viewer chrome outside the screenshot. These are visual estimates for display only and must never serve as measured layout, review proof or verification evidence. Omit uncertain boxes.';
export const IMAGE_LAYOUT_REGIONS = 'Return imageLayouts for every provided screenshot. Each entry must include at least one identifiable structural region with estimated bounds even when there are zero findings, notes or suggestions. In regions, label a few broad visible areas in Korean with one tight box each, estimating the boundaries from the screenshot. Use focusAreas: [] when there are no findings.';
export const IMAGE_LAYOUT_FOCUS = 'In focusAreas, include at most one entry per finding. Use its exact issueId as findingId, only for a finding that cites this screenshot. For a finding that observes one visible UI element covering another, return occlusion with occluderBounds for the front element and occludedBounds for the element behind it. Estimate each complete rectangular footprint, including a covered segment only where the visible geometry supports its continuation. The two rectangles must share the same screenshot and overlap by a positive area. The service computes their intersection; do not return a union or a single bounds box for a covering finding. For all other findings use a single descriptive bounds box. Omit the focus entry when its coordinates cannot be located with confidence; leave focusAreas empty when there are no relevant findings.';

function focusBounds(value:z.infer<typeof focus>):Rect|undefined {
 if ('bounds' in value) return imageLayoutBoundsSchema.safeParse(value.bounds).data;
 const {occluderBounds,occludedBounds}=value.occlusion;
 if (!imageLayoutBoundsSchema.safeParse(occluderBounds).success ||
     !imageLayoutBoundsSchema.safeParse(occludedBounds).success) return;
 const x=Math.max(occluderBounds.x,occludedBounds.x);
 const y=Math.max(occluderBounds.y,occludedBounds.y);
 const right=Math.min(occluderBounds.x+occluderBounds.width,occludedBounds.x+occludedBounds.width);
 const bottom=Math.min(occluderBounds.y+occluderBounds.height,occludedBounds.y+occludedBounds.height);
 const width=right-x, height=bottom-y;
 // Avoid a phantom overlap from rounding two representations of a shared edge.
 if (width<=Number.EPSILON || height<=Number.EPSILON) return;
 return {x,y,width,height};
}

export function validateImageLayouts(raw:unknown,input:EvaluationInput,validEvidence:ReadonlySet<string>,findings:ReviewFinding[]):ImageLayout[] {
 if (!Array.isArray(raw) || raw.length > MAX_LAYOUTS) return [];
 const layoutEntries = raw.flatMap(value => {
  const ref = screenshotRef.strip().safeParse(value);
  return ref.success ? [{...ref.data,raw:value as Record<string,unknown>}] : [];
 });
 const layouts:ImageLayout[] = [];
 for (const {observationId,evidenceId,raw} of layoutEntries) {
  if (layoutEntries.filter(entry => entry.evidenceId === evidenceId).length !== 1 || !validEvidence.has(evidenceId)) continue;
  const observation = input.observations.find(item => item.observationId === observationId);
  const evidence = input.evidence.find(item => item.evidenceId === evidenceId);
  const screenshot = evidence?.screenshot;
  if (observation?.source?.kind !== 'image' || !observation.screenshotRefs.includes(evidenceId) ||
      evidence?.kind !== 'screenshot' || evidence.observationId !== observationId ||
      screenshot?.coordinateSpace !== 'image-pixels' || screenshot.deviceScaleFactor !== 1 ||
      screenshot.clip.x !== 0 || screenshot.clip.y !== 0 ||
      screenshot.clip.width !== observation.source.width || screenshot.clip.height !== observation.source.height) continue;
  const regions = Array.isArray(raw.regions) ? raw.regions.slice(0,MAX_REGIONS).flatMap(value => {
   const parsed = region.safeParse(value);
   return parsed.success && imageLayoutBoundsSchema.safeParse(parsed.data.bounds).success ? [parsed.data] : [];
  }) : [];
  const focusEntries = Array.isArray(raw.focusAreas) ? raw.focusAreas.slice(0,MAX_REGIONS) : [];
  const focusAreas = focusEntries.flatMap(value => {
   const parsed=focus.safeParse(value);
   if (!parsed.success) return [];
   const {findingId}=parsed.data;
   if (focusEntries.filter(entry => entry?.findingId === findingId).length !== 1 ||
       !findings.some(finding => finding.issueId === findingId && finding.disposition !== 'dismissed' &&
        finding.observationIds.includes(observationId) && finding.evidenceIds.includes(evidenceId))) return [];
   const highlight=focusBounds(parsed.data);
   return highlight ? [{findingId,bounds:highlight}] : [];
  });
  if (regions.length || focusAreas.length) layouts.push({observationId,evidenceId,regions,focusAreas});
 }
 return layouts;
}

export function imageLayoutLimitations(input:EvaluationInput,layouts:ImageLayout[]):string[] {
 return input.observations.flatMap(observation => observation.source?.kind === 'image'
  ? observation.screenshotRefs.filter(evidenceId => !layouts.some(layout => layout.observationId === observation.observationId && layout.evidenceId === evidenceId && layout.regions.length))
   .map(evidenceId => `화면 구조의 유효한 추정 좌표가 없어 이 캡처의 일반 영역을 표시할 수 없습니다 (${evidenceId}).`)
  : []);
}

export function mergeImageLayouts(groups:(ImageLayout[]|undefined)[]):ImageLayout[] {
 const merged = new Map<string,ImageLayout>();
 for (const group of groups) for (const layout of group??[]) {
  const existing = merged.get(layout.evidenceId);
  merged.set(layout.evidenceId,existing ? {...existing,
   regions:existing.regions.length ? existing.regions : layout.regions,
   focusAreas:[...existing.focusAreas,...layout.focusAreas],
  } : layout);
 }
 return [...merged.values()];
}

export function retainImageLayoutFocus(result:EvaluationResult):EvaluationResult {
 if(!result.imageLayouts) return result;
 const findingIds = new Set(result.findings.map(finding => finding.issueId));
 const imageLayouts = result.imageLayouts.map(layout => ({...layout,
  focusAreas:layout.focusAreas.filter(area => findingIds.has(area.findingId)),
 })).filter(layout => layout.regions.length || layout.focusAreas.length);
 if(imageLayouts.length) result.imageLayouts = imageLayouts;
 else delete result.imageLayouts;
 return result;
}
