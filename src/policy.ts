import {normalizeProjectPostHost,PROJECT_POST_HOST_LIMIT} from './post-host-policy.js';
import type { AllowedAction, CoverageState, Check, RunSpec } from './types.js';
import { evaluationBudgetSchema } from './review-contract.js';
import { MAX_REVIEW_TIMEOUT_SECONDS } from './evaluation-budget.js';
import { reviewEvaluatorSchema } from './review-settings.js';
import { themeReviewSchema } from './theme-review.js';
import { alignmentContractsSchema } from './group-alignment.js';
import { styleComparisonSchema } from './style-comparison.js';
import { autoStyleComparisonConfigSchema } from './automatic-style-comparison.js';
export class PolicyError extends Error { constructor(public code:string,message:string){super(message);} }
export function validateSpec(spec:RunSpec):void {
 if(spec.followup&&((!spec.targetUrl&&!spec.imagePath)||!spec.followup.instruction?.trim()||!spec.followup.workspaceId||!spec.followup.requestId||!Number.isSafeInteger(spec.followup.maxOptions)||spec.followup.maxOptions<1||spec.followup.maxOptions>3||spec.followup.scopeMode!==undefined&&!['selected-only','related-screen'].includes(spec.followup.scopeMode)))throw new PolicyError('invalid-followup','Follow-up requires a source, immutable parent, instruction and one to three representative options.');
 if(spec.limits.maxDurationMs>MAX_REVIEW_TIMEOUT_SECONDS*1000)throw new PolicyError('invalid-limit',`Run duration must not exceed ${MAX_REVIEW_TIMEOUT_SECONDS} seconds.`);
 const modalOptions=spec.stateDiscovery?.modalExploration;
 if(modalOptions&&(!Number.isSafeInteger(modalOptions.maxAttempts??3)||(modalOptions.maxAttempts??3)<1||(modalOptions.maxAttempts??3)>3||modalOptions.canChoosePreferences!==undefined&&typeof modalOptions.canChoosePreferences!=='boolean'||modalOptions.preferenceHint!==undefined&&(typeof modalOptions.preferenceHint!=='string'||!modalOptions.preferenceHint.trim()||modalOptions.preferenceHint.length>500)))throw new PolicyError('invalid-modal-exploration','Modal exploration requires 1 to 3 attempts, a boolean preference permission and an optional hint up to 500 characters.');
 if(spec.stateDiscovery && [spec.stateDiscovery.readySelector,spec.stateDiscovery.loadingSelector].some(selector=>selector!==undefined&&(typeof selector!=='string'||!selector.trim()||selector.length>500)))throw new PolicyError('invalid-state-hint','State hints require a CSS selector of 1 to 500 characters.');
 if(spec.stateDiscovery && (spec.imagePath || !Number.isSafeInteger(spec.stateDiscovery.maxWaitMs??15000) || (spec.stateDiscovery.maxWaitMs??15000)<0 || (spec.stateDiscovery.maxWaitMs??15000)>120000 || !Number.isSafeInteger(spec.stateDiscovery.maxDismissals??1) || (spec.stateDiscovery.maxDismissals??1)<0 || (spec.stateDiscovery.maxDismissals??1)>2))throw new PolicyError('invalid-state-discovery','State discovery requires a URL, wait up to 120000ms and at most two dismissals.');
 if(spec.evaluationBudget && (!evaluationBudgetSchema.safeParse(spec.evaluationBudget).success || spec.evaluator!=='openai-compatible' || (spec.strategy??'A')!=='A' || (spec.reviewPipeline??'standard')!=='standard' || spec.evaluationBudget.stageTimeoutSeconds*1000>spec.limits.maxDurationMs))throw new PolicyError('invalid-evaluation-budget','Explicit budgets require compatible standard strategy A and must fit within the run limit.');
 if(spec.evaluator!=='rules-only'&&!reviewEvaluatorSchema.safeParse(spec.evaluator).success)throw new PolicyError('invalid-evaluator','Unsupported evaluator provider.');
 if(spec.strategy!==undefined&&!['A','B','C'].includes(spec.strategy))throw new PolicyError('invalid-strategy','Strategy must be A, B or C.');
 if(spec.reasoningEffort!==undefined&&!['low','medium','high'].includes(spec.reasoningEffort))throw new PolicyError('invalid-effort','Reasoning effort must be low, medium or high.');
 if(spec.model!==undefined&&!spec.model.trim())throw new PolicyError('invalid-model','Model must not be empty.');
 if(spec.evaluator==='rules-only'&&(spec.model!==undefined||spec.reasoningEffort!==undefined||(spec.strategy!==undefined&&spec.strategy!=='A')))throw new PolicyError('invalid-evaluator-options','Rules-only does not support model, reasoning effort or AI strategies B/C.');
 const hasImage=typeof spec.imagePath==='string'&&spec.imagePath.trim().length>0;
 const hasUrl=typeof spec.targetUrl==='string'&&spec.targetUrl.trim().length>0;
 const post=spec.projectPostPolicy;
 if(post&&(!hasUrl||spec.hasMutationPermission||spec.shouldWaitForLogin||typeof post.projectId!=='string'||!post.projectId.trim()||!Array.isArray(post.hosts)||post.hosts.length<1||post.hosts.length>PROJECT_POST_HOST_LIMIT||new Set(post.hosts).size!==post.hosts.length||post.hosts.some(host=>typeof host!=='string'||normalizeProjectPostHost(host)!==host)))throw new PolicyError('invalid-project-post-policy','Project POST permission requires canonical exact DNS hosts and a read-only URL review.');

 if(spec.themeReview&&(!themeReviewSchema.safeParse(spec.themeReview).success||!hasUrl||spec.followup||spec.mode!=='quick'||spec.shouldVerify||spec.limits.maxObservations<2))throw new PolicyError('invalid-theme-review','Theme comparison requires a quick URL review with at least two observations and no follow-up or interactive verification.');
 if(spec.alignmentContracts&&(!alignmentContractsSchema.safeParse(spec.alignmentContracts).success||!hasUrl||spec.followup))throw new PolicyError('invalid-alignment-contracts','Alignment contracts require valid group rules and an initial URL review.');
 if(spec.reviewPipeline!==undefined&&!['standard','observation-ledger'].includes(spec.reviewPipeline))throw new PolicyError('invalid-pipeline','Unknown review pipeline.');
 if(spec.reviewPipeline==='observation-ledger'&&(!hasImage||(spec.strategy??'A')!=='A'||spec.evaluator==='rules-only'))throw new PolicyError('invalid-pipeline','Observation ledger requires one image, an AI evaluator and strategy A.');
 if(hasImage===hasUrl)throw new PolicyError('invalid-input','Provide exactly one URL or image file.');
 if(hasImage){
  if(spec.evaluator==='rules-only')throw new PolicyError('invalid-image-options','Image input requires an AI evaluator; DOM rules are unavailable.');
  if(spec.mode!=='quick'||spec.shouldVerify||spec.allowedActions.length||spec.allowedOrigins.length||spec.hasMutationPermission||spec.isHeaded||spec.shouldWaitForLogin||spec.limits.maxActions!==0)throw new PolicyError('invalid-image-options','Image input does not support browser actions, verification, origins, mutations or login.');
 }else{
 const url=new URL(spec.targetUrl!);
 if(!['http:','https:'].includes(url.protocol)||url.username||url.password) throw new PolicyError('invalid-url','Only HTTP(S) URLs without credentials are supported.');
 for(const origin of spec.allowedOrigins) if(new URL(origin).origin!==origin) throw new PolicyError('invalid-origin','Allowed origins must be exact origins.');
 if(!spec.allowedOrigins.includes(url.origin)) throw new PolicyError('scope-denied','Target origin is not allowed.');
 }
 if(spec.styleComparison&&spec.autoStyleComparison)
  throw new PolicyError('invalid-style-comparison','Choose automatic or selector-based style comparison.');
 if(spec.styleComparison||spec.autoStyleComparison){
  const parsed=spec.styleComparison?styleComparisonSchema.safeParse(spec.styleComparison):autoStyleComparisonConfigSchema.safeParse(spec.autoStyleComparison);
  if(!parsed.success||!hasUrl||spec.mode!=='quick'||spec.evaluator!=='rules-only'||spec.limits.maxObservations<2||
   spec.followup||spec.themeReview||spec.alignmentContracts?.length||spec.stateDiscovery||spec.shouldWaitForLogin||spec.shouldVerify||post||spec.hasMutationPermission)
   throw new PolicyError('invalid-style-comparison','Style comparison requires a read-only, quick rules-only URL review with at least two observations.');
  const reference=new URL(spec.targetUrl!),comparison=new URL(parsed.data.comparisonUrl);
  if(reference.origin!==comparison.origin||reference.href===comparison.href)
   throw new PolicyError('invalid-style-comparison','Specify a distinct comparison URL on the same origin as the reference.');
 }
 if(spec.mode==='quick' && (spec.allowedActions.length>0||spec.limits.maxActions!==0)) throw new PolicyError('scope-denied','Quick mode cannot execute actions.');
 if(spec.mode==='interaction' && !spec.allowedActions.length) throw new PolicyError('scope-denied','Interaction requires an explicit action allowlist.');
 const ids=new Set<string>();
 for(const action of spec.allowedActions){
  if(ids.has(action.id)||!action.id||!action.selector||!action.description)throw new PolicyError('invalid-action','Action IDs must be unique and all actions require selector and description.');
  ids.add(action.id);
  if(!['click','fill','press'].includes(action.type))throw new PolicyError('invalid-action','Unsupported action.');
  if(['fill','press'].includes(action.type)&&typeof action.value!=='string')throw new PolicyError('invalid-action','Action requires value.');
 }
 for(const [key,value] of Object.entries(spec.limits))if(!Number.isSafeInteger(value)||value<0||(key!=='maxActions'&&value===0))throw new PolicyError('invalid-limit',`Invalid ${key}.`);
 if(spec.shouldWaitForLogin&&!spec.isHeaded)throw new PolicyError('invalid-auth-mode','Manual login requires --headed.');
 for(const v of Object.values(spec.viewport))if(!Number.isFinite(v)||v<=0)throw new PolicyError('invalid-viewport','Viewport values must be positive.');
}
export function assertOrigin(url:string,spec:RunSpec):void {if(!spec.allowedOrigins.includes(new URL(url).origin))throw new PolicyError('scope-denied','Navigation outside configured origins was blocked.');}
export class Budget {
 private actionCount=0; private observationCount=0;private toolCount=0;
 private reservedObservations=0;
 constructor(public readonly spec:RunSpec,private startedAt=Date.now()){}
 resetClock():void{this.startedAt=Date.now();}
 remainingMs():number{return Math.max(0,this.spec.limits.maxDurationMs-(Date.now()-this.startedAt));}
 remainingObservations():number{return this.spec.limits.maxObservations-this.observationCount-this.reservedObservations;}
 async preservingObservations<T>(count:number,run:()=>Promise<T>):Promise<T>{
  this.reservedObservations+=count;
  try{return await run();}finally{this.reservedObservations-=count;}
 }
 assertTime():void{if(this.remainingMs()<=0)throw new PolicyError('budget-exceeded','Automatic inspection time limit reached.');}
 takeTool():void{this.assertTime();if(this.toolCount>=this.spec.limits.maxToolCalls)throw new PolicyError('budget-exceeded','Tool limit reached.');this.toolCount++;}
 takeObservation():void{this.assertTime();if(this.remainingObservations()<=0)throw new PolicyError('budget-exceeded','Observation limit reached.');this.observationCount++;}
 takeAction(id:string):AllowedAction{this.assertTime();if(this.spec.mode!=='interaction')throw new PolicyError('scope-denied','Actions are disabled in quick mode.');const action=this.spec.allowedActions.find(a=>a.id===id);if(!action)throw new PolicyError('scope-denied','Action ID is not in the allowlist.');if(this.actionCount>=this.spec.limits.maxActions)throw new PolicyError('budget-exceeded','Action limit reached.');this.actionCount++;return action;}
}
export function computeCoverage(checks:Check[],observed:Map<string,string[]>,reasons:Map<string,string>,hasValidEvaluation:boolean):CoverageState {
 const requiredChecks=checks.filter(c=>c.isRequired).map(c=>c.checkId);
 const observedChecks=[...observed].filter(([id,refs])=>checks.some(c=>c.checkId===id)&&refs.length>0).map(([checkId,evidenceIds])=>({checkId,evidenceIds}));
 const unmetChecks=requiredChecks.filter(id=>!observedChecks.some(c=>c.checkId===id)).map(checkId=>({checkId,reason:reasons.get(checkId)??'Not observed',state:reasons.has(checkId)?'failed' as const:'pending' as const}));
 const completionBlockers=[...unmetChecks.map(c=>c.reason),...(!hasValidEvaluation?['Evaluation is incomplete']:[])];
 return {requiredChecks,observedChecks,unmetChecks,canFinish:unmetChecks.length===0&&hasValidEvaluation,completionBlockers};
}
export function safeUrl(raw:string):string {const url=new URL(raw);url.username='';url.password='';url.search='';url.hash='';return url.toString();}
