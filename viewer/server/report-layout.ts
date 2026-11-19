import {imageLayoutBoundsSchema} from '../../src/image-layout.js';
import type {Rect} from '../../src/types.js';
import type {ReportImageLayout} from '../features/reports/types.js';

function records(value: unknown): Record<string, any>[] {
 return Array.isArray(value) ? value.filter(item => item && typeof item === 'object') : [];
}

function isRect(rect: Rect | undefined): rect is Rect {
 return !!rect && [rect.x, rect.y, rect.width, rect.height, rect.x + rect.width, rect.y + rect.height].every(Number.isFinite)
  && rect.width > 0 && rect.height > 0;
}

function hasRef(refs: unknown, id: string): boolean {
 return Array.isArray(refs) && refs.includes(id);
}

function projectUploadedImageLayout(report: Record<string, any>, evidence: Record<string, any>): ReportImageLayout | undefined {
 const {observationId, evidenceId, screenshot} = evidence;
 if (evidence.kind !== 'screenshot' || typeof observationId !== 'string' || typeof evidenceId !== 'string') return;
 if (screenshot?.coordinateSpace !== 'image-pixels' || screenshot.deviceScaleFactor !== 1) return;

 const {width, height} = report.imageSource;
 const {clip} = screenshot;
 if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) return;
 if (clip?.x !== 0 || clip.y !== 0 || clip.width !== width || clip.height !== height) return;

 const observation = records(report.observations).find(item => item.observationId === observationId);
 const source = observation?.source;
 if (source?.kind !== 'image' || source.width !== width || source.height !== height || !hasRef(observation?.screenshotRefs, evidenceId)) return;

 const layouts = records(report.evaluation?.imageLayouts).filter(layout => layout.evidenceId === evidenceId);
 if (layouts.length !== 1 || layouts[0].observationId !== observationId) return;
 const [layout] = layouts;
 const regions = records(layout.regions).slice(0, 20).flatMap(section => {
  const label = typeof section.label === 'string' ? section.label.trim().slice(0, 100) : '';
  const bounds = imageLayoutBoundsSchema.safeParse(section.bounds);
  return label && bounds.success ? [{label, bounds: bounds.data}] : [];
 });

 const findingIds = new Set(records(report.evaluation?.findings)
  .filter(finding => typeof finding.issueId === 'string' && ['confirmed', 'needs-verification'].includes(finding.disposition)
   && hasRef(finding.evidenceIds, evidenceId) && hasRef(finding.observationIds, observationId))
  .map(finding => finding.issueId));
 const focusCandidates = records(layout.focusAreas).slice(0, 60).flatMap(area => {
  const bounds = imageLayoutBoundsSchema.safeParse(area.bounds);
  return findingIds.has(area.findingId) && bounds.success ? [{findingId: area.findingId, bounds: bounds.data}] : [];
 });
 const focusAreas = focusCandidates.filter(area => focusCandidates.filter(other => other.findingId === area.findingId).length === 1);
 if (!regions.length && !focusAreas.length) return;
 return {imageSize: {width, height, deviceScaleFactor: 1}, isEstimated: true, regions, focusAreas};
}

export function projectReportImageLayout(report: Record<string, any>, evidence: Record<string, any>): ReportImageLayout | undefined {
 if (report.focusedReview) return;
 if (report.imageSource?.kind === 'image') return projectUploadedImageLayout(report, evidence);
 const screenshot = evidence.screenshot;
 if (!evidence.observationId || screenshot?.coordinateSpace !== 'viewport-css-pixels') return;

 const {clip, deviceScaleFactor} = screenshot;
 if (!isRect(clip) || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor <= 0) return;
 const imageSize = {width: clip.width * deviceScaleFactor, height: clip.height * deviceScaleFactor, deviceScaleFactor};
 if (![imageSize.width, imageSize.height].every(size => Number.isFinite(size) && size > 0)) return;

 const observation = records(report.observations).find(item => item.observationId === evidence.observationId);
 const screenMap = records(report.evaluation?.screenMap).find(item => item.observationId === evidence.observationId);
 if (!observation || !screenMap || observation.source?.kind === 'image' || observation.isStable === false) return;

 const elementBoxes = new Map<string, Rect>();
 for (const element of records(observation.elements)) {
  const box = element.boundingBox;
  if (typeof element.elementRef !== 'string' || element.isVisible === false || !isRect(box)) continue;
  const left = Math.max(box.x, clip.x), top = Math.max(box.y, clip.y);
  const right = Math.min(box.x + box.width, clip.x + clip.width);
  const bottom = Math.min(box.y + box.height, clip.y + clip.height);
  if (right <= left || bottom <= top) continue;
  elementBoxes.set(element.elementRef, {x: left, y: top, width: right - left, height: bottom - top});
 }

 function regionFor(refs: unknown): Rect | undefined {
  if (!Array.isArray(refs)) return;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const ref of refs) {
   const box = elementBoxes.get(ref);
   if (!box) continue;
   left = Math.min(left, box.x);
   top = Math.min(top, box.y);
   right = Math.max(right, box.x + box.width);
   bottom = Math.max(bottom, box.y + box.height);
  }
  if (!Number.isFinite(left)) return;
  return {
   x: (left - clip.x) / clip.width,
   y: (top - clip.y) / clip.height,
   width: (right - left) / clip.width,
   height: (bottom - top) / clip.height,
  };
 }

 const regions = records(screenMap.sections).flatMap(section => {
  const label = typeof section.label === 'string' ? section.label.trim().slice(0, 250) : '';
  const bounds = regionFor(section.elementRefs);
  return label && bounds ? [{label, bounds}] : [];
 });
 if (!regions.length) return;

 const focusAreas = records(report.evaluation.findings).flatMap(finding => {
  if (typeof finding.issueId !== 'string' || !['confirmed', 'needs-verification'].includes(finding.disposition)) return [];
  const refs = records(finding.visualEvidence)
   .filter(link => link.observationId === observation.observationId && link.hasMaskedContentDependency !== true)
   .flatMap(link => Array.isArray(link.elementRefs) ? link.elementRefs : []);
  const bounds = regionFor(refs);
  return bounds ? [{findingId: finding.issueId, bounds}] : [];
 });
 return {imageSize, regions, focusAreas};
}
