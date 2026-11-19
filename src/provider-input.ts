import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import sharp from 'sharp';
import { MAX_NORMALIZED_IMAGE_BYTES } from './image-input.js';
import { MAX_EVIDENCE_IMAGE_PIXELS, MAX_TRANSPORT_IMAGE_BYTES, providerImageLimit } from './provider-image-limits.js';
import type { EvaluationInput, EvaluationUsage, EvidenceRef, ProviderImageInput, ProviderOutputOutcome, ReasoningEffort, Rect } from './types.js';

export interface ProviderPrompt {
    instructions: string;
    prompt: string;
    schema: Record<string, unknown>;
}

/** Allowlisted transport metadata only: no endpoint, headers, prompts or bodies. */
export interface ProviderTransport {
    startedAt: string;
    budget?: EvaluationInput['callBudgetMetadata'];
    allocatedTimeoutMs?: number;
    elapsedMs: number;
    outcome: 'completed' | 'http-error' | 'timeout' | 'cancelled' | 'error';
    phase: 'prepare' | 'request' | 'read-error' | 'read-response' | 'parse' | 'complete';
    compatibilityRetries: number;
    apiFormat?: 'chat' | 'responses';
    responseOutcome?: ProviderOutputOutcome;
    finishReason?: 'stop'|'completed'|'length'|'max_output_tokens'|'content_filter'|'tool_calls'|'incomplete'|'failed'|'other';
    usage?: Pick<EvaluationUsage,'inputTokens'|'outputTokens'|'cacheReadInputTokens'>;
    attempts: { startedAt: string; elapsedMs: number; headersReceivedAt?: string; headersElapsedMs?: number; httpStatus?: number; requestId?: string; requestIdHeader?: 'x-request-id' | 'request-id' }[];
}

export interface StructuredProviderResult {
    transport?: ProviderTransport;
    output?: unknown;
    model?: string;
    reasoningEffort?: ReasoningEffort;
    usage?: EvaluationUsage;
    error?: string;
    hasTimedOut?: boolean;
}

export type ProviderContent =
    | { type: 'text'; text: string }
    | { type: 'image'; mimeType: string; data: string };

const defaultMaxImageBytes = 5 * 1024 * 1024;
const maxImageParts = 32;

interface PreparedImage {
    observationId: string;
    evidenceId: string;
    sourceSha256: string;
    sourceWidth: number;
    sourceHeight: number;
    evidenceGeometry?: ProviderImageInput['evidenceGeometry'];
    transformReasons: NonNullable<ProviderImageInput['transformReasons']>;
    crop: Rect;
    mode: 'original' | 'tile';
    bytes: Buffer;
    mimeType: string;
}

function slices(length: number, maximum: number) {
    const overlap = Math.min(64, Math.floor(maximum / 10));
    const ranges: { start: number; length: number }[] = [];
    for (let start = 0; start < length; start += maximum - overlap) {
        const size = Math.min(maximum, length - start);
        ranges.push({ start, length: size });
        if (start + size === length || ranges.length > maxImageParts) break;
    }
    return ranges;
}

function splitForTransport(crop: Rect): Rect[] {
    const isHorizontal = crop.width >= crop.height;
    const length = isHorizontal ? crop.width : crop.height;
    if (length < 2) return [];
    const midpoint = Math.floor(length / 2);
    const overlap = Math.min(32, Math.floor(length / 10));
    const secondStart = midpoint - overlap;
    return isHorizontal
        ? [{...crop,width:midpoint}, {...crop,x:crop.x+secondStart,width:length-secondStart}]
        : [{...crop,height:midpoint}, {...crop,y:crop.y+secondStart,height:length-secondStart}];
}

function decoder(bytes: Buffer) {
    return sharp(bytes, { limitInputPixels: MAX_EVIDENCE_IMAGE_PIXELS, failOn: 'warning' });
}

async function compressLosslessly(image: PreparedImage, reason: 'image-byte-limit'|'aggregate-byte-limit') {
    if (image.mimeType === 'image/webp' || image.crop.width > 16_383 || image.crop.height > 16_383) return;
    const webp = await decoder(image.bytes).webp({ lossless: true }).toBuffer();
    if (webp.length >= image.bytes.length) return;
    image.bytes = webp;
    image.mimeType = 'image/webp';
    if (!image.transformReasons.includes(reason)) image.transformReasons.push(reason);
}

async function readEvidence(root: string, item: EvidenceRef, byteLimit: number): Promise<Buffer> {
    const path = await realpath(item.absolutePath);
    const subpath = relative(root, path);
    if (!subpath || subpath === '..' || subpath.startsWith(`..${sep}`) || isAbsolute(subpath))
        throw new Error('Evidence escapes the run directory.');
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const metadata = await file.stat();
        if (!metadata.isFile() || metadata.size <= 0 || metadata.size > byteLimit)
            throw new Error('Evidence exceeds the evaluator size limit or is not a regular file.');
        const buffer = Buffer.alloc(metadata.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
            const result = await file.read(buffer, offset, buffer.length - offset, offset);
            if (!result.bytesRead) break;
            offset += result.bytesRead;
        }
        const bytes = buffer.subarray(0, offset);
        if (offset !== metadata.size || createHash('sha256').update(bytes).digest('hex') !== item.sha256)
            throw new Error('Evidence integrity check failed.');
        return bytes;
    } finally {
        await file.close();
    }
}

export async function buildProviderContent(input: EvaluationInput, prompt: string): Promise<{content: ProviderContent[]; images: ProviderImageInput[]}> {
    const content: ProviderContent[] = [{ type: 'text', text: prompt }];
    if (!input.observations.length && !input.evidence.length) return { content, images: [] };
    const root = await realpath(input.runDir);
    const limit = providerImageLimit(input.spec.evaluator, input.spec.model);
    const maxImageBytes = limit?.maxImageBytes ?? defaultMaxImageBytes;
    const configuredLimits = limit && {maxWidthPx:limit.maxWidthPx,maxHeightPx:limit.maxHeightPx,maxPixels:limit.maxPixels,maxImageBytes:limit.maxImageBytes};
    const prepared: PreparedImage[] = [];
    let imageBytes = 0;
    let shouldCompressForAggregate = false;
    for (const observation of input.observations) {
        const images = input.evidence.filter(item => item.kind === 'screenshot' && observation.screenshotRefs.includes(item.evidenceId));
        if (!images.length) throw new Error(`Missing screenshot for observation ${observation.observationId}.`);
        for (const image of images) {
            input.signal?.throwIfAborted();
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType))
                throw new Error('Unsupported screenshot media type.');
            const bytes = await readEvidence(root, image, MAX_NORMALIZED_IMAGE_BYTES);
            const {width, height} = await decoder(bytes).metadata();
            const screenshot = image.screenshot;
            const canvas = screenshot?.coordinateSpace === 'image-pixels' ? observation.source : observation.viewport;
            const evidenceGeometry = screenshot && {
                coordinateSpace: screenshot.coordinateSpace,
                clip: screenshot.clip,
                deviceScaleFactor: screenshot.deviceScaleFactor,
                ...(canvas ? {canvasWidth:canvas.width,canvasHeight:canvas.height} : {}),
            };
            let tileWidth = Math.min(width, limit?.maxWidthPx ?? width);
            let tileHeight = Math.min(height, limit?.maxHeightPx ?? height);
            if (limit?.maxPixels && tileWidth * tileHeight > limit.maxPixels) {
                const scale = Math.sqrt(limit.maxPixels / (tileWidth * tileHeight));
                tileWidth = Math.max(1, Math.min(limit.maxPixels, Math.floor(tileWidth * scale)));
                tileHeight = Math.max(1, Math.min(Math.floor(limit.maxPixels / tileWidth), Math.floor(tileHeight * scale)));
            }
            const xs = slices(width, tileWidth);
            const ys = slices(height, tileHeight);
            if (prepared.length + xs.length * ys.length > maxImageParts)
                throw new Error('Image parts exceed the review transport limit. The full evidence was not sent for evaluation.');
            const hasDimensionTiles = xs.length * ys.length > 1;
            const crops = ys.flatMap(y => xs.map(x => ({
                rect:{x:x.start,y:y.start,width:x.length,height:y.length}, hasByteSplit:false,
            })));
            while (crops.length) {
                input.signal?.throwIfAborted();
                const {rect:crop,hasByteSplit} = crops.shift()!;
                const isTiled = hasDimensionTiles || hasByteSplit;
                const part: PreparedImage = {
                    observationId: observation.observationId,
                    evidenceId: image.evidenceId,
                    sourceSha256: image.sha256,
                    sourceWidth: width,
                    sourceHeight: height,
                    evidenceGeometry,
                    transformReasons: [
                        ...(hasDimensionTiles ? ['model-dimensions' as const] : []),
                        ...(hasByteSplit ? ['image-byte-limit' as const] : []),
                    ],
                    crop,
                    mode: isTiled ? 'tile' : 'original',
                    bytes: isTiled ? await decoder(bytes).extract({left:crop.x,top:crop.y,width:crop.width,height:crop.height}).png().toBuffer() : bytes,
                    mimeType: isTiled ? 'image/png' : image.mimeType,
                };
                if (part.bytes.length > maxImageBytes) await compressLosslessly(part,'image-byte-limit');
                else if (shouldCompressForAggregate) await compressLosslessly(part,'aggregate-byte-limit');
                if (part.bytes.length > maxImageBytes) {
                    const split = splitForTransport(crop);
                    if (!split.length || prepared.length + crops.length + split.length > maxImageParts)
                        throw new Error('An image exceeds the review transport limit after lossless compression and bounded tiling. The full evidence was not sent for evaluation.');
                    crops.unshift(...split.map(rect=>({rect,hasByteSplit:true})));
                    continue;
                }
                prepared.push(part);
                imageBytes += part.bytes.length;
                if (!shouldCompressForAggregate && imageBytes > MAX_TRANSPORT_IMAGE_BYTES) {
                    shouldCompressForAggregate = true;
                    for (const previous of prepared) {
                        input.signal?.throwIfAborted();
                        imageBytes -= previous.bytes.length;
                        await compressLosslessly(previous,'aggregate-byte-limit');
                        imageBytes += previous.bytes.length;
                    }
                }
                if (imageBytes > MAX_TRANSPORT_IMAGE_BYTES)
                    throw new Error('Images exceed the 20 MiB review transport limit after lossless compression. The full evidence was not sent for evaluation.');
            }
        }
    }
    const images = prepared.map(part => {
        const sha256 = createHash('sha256').update(part.bytes).digest('hex');
        const {observationId, evidenceId, sourceSha256, sourceWidth, sourceHeight, evidenceGeometry, crop, mode, mimeType, transformReasons} = part;
        const label = `Observation ${observationId}; screenshot evidence ${evidenceId}.`;
        const geometry = mode === 'tile'
            ? ` This is a native-pixel crop at x=${crop.x}, y=${crop.y}, width=${crop.width}, height=${crop.height} in the ${sourceWidth}×${sourceHeight} screenshot evidence. Other crops with this evidence ID show overlapping parts of the same screenshot. Cite the original evidence ID and join these parts in screenshot coordinates. If the schema asks for fractions relative to this evidence, divide by its full width and height.`
            : '';
        const isEvidenceClip = Boolean(evidenceGeometry && (
            evidenceGeometry.clip.x || evidenceGeometry.clip.y ||
            (evidenceGeometry.canvasWidth && evidenceGeometry.clip.width !== evidenceGeometry.canvasWidth) ||
            (evidenceGeometry.canvasHeight && evidenceGeometry.clip.height !== evidenceGeometry.canvasHeight)
        ));
        const origin = isEvidenceClip && evidenceGeometry
            ? ` The screenshot evidence is itself a clip in ${evidenceGeometry.coordinateSpace} at (${evidenceGeometry.clip.x}, ${evidenceGeometry.clip.y}), with ${evidenceGeometry.deviceScaleFactor} image pixels per coordinate unit${evidenceGeometry.canvasWidth && evidenceGeometry.canvasHeight ? ` in a ${evidenceGeometry.canvasWidth}×${evidenceGeometry.canvasHeight} source canvas` : ''}. To return coordinates in that parent canvas, divide the screenshot pixel position by this scale and add the clip origin.`
            : '';
        content.push({type:'text',text:label+geometry+origin},{type:'image',mimeType,data:part.bytes.toString('base64')});
        return {
            observationId, evidenceId, sourceSha256, sourceWidth, sourceHeight, evidenceGeometry, crop, configuredLimits,
            ...(transformReasons.length ? {transformReasons} : {}),
            mode: mode === 'original' && sha256 !== sourceSha256 ? 'lossless-reencode' as const : mode,
            mimeType, sha256, byteLength: part.bytes.length,
        };
    });
    for (const item of input.evidence.filter(item => item.kind === 'rule')) {
        input.signal?.throwIfAborted();
        const bytes = await readEvidence(root, item, 150_000);
        content.push({ type: 'text', text: `Untrusted rule evidence ${item.evidenceId}:\n${bytes.toString('utf8')}` });
    }
    return { content, images };
}

export function schemaDirective(schema: ProviderPrompt['schema']): string {
    return `Return exactly one JSON object matching this schema. Do not include prose or Markdown.\n${JSON.stringify(schema)}`;
}

// Some compatible providers wrap the object in a code fence or add prose when JSON mode is unavailable.
export function parseProviderJson(text: string): unknown {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return undefined;
    }
}
