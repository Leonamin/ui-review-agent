import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import sharp from 'sharp';
import {inspect} from '../src/core.js';
import {evaluate} from '../src/evaluator.js';
import {validateSpec} from '../src/policy.js';
import {ReportRepository} from '../viewer/server/repository.js';
import type {RunSpec,EvaluationInput} from '../src/types.js';

function spec(imagePath:string):RunSpec{return {imagePath,mode:'quick',purpose:'Review the supplied settings screen.',viewport:{width:1440,height:900,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[],hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,limits:{maxDurationMs:5000,maxObservations:1,maxActions:0,maxToolCalls:1,maxFindings:10},evaluator:'codex',strategy:'A'};}
async function fixture(fn:(dir:string)=>Promise<void>){const dir=await mkdtemp(join(tmpdir(),'image-input-test-'));try{await fn(dir);}finally{await rm(dir,{recursive:true,force:true});}}
const completed=async()=>({status:'completed' as const,findings:[],screenMap:[],interpretations:[],limitations:[]});

test('PNG/JPEG/WebP imports decode real dimensions and preserve source provenance without browser claims',async()=>fixture(async dir=>{
 for(const format of ['png','jpeg','webp'] as const){
  const bytes=await sharp({create:{width:47,height:31,channels:3,background:'#597b91'}}).toFormat(format).toBuffer();
  const inputPath=join(dir,`untrusted-name-${format}.bin`);await writeFile(inputPath,bytes);
  let evaluationInput:EvaluationInput|undefined;
  const {result,runDir}=await inspect(spec(inputPath),join(dir,'runs'),{evaluate:async input=>{evaluationInput=input;return completed();}});
  assert.equal(result.status,'completed');assert.equal(result.targetUrl,undefined);assert.equal(result.observations.length,1);
  assert.equal(result.imageSource?.width,47);assert.equal(result.imageSource?.height,31);assert.equal(result.imageSource?.mimeType,`image/${format}`);
  assert.equal(result.imageSource?.sourceSha256,createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await readFile(join(runDir,result.imageSource!.originalRelativePath)),bytes);
  assert.equal(evaluationInput?.spec.imagePath,undefined);assert.equal(result.evidence[0].isRedacted,false);
  assert.equal(result.evidence[0].screenshot?.coordinateSpace,'image-pixels');
  const decoded=await sharp(await readFile(result.evidence[0].absolutePath)).metadata();assert.equal(decoded.format,'png');assert.equal(decoded.width,47);
  assert.deepEqual(result.actions,[]);assert.deepEqual(result.rules,[]);assert.deepEqual(result.observations[0].elements,[]);
  assert.ok(result.coverage.unavailableChecks?.some(check=>check.checkId==='interaction'));assert.equal(result.coverage.canFinish,true);
  const report=await readFile(join(runDir,'report.md'),'utf8');assert.match(report,/47×31 이미지 px/);assert.doesNotMatch(report,/47×31 CSS px/);assert.match(report,/촬영 시각 아님/);
  const manifest=await readFile(join(runDir,'manifest.json'),'utf8');assert.ok(!manifest.includes(inputPath));
 }
}));

test('EXIF orientation is applied and output dimensions describe actual analysis pixels',async()=>fixture(async dir=>{
 const inputPath=join(dir,'rotated.jpg');await writeFile(inputPath,await sharp({create:{width:40,height:20,channels:3,background:'red'}}).jpeg().withMetadata({orientation:6}).toBuffer());
 const {result}=await inspect(spec(inputPath),join(dir,'runs'),{evaluate:completed});
 assert.equal(result.imageSource?.width,20);assert.equal(result.imageSource?.height,40);
}));

test('malformed, unsupported and oversized image sources fail before model evaluation',async()=>fixture(async dir=>{
 const invalids=[['broken.png',Buffer.from([137,80,78,71,13,10,26,10])],['not-image.jpg',Buffer.from('not an image')],['vector.svg',Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>')],['large.png',Buffer.alloc(5*1024*1024+1)]] as const;
 for(const [name,bytes] of invalids){const inputPath=join(dir,name);await writeFile(inputPath,bytes);let hasCalled=false;
  const {result}=await inspect(spec(inputPath),join(dir,'runs'),{evaluate:async()=>{hasCalled=true;return completed();}});
  assert.equal(hasCalled,false);assert.equal(result.status,'failed');assert.equal(result.coverage.canFinish,false);assert.equal(result.evidence.length,0);
 }
 const {result}=await inspect(spec(dir),join(dir,'runs'),{evaluate:completed});assert.equal(result.status,'failed');
}));

test('image contract rejects URL mixing, rules-only and browser-specific controls',()=>{
 const base=spec('/tmp/example.png');
 for(const change of [{targetUrl:'https://example.com'},{evaluator:'rules-only'},{shouldVerify:true},{isHeaded:true},{shouldWaitForLogin:true},{hasMutationPermission:true},{mode:'interaction'},{allowedOrigins:['https://example.com']}])assert.throws(()=>validateSpec({...base,...change} as RunSpec));
 assert.doesNotThrow(()=>validateSpec(base));
 for(const args of [['--image','x','--url','https://example.com'],['--image','x','--viewport','390x800'],['--image','x','--verify'],['--image','x','--evaluator','rules-only']]){
  const process=spawnSync('node',['--import','tsx','src/cli.ts',...args],{encoding:'utf8'});assert.equal(process.status,1);assert.match(process.stderr,/exactly one|does not support/);
 }
});

test('viewer displays imported image identity and does not invent capture metadata',async()=>fixture(async dir=>{
 const path=join(dir,'settings.webp');await writeFile(path,await sharp({create:{width:80,height:60,channels:3,background:'white'}}).webp().toBuffer());
 const output=join(dir,'runs');const {result}=await inspect(spec(path),output,{evaluate:completed});
 const repo=new ReportRepository(output);const row=(await repo.list()).reports[0];assert.equal(row.target,'이미지: settings.webp');
 const detail=await repo.detail(row.id);assert.equal(detail.pageTitle,undefined);assert.equal(detail.requestedUrl,undefined);assert.equal(detail.captures?.[0].viewport,undefined);assert.equal(detail.captures?.[0].capturedAt,undefined);assert.equal(detail.captures?.[0].isStable,undefined);
 assert.deepEqual(detail.captures?.[0].image,{fileName:'settings.webp',width:80,height:60,importedAt:result.imageSource?.importedAt});
 const imageId=detail.images[0].url.split('/').at(-1)!;const image=await repo.image(row.id,imageId);assert.equal((await sharp(image).metadata()).format,'png');
}));

test('image cancellation/evaluation failure never becomes a successful empty review',async()=>fixture(async dir=>{
 const path=join(dir,'sample.png');await writeFile(path,await sharp({create:{width:10,height:10,channels:3,background:'white'}}).png().toBuffer());
 const {result}=await inspect(spec(path),join(dir,'runs'),{evaluate:async()=>({status:'failed',findings:[],screenMap:[],interpretations:[],limitations:['Provider unavailable']})});
 assert.equal(result.status,'partial');assert.equal(result.coverage.canFinish,false);assert.match(result.limitations.join('\n'),/Provider unavailable/);
}));

test('image pipeline persists advisory suggestions separately in JSON, Markdown and viewer counts',async()=>fixture(async dir=>{
 const inputPath=join(dir,'sample.png');await writeFile(inputPath,await sharp({create:{width:40,height:30,channels:3,background:'white'}}).png().toBuffer());
 const {result,runDir}=await inspect(spec(inputPath),join(dir,'runs'),{evaluate:async input=>({...await completed(),suggestions:[{suggestionId:'s1',category:'content',title:'정보 묶음 검토',observation:'정보가 여러 구역에 있습니다.',rationale:'관련 정보의 비교를 도울 수 있습니다.',possibleImpact:'탐색 부담 감소 가능성',uncertainty:'사용자 탐색은 미관찰',recommendation:'그룹 구성을 검토합니다.',evidenceIds:[input.evidence[0].evidenceId],observationIds:[input.observations[0].observationId]}]})});
 assert.equal(result.findings.length,0);assert.equal(result.verificationCandidates.length,0);assert.equal(result.suggestions?.length,1);
 const saved=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));assert.equal(saved.suggestions[0].uncertainty,'사용자 탐색은 미관찰');assert.match(await readFile(join(runDir,'report.md'),'utf8'),/개선 제안 \(결함 수 제외\)/);
 const repo=new ReportRepository(join(dir,'runs'));const row=(await repo.list()).reports[0];assert.equal(row.initialCount,0);assert.equal((await repo.detail(row.id)).suggestions?.length,1);
}));

test('standard image review stores only valid estimates for uniquely bound screenshot evidence without extra evaluation',async()=>fixture(async dir=>{
 const inputPath=join(dir,'sample.png');
 await writeFile(inputPath,await sharp({create:{width:40,height:30,channels:3,background:'white'}}).png().toBuffer());
 for(const mode of ['mixed','duplicate','empty','absent'] as const){
  let calls=0;
  const {result,runDir}=await inspect({...spec(inputPath),evaluator:'claude'},join(dir,'runs'),{evaluate:input=>evaluate(input,{runClaude:async(_input,_repair,stage)=>{
   calls++;
   assert.match(stage?.instructions??'',/full supplied oriented screenshot/);
   assert.match(stage?.instructions??'',/even when there are zero findings/);
   const {evidenceId,observationId}=input.evidence[0];
   const valid={observationId,evidenceId,regions:[{label:'본문',bounds:{x:0,y:.2,width:1,height:.6}}],focusAreas:[]};
   const imageLayouts=mode==='mixed'?[{...valid,regions:[...valid.regions,
    {label:'영역 초과',bounds:{x:.9,y:.2,width:.3,height:.2}},
    {label:'잘못된 크기',bounds:{x:0,y:.2,width:null,height:.2}},
   ],focusAreas:[{findingId:'unknown',bounds:{x:0,y:.2,width:.3,height:.2}}]},
   {...valid,evidenceId:'unknown'},{...valid,observationId:'unknown',evidenceId:'another'}]:mode==='empty'?[]:[valid,valid];
   const draft={findings:[],suggestions:[],screenMap:[{observationId,sections:[]}],interpretations:[],limitations:[],
    ...(mode==='absent'?{}:{imageLayouts})};
   return {events:[{type:'system',subtype:'init',tools:['StructuredOutput'],mcp_servers:[]},{type:'result',structured_output:draft}],exitCode:0,hasTimedOut:false};
  }})});
  assert.equal(calls,1);
  assert.equal(result.status,'completed');
  assert.equal(result.findings.length,0);
  const {evaluation}=JSON.parse(await readFile(join(runDir,'report.json'),'utf8'));
  const inputArtifact=(await readdir(runDir)).find(name=>name.startsWith('evaluation-input-'))!;
  const {schema}=JSON.parse(await readFile(join(runDir,inputArtifact),'utf8'));
  assert.ok(schema.required.includes('imageLayouts'));
  const imageLayouts=schema.properties.imageLayouts;
  assert.equal(imageLayouts.type,'array');
  assert.equal(imageLayouts.minItems,1);
  assert.ok(imageLayouts.items.required.includes('regions'));
  assert.equal(imageLayouts.items.properties.regions.minItems,1);
  assert.ok(evaluation.limitations.some((message:string)=>message.includes('일반 영역을 표시할 수 없습니다')) === (mode!=='mixed'));
  assert.deepEqual(evaluation.imageLayouts,mode==='mixed'?[{
   observationId:result.observations[0].observationId,evidenceId:result.evidence[0].evidenceId,
   regions:[{label:'본문',bounds:{x:0,y:.2,width:1,height:.6}}],focusAreas:[],
  }]:undefined);
 }
}));
