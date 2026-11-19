import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {inspect} from '../src/core.js';
import {autoStyleComparisonReportSchema,makeAutomaticStyleComparison,settleAutomaticStyles,type AutoStyleProbe} from '../src/automatic-style-comparison.js';
import {validateSpec} from '../src/policy.js';
import type {RunSpec} from '../src/types.js';

const run = promisify(execFile);
const cliPath=fileURLToPath(new URL('../src/cli.ts',import.meta.url));

function spec(a:URL,b:URL):RunSpec{
 return {targetUrl:a.href,autoStyleComparison:{comparisonUrl:b.href},mode:'quick',evaluator:'rules-only',
  viewport:{width:800,height:600,deviceScaleFactor:1},allowedActions:[],allowedOrigins:[a.origin],
  hasMutationPermission:false,isHeaded:false,shouldWaitForLogin:false,
  limits:{maxDurationMs:30_000,maxObservations:2,maxActions:0,maxToolCalls:10,maxFindings:10}};
}

async function fixture(use:(origin:string,root:string)=>Promise<void>){
 const root=await mkdtemp(join(tmpdir(),'automatic-style-'));
 const server=createServer((request,response)=>{
  const url=new URL(request.url??'/','http://localhost');
  const isComparison=url.pathname==='/b'||url.pathname==='/404';
  const controls=url.pathname==='/unrelated'?'<input type="radio" aria-label="별개 옵션">':`
   <label for="search">${isComparison?'보고서 검색':'프로젝트 검색'}</label>
   <input id="search" type="search" value="masked-control-secret" style="height:44px;border-radius:${isComparison?999:16}px">
   <button>공통 동작</button><button>반복 동작</button><button>반복 동작</button>
   <button>${isComparison?'보고서 전용':'프로젝트 전용'}</button>
   <button style="display:none">숨긴 버튼</button>
   <a href="/" ${isComparison?'':'aria-current="page"'}>홈</a>`;
  const startup=url.pathname==='/b'?`<script>setTimeout(()=>{
   const url=new URL(location.href);url.searchParams.set('default','app');history.replaceState(null,'',url);
  },100)</script>`:'';
  response.writeHead(url.pathname==='/404'?404:200,{'Content-Type':'text/html; charset=utf-8'}).end(`
    <!doctype html><html lang="ko"><head><title>스타일 검사 fixture</title></head><body><main>${controls}</main>${startup}</body></html>`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();
 assert(address&&typeof address!=='string');
 try{await use(`http://127.0.0.1:${address.port}`,root);}
 finally{
  server.closeAllConnections();
  await new Promise<void>(resolve=>server.close(()=>resolve()));
  await rm(root,{recursive:true,force:true});
 }
}

test('discovers comparable controls from two URLs using the CLI without extra arguments',()=>fixture(async(origin,root)=>{
 const {stdout}=await run(process.execPath,['--import','tsx',cliPath,'--url',origin+'/a','--compare-url',origin+'/b?secret=route-secret','--output',root]);
 const summary=JSON.parse(stdout);
 assert.equal(summary.provider,'rules-only');
 assert.equal(summary.status,'completed');
 assert.deepEqual(summary.autoStyleComparison,{matched:2,changed:1,unmatched:2,ambiguous:6,unmeasured:0,isMeasured:true});
 const raw=await readFile(join(dirname(summary.report),'report.json'),'utf8');
 const report=JSON.parse(raw);
 const comparison=autoStyleComparisonReportSchema.parse(report.observations[0].deterministicChecks.autoStyleComparison);
 assert.equal(comparison.reference.inspected,6);
 assert.equal(comparison.comparison.inspected,6);
 assert.doesNotMatch(raw,/route-secret|masked-control-secret/);
 assert.doesNotMatch(await readFile(join(dirname(summary.report),'manifest.json'),'utf8'),/route-secret/);
 const search=comparison.matches.find(candidate=>candidate.role==='searchbox');
 assert.equal(search?.method,'unique-role');
 assert.equal(search?.reference.label,'프로젝트 검색');
 assert.equal(search?.comparison.label,'보고서 검색');
 assert.deepEqual(search?.differences,[{property:'border-top-left-radius',reference:'16px',comparison:'999px'}]);
 assert.deepEqual(comparison.matches.find(candidate=>candidate.role==='button')?.differences,[]);
 assert.equal(comparison.ambiguous.filter(entry=>entry.label==='홈').length,2);
 const check=report.coverage.observedChecks.find((check:{checkId:string})=>check.checkId==='style-comparison');
 assert.deepEqual(check.evidenceIds,[comparison.evidenceId,comparison.reference.screenshotEvidenceId,comparison.comparison.screenshotEvidenceId]);
}));

test('keeps zero matches and an unusable comparison separate from successful measurements',()=>fixture(async(origin,root)=>{
 const a=new URL(origin+'/a');
 const zero=await inspect(spec(a,new URL(origin+'/unrelated')),root);
 assert.equal(zero.result.status,'partial');
 const summary=zero.result.observations[0].deterministicChecks?.autoStyleComparison;
 assert.equal(summary?.coverage.matched,0);
 assert.equal(summary?.coverage.unmatched,7);
 assert(zero.result.coverage.unmetChecks.some(check=>check.checkId==='style-comparison'&&check.reason.includes('쌍')));

 const failed=await inspect(spec(a,new URL(origin+'/404')),root);
 assert.equal(failed.result.status,'partial');
 const failedSummary=failed.result.observations[0].deterministicChecks?.autoStyleComparison;
 assert.equal(failedSummary?.comparison.reason,'http-error');
 assert(failedSummary.comparison.screenshotEvidenceId);
 assert.deepEqual(failedSummary.coverage,{matched:0,changed:0,unmatched:0,ambiguous:0,unmeasured:6});
}));

test('rejects another origin and excludes unstable measurements before pairing',()=>{
 const a=new URL('http://localhost/a');
 assert.throws(()=>validateSpec(spec(a,new URL('http://example.test/b'))),/same origin/);
 const probe:AutoStyleProbe={hasReachedLimit:false,entries:[{
  label:'검색',selector:'input:nth-of-type(1)',role:'searchbox',scope:'main',interactionState:'',
  bounds:{x:8,y:8,width:100,height:44},values:{height:'44px'},
 }]};
 const changed:AutoStyleProbe={...probe,entries:[{...probe.entries[0],values:{height:'43px'}}]};
 const reference=settleAutomaticStyles(probe,changed,true,value=>value);
 const comparison=settleAutomaticStyles(probe,probe,true,value=>value);
 const report=makeAutomaticStyleComparison({url:a.href,sample:reference},{url:new URL('/b',a).href,sample:comparison});
 assert.deepEqual(report.coverage,{matched:0,changed:0,unmatched:0,ambiguous:0,unmeasured:2});
 assert.equal(report.unmeasured[0].reason,'unstable');
});

test('does not pair identical button names across conflicting contexts or truncated scans',()=>{
 const sample=(scope:string,hasReachedLimit=false)=>({
  hasReachedLimit,
  entries:[{label:'삭제',selector:'button:nth-of-type(1)',role:'button' as const,scope,interactionState:'',
   bounds:{x:8,y:8,width:100,height:44},values:{height:'44px'}}],
 });
 const compare=(scope:string,hasReachedLimit=false)=>makeAutomaticStyleComparison(
  {url:'http://localhost/a',sample:sample('main 주문 작업')},
  {url:'http://localhost/b',sample:sample(scope,hasReachedLimit)},
 );
 assert.equal(compare('main 주문 작업').coverage.matched,1);
 assert.equal(compare('aside 검색 필터').coverage.ambiguous,2);
 assert.equal(compare('main 검색 필터').coverage.ambiguous,2);
 assert.equal(compare('main 주문 작업',true).coverage.ambiguous,2);
 const partial=makeAutomaticStyleComparison(
  {url:'http://localhost/a',sample:sample('main 주문 작업')},
  {url:'http://localhost/b',sample:{...sample('main 주문 작업',true),incompleteRoles:['link']}},
 );
 assert.equal(partial.coverage.matched,1);
 assert.equal(partial.comparison.hasReachedLimit,true);
});
