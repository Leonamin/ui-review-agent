import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {open, readdir, realpath} from 'node:fs/promises';
import {dirname, isAbsolute, relative, resolve, sep} from 'node:path';
import {MAX_NORMALIZED_IMAGE_BYTES} from './image-input.js';

type JsonObject = Record<string, unknown>;

export interface WorkspaceReportAuditOptions {
 reportIds: Iterable<string>;
 memberships?: ReadonlyMap<string, string>;
 trashedReportIds?: Iterable<string>;
 expectedPaths?: ReadonlyMap<string, string>;
 expectedReportHashes?: ReadonlyMap<string, string>;
 expectedImageHashes?: ReadonlyMap<string, ReadonlyMap<string, string>>;
 originalRunsRoot?: string;
}

const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 30_000;
const MAX_DEPTH = 9;
const MAX_ISSUE_SAMPLES = 32;
const SHA256 = /^[a-f0-9]{64}$/;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function hash(value: string | Buffer) {
 return createHash('sha256').update(value).digest('hex');
}

function inventoryHash(rows: string[]) {
 return hash(rows.sort().join('\n'));
}

function object(value: unknown): JsonObject | undefined {
 return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined;
}

function array(value: unknown): unknown[] {
 return Array.isArray(value) ? value : [];
}

function isInside(root: string, path: string) {
 const suffix = relative(root, path);
 return suffix !== '' && suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
}

async function readFileWithin(root: string, path: string, maxBytes: number) {
 const canonical = await realpath(path);
 if (!isInside(root, canonical)) throw new Error('path-outside-replica');
 const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
 try {
  const info = await file.stat();
  if (!info.isFile() || info.size > maxBytes) throw new Error('invalid-file');
  const bytes = await file.readFile();
  if (bytes.length > maxBytes) throw new Error('invalid-file');
  return bytes;
 } finally {
  await file.close();
 }
}

async function readImage(root: string, reportPath: string, evidence: JsonObject, originalRunsRoot?: string) {
 const path = evidence.relativePath;
 if (typeof path !== 'string' || !path || isAbsolute(path) || path.split(/[\\/]/).includes('..'))
  throw new Error('invalid-image-path');
 const imagePath = resolve(dirname(reportPath), path);
 try {
  return {bytes: await readFileWithin(root, imagePath, MAX_NORMALIZED_IMAGE_BYTES), hasUsedFallback: false};
 } catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  const fallback = evidence.absolutePath;
  if (typeof fallback !== 'string' || !isAbsolute(fallback)) throw error;
  // Resolve saved absolute paths inside the replica, never the original tree.
  const originalRoot = originalRunsRoot && resolve(originalRunsRoot);
  const replicaPath = originalRoot && isInside(originalRoot, fallback)
   ? resolve(root, relative(originalRoot, fallback))
   : fallback;
  if (!isInside(root, replicaPath)) throw error;
  return {bytes: await readFileWithin(root, replicaPath, MAX_NORMALIZED_IMAGE_BYTES), hasUsedFallback: true};
 }
}

function screenshotEvidence(report: JsonObject) {
 const evidence = new Map<string, JsonObject>();
 const entries = [...array(report.evidence), ...array(report.observations).flatMap(observation => array(object(observation)?.evidenceRefs))];
 for (const entry of entries) {
  const item = object(entry);
  if (item?.kind === 'screenshot' && typeof item.evidenceId === 'string') evidence.set(hash(item.evidenceId), item);
 }
 return evidence;
}

/** Audit the same relative-path and evidence IDs used by the viewer using only files in a replica. */
export async function auditWorkspaceReportPaths(runsRoot: string, options: WorkspaceReportAuditOptions) {
 const root = await realpath(runsRoot);
 const trashed = new Set(options.trashedReportIds);
 const issues: Array<{code: string; reportId?: string; imageId?: string}> = [];
 let issueCount = 0;
 function addIssue(code: string, reportId?: string, imageId?: string) {
  issueCount++;
  if (issues.length < MAX_ISSUE_SAMPLES) issues.push({code, reportId, imageId});
 }

 const reportPaths = new Map<string, string>();
 let scanned = 0;
 let hasReachedScanLimit = false;
 async function scan(directory: string, depth: number) {
  if (depth > MAX_DEPTH || scanned >= MAX_ENTRIES) {
   hasReachedScanLimit = true;
   return;
  }
  const children = await readdir(directory, {withFileTypes: true});
  for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
   if (++scanned > MAX_ENTRIES) {
    hasReachedScanLimit = true;
    break;
   }
   const path = resolve(directory, child.name);
   if (child.isDirectory()) await scan(path, depth + 1);
   else if (child.isFile() && child.name === 'report.json') reportPaths.set(hash(relative(root, path)), path);
  }
 }
 await scan(root, 0);
 if (hasReachedScanLimit) addIssue('report_scan_limit');

 const expectedReportIds = new Set([
  ...options.reportIds, ...trashed,
  ...(options.memberships?.keys() ?? []), ...(options.expectedPaths?.keys() ?? []),
  ...(options.expectedReportHashes?.keys() ?? []), ...(options.expectedImageHashes?.keys() ?? []),
 ]);
 for (const reportId of [...expectedReportIds].sort()) {
  if (!SHA256.test(reportId)) addIssue('invalid_report_id');
  else if (!reportPaths.has(reportId)) addIssue(trashed.has(reportId) ? 'trashed_report_missing' : 'report_missing', reportId);
 }

 const reportInventory: string[] = [];
 const imageInventory: string[] = [];
 let visibleReports = 0, hiddenReports = 0, linkedReports = 0, standaloneReports = 0;
 let managedReports = 0, focusedReports = 0, imageCount = 0, absoluteFallbackImages = 0;
 for (const [reportId, reportPath] of [...reportPaths].sort(([a], [b]) => a.localeCompare(b))) {
  const workspaceId = options.memberships?.get(reportId);
  const isTrashed = trashed.has(reportId);
  if (isTrashed) hiddenReports++;
  else {
   visibleReports++;
   if (workspaceId) linkedReports++;
   else standaloneReports++;
  }
  const localReportPath = relative(root, reportPath);
  const expectedPath = options.expectedPaths?.get(reportId);
  if (expectedPath !== undefined) {
   managedReports++;
   if (expectedPath !== localReportPath) addIssue('managed_report_path_mismatch', reportId);
  }
  let report: JsonObject | undefined;
  try {
   const bytes = await readFileWithin(root, reportPath, MAX_REPORT_BYTES);
   const digest = hash(bytes);
   reportInventory.push(JSON.stringify([reportId, digest, workspaceId ?? null, isTrashed]));
   const expectedHash = options.expectedReportHashes?.get(reportId);
   if (expectedHash !== undefined && expectedHash !== digest) addIssue('report_hash_mismatch', reportId);
   report = object(JSON.parse(bytes.toString('utf8')));
  } catch {
   // Errors may contain replica paths or report text. Only disclose the fixed issue code.
  }
  if (!report) {
   addIssue('report_unreadable', reportId);
   continue;
  }
  if (object(report.focusedReview)) focusedReports++;
  const evidence = screenshotEvidence(report);
  const expectedImages = options.expectedImageHashes?.get(reportId);
  for (const imageId of expectedImages?.keys() ?? []) {
   if (!evidence.has(imageId)) addIssue('source_image_missing', reportId, SHA256.test(imageId) ? imageId : undefined);
  }
  for (const [imageId, item] of evidence) {
   try {
    const {bytes, hasUsedFallback} = await readImage(root, reportPath, item, options.originalRunsRoot);
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
     addIssue('image_not_png', reportId, imageId);
     continue;
    }
    const digest = hash(bytes);
    imageCount++;
    if (hasUsedFallback) absoluteFallbackImages++;
    imageInventory.push(JSON.stringify([reportId, imageId, digest]));
    const recordedHash = typeof item.sha256 === 'string' ? item.sha256 : undefined;
    const expectedHash = expectedImages?.get(imageId);
    if ((recordedHash !== undefined && recordedHash !== digest) || (expectedHash !== undefined && expectedHash !== digest))
     addIssue('image_hash_mismatch', reportId, imageId);
   } catch {
    addIssue('image_unreadable', reportId, imageId);
   }
  }
 }

 return {
  reportsOnDisk: reportPaths.size, visibleReports, hiddenReports, linkedReports, standaloneReports,
  managedReports, focusedReports, imageCount, absoluteFallbackImages,
  reportInventorySha256: inventoryHash(reportInventory), imageInventorySha256: inventoryHash(imageInventory), issueCount, issues,
 };
}
