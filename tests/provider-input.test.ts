import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import sharp from 'sharp';
import { EvidenceStore } from '../src/evidence.js';
import { importImage } from '../src/image-input.js';
import { buildProviderContent } from '../src/provider-input.js';
import { runWithOpenAiCompatible } from '../src/review-settings-runtime.js';
import type { EvaluationInput } from '../src/types.js';

const profileVariable = 'UI_REVIEW_PROVIDER_IMAGE_LIMITS';
const endpoint = 'https://provider.test/v1';

function useProfiles(t: TestContext, profiles: unknown) {
    const previous = process.env[profileVariable];
    process.env[profileVariable] = JSON.stringify(profiles);
    t.after(() => {
        if (previous === undefined) delete process.env[profileVariable];
        else process.env[profileVariable] = previous;
    });
}

async function fixture(t: TestContext, images: Buffer[] = []) {
    const runDir = await mkdtemp(join(tmpdir(), 'review-image-transport-'));
    t.after(() => rm(runDir, {recursive:true,force:true}));
    const store = new EvidenceStore('run', runDir);
    const input = {runId:'run',runDir,spec:{evaluator:'openai-compatible',model:'vision'},observations:[],evidence:store.evidence} as unknown as EvaluationInput;
    for (const [index, bytes] of images.entries()) {
        const observationId = `obs-${index+1}`;
        const screenshot = await store.save(observationId, 'screenshot', bytes, 'image/png');
        input.observations.push({observationId,screenshotRefs:[screenshot.evidenceId]} as EvaluationInput['observations'][number]);
    }
    return { input, store };
}

function prepare(input: EvaluationInput, baseUrl = endpoint) {
    return runWithOpenAiCompatible({baseUrl,apiFormat:'chat'},()=>buildProviderContent(input,'Review this page.'));
}

test('unmatched endpoint and model forward original evidence bytes', async t => {
    useProfiles(t, [{evaluator:'openai-compatible',baseUrl:endpoint,model:'limited',maxWidthPx:128}]);
    const png = await sharp({create:{width:300,height:170,channels:3,background:'#101820'}}).png().toBuffer();
    const {input} = await fixture(t, [png]);
    const observed = await prepare(input);
    input.spec.model = 'limited';
    const otherEndpoint = await prepare(input,'https://other.test/v1');
    for (const result of [observed,otherEndpoint]) {
        assert.equal(result.images.length,1);
        assert.equal(result.images[0].mode,'original');
        assert.equal(result.images[0].sha256,result.images[0].sourceSha256);
        assert.deepEqual(result.content[2],{type:'image',mimeType:'image/png',data:png.toString('base64')});
    }
});

test('a known limit tiles the original pixels with overlap and keeps one evidence ID for the capture', async t => {
    useProfiles(t, [{evaluator:'openai-compatible',baseUrl:endpoint,model:'vision',maxWidthPx:180,maxHeightPx:128}]);
    const canvas = {width:310,height:190,channels:3 as const};
    const original = Buffer.alloc(canvas.width*canvas.height*canvas.channels);
    for (let i=0;i<original.length;i+=3) {
        original[i]=Math.floor(i/3)%canvas.width;
        original[i+1]=Math.floor(i/3/canvas.width);
        original[i+2]=0x80;
    }
    const png = await sharp(original,{raw:canvas}).png().toBuffer();
    const {input} = await fixture(t,[png]);
    input.observations[0].viewport = {width:1440,height:900,deviceScaleFactor:2};
    input.evidence[0].screenshot = {
        coordinateSpace:'viewport-css-pixels',clip:{x:40,y:75,width:155,height:95},
        deviceScaleFactor:2,maskColor:'#6b7280',redactionRegions:[],
    };
    const result = await prepare(input);
    assert.deepEqual(result.images.map(image=>image.crop),[
        {x:0,y:0,width:180,height:128},{x:162,y:0,width:148,height:128},
        {x:0,y:116,width:180,height:74},{x:162,y:116,width:148,height:74},
    ]);
    for (const [index,image] of result.images.entries()) {
        assert.equal(image.mode,'tile');
        assert.deepEqual(image.transformReasons,['model-dimensions']);
        assert.equal(image.evidenceId,input.evidence[0].evidenceId);
        assert.deepEqual([image.sourceWidth,image.sourceHeight],[310,190]);
        assert.deepEqual(image.evidenceGeometry?.clip,{x:40,y:75,width:155,height:95});
        const label = result.content[index*2+1];
        const payload = result.content[index*2+2];
        assert(label.type==='text'&&label.text.includes('Cite the original evidence ID'));
        assert.match(label.text,/viewport-css-pixels at \(40, 75\), with 2 image pixels per coordinate unit in a 1440×900 source canvas/);
        assert.equal(payload.type,'image');
        const bytes = Buffer.from(payload.data,'base64');
        assert.equal(image.sha256,createHash('sha256').update(bytes).digest('hex'));
        const {x:left,y:top,width,height}=image.crop;
        const crop=await sharp(original,{raw:canvas}).extract({left,top,width,height}).raw().toBuffer();
        assert.deepEqual(await sharp(bytes).raw().toBuffer(),crop);
    }
    assert.deepEqual(await readFile(input.evidence[0].absolutePath),png);
});

test('aggregate byte pressure preserves every viewport through lossless transport', async t => {
    useProfiles(t, []);
    const png = await sharp({create:{width:1200,height:1200,channels:3,background:'#6b7280'}}).png({compressionLevel:0}).toBuffer();
    assert(png.length<5*1024*1024&&png.length*5>20*1024*1024);
    const {input} = await fixture(t,Array.from({length:5},()=>png));
    const {images,content} = await prepare(input);
    assert.deepEqual(images.map(image=>image.evidenceId),input.evidence.map(image=>image.evidenceId));
    assert(images.every(image=>image.mode==='lossless-reencode'&&image.mimeType==='image/webp'));
    assert(images.every(image=>image.transformReasons?.includes('aggregate-byte-limit')));
    const first = content[2];
    assert.equal(first.type,'image');
    const inputPixels = await sharp(png).raw().toBuffer();
    assert.deepEqual(await sharp(Buffer.from(first.data,'base64')).raw().toBuffer(),inputPixels);
});

test('dimension tiling can send a normalized PNG larger than the compressed source upload limit', async t => {
    useProfiles(t,[{evaluator:'openai-compatible',baseUrl:endpoint,model:'vision',maxWidthPx:1_100}]);
    const {input,store} = await fixture(t);
    const raw = Buffer.alloc(2000*1000*3);
    let seed=8423;
    for (let i=0;i<raw.length;i++) {
        seed=Math.imul(seed,1664525)+1013904223;
        raw[i]=seed>>>24;
    }
    const jpeg=await sharp(raw,{raw:{width:2000,height:1000,channels:3}}).jpeg().toBuffer();
    const source=join(input.runDir,'upload.jpg');
    assert(jpeg.length<5*1024*1024);
    await writeFile(source,jpeg);
    input.observations.push(await importImage(source,store));
    assert((await readFile(input.evidence[0].absolutePath)).length>5*1024*1024);
    const {images}=await prepare(input);
    assert.deepEqual(images.map(image=>image.crop.width),[1100,964]);
    assert(images.every(image=>image.sourceWidth===2000&&image.byteLength<=5*1024*1024));
    const followupDir=await mkdtemp(join(tmpdir(),'review-stored-evidence-'));
    t.after(()=>rm(followupDir,{recursive:true,force:true}));
    const followupStore=new EvidenceStore('followup',followupDir);
    await assert.rejects(importImage(input.evidence[0].absolutePath,followupStore),/5 MiB/);
    const copied=await importImage(input.evidence[0].absolutePath,followupStore,'stored-png');
    assert.equal(copied.source?.sourceSha256,input.evidence[0].sha256);
});

test('hard per-image byte limit splits losslessly even when the model has no native dimension profile', async t => {
    useProfiles(t,[]);
    const raw = Buffer.alloc(2000*1000*3);
    let seed=5419;
    for (let i=0;i<raw.length;i++) {
        seed=Math.imul(seed,1664525)+1013904223;
        raw[i]=seed>>>24;
    }
    const png=await sharp(raw,{raw:{width:2000,height:1000,channels:3}}).png().toBuffer();
    const {input}=await fixture(t,[png]);
    const {images}=await prepare(input);
    assert.deepEqual(images.map(image=>image.crop),[
        {x:0,y:0,width:1000,height:1000},{x:968,y:0,width:1032,height:1000},
    ]);
    assert(images.every(image=>image.mode==='tile'&&image.byteLength<=5*1024*1024));
    assert(images.every(image=>image.transformReasons?.includes('image-byte-limit')));
    process.env[profileVariable]=JSON.stringify([{evaluator:'openai-compatible',baseUrl:endpoint,model:'vision',maxImageBytes:8*1024*1024}]);
    const permitted=await prepare(input);
    assert.equal(permitted.images.length,1);
    assert.equal(permitted.images[0].mode,'original');
    assert.equal(permitted.images[0].byteLength,png.length);
    assert.equal(permitted.images[0].configuredLimits?.maxImageBytes,8*1024*1024);
});

test('a model area-only limit creates overlapping tiles in native pixels', async t => {
    useProfiles(t,[{evaluator:'openai-compatible',baseUrl:endpoint,model:'vision',maxPixels:18_000}]);
    const png=await sharp({create:{width:300,height:200,channels:3,background:'red'}}).png().toBuffer();
    const {input}=await fixture(t,[png]);
    const {images}=await prepare(input);
    assert.deepEqual(images[0].crop,{x:0,y:0,width:164,height:109});
    assert.deepEqual(images[1].crop,{x:148,y:0,width:152,height:109});
    assert.deepEqual(images.at(-1)?.crop,{x:148,y:99,width:152,height:101});
    assert(images.every(image=>image.crop.width*image.crop.height<=18_000));
});

test('compatible endpoint profiles require an address and explicit size', async t => {
    useProfiles(t,[{evaluator:'openai-compatible',model:'vision',maxWidthPx:180}]);
    const png=await sharp({create:{width:300,height:190,channels:3,background:'red'}}).png().toBuffer();
    const {input}=await fixture(t,[png]);
    await assert.rejects(prepare(input),/Invalid UI_REVIEW_PROVIDER_IMAGE_LIMITS/);
});
