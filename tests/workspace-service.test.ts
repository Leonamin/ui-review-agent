import {readStoredReviewTask} from './helpers/review-state.js';
import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm,mkdir,writeFile,readFile,rename,unlink} from 'node:fs/promises';import {tmpdir} from 'node:os';import {resolve} from 'node:path';import {randomUUID,createHash} from 'node:crypto';import {ReviewService} from '../src/review-service.js';import type {inspect} from '../src/core.js';import type {RunSpec} from '../src/types.js';
async function waitFor(fn:()=>Promise<boolean>){const end=Date.now()+4000;while(Date.now()<end){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw new Error('timeout');}
async function report(spec:RunSpec,root:string){const runId=randomUUID(),runDir=resolve(root,runId);await mkdir(runDir,{recursive:true});const result={runId,status:'partial',endedAt:new Date().toISOString(),findings:[],observations:[],...(spec.followup?{followup:{requestId:spec.followup.requestId,workspaceId:spec.followup.workspaceId,status:'completed',reason:'observed',restoration:{status:'replayed',reason:'current DOM'},history:[],replay:[],needsImageHandoff:false}}:{})};await writeFile(resolve(runDir,'report.json'),JSON.stringify(result));return{result,runDir};}
const source=async(reportId:string)=>({reportId,reportSha256:'a'.repeat(64),runId:'source-run'});
async function setup(handler?:typeof inspect){const root=await mkdtemp(resolve(tmpdir(),'workspace-'));const service=new ReviewService(root,{inspect:handler??report as typeof inspect});await service.start();const project=await service.addProject({name:'Test'}),workspace=await service.addWorkspace({projectId:project.projectId,name:'Products',goal:'Review filters'});return{root,service,project,workspace};}
const firstInput=()=>({submissionId:randomUUID(),target:{kind:'url',url:'https://example.test/?scope=all#products'}});
async function initial(service:ReviewService,id:string){const result=await service.submitWorkspaceInitial(id,firstInput());await waitFor(async()=>!!(await service.workspace(id)).workspace.latestReportId);return result;}
test('workspace initial/followup immutable source, idempotency, snapshot budget and membership CAS',async()=>{const ctx=await setup();const {service,workspace,root}=ctx;try{const first=await initial(service,workspace.workspaceId);const before=await service.workspace(workspace.workspaceId),parent=before.workspace.latestReportId!;const parentAttempt=before.requests[0].attempts[0];const path=resolve(root,'review-attempts',parentAttempt.attemptId,parentAttempt.runId!,'report.json'),original=await readFile(path);const input={submissionId:randomUUID(),parentReportId:parent,instruction:'Choose a representative category'};const [a,b]=await Promise.all([service.submitWorkspaceFollowup(workspace.workspaceId,input,source),service.submitWorkspaceFollowup(workspace.workspaceId,input,source)]);assert.equal(a.request.requestId,b.request.requestId);assert.equal(a.request.source!.targetUrl,'https://example.test/?scope=all#products');assert.equal(a.request.options.timeoutSeconds,1200);await assert.rejects(service.submitWorkspaceFollowup(workspace.workspaceId,{...input,instruction:'different'},source),/다른/);await waitFor(async()=>(await service.workspace(workspace.workspaceId)).requests.at(-1)!.attempts[0].status==='completed');assert.deepEqual(await readFile(path),original);const task=await readStoredReviewTask(service, first.request.taskId);assert.equal(task.title,'Products');assert.equal(task.purpose,'Review filters');assert.equal(task.revisions.length,2);assert.equal(task.revisions[1].targets.length,1);const project=await service.addProject({name:'Moved'});await service.moveWorkspace(workspace.workspaceId,{projectId:project.projectId,expectedVersion:1});await assert.rejects(service.moveWorkspace(workspace.workspaceId,{projectId:ctx.project.projectId,expectedVersion:1}),/変更|변경/);}finally{await service.close();await rm(root,{recursive:true,force:true});}});
test('legacy migration IDs and user membership persist through restart without touching reports',async()=>{const root=await mkdtemp(resolve(tmpdir(),'workspace-migration-'));let service=new ReviewService(root,{inspect:report as typeof inspect});try{await service.start();const created=await service.submit({submissionId:randomUUID(),title:'Legacy',purpose:'Original',targets:[{kind:'url',name:'Home',url:'https://legacy.test/?q=1'}]});await waitFor(async()=>(await readStoredReviewTask(service, created.task.taskId)).revisions[0].targets[0].attempts[0].status==='completed');const before=await service.workspaces();assert.equal(before.length,1);const id=before[0].workspaceId;const project=await service.addProject({name:'Manual'});await service.moveWorkspace(id,{projectId:project.projectId,expectedVersion:1});await service.close();service=new ReviewService(root,{inspect:report as typeof inspect});await service.start();assert.equal((await service.workspaces()).length,1);assert.equal((await service.workspace(id)).project.projectId,project.projectId);}finally{await service.close();await rm(root,{recursive:true,force:true});}});
test('same-workspace queue is serial, cancellation remains terminal, predecessor failure blocks continuation',async()=>{let active=0,maxActive=0,release:()=>void=()=>{};const ctx=await setup((async(spec,root,dependencies)=>{if(!spec.followup)return report(spec,root);active++;maxActive=Math.max(maxActive,active);try{await new Promise<void>((resolve,reject)=>{release=resolve;dependencies.signal?.addEventListener('abort',()=>reject(new Error('cancelled')),{once:true});});return report(spec,root);}finally{active--;}}) as typeof inspect);const {service,root,workspace}=ctx;try{await initial(service,workspace.workspaceId);const parent=(await service.workspace(workspace.workspaceId)).workspace.latestReportId!;const a=await service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'One'},source);await waitFor(async()=>active===1);const b=await service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'Two'},source);await service.cancelWorkspaceRequest(a.request.requestId,{attemptId:a.request.attempts[0].attemptId});await waitFor(async()=>(await service.workspace(workspace.workspaceId)).requests.find(r=>r.requestId===b.request.requestId)!.attempts[0].status==='failed');const requests=(await service.workspace(workspace.workspaceId)).requests;assert.equal(requests.find(r=>r.requestId===a.request.requestId)!.attempts[0].status,'cancelled');assert.equal(requests.find(r=>r.requestId===b.request.requestId)!.needsImageHandoff,true);assert.equal(maxActive,1);release();}finally{await service.close();await rm(root,{recursive:true,force:true});}});
test('classification moves metadata to a linked workspace, keeps source fixed and survives restart',async()=>{const ctx=await setup((async(spec,root)=>{const out=await report(spec,root);if(spec.followup){const result=out.result as any;result.followup.scopeSuggestion={kind:'new-workspace',name:'Character detail',goal:'Review character details',reason:'The instruction opens a separate detail screen'};await writeFile(resolve(out.runDir,'report.json'),JSON.stringify(result));}return out;}) as typeof inspect);let {service}=ctx;try{await initial(service,ctx.workspace.workspaceId);const parent=(await service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId!;const input={submissionId:randomUUID(),parentReportId:parent,instruction:'Open the character detail'};const created=await service.submitWorkspaceFollowup(ctx.workspace.workspaceId,input,source);await waitFor(async()=>(await service.workspace(ctx.workspace.workspaceId)).linkedWorkspaces.length===1);const original=await service.workspace(ctx.workspace.workspaceId),linked=await service.workspace(original.linkedWorkspaces[0].workspaceId);assert.equal(linked.requests[0].requestId,created.request.requestId);assert.equal(linked.requests[0].parentReportId,parent);assert.equal(linked.requests[0].source!.reportId,parent);assert.match(linked.requests[0].classification!.reason,/detail/);assert.equal(original.workspace.latestReportId,parent);assert.equal((await service.workspaceContext(linked.workspace.latestReportId!)).workspace!.workspaceId,linked.workspace.workspaceId);await service.close();service=new ReviewService(ctx.root,{inspect:report as typeof inspect});await service.start();assert.equal((await service.workspace(linked.workspace.workspaceId)).requests[0].source!.reportId,parent);}finally{await service.close();await rm(ctx.root,{recursive:true,force:true});}});
test('queued cancellation is idempotent and duplicate intake does not reload deleted source',async()=>{let release:()=>void=()=>{};const ctx=await setup((async(spec,root)=>{if(spec.followup)await new Promise<void>(r=>{release=r;});return report(spec,root);}) as typeof inspect);const {service,workspace,root}=ctx;try{await initial(service,workspace.workspaceId);const parent=(await service.workspace(workspace.workspaceId)).workspace.latestReportId!,input={submissionId:randomUUID(),parentReportId:parent,instruction:'First'};const a=await service.submitWorkspaceFollowup(workspace.workspaceId,input,source);const b=await service.submitWorkspaceFollowup(workspace.workspaceId,{...input,submissionId:randomUUID(),instruction:'Queued'},source);await service.cancelWorkspaceRequest(b.request.requestId,{attemptId:b.request.attempts[0].attemptId});await service.cancelWorkspaceRequest(b.request.requestId,{attemptId:b.request.attempts[0].attemptId});assert.equal((await service.workspace(workspace.workspaceId)).requests.find(r=>r.requestId===b.request.requestId)!.attempts[0].status,'cancelled');const duplicate=await service.submitWorkspaceFollowup(workspace.workspaceId,input,async()=>{throw new Error('Source deleted after accepted intake');});assert.equal(duplicate.request.requestId,a.request.requestId);release();await waitFor(async()=>(await service.workspace(workspace.workspaceId)).requests.find(r=>r.requestId===a.request.requestId)!.attempts[0].status==='completed');}finally{release();await service.close();await rm(root,{recursive:true,force:true});}});

test('selected source snapshot is private, hash-bound and separate from current-run observations',async()=>{const sharp=(await import('sharp')).default;const bytes=await sharp({create:{width:32,height:32,channels:3,background:'white'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');let hasSeenSnapshot=false;const ctx=await setup((async(spec,root)=>{if(spec.followup){assert.deepEqual(await readFile(spec.followup.sourceImagePath!),bytes);hasSeenSnapshot=true;}return report(spec,root);}) as typeof inspect);try{await initial(ctx.service,ctx.workspace.workspaceId);const parent=(await ctx.service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId!,input={submissionId:randomUUID(),parentReportId:parent,instruction:'Review this selected filter',imageId:'b'.repeat(64),sourceSha256:sha256,region:{x:0,y:0,width:20,height:20}};const load=async(reportId:string)=>({...await source(reportId),image:{reportId,imageId:input.imageId,runId:'old-run',observationId:'old-obs',evidenceId:'old-image',sha256,width:32,height:32},imageBytes:bytes});const created=await ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,input,load);assert.doesNotMatch(JSON.stringify(created),/followup-sources|sourceImagePath|imageBytes/);await waitFor(async()=>hasSeenSnapshot);await assert.rejects(ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{...input,submissionId:randomUUID(),sourceSha256:'c'.repeat(64)},load),/변경/);}finally{await ctx.service.close();await rm(ctx.root,{recursive:true,force:true});}});

test('initial request canonicalizes target key order and rejects caller-assigned target identity',async()=>{const ctx=await setup();try{const input=firstInput();const a=await ctx.service.submitWorkspaceInitial(ctx.workspace.workspaceId,input),b=await ctx.service.submitWorkspaceInitial(ctx.workspace.workspaceId,{target:{url:input.target.url,kind:'url'},submissionId:input.submissionId});assert.equal(a.request.requestId,b.request.requestId);await assert.rejects(ctx.service.submitWorkspaceInitial(ctx.workspace.workspaceId,{...firstInput(),target:{kind:'url',url:'https://example.test',targetId:randomUUID()}}));}finally{await ctx.service.close();await rm(ctx.root,{recursive:true,force:true});}});

test('moving a report moves its request and all report memberships, leaves source latest coherent and appends audit',async()=>{const ctx=await setup();try{await initial(ctx.service,ctx.workspace.workspaceId);const original=await ctx.service.workspace(ctx.workspace.workspaceId),request=original.requests[0],reportId=original.workspace.latestReportId!;const destination=await ctx.service.addWorkspace({projectId:ctx.project.projectId,name:'Moved screen',goal:'Review'});await ctx.service.attachWorkspaceReport(destination.workspaceId,{reportId,expectedVersion:destination.version},source);const from=await ctx.service.workspace(ctx.workspace.workspaceId),to=await ctx.service.workspace(destination.workspaceId);assert.equal(from.requests.length,0);assert.equal(from.workspace.latestReportId,undefined);assert.equal(from.reportIds.length,0);assert.equal(to.requests[0].requestId,request.requestId);assert.equal(to.workspace.latestReportId,reportId);assert.equal(to.membershipEvents!.length,1);assert.equal(to.membershipEvents![0].fromId,ctx.workspace.workspaceId);await ctx.service.moveWorkspaceRequest(request.requestId,{workspaceId:ctx.workspace.workspaceId,expectedVersion:to.workspace.version});assert.equal((await ctx.service.workspace(destination.workspaceId)).workspace.latestReportId,undefined);assert.equal((await ctx.service.workspace(ctx.workspace.workspaceId)).membershipEvents!.length,2);}finally{await ctx.service.close();await rm(ctx.root,{recursive:true,force:true});}});
test('restart reconnects report artifacts, membership and classification after a worker-finalization crash',async()=>{const ctx=await setup((async(spec,root)=>{const out=await report(spec,root);if(spec.followup){(out.result as any).followup.scopeSuggestion={kind:'new-workspace',name:'Detail',goal:'Inspect detail',reason:'New purpose'};await writeFile(resolve(out.runDir,'report.json'),JSON.stringify(out.result));}return out;}) as typeof inspect);let service=ctx.service;try{await initial(service,ctx.workspace.workspaceId);const parent=(await service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId!;const created=await service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'Open detail'},source);await waitFor(async()=>(await service.workspace(ctx.workspace.workspaceId)).linkedWorkspaces.length===1);await service.close();const path=resolve(service.stateRoot,'state.json'),state=JSON.parse(await readFile(path,'utf8')),data=state.workspaceData,request=data.requests.find((r:any)=>r.requestId===created.request.requestId),lostId=request.workspaceId;request.workspaceId=ctx.workspace.workspaceId;delete request.result;delete request.classification;data.workspaces=data.workspaces.filter((w:any)=>w.workspaceId!==lostId);data.memberships=data.memberships.filter((m:any)=>m.reportId===parent);data.movements=[];for(const task of state.tasks)for(const revision of task.revisions)if(revision.workspaceRequestId){const attempt=revision.targets[0].attempts[0];attempt.status='running';delete attempt.reportId;delete attempt.endedAt;}data.memberships=[];delete data.workspaces[0].latestReportId;await writeFile(path,JSON.stringify(state));service=new ReviewService(ctx.root,{inspect:report as typeof inspect});await service.start();const recovered=await service.workspace(ctx.workspace.workspaceId);assert.equal(recovered.workspace.latestReportId,parent);assert.equal(recovered.linkedWorkspaces.length,1);const child=await service.workspace(recovered.linkedWorkspaces[0].workspaceId);assert.equal(child.requests[0].attempts[0].status,'completed');assert.equal(child.reportIds.length,1);assert.equal(child.requests[0].result!.scopeSuggestion!.reason,'New purpose');const childId=child.workspace.workspaceId;await service.close();service=new ReviewService(ctx.root,{inspect:report as typeof inspect});await service.start();assert.equal((await service.workspace(ctx.workspace.workspaceId)).linkedWorkspaces[0].workspaceId,childId);assert.equal((await service.workspace(childId)).membershipEvents!.length,1);}finally{await service.close();await rm(ctx.root,{recursive:true,force:true});}});
test('cross-task requests in one workspace dispatch in submission order rather than legacy task order',async()=>{let unblock:()=>void=()=>{};const order:string[]=[];const ctx=await setup((async(spec,root)=>{if(spec.followup){order.push(spec.followup.instruction);if(spec.followup.instruction==='Blocking')await new Promise<void>(r=>{unblock=r;});}return report(spec,root);}) as typeof inspect);try{await initial(ctx.service,ctx.workspace.workspaceId);const a=(await ctx.service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId!;const other=await ctx.service.addWorkspace({projectId:ctx.project.projectId,name:'Other',goal:'Inspect'});await initial(ctx.service,other.workspaceId);const b=(await ctx.service.workspace(other.workspaceId)).workspace.latestReportId!;await ctx.service.attachWorkspaceReport(ctx.workspace.workspaceId,{reportId:b,expectedVersion:ctx.workspace.version},source);await ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{submissionId:randomUUID(),parentReportId:a,instruction:'Blocking'},source);await waitFor(async()=>order.length===1);await ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{submissionId:randomUUID(),parentReportId:b,instruction:'B'},source);await ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{submissionId:randomUUID(),parentReportId:a,instruction:'C'},source);unblock();await waitFor(async()=>(await ctx.service.workspace(ctx.workspace.workspaceId)).requests.at(-1)!.attempts[0].status==='completed');assert.deepEqual(order,['Blocking','B','C']);}finally{unblock();await ctx.service.close();await rm(ctx.root,{recursive:true,force:true});}});
test('image-parent followup dispatches immutable PNG with the same instruction and no live URL',async()=>{const sharp=(await import('sharp')).default;const bytes=await sharp({create:{width:48,height:32,channels:3,background:'white'}}).png().toBuffer(),sha256=createHash('sha256').update(bytes).digest('hex');let hasImageFollowup=false;const ctx=await setup((async(spec,root)=>{assert.equal(spec.projectPostPolicy,undefined);if(spec.followup){assert.equal(spec.targetUrl,undefined);assert(spec.imagePath);assert.deepEqual(await readFile(spec.imagePath),bytes);assert.equal(spec.followup.instruction,'이 글자가 읽기 쉬운지 확인');hasImageFollowup=true;}return report(spec,root);}) as typeof inspect);try{await ctx.service.updateProjectPostHosts(ctx.project.projectId,{postAllowedHosts:['api.project.test'],expectedVersion:ctx.project.version});const asset=await ctx.service.upload({fileName:'screen.png',base64:bytes.toString('base64')});await ctx.service.submitWorkspaceInitial(ctx.workspace.workspaceId,{submissionId:randomUUID(),target:{kind:'image',assetId:asset.assetId}});await waitFor(async()=>!!(await ctx.service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId);const parent=(await ctx.service.workspace(ctx.workspace.workspaceId)).workspace.latestReportId!;const created=await ctx.service.submitWorkspaceFollowup(ctx.workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'이 글자가 읽기 쉬운지 확인'},async reportId=>({...await source(reportId),image:{reportId,imageId:'b'.repeat(64),runId:'old',observationId:'image-1',evidenceId:'image-1',sha256,width:48,height:32},imageBytes:bytes}));assert.equal(created.request.source?.targetUrl,undefined);await waitFor(async()=>hasImageFollowup);}finally{await ctx.service.close();await rm(ctx.root,{recursive:true,force:true});}});
test('queued workspace order survives restart and unrelated interrupted work is not promoted to success',async()=>{const root=await mkdtemp(resolve(tmpdir(),'workspace-restart-order-')),order:string[]=[];let hasBlocked=false;const engine=(async(spec:RunSpec,out:string,dependencies:any)=>{if(spec.targetUrl?.includes('block.test')){hasBlocked=true;await new Promise<void>((_resolve,reject)=>dependencies.signal.addEventListener('abort',()=>reject(new Error('interrupted')),{once:true}));}if(spec.followup)order.push(spec.followup.instruction);return report(spec,out);}) as typeof inspect;let service=new ReviewService(root,{inspect:engine,maxConcurrentReviews:1});try{await service.start();const project=await service.addProject({name:'Queue'}),workspace=await service.addWorkspace({projectId:project.projectId,name:'Catalog',goal:'Review'});await initial(service,workspace.workspaceId);const parent=(await service.workspace(workspace.workspaceId)).workspace.latestReportId!;const blocking=await service.addWorkspace({projectId:project.projectId,name:'Block',goal:'Review'});await service.submitWorkspaceInitial(blocking.workspaceId,{submissionId:randomUUID(),target:{kind:'url',url:'https://block.test'}});await waitFor(async()=>hasBlocked);await service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'First'},source);await service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'Second'},source);await service.close();service=new ReviewService(root,{inspect:engine,maxConcurrentReviews:1});await service.start();await waitFor(async()=>(await service.workspace(workspace.workspaceId)).requests.at(-1)!.attempts[0].status==='completed');assert.deepEqual(order,['First','Second']);assert.equal((await service.workspace(blocking.workspaceId)).requests[0].attempts[0].status,'failed');}finally{await service.close();await rm(root,{recursive:true,force:true});}});

test('bound workspace URL runs snapshot project POST hosts; subsequent changes can only narrow the grant',async()=>{
    const api='api.project.test',retained='existing.project.test',added='new.project.test';
    const seen:{spec:RunSpec;check?: (projectId:string,host:string)=>boolean}[]=[];
    let release=()=>{};
    const ctx=await setup((async(spec,root,deps)=>{
        seen.push({spec,check:deps.canSendProjectPost});
        if(spec.followup?.instruction==='Hold') await new Promise<void>(resolve=>{release=resolve;});
        return report(spec,root);
    }) as typeof inspect);
    const {service,workspace,project,root}=ctx;
    try {
        const first=await service.updateProjectPostHosts(project.projectId,{expectedVersion:project.version,postAllowedHosts:[api,retained]});
        await initial(service,workspace.workspaceId);
        assert.deepEqual(seen[0].spec.projectPostPolicy,{projectId:project.projectId,hosts:[api,retained]});
        assert.equal(seen[0].check?.(project.projectId,api),false,'finished runs lose the live grant');
        const parent=(await service.workspace(workspace.workspaceId)).workspace.latestReportId!;
        const followup=(instruction:string)=>service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction},source);
        await followup('Hold');
        await waitFor(async()=>seen.length===2);
        const active=seen[1].check!;
        assert.equal(active(project.projectId,api),true);
        assert.equal(active(randomUUID(),api),false);
        await followup('Queued');
        const second=await service.updateProjectPostHosts(project.projectId,{expectedVersion:first.version,postAllowedHosts:[retained,added]});
        assert.equal(active(project.projectId,api),false);
        assert.equal(active(project.projectId,added),false);
        await service.updateProjectPostHosts(project.projectId,{expectedVersion:second.version,postAllowedHosts:[retained,added,api]});
        assert.equal(active(project.projectId,api),false,'re-adding a host does not resurrect old accepted grants');
        assert.equal(active(project.projectId,retained),true);
        release();
        await waitFor(async()=>seen.length===3);
        assert.deepEqual(seen[2].spec.projectPostPolicy,{projectId:project.projectId,hosts:[retained]});
        await service.submit({title:'Legacy',purpose:'Review',project:project.name,submissionId:randomUUID(),targets:[{kind:'url',name:'Legacy',url:'https://example.test'}]});
        await waitFor(async()=>seen.length===4);
        assert.equal(seen[3].spec.projectPostPolicy,undefined,'legacy project display names do not authorize POST');
        assert.equal(seen[3].check,undefined);
        await followup('Hold');
        await waitFor(async()=>seen.length===5);
        const newest=seen[4].check!;
        assert.equal(newest(project.projectId,api),true,'newly submitted work sees current project configuration');
        const destination=await service.addProject({name:'Other',description:'Another isolated project'});
        const moved=await service.moveWorkspace(workspace.workspaceId,{expectedVersion:workspace.version,projectId:destination.projectId});
        assert.equal(newest(project.projectId,api),false);
        await service.moveWorkspace(workspace.workspaceId,{expectedVersion:moved.version,projectId:project.projectId});
        assert.equal(newest(project.projectId,api),false,'moving back does not resurrect the old grant');
    } finally {release();await service.close();await rm(root,{recursive:true,force:true});}
});

test('legacy projects default to no POST or Supabase auth grants and edits persist across service restart',async()=>{
    const {root,project,workspace,service}=await setup();
    await service.close();
    const file=resolve(service.stateRoot,'state.json');
    const older=JSON.parse(await readFile(file,'utf8'));
    delete older.workspaceData.projects[0].postAllowedHosts;
    delete older.workspaceData.projects[0].supabaseAuthBindings;
    await writeFile(file,JSON.stringify(older));
    let reopened=new ReviewService(root,{inspect:report as typeof inspect});
    try{
        await reopened.start();
        const legacy=(await reopened.workspace(workspace.workspaceId)).project;
        assert.deepEqual(legacy.postAllowedHosts,[]);
        assert.deepEqual(legacy.supabaseAuthBindings,[]);
        const updated=await reopened.updateProjectPostHosts(project.projectId,{expectedVersion:legacy.version,postAllowedHosts:['api.project.test']});
        const bindings=[{targetOrigin:'https://example.test',origin:'https://exampleproject.supabase.co'}];
        await reopened.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:updated.version,supabaseAuthBindings:bindings});
        await reopened.close();
        reopened=new ReviewService(root,{inspect:report as typeof inspect});
        await reopened.start();
        const restored=(await reopened.workspace(workspace.workspaceId)).project;
        assert.deepEqual(restored.postAllowedHosts,['api.project.test']);
        assert.deepEqual(restored.supabaseAuthBindings,bindings);
    }finally{await reopened.close();await rm(root,{recursive:true,force:true});}
});

test('a Supabase login grant binds to the accepted URL and workspace and is revoked for active and waiting requests',async()=>{
    const targetOrigin='https://example.test';
    const origin='https://exampleproject.supabase.co';
    const bindings=[{targetOrigin,origin}];
    let release=()=>{};
    type Auth = NonNullable<Parameters<typeof inspect>[2]>['projectSupabaseAuth'];
    const inspected:Array<{spec:RunSpec;policy:Auth}>=[];
    const ctx=await setup((async(spec,root,runtime)=>{
        inspected.push({spec,policy:runtime.projectSupabaseAuth});
        if(spec.purpose==='Hold')await new Promise<void>(resolve=>{
            const releaseOther=release;
            release=()=>{releaseOther();resolve();};
        });
        return report(spec,root);
    }) as typeof inspect);
    const {service,project,workspace,root}=ctx;
    const password={method:'password',username:'test-user',password:'fixture-password'};
    const submit=async(workspaceId:string,url=`${targetOrigin}/products`,shouldWaitForStart=true)=>
        (await service.submitWorkspaceInitial(workspaceId,{submissionId:randomUUID(),target:{kind:'url',url,shouldWaitForStart}})).request;
    const start=(request:Awaited<ReturnType<typeof submit>>,credentials?:{method:string;username?:string;password?:string;code?:string})=>
        service.startReviewTarget(request.taskId,request.revisionId,request.targetId,{attemptId:request.attempts[0].attemptId,credentials});
    try{
        const preexisting=await submit(workspace.workspaceId);
        let current=await service.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:project.version,supabaseAuthBindings:bindings});
        await start(preexisting,password);
        await waitFor(async()=>inspected.length===1);
        assert.equal(inspected[0].policy,undefined,'a pre-existing request cannot inherit a newly added binding');

        const hold=await service.addWorkspace({projectId:project.projectId,name:'Protected products',goal:'Hold'});
        await start(await submit(hold.workspaceId),password);
        await waitFor(async()=>inspected.length===2);
        const active=inspected[1].policy!;
        assert.equal(active.targetOrigin,targetOrigin);
        assert.equal(active.origin,origin);
        assert.equal(active.canSend(),true);
        assert.equal('projectSupabaseAuth' in inspected[1].spec,false,'the runtime grant stays out of stored run specs');
        await assert.rejects(service.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:project.version,supabaseAuthBindings:[]}),/변경/);
        assert.equal(active.canSend(),true,'a stale save cannot revoke an unchanged grant');

        const secondHold=await service.addWorkspace({projectId:project.projectId,name:'Hold another slot',goal:'Hold'});
        await start(await submit(secondHold.workspaceId),password);
        await waitFor(async()=>inspected.length===3);
        const waiting=await submit(workspace.workspaceId);
        const queuedWorkspace=await service.addWorkspace({projectId:project.projectId,name:'Queued screen',goal:'Review'});
        const queued=await submit(queuedWorkspace.workspaceId);
        await start(queued,password);
        assert.equal((await service.workspace(queuedWorkspace.workspaceId)).requests[0].attempts[0].status,'queued');
        current=await service.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:current.version,supabaseAuthBindings:[]});
        assert.equal(active.canSend(),false);
        await service.updateProjectSupabaseAuthBindings(project.projectId,{expectedVersion:current.version,supabaseAuthBindings:bindings});
        assert.equal(active.canSend(),false,'re-adding a binding cannot restore old permissions');
        await assert.rejects(start(waiting,password),/Supabase 로그인 허용이 변경/);
        release();
        const queuedLatest=async()=>(await service.workspace(queuedWorkspace.workspaceId)).requests[0].attempts.at(-1)!;
        await waitFor(async()=>(await queuedLatest()).status==='awaiting-start');
        assert.match((await queuedLatest()).error??'',/Supabase 로그인 허용이 변경/);
        assert.equal(inspected.length,3,'revocation cannot fall back to native form submission');
        await start(waiting);
        await waitFor(async()=>inspected.length===4);
        assert.equal(inspected[3].policy,undefined);

        await start(await submit(workspace.workspaceId,'https://other.example.test/products'),password);
        await waitFor(async()=>inspected.length===5);
        assert.equal(inspected[4].policy,undefined);
        await start(await submit(workspace.workspaceId),{method:'code',code:'012345'});
        await waitFor(async()=>inspected.length===6);
        assert.equal(inspected[5].policy,undefined);

        const legacy=await service.submit({title:'Legacy',purpose:'Review',project:project.name,submissionId:randomUUID(),
            targets:[{kind:'url',name:'Legacy',url:`${targetOrigin}/products`,shouldWaitForStart:true}]});
        const legacyTarget=legacy.revision.targets[0];
        await service.startReviewTarget(legacy.task.taskId,legacy.revision.revisionId,legacyTarget.targetId,{attemptId:legacyTarget.attempts[0].attemptId,credentials:password});
        await waitFor(async()=>inspected.length===7);
        assert.equal(inspected[6].policy,undefined,'a project name on legacy intake is not authorization');

        const moving=await submit(workspace.workspaceId);
        const other=await service.addProject({name:'Another project'});
        const moved=await service.moveWorkspace(workspace.workspaceId,{expectedVersion:workspace.version,projectId:other.projectId});
        await service.moveWorkspace(workspace.workspaceId,{expectedVersion:moved.version,projectId:project.projectId});
        await assert.rejects(start(moving,password),/Supabase 로그인 허용이 변경/,'moving back cannot restore the accepted permission');
    }finally{release();await service.close();await rm(root,{recursive:true,force:true});}
});

test('moving a legacy parent report out and back permanently revokes an active followup POST grant',async()=>{
    const host='api.project.test';
    let release=()=>{};
    let check:((projectId:string,host:string)=>boolean)|undefined;
    const ctx=await setup((async(spec,root,deps)=>{
        if(spec.followup){
            check=deps.canSendProjectPost;
            await new Promise<void>(resolve=>{release=resolve;});
        }
        return report(spec,root);
    }) as typeof inspect);
    const {service,project,workspace,root}=ctx;
    try{
        await service.updateProjectPostHosts(project.projectId,{expectedVersion:project.version,postAllowedHosts:[host]});
        const legacy=await service.submit({title:'Legacy',purpose:'Review',project:project.name,submissionId:randomUUID(),targets:[{kind:'url',name:'Legacy',url:'https://example.test'}]});
        const getReport=async()=> (await readStoredReviewTask(service, legacy.task.taskId)).revisions[0].targets[0].attempts[0].reportId;
        await waitFor(async()=>!!await getReport());
        const parent=(await getReport())!;
        await service.attachWorkspaceReport(workspace.workspaceId,{reportId:parent,expectedVersion:workspace.version},source);
        await service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId:parent,instruction:'Follow up'},source);
        await waitFor(async()=>!!check);
        assert.equal(check!(project.projectId,host),true);
        const other=await service.addWorkspace({projectId:project.projectId,name:'Other',goal:'Review'});
        await service.attachWorkspaceReport(other.workspaceId,{reportId:parent,expectedVersion:other.version},source);
        assert.equal(check!(project.projectId,host),false);
        const prior=(await service.workspace(workspace.workspaceId)).workspace;
        await service.attachWorkspaceReport(workspace.workspaceId,{reportId:parent,expectedVersion:prior.version},source);
        assert.equal(check!(project.projectId,host),false);
    }finally{release();await service.close();await rm(root,{recursive:true,force:true});}
});

test('a POST allowlist write failure does not widen in-memory or persisted authorization',async()=>{
    let submitted:RunSpec|undefined;
    const ctx=await setup((async(spec,root)=>{
        submitted=spec;
        return report(spec,root);
    }) as typeof inspect);
    const {service,project,workspace,root}=ctx;
    const backup=service.stateRoot+'-saved';
    const before=await readFile(resolve(service.stateRoot,'state.json'));
    try{
        await rename(service.stateRoot,backup);
        try{
            await writeFile(service.stateRoot,'this file prevents creating the temporary state file');
            try{
                await assert.rejects(service.updateProjectPostHosts(project.projectId,{expectedVersion:project.version,postAllowedHosts:['api.project.test']}),{code:'ENOTDIR'});
            } finally {await unlink(service.stateRoot);}
        } finally {await rename(backup,service.stateRoot);}
        assert.deepEqual((await service.workspace(workspace.workspaceId)).project,project);
        assert.deepEqual(await readFile(resolve(service.stateRoot,'state.json')),before);
        await initial(service,workspace.workspaceId);
        assert.equal(submitted?.projectPostPolicy,undefined);
    } finally {await service.close();await rm(root,{recursive:true,force:true});}
});


test('replay dismissal evidence uses the hash-pinned explicit parent without changing the latest execution base',async()=>{
    const replay=[{type:'click',role:'button',label:'Close',dismissMethod:'close-button'},{type:'click',role:'button',label:'Latest'}];
    const dispatched=new Map<string,NonNullable<RunSpec['followup']>>();
    const ctx=await setup((async(spec,root)=>{
        const out=await report(spec,root);
        if(!spec.followup)return out;
        dispatched.set(spec.followup.instruction,structuredClone(spec.followup));
        const result=out.result as any;
        result.followup.replay=replay;
        if(['Parent proof','Conflict proof'].includes(spec.followup.instruction)){
            const modalTitle=spec.followup.instruction==='Parent proof'?'Preferences':'Other';
            result.followup.history=[{step:1,actionId:'action-1',type:'click',label:'Close',outcome:'success',beforeObservationId:'obs-001',afterObservationId:'obs-002'}];
            result.actions=[{actionId:'action-1',type:'click',outcome:'success',beforeObservationId:'obs-001',afterObservationId:'obs-002'}];
            result.observations=[
                {observationId:'obs-001',runId:out.result.runId,accessibilitySnapshot:`- dialog "${modalTitle}":\n  - button "Close"`,elements:[{elementRef:'e0',role:'dialog',accessibleName:modalTitle,isVisible:true,isModal:true}]},
                {observationId:'obs-002',runId:out.result.runId,accessibilitySnapshot:'- heading "Catalog"',elements:[]},
            ];
        }
        await writeFile(resolve(out.runDir,'report.json'),JSON.stringify(result));
        return out;
    }) as typeof inspect);
    const {service,workspace,root}=ctx;
    try{
        await initial(service,workspace.workspaceId);
        const starter=(await service.workspace(workspace.workspaceId)).workspace.latestReportId!;
        const submit=(parentReportId:string,instruction:string,load=source)=>service.submitWorkspaceFollowup(workspace.workspaceId,{submissionId:randomUUID(),parentReportId,instruction},load);
        const findAttempt=async(reportId:string)=>(await service.workspace(workspace.workspaceId)).requests.flatMap(req=>req.attempts).find(a=>a.reportId===reportId)!;
        const readParent=async(reportId:string)=>{
            const attempt=await findAttempt(reportId);
            const path=resolve(root,'review-attempts',attempt.attemptId,attempt.runId!,'report.json');
            return {reportId,runId:attempt.runId!,reportSha256:createHash('sha256').update(await readFile(path)).digest('hex')};
        };
        const waitDone=async(requestId:string)=>{
            await waitFor(async()=>((await service.workspace(workspace.workspaceId)).requests.find(req=>req.requestId===requestId)?.attempts.at(-1)?.status==='completed'));
            return (await service.workspace(workspace.workspaceId)).requests.find(req=>req.requestId===requestId)!.attempts.at(-1)!.reportId!;
        };
        const parent=await submit(starter,'Parent proof');
        const pinnedId=await waitDone(parent.request.requestId);
        const tail=await submit(starter,'Failed tail with no dismissal observations');
        assert.equal(tail.request.parentReportId,starter);
        const tailId=await waitDone(tail.request.requestId);
        const expected=[{replayIndex:0,modalFingerprint:createHash('sha256').update(JSON.stringify(['dialog','Preferences'])).digest('hex')}];
        assert.deepEqual(dispatched.get('Failed tail with no dismissal observations')?.executionBase?.dismissalEvidence,expected,
            'the immediate execution base can prove history even when the explicit parent has none');
        const verified=await submit(pinnedId,'Explicit source',readParent);
        await waitDone(verified.request.requestId);
        const args=dispatched.get('Explicit source')!;
        assert.equal(args.source.reportId,pinnedId);
        assert.equal(args.executionBase?.reportId,tailId);
        assert.equal(args.executionBaseRequestId,tail.request.requestId);
        assert.deepEqual(args.executionBase?.replay,replay);
        assert.deepEqual(args.executionBase?.dismissalEvidence,expected);
        const other=await submit(pinnedId,'Unexpected bytes',async id=>({...await readParent(id),reportSha256:'d'.repeat(64)}));
        await waitDone(other.request.requestId);
        assert.equal(dispatched.get('Unexpected bytes')?.executionBase?.dismissalEvidence,undefined);
        const different=await submit(pinnedId,'Conflict proof',readParent);
        await waitDone(different.request.requestId);
        const conflict=await submit(pinnedId,'Conflicting sources',readParent);
        await waitDone(conflict.request.requestId);
        assert.equal(dispatched.get('Conflicting sources')?.executionBase?.dismissalEvidence,undefined,
            'disagreeing canonical reports cannot authorize that replay index');
        assert.deepEqual(dispatched.get('Conflicting sources')?.executionBase?.dismissalConflicts,[0],
            'the explicit conflict reaches the runtime and disables legacy fallback for that replay group');
    }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

test('style comparisons keep queue order without becoming live follow-up replay bases',async()=>{
    const order:string[]=[];
    let release=()=>{};
    const ctx=await setup((async(spec,root)=>{
        if(spec.autoStyleComparison){
            order.push('style comparison');
            throw new Error('Comparison browser failed');
        }
        if(spec.followup){
            order.push(spec.followup.instruction);
            if(spec.followup.instruction==='prior live review')await new Promise<void>(resolve=>{release=resolve;});
            else {
                assert.equal(spec.followup.executionBaseRequestId,priorRequestId);
                assert.equal(spec.followup.executionBase?.requestId,priorRequestId);
            }
        }
        return report(spec,root);
    }) as typeof inspect);
    let priorRequestId:string|undefined;
    const {service,workspace,root}=ctx;
    const workspaceId=workspace.workspaceId;
    try {
        await initial(service,workspaceId);
        const parentReportId=(await service.workspace(workspaceId)).workspace.latestReportId!;
        const next=(instruction:string)=>service.submitWorkspaceFollowup(workspaceId,{submissionId:randomUUID(),parentReportId,instruction},source);
        priorRequestId=(await next('prior live review')).request.requestId;
        await waitFor(async()=>order.length===1);
        const pair=await service.submitWorkspaceInitial(workspaceId,{
            submissionId:randomUUID(),
            target:{...firstInput().target,comparisonUrl:'https://example.test/?scope=recent'},
        });
        const following=await next('later live review');
        assert.equal(following.request.queuePredecessorRequestId,pair.request.requestId);
        assert.equal(following.request.executionBaseRequestId,priorRequestId);
        release();
        await waitFor(async()=> (await service.workspace(workspaceId)).requests.at(-1)?.attempts[0].status==='completed');
        const finished=(await service.workspace(workspaceId)).requests;
        assert.equal(finished.find(request=>request.requestId===pair.request.requestId)?.attempts[0].status,'failed');
        assert.equal(finished.at(-1)?.needsImageHandoff,false);
        assert.deepEqual(order,['prior live review','style comparison','later live review']);
    }finally{
        release();
        await service.close();
        await rm(root,{recursive:true,force:true});
    }
});
