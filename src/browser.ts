import {assertNativePreflightPatch,NATIVE_REVIEW_CORS_CONTEXT,NATIVE_SUPABASE_REVIEW_CORS_CONTEXT,permittedProjectPostUrl,sendProjectPost,PROJECT_POST_BODY_LIMIT,type ProjectPostPolicy} from './post-host-policy.js';
import {ActionNetworkRecorder} from './action-network.js';
import {classifyBlockedTelemetry} from './blocked-telemetry.js';
import {collectOcclusionEvidence} from './occlusion-observation.js';
import {chromium,type Browser,type BrowserContext,type Page,type JSHandle,type Route,type Request} from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import type {RunSpec,Observation,RuleFinding,ActionRecord,ModalActionMethod,BlockedBrowserRequest} from './types.js';
import {Budget,assertOrigin,PolicyError,safeUrl} from './policy.js';
import {EvidenceStore} from './evidence.js';
import {readModalSnapshot,readModalButton} from './modal-exploration.js';
import {collectMoneyRelations} from './money-relations.js';
import {measureFormRowAlignment,measureGroupAlignment,type GroupAlignmentReport} from './group-alignment.js';
import {measureLayoutSpacing,type LayoutSpacingReport} from './layout-spacing.js';
import {sampleComputedStyle,type StyleSample} from './style-comparison.js';
import {probeAutomaticStyles,settleAutomaticStyles,type AutoStyleProbe,type AutoStyleSample} from './automatic-style-comparison.js';
import {collectThemeContrast,probeTheme,type ThemeMode,type ThemeProbe} from './theme-review.js';
import {activeReplayModal} from './replay-dismissal.js';
import {assertAuthenticatedReviewTarget,assertReviewCredentialIsHidden,canDetectReviewLoginRedirect,getAuthenticatedReviewState,readRedirectedReviewLogin,ReviewAuthenticationError,type ReviewCredentials,type ReviewLoginRequired} from './review-auth.js';
import {forwardReviewSupabaseRequest,type ProjectSupabaseAuth} from './review-supabase-transport.js';
function isRequestedStylePage(actual:URL,expected:URL):boolean{
 return actual.origin===expected.origin&&actual.pathname===expected.pathname&&actual.hash===expected.hash&&
  [...new Set(expected.searchParams.keys())].every(key=>JSON.stringify(actual.searchParams.getAll(key))===JSON.stringify(expected.searchParams.getAll(key)));
}
export interface ReadinessProbe {hasLoadingSignal:boolean;hasContentSignal:boolean;hasVisibleModal:boolean;hasPendingImages:boolean;hasRequiredReadyHint:boolean;fingerprint:string}
export interface ModalActionCandidate {type:ModalActionMethod;elementRef:string|null;label?:string}
export interface ModalActionContext {modalRef:string;title:string;semanticKey:string;actions:ModalActionCandidate[];blockedReason?:string}
export interface DismissCandidate {elementRef:string;label:string}
// Runs in the page; keep this function self-contained and never execute page-authored code.
function readDismissTarget(el:Element):{label:string;signature:string}|null {
 const modal=el.closest('dialog[open],[role="dialog"],[aria-modal="true"]');
 if(!modal||!(el.tagName==='BUTTON'||el.getAttribute('role')==='button')||el.closest('form,a[href],area[href]')||el.hasAttribute('href')||el.hasAttribute('formaction')||el.hasAttribute('download')||(el instanceof HTMLButtonElement&&(el.form!==null||el.getAttribute('type')==='submit'))||el.matches(':disabled,[disabled],[aria-disabled="true"]')||el.closest('[inert]'))return null;
 const label=(el.getAttribute('aria-label')||el.getAttribute('title')||el.textContent||'').replace(/\s+/g,' ').trim();
 if(!/^(?:닫기|나중에|다음에|취소|close|dismiss|not now|later|cancel|[x×✕✖])$/i.test(label))return null;
 const text=(modal.textContent??'').replace(/\s+/g,' ').trim();
 if(/로그인|회원가입|동의|개인정보|쿠키|권한|결제|삭제|제출|저장|구매|구독|\b(?:consent|cookies?|permissions?|log\s?in|sign\s?(?:in|up)|payment|purchase|delete|submit|subscribe|save)\b/i.test(text)||modal.querySelector('input,textarea,select,[contenteditable="true"]'))return null;
 const box=el.getBoundingClientRect(),css=getComputedStyle(el);
 if(box.width<=0||box.height<=0||box.top<0||box.left<0||box.bottom>innerHeight||box.right>innerWidth||css.visibility!=='visible'||css.display==='none'||Number(css.opacity)===0)return null;
 const hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);if(!hit||!el.contains(hit))return null;
 return {label,signature:JSON.stringify({label,text,tag:el.tagName,box:{x:box.x,y:box.y,width:box.width,height:box.height}})};
}
export interface BrowserPhysicalContext {browser:Browser;context:BrowserContext;page:Page;owner?:BrowserSession}
export interface BrowserRuntimeDependencies {canSendProjectPost?:(projectId:string,hostname:string)=>boolean;sendProjectPost?:typeof sendProjectPost;projectSupabaseAuth?:ProjectSupabaseAuth}
export class BrowserSession {
 browser?:Browser;context?:BrowserContext;page?:Page;
 readonly observations:Observation[]=[];readonly rules:RuleFinding[]=[];readonly actions:ActionRecord[]=[];readonly warnings:string[]=[];
 readonly blockedRequests:BlockedBrowserRequest[]=[];
 private hasUnknownBlockedDataRequests=false;
 get hasBlockingDataRequests(){return this.hasUnknownBlockedDataRequests;}
 private dismissBindings=new Map<string,{handle:JSHandle<Element>;signature:string}>();
 private dismissalCount=0;
 private modalActionCount=0;
 private modalBinding?:{observationId:string;modalRef:string;handle:JSHandle<Element>;signature:string;semanticKey:string;actions:ModalActionCandidate[];buttons:Map<string,{handle:JSHandle<Element>;signature:string}>;backdrop?:JSHandle<Element>;backdropPoint?:{x:number;y:number};replayFingerprint?:string};
 private isDismissingAutomatically=false;
 private automaticNavigationBlocks=0;
 private hasActiveModalNavigationGuard=false;
 private modalNavigationCheckpoint=0;
 private modalNavigationBaselineUrl?:string;
 private isBusy=false;
 private isClosed=false;
 private startPromise?:Promise<void>;
 private latestElements?:JSHandle<Element[]>;
 private observationElements=new Map<string,JSHandle<Element[]>>();
 private capturedThemeProbe?:{observationId:string;probe: ThemeProbe};
 private capturedSpacing?:{observationId:string;spacing:LayoutSpacingReport};
 private capturedFormRows=new Map<string,GroupAlignmentReport>();
 private reportedFormRows=new Set<string>();
 private hasStyleReferenceHttpError=false;
 private authenticatedOrigin?:URL;
 private authenticatedSupabase?:ProjectSupabaseAuth;
 private supabaseAccessToken?:string;
 private loginSecret?:string;
 private mainNavigationVersion=0;
 private shouldDetectLoginDuringCapture=false;
 private expectedLoginDocument?:{url:string;navigationVersion:number};
 private loginCaptureError?:ReviewAuthenticationError|ReviewLoginRequired;
 private redactionValues:string[]=[];
 private redact(text:string,isStructured=false):string{return this.redactionValues.reduce((value,secret)=>{
  if(secret.length>3)return value.split(secret).join('[input value omitted]');
  const escaped=secret.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const replaceToken=(part:string)=>part.replace(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'gu'),'[input value omitted]');
  // Native aria metadata (for example heading [level=1]) is not input content.
  return isStructured?value.replace(/"(?:[^"\\]|\\.)*"|(?<=: ).*$/gm,replaceToken):replaceToken(value);
 },text);}

 private isAwaitingLogin=false;
 private physical?:BrowserPhysicalContext;
 readonly actionNetwork:ActionNetworkRecorder;
 private readonly postPolicy?:ProjectPostPolicy;
 private readonly postAbort=new AbortController();
 constructor(readonly spec:RunSpec,readonly budget:Budget,readonly store:EvidenceStore,physical?:BrowserPhysicalContext,private readonly runtime:BrowserRuntimeDependencies={}){
  this.physical=physical;this.actionNetwork=new ActionNetworkRecorder(spec.targetUrl??'');
  if(spec.projectPostPolicy)this.postPolicy={projectId:spec.projectPostPolicy.projectId,hosts:[...spec.projectPostPolicy.hosts]};
 }
 private recordBlockedPost(req:Request,reason:Parameters<ActionNetworkRecorder['blocked']>[1],statusCode?:number,preflightMethod?:string){
  const method=req.method(),resourceType=req.resourceType();
  const telemetry=reason==='read-only-method'&&!req.redirectedFrom()?classifyBlockedTelemetry(this.spec.targetUrl,req.url(),method,resourceType,preflightMethod):undefined;
  if(telemetry){
   const warning=`Telemetry request blocked by the inspection policy (${telemetry}, ${method})`;
   if(!this.warnings.includes(warning))this.warnings.push(warning);
  }else{
   if(preflightMethod||['xhr','fetch','websocket'].includes(resourceType))this.hasUnknownBlockedDataRequests=true;
   this.warnings.push(reason==='read-only-method'?`Blocked ${method} request in read-only mode`:`Blocked ${method} request (${reason})`);
  }
  if(this.blockedRequests.length<30)this.blockedRequests.push({method,origin:new URL(req.url()).origin,resourceType,...(telemetry?{telemetry}:{})});
  this.actionNetwork.blocked(req,reason,statusCode,telemetry);
 }
 private async forwardProjectPost(route:Route,req:Request,url:URL,policy:ProjectPostPolicy,method:'POST'|'OPTIONS'='POST'):Promise<void>{
  const canSend=()=>!this.isClosed&&this.physical?.owner===this&&this.budget.remainingMs()>0&&this.runtime.canSendProjectPost?.(policy.projectId,url.hostname)===true;
  if(!canSend()){this.recordBlockedPost(req,'project-post-revoked',undefined,method==='OPTIONS'?'POST':undefined);await route.abort('blockedbyclient');return;}
  const body=method==='POST'?req.postDataBuffer():null;
  if((body?.length??0)>PROJECT_POST_BODY_LIMIT){this.recordBlockedPost(req,'project-post-size');await route.abort('blockedbyclient');return;}
  let result:Awaited<ReturnType<typeof sendProjectPost>>;
  try{
   const headers=await req.allHeaders();
   result=await(this.runtime.sendProjectPost??sendProjectPost)({url,headers,body,method,timeoutMs:Math.min(15000,this.budget.remainingMs()),signal:this.postAbort.signal,canSend,onDispatch:()=>this.actionNetwork.allowedProjectPost(req)});
  }catch{result={kind:'failed'};}
  if(result.kind==='blocked'){this.recordBlockedPost(req,result.reason,result.statusCode,method==='OPTIONS'?'POST':undefined);await route.abort('blockedbyclient');return;}
  if(result.kind==='failed'){await route.abort('failed');return;}
  // Playwright adds permissive CORS to synthetic cross-origin responses when the header
  // is entirely absent. Preserve the upstream denial instead of having it inferred.
  const headers={...result.headers};
  if(!Object.keys(headers).some(key=>key.toLowerCase()==='access-control-allow-origin'))headers['access-control-allow-origin']='';
  await route.fulfill({status:result.status,headers,body:result.body});
 }
 async start(credentials?:ReviewCredentials):Promise<void>{
  if(this.isClosed)throw new PolicyError('closed','Browser session is closed');this.budget.assertTime();const pending=this.startInternal(credentials);this.startPromise=pending;try{await pending;}finally{this.startPromise=undefined;if(this.isClosed)await this.browser?.close().catch(()=>{});}
 }
 private async handleAuthenticatedRoute(route:Route):Promise<void>{
  try{
   // A later native redirect can bypass routing. Host-only cookies still span ports,
   // so forward a single hop and reject redirects before Chromium sees them.
   const response=await route.fetch({maxRedirects:0,maxRetries:0,timeout:Math.max(1,Math.min(15000,this.budget.remainingMs()))});
   try{
    const status=response.status();
    if(status>=300&&status<400&&status!==304){
     this.recordAuthenticatedBlock(route.request(),'Blocked a redirect in an authenticated review');
     await route.abort('blockedbyclient');return;
    }
    // Preserve upstream CORS denial for synthetic responses.
    const headers=response.headers();
    if(!Object.keys(headers).some(key=>key.toLowerCase()==='access-control-allow-origin'))headers['access-control-allow-origin']='';
    await route.fulfill({response,headers});
   }finally{await response.dispose().catch(()=>{});}
  }catch{await route.abort('failed').catch(()=>{});}
 }
 private recordAuthenticatedBlock(req:Request,warning:string):void{
  if(['fetch','xhr'].includes(req.resourceType()))this.hasUnknownBlockedDataRequests=true;
  if(!this.warnings.includes(warning))this.warnings.push(warning);
 }
 private async handleRoute(route:Route):Promise<void>{
  const req=route.request();
  if(this.authenticatedOrigin){
   const url=new URL(req.url());
   if(this.authenticatedSupabase&&url.origin===this.authenticatedSupabase.origin){
    const transferred=await forwardReviewSupabaseRequest(route,url,this.requirePage(),this.authenticatedSupabase,{accessToken:this.supabaseAccessToken},this.postAbort.signal,Math.min(15000,this.budget.remainingMs()));
    if(!transferred)this.recordAuthenticatedBlock(req,'Blocked a Supabase request outside the authenticated review permission');
    return;
   }
   if(url.origin!==this.authenticatedOrigin.origin&&(url.hostname===this.authenticatedOrigin.hostname||await req.headerValue('authorization'))){
    this.recordAuthenticatedBlock(req,'Blocked a cross-origin request in an authenticated review');
    await route.abort('blockedbyclient');return;
   }
  }
  if((this.isDismissingAutomatically||this.hasActiveModalNavigationGuard)&&req.isNavigationRequest()&&req.frame().parentFrame()===null){this.automaticNavigationBlocks++;this.warnings.push('Blocked navigation during automatic modal dismissal');this.actionNetwork.blocked(req,'modal-navigation');await route.fulfill({status:204,body:''});return;}
  if(this.postPolicy&&req.method()==='OPTIONS'){
   const requestedMethod=await req.headerValue('access-control-request-method');
   if(requestedMethod&&!['GET','HEAD','OPTIONS'].includes(requestedMethod)){
    const postUrl=requestedMethod==='POST'?permittedProjectPostUrl(req.url(),this.postPolicy):undefined;
    if(postUrl){await this.forwardProjectPost(route,req,postUrl,this.postPolicy,'OPTIONS');return;}
    this.recordBlockedPost(req,'read-only-method',undefined,requestedMethod);await route.abort('blockedbyclient');return;
   }
  }
  if(!this.isAwaitingLogin&&!this.spec.hasMutationPermission&&!['GET','HEAD','OPTIONS'].includes(req.method())){
   const postUrl=req.method()==='POST'&&this.postPolicy?permittedProjectPostUrl(req.url(),this.postPolicy):undefined;
   if(postUrl&&this.postPolicy){
    if(req.isNavigationRequest()&&req.frame().parentFrame()===null){try{assertOrigin(req.url(),this.spec);}catch{this.recordBlockedPost(req,'navigation-origin');await route.abort('blockedbyclient');return;}}
    await this.forwardProjectPost(route,req,postUrl,this.postPolicy);return;
   }
   this.recordBlockedPost(req,'read-only-method');await route.abort('blockedbyclient');return;
  }
  if(!this.isAwaitingLogin&&req.isNavigationRequest()&&req.frame().parentFrame()===null){try{assertOrigin(req.url(),this.spec);}catch{this.warnings.push('Blocked navigation outside allowed origins');this.actionNetwork.blocked(req,'navigation-origin');await route.abort('blockedbyclient');return;}}
  if(this.authenticatedOrigin){await this.handleAuthenticatedRoute(route);return;}
  await route.continue();
 }
 private async startInternal(credentials?:ReviewCredentials):Promise<void>{
  this.isAwaitingLogin=this.spec.shouldWaitForLogin;
  if(this.postPolicy)await assertNativePreflightPatch();
  if(this.physical){
   this.browser=this.physical.browser;this.context=this.physical.context;this.page=this.physical.page;this.physical.owner=this;
   if(!this.browser.isConnected()||this.page.isClosed())throw new PolicyError('closed','Retained browser is unavailable');
   assertOrigin(this.page.url(),this.spec);this.modalNavigationBaselineUrl=this.page.url();return;
  }
  this.browser=await chromium.launch({headless:!this.spec.isHeaded});if(this.isClosed)throw new PolicyError('closed','Browser session closed during launch');this.budget.assertTime();
  const viewport={width:this.spec.viewport.width,height:this.spec.viewport.height};
  const projectSupabaseAuth=credentials?.method==='password'?this.runtime.projectSupabaseAuth:undefined;
  const authentication=credentials?await getAuthenticatedReviewState(this.browser,this.spec.targetUrl!,credentials,viewport,()=>this.budget.remainingMs(),this.postAbort.signal,projectSupabaseAuth):undefined;
  if(this.isClosed)throw new PolicyError('closed','Browser session closed during authentication');this.budget.assertTime();
  if(credentials){
   this.authenticatedOrigin=new URL(this.spec.targetUrl!);
   this.authenticatedSupabase=projectSupabaseAuth;
   this.supabaseAccessToken=authentication?.accessToken;
   this.loginSecret=credentials.method==='password'?credentials.password:credentials.code;
   this.redactionValues=credentials.method==='password'?[credentials.username,this.loginSecret]:[this.loginSecret];
   if(this.supabaseAccessToken)this.redactionValues.push(this.supabaseAccessToken);
  }
  const nativeCors=projectSupabaseAuth?NATIVE_SUPABASE_REVIEW_CORS_CONTEXT:this.postPolicy?NATIVE_REVIEW_CORS_CONTEXT:undefined;
  this.context=await this.browser.newContext({viewport,storageState:authentication?.storageState,deviceScaleFactor:this.spec.viewport.deviceScaleFactor,serviceWorkers:'block',acceptDownloads:false,...(nativeCors?{baseURL:nativeCors}:{}),...(this.spec.themeReview?{colorScheme:'light' as const}:{})});
  this.page=await this.context.newPage();const physical:BrowserPhysicalContext={browser:this.browser,context:this.context,page:this.page,owner:this};this.physical=physical;
  await this.context.route('**/*',async route=>{if(physical.owner)await physical.owner.handleRoute(route);else await route.abort('blockedbyclient');});
  await this.context.routeWebSocket('**/*',ws=>{ws.close();const owner=physical.owner;if(owner){owner.hasUnknownBlockedDataRequests=true;if(owner.blockedRequests.length<30)owner.blockedRequests.push({method:'WEBSOCKET',origin:new URL(ws.url()).origin,resourceType:'websocket'});owner.warnings.push('WebSocket disabled during inspection');}});
  // Listeners live on the physical page; a lease always routes them to its current run.
  this.page.on('request',request=>physical.owner?.actionNetwork.request(request));
  this.page.on('response',response=>physical.owner?.actionNetwork.response(response));
  this.page.on('requestfailed',request=>physical.owner?.actionNetwork.failed(request));
  this.page.on('framenavigated',frame=>{if(frame===physical.page.mainFrame()&&physical.owner)physical.owner.mainNavigationVersion++;});
  this.page.on('dialog',dialog=>{void dialog.dismiss();});
  this.context.on('page',page=>{if(page!==physical.page&&(!physical.owner||!physical.owner.isAwaitingLogin)){physical.owner?.warnings.push('Unexpected popup closed');void page.close();}});
  const response=await this.page.goto(authentication?.targetUrl??this.spec.targetUrl!,{waitUntil:credentials?'load':'domcontentloaded',timeout:Math.min(30000,this.budget.remainingMs())});
  if((this.spec.styleComparison||this.spec.autoStyleComparison)&&response)this.hasStyleReferenceHttpError=response.status()>=400;
  if(credentials)await assertAuthenticatedReviewTarget(this.page,this.spec.targetUrl!,credentials,response);
  if(this.supabaseAccessToken)await assertReviewCredentialIsHidden(this.page,this.supabaseAccessToken);
  if(!this.isAwaitingLogin)assertOrigin(this.page.url(),this.spec);this.modalNavigationBaselineUrl=this.page.url();
 }
 async waitForStyleReference():Promise<void>{
  if(!this.isAwaitingLogin||!this.spec.autoStyleComparison)throw new Error('Manual style login is not active.');
  const reference=new URL(this.spec.targetUrl!);
  await this.requirePage().waitForURL(url=>isRequestedStylePage(url,reference),{waitUntil:'domcontentloaded',timeout:600_000});
 }
 async finishLogin():Promise<void>{
  const page=this.requirePage();
  assertOrigin(page.url(),this.spec);
  this.isAwaitingLogin=false;
  for(const otherPage of this.context?.pages()??[])if(otherPage!==page)await otherPage.close();
  this.budget.resetClock();
  if(!this.spec.autoStyleComparison)return;
  // Manual login may land on a dashboard rather than on the requested reference.
  const referenceUrl=this.spec.targetUrl!;
  const response=await page.goto(referenceUrl,{waitUntil:'domcontentloaded',timeout:Math.min(30000,this.budget.remainingMs())});
  assertOrigin(page.url(),this.spec);
  if(!isRequestedStylePage(new URL(page.url()),new URL(referenceUrl)))
   throw new PolicyError('style-login-reference','로그인 후 기준 화면을 열 수 없습니다. 로그인 상태와 접근 권한을 확인하세요.');
  this.hasStyleReferenceHttpError=(response?.status()??0)>=400;
 }

 async prepareLoginCapture(expectedLoginUrl?:string,shouldOnlyReadCurrent=false):Promise<void>{
  this.shouldDetectLoginDuringCapture=!expectedLoginUrl&&canDetectReviewLoginRedirect(this.spec.targetUrl!);
  if(!expectedLoginUrl&&!this.shouldDetectLoginDuringCapture)return;
  const candidate=await this.waitForRedirectedLogin(expectedLoginUrl,shouldOnlyReadCurrent);
  if(expectedLoginUrl&&!candidate)throw new ReviewAuthenticationError('redirect-changed');
  if(!expectedLoginUrl&&candidate)throw candidate;
 }
 private async waitForRedirectedLogin(expectedLoginUrl?:string,shouldOnlyReadCurrent=false):Promise<ReviewLoginRequired|undefined>{
  const targetUrl=this.spec.targetUrl!;
  if(!canDetectReviewLoginRedirect(targetUrl))return;
  const page=this.requirePage(),target=new URL(targetUrl);
  const startedAt=Date.now();
  const deadline=startedAt+Math.min(4_000,Math.max(0,this.budget.remainingMs()-500));
  for(;;){
   this.budget.assertTime();
   try{
    const navigationVersion=this.mainNavigationVersion;
    const candidate=await readRedirectedReviewLogin(page,target);
    if(candidate&&(!expectedLoginUrl||candidate.loginUrl===expectedLoginUrl)&&navigationVersion===this.mainNavigationVersion){
     if(expectedLoginUrl)this.expectedLoginDocument={url:page.url(),navigationVersion};
     return candidate;
    }
    if(shouldOnlyReadCurrent||Date.now()>=deadline)return;
    if(!expectedLoginUrl&&Date.now()-startedAt>=1_600&&!(await this.probeReadiness()).hasLoadingSignal)return;
   }catch(error){
    // A client redirect can replace the document while its DOM is being checked.
    if(!(error instanceof Error)||!/Execution context was destroyed|Cannot find context with specified id/.test(error.message))throw error;
   }
   if(shouldOnlyReadCurrent||Date.now()>=deadline)return;
   await page.waitForTimeout(Math.max(0,Math.min(150,deadline-Date.now())));
  }
 }
 getLoginCaptureError(){return this.loginCaptureError;}
 checkLoginCaptureError(){if(this.loginCaptureError)throw this.loginCaptureError;}
 async validateLoginCaptureScope():Promise<void>{
  if(this.shouldDetectLoginDuringCapture||this.expectedLoginDocument)await this.assertLoginCaptureScope(this.requirePage());
 }
 private async assertLoginCaptureScope(page:Page):Promise<void>{
  this.checkLoginCaptureError();
  const expected=this.expectedLoginDocument;
  if(!expected&&!this.shouldDetectLoginDuringCapture)return;
  const version=this.mainNavigationVersion;
  if(expected&&(expected.url!==page.url()||expected.navigationVersion!==version)){
   this.loginCaptureError=new ReviewAuthenticationError('redirect-changed');
   throw this.loginCaptureError;
  }
  let candidate:ReviewLoginRequired|undefined;
  try{candidate=await readRedirectedReviewLogin(page,new URL(this.spec.targetUrl!));}
  catch(error){
   if(!expected||expected.navigationVersion===this.mainNavigationVersion)throw error;
  }
  if(expected){
   if(!candidate||expected.url!==page.url()||expected.navigationVersion!==this.mainNavigationVersion)
    this.loginCaptureError=new ReviewAuthenticationError('redirect-changed');
  }else if(candidate){
   this.loginCaptureError=candidate;
  }
  this.checkLoginCaptureError();
 }
 private requirePage():Page{if(!this.page)throw new Error('Browser not started');return this.page;}
 private async assertLoginSecretsHidden(page:Page):Promise<void>{
  if(this.loginSecret)await assertReviewCredentialIsHidden(page,this.loginSecret);
  if(this.supabaseAccessToken)await assertReviewCredentialIsHidden(page,this.supabaseAccessToken);
 }
 async setReviewTheme(theme:ThemeMode):Promise<void>{await this.exclusive(async()=>{
  this.budget.assertTime();
  const page=this.requirePage();assertOrigin(page.url(),this.spec);
  await page.emulateMedia({colorScheme:theme});
 });}
 async readReviewTheme(observation:Observation):Promise<ThemeProbe|undefined>{
  this.budget.assertTime();
  const captured=this.capturedThemeProbe;
  if(!this.spec.themeReview||!captured||captured.observationId!==observation.observationId||
    observation.state?.readiness==='loading'||observation.state?.readiness==='blocked')return;
  const current=await probeTheme(this.requirePage(),this.spec.themeReview.selectors);
  if(JSON.stringify(current)===JSON.stringify(captured.probe))return captured.probe;
 }
 private async exclusive<T>(fn:()=>Promise<T>):Promise<T>{
  if(this.isBusy)throw new PolicyError('busy','Another browser operation is running');
  this.isBusy=true;
  try{return await fn();}
  catch(error){
   // A transition can interrupt one of the DOM or screenshot calls before the
   // final evidence check runs. Reclassify the new document when it settles.
   this.checkLoginCaptureError();
   if((this.expectedLoginDocument||this.shouldDetectLoginDuringCapture)&&this.page&&!this.page.isClosed()){
    if(error instanceof Error&&/Execution context was destroyed|Cannot find context with specified id|navigation|navigating/i.test(error.message)){
     await this.page.waitForTimeout(Math.max(0,Math.min(100,this.budget.remainingMs()))).catch(()=>{});
    }
    await this.assertLoginCaptureScope(this.page).catch(()=>{});
    this.checkLoginCaptureError();
   }
   throw error;
  }finally{this.isBusy=false;}
 }
 private async hasMatchingMaskGeometry(regions:Observation['redactionRegions']):Promise<boolean>{return this.requirePage().evaluate(expected=>{
  const current=Array.from(document.querySelectorAll('input,textarea,select,[contenteditable]:not([contenteditable="false"])')).flatMap(el=>{const box=el.getBoundingClientRect();if(box.width<=0||box.height<=0||box.x>=innerWidth||box.y>=innerHeight||box.x+box.width<=0||box.y+box.height<=0)return[];return[{x:Math.max(0,box.x),y:Math.max(0,box.y),width:Math.min(innerWidth,box.x+box.width)-Math.max(0,box.x),height:Math.min(innerHeight,box.y+box.height)-Math.max(0,box.y)}];});
  return JSON.stringify(current)===JSON.stringify(expected);
 },(regions??[]).map(region=>region.boundingBox));}
 async capture(preferredReplayControl?:JSHandle<Element>):Promise<Observation>{return this.exclusive(()=>this.captureInternal(preferredReplayControl));}
 async captureStyleSide(key:'reference'|'comparison'):Promise<{observation:Observation;sample:StyleSample}>{
  const config=this.spec.styleComparison;
  if(!config)throw new Error('Style comparison is not configured.');
  const {observation,before,after}=await this.captureStylePage<StyleSample>(key,config.comparisonUrl,
   (page,url)=>sampleComputedStyle(page,url,config[key].selector,config.properties),
   reason=>({status:'unverified',reason}));
  const sample:StyleSample=after.status==='unverified'&&after.reason==='http-error'||observation.isStable&&JSON.stringify(before)===JSON.stringify(after)
   ?after:{status:'unverified',reason:'unstable'};
  return {observation,sample};
 }
 async captureAutomaticStyleSide(key:'reference'|'comparison',url:string,reservedObservations:number):Promise<{observation:Observation;sample:AutoStyleSample}>{
  const config=this.spec.autoStyleComparison;
  if(!config)throw new Error('Automatic style comparison is not configured.');
  const {observation,before,after}=await this.captureStylePage<AutoStyleProbe>(key,url,probeAutomaticStyles,
   reason=>({entries:[],hasReachedLimit:false,reason}),reservedObservations);
  return {observation,sample:settleAutomaticStyles(before,after,observation.isStable,value=>this.redact(value))};
 }
 private async captureStylePage<T>(key:'reference'|'comparison',comparisonUrl:string,probe:(page:Page,url:string)=>Promise<T>,
  unavailable:(reason:'http-error'|'unavailable')=>T,reservedObservations=0):Promise<{observation:Observation;before:T;after:T}>{
  return this.exclusive(async()=>{
   const page=this.requirePage();
   const url=key==='reference'?this.spec.targetUrl!:comparisonUrl;
   let hasHttpError=this.hasStyleReferenceHttpError;
   if(key==='comparison'){
    this.budget.assertTime();
    const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:Math.min(30000,this.budget.remainingMs())});
    if(response)hasHttpError=response.status()>=400;
    assertOrigin(page.url(),this.spec);
   }
   if(hasHttpError){
    const failed=unavailable('http-error');
    return {observation:await this.captureInternal(),before:failed,after:failed};
   }
   const capture=async()=>{
    const probes:T[]=[];
    const observation=await this.captureInternal(undefined,async()=>{
     const measured=await probe(page,url).catch(()=>unavailable('unavailable'));
     probes.push(measured);
    });
    const [before,after]=probes;
    return {observation,before,after};
   };
   // Allow lazy rendering and default route parameters to settle before taking the first sample.
   if(this.spec.autoStyleComparison&&this.budget.remainingMs()>1000)await page.waitForTimeout(350);
   const measured=await capture();
   if(this.spec.autoStyleComparison&&!measured.observation.isStable&&this.budget.remainingObservations()>reservedObservations&&this.budget.remainingMs()>1000)
    return capture();
   return measured;
  });
 }
 async observedHandle(observationId:string,elementRef:string):Promise<JSHandle<Element>>{
  this.budget.assertTime();const observation=this.observations.at(-1);
  if(!observation||observation.observationId!==observationId||!this.latestElements||!observation.elements.some(element=>element.elementRef===elementRef))throw new PolicyError('stale-observation','Follow-up requires a current observed element');
  return this.latestElements.getProperty(elementRef.slice(1)) as Promise<JSHandle<Element>>;
 }
 safeReplayScope(value:string){return this.redact(value);}
 private async captureInternal(preferredReplayControl?:JSHandle<Element>,probeScreenshot?:()=>Promise<void>):Promise<Observation>{
  this.budget.takeObservation();const page=this.requirePage();assertOrigin(page.url(),this.spec);
  const observationId=`obs-${String(this.observations.length+1).padStart(3,'0')}`;const captureStartedAt=new Date().toISOString();
  const stateBefore=this.spec.stateDiscovery?await this.probeReadiness():undefined;
  const before=await page.evaluate(()=>({url:location.href,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,x:scrollX,y:scrollY}));
  await page.waitForTimeout(Math.min(500,this.budget.remainingMs()));this.budget.assertTime();
  await this.assertLoginCaptureScope(page);
  const capturedData=await page.evaluateHandle(preferred=>{
   const sensitiveSelector='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
   const sensitiveValues:string[]=[];
   for(const field of document.querySelectorAll(sensitiveSelector)){
    if('value' in field&&typeof field.value==='string')sensitiveValues.push(field.value);
    if(field.matches('select'))for(const option of field.querySelectorAll('option'))sensitiveValues.push(option.textContent??'',option.value);
    if(field.matches('textarea,[contenteditable]')){
     sensitiveValues.push(field.textContent??'');const walker=document.createTreeWalker(field,NodeFilter.SHOW_TEXT);let node:Node|null;while((node=walker.nextNode()))sensitiveValues.push(node.textContent??'');
    }
   }
   const semanticCandidates=Array.from(document.querySelectorAll('h1,h2,h3,p,button,a,input,select,textarea,[role],[aria-modal="true"],dialog[open],label,img,dt,dd,th,td,output,meter,progress'));
   const leafCandidates=Array.from(document.querySelectorAll('span,div,small,strong,em')).filter(el=>el.childElementCount===0&&Boolean(el.textContent?.trim())&&!el.closest(sensitiveSelector)&&(()=>{const box=el.getBoundingClientRect();return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;})());
   const paintContainers=Array.from(document.querySelectorAll('div,section,article,aside')).filter(el=>{
    if(!el.childElementCount||el.closest(sensitiveSelector))return false;
    const css=getComputedStyle(el),box=el.getBoundingClientRect(),color=css.backgroundColor;
    const alpha=color.startsWith('rgba')?Number(color.split(',').at(-1)?.replace(')','')):color.startsWith('rgb')?1:0;
    return alpha>=0.99&&Number(css.opacity)===1&&css.visibility==='visible'&&css.display!=='none'&&(/absolute|fixed|sticky/.test(css.position)||(css.position==='relative'&&[css.top,css.right,css.bottom,css.left].some(offset=>offset!=='auto'&&Number.parseFloat(offset)!==0))||css.zIndex!=='auto')&&box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;
   }).slice(0,40);
   const candidatePool=new Set([...(preferred?.isConnected?[preferred]:[]),...semanticCandidates,...paintContainers,...leafCandidates]);
   const candidates:Element[]=[];
   for(const candidate of candidatePool){
    // A long document can place every relevant scrolled control after the first 500 DOM nodes.
    // Keep the bound on captured geometry while preferring currently visible elements.
    if(candidatePool.size>500&&candidate!==preferred){
     const box=candidate.getBoundingClientRect();
     if(box.width<=0||box.height<=0||box.bottom<=0||box.top>=innerHeight||box.right<=0||box.left>=innerWidth)continue;
     const css=getComputedStyle(candidate);
     if(css.display==='none'||css.visibility==='hidden')continue;
    }
    candidates.push(candidate);
    if(candidates.length===500)break;
   }
   const parentGroups=[...new Set(candidates.map(el=>el.parentElement).filter((el):el is HTMLElement=>el!==null))];
   const elements=candidates.flatMap((el,index)=>{
    const box=el.getBoundingClientRect();const css=getComputedStyle(el);const isVisible=box.width>0&&box.height>0&&css.visibility!=='hidden'&&css.display!=='none'&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth;
    if(!isVisible)return[];
    const tag=el.tagName.toLowerCase();const isInput=el.matches(sensitiveSelector);if(!isInput&&el.closest(sensitiveSelector))return[];
    const parent=el.parentElement;const parentCss=parent?getComputedStyle(parent):null;
    const clone=el.cloneNode(true) as Element;for(const field of clone.querySelectorAll(sensitiveSelector))field.remove();
    return [{...(el.matches('dialog[open],[role="dialog"],[aria-modal="true"]')?{isModal:true}:{}),...(paintContainers.includes(el)?{isPaintContainer:true}:{}),...(el instanceof HTMLImageElement?{imageState:{naturalWidth:el.naturalWidth,naturalHeight:el.naturalHeight,isComplete:el.complete}}:{}),...(parent&&parentCss?{parentGroup:{groupRef:`g${parentGroups.indexOf(parent)}`,tag:parent.tagName.toLowerCase(),boundingBox:parent.getBoundingClientRect().toJSON(),display:parentCss.display,flexDirection:parentCss.flexDirection,alignItems:parentCss.alignItems,gap:parentCss.gap}}:{}),typography:{fontSize:css.fontSize,lineHeight:css.lineHeight,fontWeight:css.fontWeight},elementRef:`e${index}`,tag,role:el.getAttribute('role')??'',text:isInput?'[input value omitted]':(clone.textContent??el.getAttribute('alt')??'').replace(/\s+/g,' ').trim().slice(0,250),accessibleName:(el.getAttribute('aria-label')??el.getAttribute('alt')??'').slice(0,160),boundingBox:{x:box.x,y:box.y,width:box.width,height:box.height},isVisible,isEnabled:!el.matches(':disabled')&&!el.hasAttribute('disabled')}];
   });
   const observedRefs=new Set(elements.map(element=>element.elementRef));
   const relatedElements=elements.map(element=>{const ancestorRefs:string[]=[];let ancestor=candidates[Number(element.elementRef.slice(1))]?.parentElement;let depth=0;while(ancestor&&depth++<8){const ref=`e${candidates.indexOf(ancestor)}`;if(observedRefs.has(ref))ancestorRefs.push(ref);ancestor=ancestor.parentElement;}return{...element,ancestorRefs};});
   const redactionElements=Array.from(document.querySelectorAll(sensitiveSelector));
   const redactionRegions=redactionElements.flatMap((el,index)=>{const box=el.getBoundingClientRect();if(box.width<=0||box.height<=0||box.x>=innerWidth||box.y>=innerHeight||box.x+box.width<=0||box.y+box.height<=0)return[];
    const elementRef=`e${candidates.indexOf(el)}`;const reason: 'input-value'|'select-options'|'editable-content'=el.matches('select')?'select-options':el.matches('input')?'input-value':'editable-content';
    return[{regionId:`mask-${index}`,...(elements.some(element=>element.elementRef===elementRef)?{elementRef}:{}),reason,boundingBox:{x:Math.max(0,box.x),y:Math.max(0,box.y),width:Math.min(innerWidth,box.x+box.width)-Math.max(0,box.x),height:Math.min(innerHeight,box.y+box.height)-Math.max(0,box.y)}}];});
   const active=document.activeElement;const activeRef=active?`e${candidates.indexOf(active)}`:undefined;
   const activeRole=active?.getAttribute('role')??'';
   const focus={capturedAt:new Date().toISOString(),hasDocumentFocus:document.hasFocus(),activeElement:active?{tag:active.tagName.toLowerCase(),...(elements.some(element=>element.elementRef===activeRef)?{elementRef:activeRef}:{}),...(['button','link','textbox','combobox','checkbox','radio','slider','dialog','tab','menuitem','spinbutton'].includes(activeRole)?{role:activeRole}:{})}:null};
   return {candidateElements:candidates,activeElementForStability:active,sensitiveValues,elements:relatedElements,redactionRegions,focus,title:document.title,url:location.href,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,x:scrollX,y:scrollY,viewportWidth:innerWidth,unsupportedFrames:document.querySelectorAll('iframe').length,imageFailures:Array.from(document.images).filter(i=>i.complete&&i.naturalWidth===0).length};
  },preferredReplayControl??null);
  this.latestElements=await capturedData.getProperty('candidateElements');this.observationElements.set(observationId,this.latestElements);
  const moneyRelations=await capturedData.evaluate(collectMoneyRelations);
  const occlusionEvidence=await capturedData.evaluate(collectOcclusionEvidence);
  const data=await capturedData.evaluate(({candidateElements:_elements,activeElementForStability:_active,...data})=>data);
  this.redactionValues=[...new Set([...this.redactionValues,...data.sensitiveValues.flatMap(value=>[value,value.replace(/\s+/g,' ').trim()])])].filter(Boolean).sort((a,b)=>b.length-a.length);
  const {sensitiveValues:_sensitiveValues,...rawSafeData}=data;
  const safeData={...rawSafeData,title:this.redact(rawSafeData.title),elements:rawSafeData.elements.map(element=>({...element,...(occlusionEvidence[element.elementRef]?{occlusionEvidence:occlusionEvidence[element.elementRef]}:{}),...(moneyRelations[element.elementRef]?{moneyLabelRelation:{...moneyRelations[element.elementRef],...(moneyRelations[element.elementRef].labelText?{labelText:this.redact(moneyRelations[element.elementRef].labelText!)}:{})}}:{}),text:this.redact(element.text),accessibleName:this.redact(element.accessibleName)}))};
  const themeBefore=this.spec.themeReview?await probeTheme(page,this.spec.themeReview.selectors):undefined;
  // Compare stable geometry on both sides of the screenshot, before asynchronous rules can observe a newer state.
  const spacingPosition={x:data.x,y:data.y,width:data.viewportWidth};
  const spacingBefore=!this.spec.followup&&this.budget.remainingMs()>250
   ?await measureLayoutSpacing(page,spacingPosition).catch(()=>undefined):undefined;
  const shouldMeasureFormRows=!this.spec.styleComparison&&!this.spec.autoStyleComparison&&this.spec.reviewPipeline!=='observation-ledger'&&
   this.budget.remainingMs()>250&&safeData.elements.some(element=>element.tag==='input'||element.tag==='textarea');
  const formRowsBefore=shouldMeasureFormRows?await measureFormRowAlignment(page,this.latestElements).catch(()=>undefined):undefined;
  await this.assertLoginSecretsHidden(page);
  if(probeScreenshot)await probeScreenshot();
  await this.assertLoginCaptureScope(page);
  const screenshot=await page.screenshot({type:'png',animations:'disabled',mask:[page.locator('input,textarea,select,[contenteditable]:not([contenteditable="false"])')],maskColor:'#6B7280',timeout:Math.min(15000,this.budget.remainingMs())});
  if(probeScreenshot)await probeScreenshot();
  const spacingAfter=spacingBefore&&this.budget.remainingMs()>130
   ?await measureLayoutSpacing(page,spacingPosition).catch(()=>undefined):undefined;
  const formRowsAfter=formRowsBefore?.checks.length&&this.budget.remainingMs()>130
   ?await measureFormRowAlignment(page,this.latestElements).catch(()=>undefined):undefined;
  const themeAfter=this.spec.themeReview?await probeTheme(page,this.spec.themeReview.selectors):undefined;
  const accessibilitySnapshot=this.redact(await page.locator('body').ariaSnapshot(),true).replace(/(textbox[^\n]*?):[^\n]*/gi,'$1: [input value omitted]').slice(0,30000);
  await this.assertLoginSecretsHidden(page);
  await this.assertLoginCaptureScope(page);
  const screenshotRef=await this.store.save(observationId,'screenshot',screenshot,'image/png');
  screenshotRef.screenshot={coordinateSpace:'viewport-css-pixels',clip:{x:0,y:0,width:this.spec.viewport.width,height:this.spec.viewport.height},deviceScaleFactor:this.spec.viewport.deviceScaleFactor,maskColor:'#6B7280',redactionRegions:safeData.redactionRegions};
  const structureRef=await this.store.save(observationId,'structure',accessibilitySnapshot,'text/plain');
  const layoutRef=await this.store.save(observationId,'layout',JSON.stringify({...safeData,url:safeUrl(data.url)},null,2),'application/json');
  const after=await page.evaluate(()=>({url:location.href,width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,x:scrollX,y:scrollY}));
  const hasStableFocus=await capturedData.evaluate(captured=>captured.activeElementForStability===document.activeElement&&captured.focus.hasDocumentFocus===document.hasFocus());await capturedData.dispose();
  const hasStableMasks=await this.hasMatchingMaskGeometry(safeData.redactionRegions);
  const stateAfter=this.spec.stateDiscovery?await this.probeReadiness():undefined;
  const isStable=JSON.stringify(before)===JSON.stringify(after)&&hasStableFocus&&hasStableMasks&&stateBefore?.fingerprint===stateAfter?.fingerprint;const consistencyWarnings=[...(isStable?[]:['Layout or URL changed during sequential capture; exact pixel claims require verification']),...(hasStableFocus?[]:['Focus changed during sequential capture; screenshot and DOM focus may describe different states']),...(hasStableMasks?[]:['Privacy mask geometry changed during sequential capture; mask coordinates and image may differ']),...new Set(this.warnings),'At most 40 positioned opaque containers are added within the 500-element collection cap. Occlusion role metadata samples at most 200 observed elements, 12 text rectangles and up to 84 text hit-test points plus bounded control-edge samples per element; absence is not visibility proof','Input values, editable regions and select options were masked; their contents were not evaluated'];
  const observation:Observation={observationId,runId:this.store.runId,url:safeUrl(data.url),pageTitle:safeData.title,captureStartedAt,captureEndedAt:new Date().toISOString(),viewport:this.spec.viewport,scrollOffset:{x:data.x,y:data.y},isStable,consistencyWarnings,screenshotRefs:[screenshotRef.evidenceId],evidenceRefs:[screenshotRef,structureRef,layoutRef],elements:safeData.elements,redactionRegions:safeData.redactionRegions,focus:safeData.focus,accessibilitySnapshot,documentWidth:data.width,viewportWidth:data.viewportWidth,unsupportedFrames:data.unsupportedFrames,imageFailures:data.imageFailures};
  this.capturedThemeProbe=isStable&&themeAfter&&JSON.stringify(themeBefore)===JSON.stringify(themeAfter)?{observationId,probe:themeAfter}:undefined;
  this.capturedSpacing=isStable&&spacingAfter&&JSON.stringify(spacingBefore)===JSON.stringify(spacingAfter)?{observationId,spacing:spacingAfter}:undefined;
  if(isStable&&formRowsAfter&&JSON.stringify(formRowsBefore)===JSON.stringify(formRowsAfter))this.capturedFormRows.set(observationId,formRowsAfter);
  this.observations.push(observation);return observation;
 }
 async saveFormRowChecks(observations:readonly Observation[]):Promise<void>{
  for(const observation of observations){
   if(!observation.isStable||observation.state?.readiness==='loading'||observation.state?.readiness==='blocked')continue;
   const alignment=this.capturedFormRows.get(observation.observationId);
   const screenshot=observation.evidenceRefs.find(item=>item.kind==='screenshot'&&item.evidenceId===observation.screenshotRefs[0]);
   if(!alignment||!screenshot)continue;
   const {observationId}=observation;
   const ref=await this.store.save(observationId,'rule',JSON.stringify({alignment},null,2),'application/json','form-row-alignment');
   this.capturedFormRows.delete(observationId);
   observation.evidenceRefs.push(ref);
   const existing=observation.deterministicChecks;
   const checks=alignment.checks.map(check=>({...check,evidenceId:ref.evidenceId}));
   observation.deterministicChecks={
    ...existing,evidenceId:existing?.evidenceId??ref.evidenceId,
    alignment:{tolerance:alignment.tolerance,checks:[...(existing?.alignment?.checks??[]),...checks]},
   };
   for(const [index,check] of checks.entries()){
    const delta=check.differences[0]?.signedTopOffset;
    if(check.status!=='candidate'||delta===undefined)continue;
    // Retain each observation's measurement, with one candidate for identical evidence at a fixed position.
    const key=JSON.stringify([observation.url,observation.scrollOffset,
     observation.verticalScroll?.owner==='container'?observation.verticalScroll.offset:null,
     screenshot.sha256,check.formPair,check.members.map(member=>member.visualBox),delta]);
    if(this.reportedFormRows.has(key))continue;
    this.reportedFormRows.add(key);
    const companion=check.formPair==='field-select'?'선택 컨트롤':'버튼';
    this.rules.push({
     ruleFindingId:`${observationId}-form-row-alignment-${index+1}`,observationId,ruleId:'group-alignment',ruleVersion:'form-row-1',
     result:'potential',title:'같은 행의 입력 컨트롤 상단 정렬 차이',
     description:`${companion}의 상단이 입력칸보다 ${Number(Math.abs(delta).toFixed(2))} CSS px ${delta<0?'위':'아래'}에 있습니다.`,
     evidenceIds:[ref.evidenceId,screenshot.evidenceId],elementRefs:check.members.flatMap(member=>member.elementRef?[member.elementRef]:[]),impact:null,
    });
   }
  }
 }
 async inspectElement(observationId:string,elementRef:string):Promise<{observation:Observation;element:Observation['elements'][number]}> {return this.exclusive(async()=>{
  const previous=this.observations.at(-1);if(previous?.observationId!==observationId)throw new PolicyError('stale-observation','Element inspection requires current observation');
  const oldElement=previous.elements.find(e=>e.elementRef===elementRef);if(!oldElement)throw new Error('Unknown element reference');
  const observation=await this.captureInternal();const element=observation.elements.find(e=>e.elementRef===elementRef&&e.tag===oldElement.tag&&e.text===oldElement.text);if(!element)throw new PolicyError('stale-observation','Element changed; use current observation');
  const box=element.boundingBox;const x=Math.max(0,box.x-12),y=Math.max(0,box.y-12);const width=Math.min(observation.viewport.width-x,box.width+24),height=Math.min(observation.viewport.height-y,box.height+24);
  if(width<=0||height<=0)throw new Error('Element is outside viewport');
  const page=this.requirePage();await this.assertLoginSecretsHidden(page);
  await this.assertLoginCaptureScope(page);
  const image=await page.screenshot({type:'png',clip:{x,y,width,height},mask:[page.locator('input,textarea,select,[contenteditable]:not([contenteditable="false"])')],maskColor:'#6B7280',animations:'disabled',timeout:Math.min(10000,this.budget.remainingMs())});
  await this.assertLoginSecretsHidden(page);
  if(!await this.hasMatchingMaskGeometry(observation.redactionRegions)){observation.isStable=false;observation.consistencyWarnings.push('Privacy mask geometry changed during detail capture; mask coordinates and image may differ');}
  await this.assertLoginCaptureScope(page);
  const ref=await this.store.save(observation.observationId,'screenshot',image,'image/png',`detail-${elementRef}`);ref.screenshot={coordinateSpace:'viewport-css-pixels',clip:{x,y,width,height},deviceScaleFactor:this.spec.viewport.deviceScaleFactor,maskColor:'#6B7280',redactionRegions:(observation.redactionRegions??[]).filter(region=>region.boundingBox.x<x+width&&region.boundingBox.x+region.boundingBox.width>x&&region.boundingBox.y<y+height&&region.boundingBox.y+region.boundingBox.height>y)};observation.evidenceRefs.push(ref);observation.screenshotRefs.push(ref.evidenceId);return{observation,element};
 });}
 async runRules(observationId:string):Promise<RuleFinding[]>{return this.exclusive(async()=>{
  this.budget.assertTime();const observation=this.observations.find(o=>o.observationId===observationId);if(!observation||this.observations.at(-1)!==observation)throw new PolicyError('stale-observation','Rules require the current observation');
  const page=this.requirePage();const findings:RuleFinding[]=[];
  await this.assertLoginCaptureScope(page);
  const capturedSpacing=this.capturedSpacing;
  const spacing=observation.isStable&&capturedSpacing?.observationId===observationId&&observation.state?.readiness!=='loading'&&observation.state?.readiness!=='blocked'
   ?capturedSpacing.spacing:undefined;
  const result=await new AxeBuilder({page}).setLegacyMode(true).withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();
  const screenshotId=observation.screenshotRefs[0];
  const contrast=this.spec.themeReview?await collectThemeContrast(page,result,observation.isStable&&screenshotId
   ?async()=>(await this.store.read(screenshotId)).data:undefined):undefined;
  const alignment=await measureGroupAlignment(page,this.spec.alignmentContracts);
  const safeNode=(node:(typeof result.violations)[number]['nodes'][number])=>({
   target:node.target.map(part=>Array.isArray(part)?part.map(item=>this.redact(item)):this.redact(part)),
   failureSummary:this.redact(node.failureSummary??''),
  });
  const sanitized={
   testEngine:result.testEngine,
   violations:result.violations.map(v=>({id:v.id,impact:v.impact,description:v.description,help:v.help,helpUrl:v.helpUrl,nodes:v.nodes.map(safeNode)})),
   incomplete:result.incomplete.map(v=>({id:v.id,description:v.description,nodes:v.nodes.map(safeNode)})),
   ...(contrast?{contrast:contrast.summary,equalColorViolations:contrast.equalColorNodes.map(safeNode),
     ...(contrast.fallback?{visibleTextContrast:contrast.fallback}: {})}:{}),
   ...(alignment.checks.length?{alignment}:{}),
   ...(spacing?{spacing}:{}),
  };
  await this.assertLoginCaptureScope(page);
  const ref=await this.store.save(observationId,'rule',JSON.stringify(sanitized,null,2),'application/json');observation.evidenceRefs.push(ref);
  if(contrast||alignment.checks.length||spacing)observation.deterministicChecks={
   evidenceId:ref.evidenceId,...(contrast?{contrast:contrast.summary}:{}),...(alignment.checks.length?{alignment}:{}),...(spacing?{spacing}:{}),
  };
  for(const violation of result.violations)findings.push({ruleFindingId:`${observationId}-axe-${violation.id}`,observationId,ruleId:violation.id,ruleVersion:result.testEngine.version,result:'violation',title:violation.help,description:violation.description,evidenceIds:[ref.evidenceId,...observation.screenshotRefs],elementRefs:[],impact:violation.impact??null});
  if(contrast?.equalColorNodes.length)findings.push({
   ruleFindingId:`${observationId}-solid-equal-color`,observationId,ruleId:'color-contrast',ruleVersion:result.testEngine.version,
   result:'violation',title:'텍스트와 단색 배경의 대비 부족',description:`가려지지 않은 텍스트 ${contrast.equalColorNodes.length}개에서 전경색과 배경색이 같아 대비율이 1:1입니다.`,
   evidenceIds:[ref.evidenceId,...observation.screenshotRefs],elementRefs:[],impact:'serious',
  });
  if(contrast?.fallback&&contrast.summary.violations>0)findings.push({
   ruleFindingId:`${observationId}-visible-text-contrast`,observationId,ruleId:'color-contrast',ruleVersion:'visible-text-1',
   result:'violation',title:'보이는 텍스트의 대비 부족',description:`보이는 텍스트 ${contrast.summary.violations}개의 전경색과 단색 배경 대비가 기준에 미달했습니다.`,
   evidenceIds:[ref.evidenceId,...observation.screenshotRefs],elementRefs:[],impact:'serious',
  });
  for(const [index,check] of alignment.checks.entries()){
   if(check.status!=='violation'&&check.status!=='candidate')continue;
   const group=check.contractIndex?`지정 그룹 ${check.contractIndex}`:`그룹 ${check.groupIndex}`;
   const values=check.differences.map(difference=>`${difference.kind==='cross-size'?'시각 크기':'정렬 위치'} ${Number(difference.spread.toFixed(2))} CSS px 차이`).join(', ');
   findings.push({
    ruleFindingId:`${observationId}-group-alignment-${index+1}`,observationId,ruleId:'group-alignment',ruleVersion:'1',result:check.status==='violation'?'violation':'potential',
    title:'컨트롤 그룹의 정렬 또는 크기 차이',description:`${group}${check.line?`의 ${check.line}번째 줄`:''}: ${values}.`,
    evidenceIds:[ref.evidenceId,...observation.screenshotRefs],elementRefs:[],impact:null,
   });
  }
  if(observation.documentWidth>observation.viewportWidth+1)findings.push({ruleFindingId:`${observationId}-overflow`,observationId,ruleId:'horizontal-overflow',ruleVersion:'1',result:'potential',title:'Viewport horizontal overflow',description:`Document width ${observation.documentWidth}px exceeds viewport ${observation.viewportWidth}px. Intentional scrolling requires manual interpretation.`,evidenceIds:observation.evidenceRefs.filter(e=>['layout','screenshot'].includes(e.kind)).map(e=>e.evidenceId),elementRefs:[],impact:'moderate'});
  for(const [index,check] of (spacing?.checks??[]).entries()){
   const observed=Number(check.observed.toFixed(2));
   const isGap=check.kind==='control-gap';
   const edgeLabels={top:'위쪽',right:'오른쪽',bottom:'아래쪽',left:'왼쪽'};
   findings.push({
    ruleFindingId:`${observationId}-${check.kind}-${index+1}`,observationId,ruleId:check.kind,ruleVersion:'1',result:'potential',
    title:isGap?'인접 버튼 사이 간격 부족 후보':'카드 안쪽 여백 부족 후보',
    description:isGap?`인접한 버튼의 ${check.axis==='row'?'가로':'세로'} 간격은 ${observed} CSS px입니다. 감지 기준은 ${check.threshold} CSS px 미만입니다.`
     :`카드 ${edgeLabels[check.edge]} 안쪽 테두리와 내용 사이의 여백은 ${observed} CSS px입니다. 감지 기준은 ${check.threshold} CSS px 미만입니다.`,
    evidenceIds:screenshotId?[ref.evidenceId,screenshotId]:[ref.evidenceId],elementRefs:[],impact:null,
   });
  }
  this.rules.push(...findings);return findings;
 });}
 async probeReadiness():Promise<ReadinessProbe>{this.budget.assertTime();return this.requirePage().evaluate((hints)=>{
  const visibleElements=new Set(Array.from(document.querySelectorAll('*')).filter(el=>{const box=el.getBoundingClientRect(),css=getComputedStyle(el);return box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth&&css.display!=='none'&&css.visibility==='visible'&&Number(css.opacity)>0;}));
  const hintMatches=[hints?.readySelector,hints?.loadingSelector].map(selector=>Boolean(selector&&Array.from(document.querySelectorAll(selector)).some(el=>visibleElements.has(el))));
  const hasRequiredReadyHint=!hints?.readySelector||hintMatches[0];
  const hasCustomLoadingSignal=hintMatches[1];
  const loading=Array.from(document.querySelectorAll('[aria-busy="true"],[role="progressbar"],progress,[data-loading="true"],[data-state="loading"],[class*="skeleton"],[class*="Skeleton"]')).filter(el=>visibleElements.has(el));
  const textElements=Array.from(document.querySelectorAll('main,[role="main"],h1,h2,p,td,li,article')).filter(el=>visibleElements.has(el)&&!el.closest('input,textarea,select,[contenteditable],dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]'));
  const text=textElements.map(el=>(el.textContent??'').replace(/\s+/g,' ').trim()).join('|').slice(0,16000);
  const hasExplicitEmptyOrError=/\b(?:no (?:results|items|data)|nothing found|not found|failed|error)\b|없습니다|결과 없음|항목 없음|오류|실패/i.test(text);
  const hasLoadingText=/^(?:loading[.…\s]*|불러오는 중[.…\s]*|로딩[ 중.…\s]*)$/i.test((document.body.innerText??'').trim());
  const visibleModals=Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[role="alertdialog"],[aria-modal="true"]')).filter(el=>visibleElements.has(el));
  const hasVisibleModal=visibleModals.length>0;
  const images=Array.from(document.images).filter(el=>visibleElements.has(el));
  return {hasRequiredReadyHint,hasLoadingSignal:loading.length>0||hasLoadingText||hasCustomLoadingSignal,hasContentSignal:text.length>=24||hasExplicitEmptyOrError||Boolean(hints?.readySelector&&hasRequiredReadyHint),hasVisibleModal,hasPendingImages:images.some(image=>!image.complete),fingerprint:JSON.stringify({text,modalText:visibleModals.map(modal=>modal.textContent),width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,hasVisibleModal,loading:loading.length,images:images.map(image=>[image.complete,image.naturalWidth])})};
 },this.spec.stateDiscovery);}
 async waitForPreparedState(maxWaitMs:number):Promise<{probe:ReadinessProbe;hasSettled:boolean;hasReachedWaitLimit?:boolean}>{
  const remainingRunMs=this.budget.remainingMs();
  const deadline=Date.now()+Math.min(maxWaitMs,remainingRunMs);let probe=await this.probeReadiness();let stableSince=Date.now();const startedAt=Date.now();
  while(Date.now()<deadline){
   await this.requirePage().waitForTimeout(Math.min(400,Math.max(0,deadline-Date.now())));this.budget.assertTime();const next=await this.probeReadiness();
   if(next.fingerprint!==probe.fingerprint)stableSince=Date.now();probe=next;
   if(Date.now()-stableSince>=800&&probe.hasVisibleModal&&!probe.hasLoadingSignal)return{probe,hasSettled:false};
   if(Date.now()-startedAt>=1600&&Date.now()-stableSince>=800&&!probe.hasLoadingSignal&&!probe.hasPendingImages&&probe.hasContentSignal&&probe.hasRequiredReadyHint)return{probe,hasSettled:true};
  }
  return {probe,hasSettled:false,hasReachedWaitLimit:maxWaitMs<remainingRunMs};
 }
 async getDismissCandidates(observationId:string):Promise<DismissCandidate[]>{return this.exclusive(async()=>{
  if(this.observations.at(-1)?.observationId!==observationId||!this.latestElements)throw new PolicyError('stale-observation','Dismiss discovery requires the current observation');
  for(const binding of this.dismissBindings.values())await binding.handle.dispose();this.dismissBindings.clear();const candidates:DismissCandidate[]=[];if(!this.observations.at(-1)!.isStable)return candidates;
  for(const el of this.observations.at(-1)!.elements.filter(el=>el.tag==='button'||el.role==='button')){
   const handle=await this.latestElements.getProperty(el.elementRef.slice(1)) as JSHandle<Element>;const target=await handle.evaluate(readDismissTarget);
   const measured=target?JSON.parse(target.signature) as {box:{x:number;y:number;width:number;height:number}}:undefined;
   const hasObservedGeometry=measured&&(['x','y','width','height'] as const).every(key=>Math.abs(measured.box[key]-el.boundingBox[key])<=1);
   if(target&&hasObservedGeometry){this.dismissBindings.set(el.elementRef,{handle,signature:target.signature});candidates.push({elementRef:el.elementRef,label:this.redact(target.label)});}else await handle.dispose();
   if(candidates.length>=5)break;
  }
  return candidates;
 });}
 async dismissObservedElement(observationId:string,elementRef:string):Promise<ActionRecord>{return this.exclusive(async()=>{
  this.budget.takeTool();if(!this.spec.stateDiscovery||this.dismissalCount>=Math.min(2,this.spec.stateDiscovery.maxDismissals??1))throw new PolicyError('scope-denied','Automatic dismissal budget exhausted');
  if(this.observations.at(-1)?.observationId!==observationId)throw new PolicyError('stale-observation','Dismiss requires the current observation');
  const binding=this.dismissBindings.get(elementRef);if(!binding)throw new PolicyError('scope-denied','Element was not registered as a safe dismissal candidate');
  const current=await binding.handle.evaluate(readDismissTarget);if(!current||current.signature!==binding.signature)throw new PolicyError('stale-observation','Dismiss target or modal changed after observation');
  const handle=binding.handle.asElement();if(!handle)throw new PolicyError('stale-observation','Dismiss target detached');
  this.dismissalCount++;const record:ActionRecord={actionId:`action-${this.actions.length+1}`,allowedActionId:'state-dismiss',type:'click',beforeObservationId:observationId,outcome:'error',failureAttribution:'unknown'};this.actions.push(record);
  const previousUrl=this.requirePage().url(),previousNavigationBlocks=this.automaticNavigationBlocks;this.isDismissingAutomatically=true;
  try{await handle.click({timeout:Math.min(3000,this.budget.remainingMs())});assertOrigin(this.requirePage().url(),this.spec);const after=await this.captureInternal();record.afterObservationId=after.observationId;if(this.automaticNavigationBlocks!==previousNavigationBlocks||this.requirePage().url()!==previousUrl){record.outcome='rejected';record.failureAttribution='automation';record.message='Navigation is not permitted during automatic dismissal';}else{record.outcome='success';record.failureAttribution=null;}}catch(error){record.message=error instanceof Error?error.message.slice(0,500):'Dismissal failed';record.failureAttribution=error instanceof PolicyError?'automation':'unknown';}finally{this.isDismissingAutomatically=false;}
  return record;
 });}
 private async clearModalBinding():Promise<void>{if(!this.modalBinding)return;await this.modalBinding.handle.dispose().catch(()=>{});await this.modalBinding.backdrop?.dispose().catch(()=>{});for(const button of this.modalBinding.buttons.values())await button.handle.dispose().catch(()=>{});this.modalBinding=undefined;}
 async getModalActionContext(observationId:string,replayModal?:NonNullable<ReturnType<typeof activeReplayModal>>):Promise<ModalActionContext|undefined>{return this.exclusive(async()=>{
  if(this.observations.at(-1)?.observationId!==observationId||!this.latestElements)throw new PolicyError('stale-observation','Modal exploration requires the current observation');
  await this.clearModalBinding();const observation=this.observations.at(-1)!;if(!observation.isStable)return;
  let modals=observation.elements.filter(element=>element.isVisible&&(element.isModal||element.role==='dialog'||element.role==='alertdialog'||element.tag==='dialog'));
  if(replayModal){
   const page=this.requirePage(),query={name:replayModal.title,exact:true};
   const named=page.getByRole('dialog',query).or(page.getByRole('alertdialog',query));
   if(await named.count()!==1)return;
   const current=await named.elementHandle({timeout:Math.min(1000,this.budget.remainingMs())});
   const matching:typeof modals=[];
   try{
    for(const modal of modals){
     const handle=await this.latestElements.getProperty(modal.elementRef.slice(1)) as JSHandle<Element>;
     try{if(await handle.evaluate((element,other)=>element===other,current))matching.push(modal);}finally{await handle.dispose();}
    }
   }finally{await current.dispose();}
   modals=matching;
  }
  if(modals.length!==1)return;
  const modal=modals[0],handle=await this.latestElements.getProperty(modal.elementRef.slice(1)) as JSHandle<Element>;
  const snapshot=await handle.evaluateHandle(readModalSnapshot);const data=await snapshot.evaluate(({backdropElement:_backdrop,...data})=>data);
  const hasSameGeometry=(['x','y','width','height'] as const).every(key=>Math.abs(JSON.parse(data.signature).box[key]-modal.boundingBox[key])<=1);
  if(!data.isVisible||!hasSameGeometry){await handle.dispose();await snapshot.dispose();return;}
  const context:ModalActionContext={modalRef:modal.elementRef,title:this.redact(data.title),semanticKey:this.redact(data.semanticKey),actions:[]};
  if(data.hasProhibitedContext)context.blockedReason='Preference/continue actions are prohibited in text-entry, consent, authentication, payment or destructive contexts; reversible dismissal may be attempted';
  const buttons=new Map<string,{handle:JSHandle<Element>;signature:string}>();const canChoosePreferences=this.spec.stateDiscovery?.modalExploration?.canChoosePreferences??true;
  for(const element of observation.elements.filter(element=>element.tag==='button'||element.tag==='input'||['button','radio','checkbox'].includes(element.role))){
   const button=await this.latestElements.getProperty(element.elementRef.slice(1)) as JSHandle<Element>;
   if(!await button.evaluate((element,modal)=>modal.contains(element),handle)){await button.dispose();continue;}
   const target=await button.evaluate(readModalButton);const hasObservedGeometry=target&&(['x','y','width','height'] as const).every(key=>Math.abs(JSON.parse(target.signature).box[key]-element.boundingBox[key])<=1);
   if(!target||!hasObservedGeometry||(!canChoosePreferences||data.hasProhibitedContext)&&target.kind!=='close-button'){await button.dispose();continue;}
   if(target.kind==='close-button'&&this.dismissalCount>=(this.spec.stateDiscovery?.maxDismissals??1)){await button.dispose();continue;}
   buttons.set(element.elementRef,{handle:button,signature:target.signature});context.actions.push({type:target.kind as ModalActionMethod,elementRef:element.elementRef,label:this.redact(target.label)});
  }
  context.actions.push({type:'escape',elementRef:null});
  const backdrop=data.backdropPoint?await snapshot.getProperty('backdropElement') as JSHandle<Element>:undefined;
  if(backdrop&&data.backdropPoint)context.actions.push({type:'backdrop',elementRef:null});
  this.modalBinding={observationId,modalRef:modal.elementRef,handle,signature:data.signature,semanticKey:data.semanticKey,actions:context.actions,buttons,...(backdrop&&data.backdropPoint?{backdrop,backdropPoint:data.backdropPoint}:{}),...(replayModal?{replayFingerprint:replayModal.fingerprint}:{})};await snapshot.dispose();return context;
 });}
 async performModalAction(observationId:string,type:ModalActionMethod,elementRef:string|null,attempt:number):Promise<ActionRecord>{return this.exclusive(async()=>{
  this.budget.takeTool();if(!this.spec.stateDiscovery||this.modalActionCount>=8||attempt<1||attempt>(this.spec.stateDiscovery.modalExploration?.maxAttempts??3))throw new PolicyError('scope-denied','Modal exploration action or attempt budget exhausted');
  const binding=this.modalBinding;if(this.observations.at(-1)?.observationId!==observationId||binding?.observationId!==observationId)throw new PolicyError('stale-observation','Modal action requires the current registered observation');
  const candidate=binding.actions.find(action=>action.type===type&&action.elementRef===elementRef);if(!candidate)throw new PolicyError('scope-denied','Modal action was not registered for this observation');
  if(binding.replayFingerprint){
   const snapshot=this.redact(await this.requirePage().locator('body').ariaSnapshot(),true).slice(0,30000);
   if(activeReplayModal(snapshot)?.fingerprint!==binding.replayFingerprint)throw new PolicyError('stale-observation','The active replay modal changed');
   const isInteractive=await binding.handle.evaluate(element=>Number(getComputedStyle(element).opacity)>0&&!element.closest('[inert],[aria-hidden="true"]'));
   if(!isInteractive)throw new PolicyError('stale-observation','The active replay modal is not interactive');
   if(!this.hasActiveModalNavigationGuard){
    this.modalNavigationBaselineUrl=this.requirePage().url();
    this.modalNavigationCheckpoint=this.automaticNavigationBlocks;
   }
  }
  const current=await binding.handle.evaluate(readModalSnapshot);if(!current.isVisible||(current.hasProhibitedContext&&(type==='preference'||type==='continue'))||current.signature!==binding.signature)throw new PolicyError('stale-observation','Modal context changed after observation');
  const button=elementRef?binding.buttons.get(elementRef):undefined;
  if(button){const target=await button.handle.evaluate(readModalButton);if(!target||target.signature!==button.signature||target.kind!==type)throw new PolicyError('stale-observation','Modal button changed after observation');}
  if(type==='backdrop'){
   if(!binding.backdrop||!binding.backdropPoint||JSON.stringify(current.backdropPoint)!==JSON.stringify(binding.backdropPoint))throw new PolicyError('stale-observation','Dedicated backdrop ownership changed');
   const fresh=await binding.handle.evaluateHandle(readModalSnapshot),freshBackdrop=await fresh.getProperty('backdropElement');const hasSameBackdrop=await binding.backdrop.evaluate((element,other)=>element===other,freshBackdrop);await freshBackdrop.dispose();await fresh.dispose();if(!hasSameBackdrop)throw new PolicyError('stale-observation','Backdrop element changed');
  }
  this.modalActionCount++;if(type==='close-button')this.dismissalCount++;
  const record:ActionRecord={actionId:`action-${this.actions.length+1}`,allowedActionId:`state-modal-${type}`,type:type==='escape'?'press':'click',beforeObservationId:observationId,outcome:'error',failureAttribution:'unknown',modalInteraction:{method:type,modalObservationRef:binding.modalRef,hasModalDismissed:null,hasRedirected:false,attempt,...(candidate.label?{buttonLabel:candidate.label}:{})}};this.actions.push(record);
  if(this.hasPendingModalRedirect()){record.outcome='rejected';record.modalInteraction!.hasRedirected=true;record.failureAttribution='automation';record.message='Pending delayed navigation prevents another action';return record;}
  const previousUrl=this.requirePage().url(),previousNavigationBlocks=this.modalNavigationCheckpoint;this.isDismissingAutomatically=true;this.hasActiveModalNavigationGuard=true;
  try{
   if(type==='escape')await binding.handle.asElement()!.press('Escape',{timeout:Math.min(3000,this.budget.remainingMs())});
   else if(type==='backdrop')await binding.backdrop!.asElement()!.click({position:binding.backdropPoint!,timeout:Math.min(3000,this.budget.remainingMs())});
   else await button!.handle.asElement()!.click({timeout:Math.min(3000,this.budget.remainingMs())});
   assertOrigin(this.requirePage().url(),this.spec);const after=await this.captureInternal();record.afterObservationId=after.observationId;
   record.modalInteraction!.hasModalDismissed=!await binding.handle.evaluate(element=>{const box=element.getBoundingClientRect(),css=getComputedStyle(element);return element.isConnected&&box.width>0&&box.height>0&&css.visibility!=='hidden'&&css.display!=='none'&&(element.tagName!=='DIALOG'||element.hasAttribute('open'));});
   record.modalInteraction!.hasRedirected=this.automaticNavigationBlocks!==previousNavigationBlocks||this.requirePage().url()!==previousUrl;
   record.outcome=record.modalInteraction!.hasRedirected?'rejected':'success';record.failureAttribution=record.outcome==='success'?null:'automation';
   record.message=record.modalInteraction!.hasRedirected?'Navigation attempt rejected; restore original target in a fresh isolated context':record.modalInteraction!.hasModalDismissed?'The observed modal closed':'Action executed; the observed modal remains visible';
  }catch(error){record.modalInteraction!.hasRedirected=this.automaticNavigationBlocks!==previousNavigationBlocks||this.requirePage().url()!==previousUrl;record.message=error instanceof Error?error.message.slice(0,500):'Modal action failed';record.failureAttribution=error instanceof PolicyError?'automation':'unknown';}finally{this.isDismissingAutomatically=false;}
  return record;
 });}
 hasPendingModalRedirect():boolean{return this.hasActiveModalNavigationGuard&&(this.automaticNavigationBlocks!==this.modalNavigationCheckpoint||this.requirePage().url()!==this.modalNavigationBaselineUrl);}
 takeDelayedModalRedirect():ActionRecord|undefined{
  if(!this.hasPendingModalRedirect())return;
  const action=this.actions.findLast(action=>Boolean(action.modalInteraction));if(!action)return;action.modalInteraction!.hasRedirected=true;action.outcome='rejected';action.failureAttribution='automation';action.message='Delayed navigation during modal exploration rejected; restore original target in a fresh context';return action;
 }
 endModalExploration():void{this.hasActiveModalNavigationGuard=false;}
 async recoverOriginalModalTarget():Promise<Observation>{return this.exclusive(async()=>{
  this.budget.takeTool();this.hasActiveModalNavigationGuard=false;this.modalNavigationCheckpoint=this.automaticNavigationBlocks;await this.clearModalBinding();for(const binding of this.dismissBindings.values())await binding.handle.dispose().catch(()=>{});this.dismissBindings.clear();for(const handle of this.observationElements.values())await handle.dispose().catch(()=>{});this.observationElements.clear();this.latestElements=undefined;
  await this.context?.close().catch(error=>{if(!this.isClosed)throw error;});await this.browser?.close().catch(error=>{if(!this.isClosed)throw error;});this.page=undefined;this.context=undefined;this.browser=undefined;this.physical=undefined;if(this.isClosed)throw new PolicyError('closed','Modal recovery cancelled');this.budget.assertTime();await this.start();this.warnings.push('Restored the original URL in a fresh isolated context after a rejected modal navigation');return this.captureInternal();
 });}
 async performAction(id:string,expectedObservationId:string):Promise<ActionRecord>{return this.exclusive(async()=>{
  if(this.observations.at(-1)?.observationId!==expectedObservationId)throw new PolicyError('stale-observation','Action requires current observation');
  const action=this.budget.takeAction(id);const page=this.requirePage();const record:ActionRecord={actionId:`action-${this.actions.length+1}`,allowedActionId:id,type:action.type,beforeObservationId:expectedObservationId,outcome:'error',failureAttribution:'unknown'};this.actions.push(record);
  try{
   const locator=page.locator(action.selector);if(await locator.count()!==1)throw new PolicyError('ambiguous-target','Action selector must match exactly one element');
   const options={timeout:Math.min(5000,this.budget.remainingMs())};
   if(action.type==='click')await locator.click(options);else if(action.type==='fill')await locator.fill(action.value??'',options);else await locator.press(action.value??'',options);
   assertOrigin(page.url(),this.spec);const after=await this.captureInternal();record.afterObservationId=after.observationId;record.outcome='success';record.failureAttribution=null;
  }catch(error){record.message=error instanceof Error?error.message.slice(0,500):String(error);record.failureAttribution=error instanceof PolicyError?'automation':'unknown';}
  return record;
 });}
 async resolveVerificationRefs(observationId:string,refs:string[]):Promise<string[]> {
  const old=this.observationElements.get(observationId);if(!old||!this.latestElements)throw new PolicyError('stale-observation','Original observation bindings unavailable');
  const original=this.observations.find(o=>o.observationId===observationId)!;
  if(refs.some(ref=>!original.elements.some(el=>el.elementRef===ref)))throw new PolicyError('unknown-reference','Unknown original element reference');
  const indices=refs.map(ref=>Number(ref.slice(1)));
  const rebound=await this.latestElements.evaluate((current,{old,indices})=>indices.map(index=>{const el=old[index];return el?.isConnected?current.indexOf(el):-1;}),{old,indices});
  const latest=this.observations.at(-1)!;
  if(rebound.some(index=>index<0||!latest.elements.some(el=>el.elementRef===`e${index}`)))throw new PolicyError('stale-observation','Target detached or no longer visible in bounded observation');
  return rebound.map(index=>`e${index}`);
 }
 async readVerificationText(observationId:string,elementRef:string):Promise<string>{
  if(this.observations.at(-1)?.observationId!==observationId||!this.latestElements)throw new PolicyError('stale-observation','Text requires current observation');
  const old=this.observations.at(-1)!.elements.find(el=>el.elementRef===elementRef);if(!old)throw new PolicyError('unknown-reference','Unknown text target');
  const text=await this.latestElements.evaluate((elements,index)=>{const el=elements[index];if(!el?.isConnected)throw new Error('Detached text target');const sensitive='input,textarea,select,[contenteditable]:not([contenteditable="false"])';if(el.closest(sensitive)||el.querySelector(sensitive))return '[input value omitted]';for(const node of [el,...el.querySelectorAll('*')]){const css=getComputedStyle(node);if(node.textContent?.trim()&&(css.display==='none'||css.visibility==='hidden'||Number(css.opacity)===0))throw new Error('Hidden text descendants prevent visible amount interpretation');}return ((el as HTMLElement).innerText??el.textContent??'').replace(/\s+/g,' ').trim().slice(0,250);},Number(elementRef.slice(1)));
  const safe=this.redact(text);if(safe!==old.text)throw new PolicyError('stale-observation','Displayed text changed after capture');return safe;
 }
 async readVerificationMoneyText(observationId:string,elementRef:string):Promise<{valueText:string;labelText?:string;combinedText:string;relation?:Observation['elements'][number]['moneyLabelRelation']}>{
  const valueText=await this.readVerificationText(observationId,elementRef);const observed=this.observations.at(-1)!.elements.find(element=>element.elementRef===elementRef)!;
  const relation=observed.moneyLabelRelation;
  if(!relation||relation.status!=='resolved')return{valueText,combinedText:valueText,...(relation?{relation}:{})};
  const fresh=(await this.latestElements!.evaluate(collectMoneyRelations))[elementRef];
  if(!fresh||fresh.status!=='resolved'||fresh.source!==relation.source||JSON.stringify(fresh.labelRefs)!==JSON.stringify(relation.labelRefs))throw new PolicyError('stale-observation','Money label relationship changed after capture');
  const labelText=(await Promise.all(relation.labelRefs.map(ref=>this.readVerificationText(observationId,ref)))).join(' ');
  if(labelText!==relation.labelText||this.redact(fresh.labelText??'')!==labelText)throw new PolicyError('stale-observation','Money label text changed after capture');
  return{valueText,labelText,combinedText:`${labelText} ${valueText}`,relation};
 }
 async measureVerification(observationId:string,elementRef:string):Promise<Record<string,unknown>> {return this.exclusive(async()=>{
  this.budget.assertTime();const observation=this.observations.at(-1);
  if(!observation||observation.observationId!==observationId||!this.latestElements)throw new PolicyError('stale-observation','Measurement requires current observation');
  const observed=observation.elements.find(element=>element.elementRef===elementRef);if(!observed)throw new PolicyError('unknown-reference','Measurement requires an observed element');
  const index=Number(elementRef.slice(1));
  const measurement=await this.latestElements.evaluate((elements,index)=>{
   const target=elements[index];if(!target?.isConnected)throw new Error('Observed element is detached');
   const box=target.getBoundingClientRect();const css=getComputedStyle(target);
   const sensitiveSelector='input,textarea,select,[contenteditable]:not([contenteditable="false"])';
   const hasSensitiveContent=Boolean(target.closest(sensitiveSelector)||target.querySelector(sensitiveSelector));
   const textRects:{x:number;y:number;width:number;height:number}[]=[];
   if(!hasSensitiveContent){const walker=document.createTreeWalker(target,NodeFilter.SHOW_TEXT);let text:Node|null;let count=0;
    while((text=walker.nextNode())&&count++<100){if(!text.textContent?.trim())continue;const range=document.createRange();range.selectNodeContents(text);for(const r of range.getClientRects())if(r.width>0&&r.height>0&&textRects.length<100)textRects.push({x:r.x,y:r.y,width:r.width,height:r.height});}}
   let clip={left:0,top:0,right:innerWidth,bottom:innerHeight};const clippingAncestors:{tag:string;box:{x:number;y:number;width:number;height:number};overflowX:string;overflowY:string}[]=[];
   for(let parent:Element|null=target;parent;parent=parent.parentElement){const c=getComputedStyle(parent),r=parent.getBoundingClientRect();const hasX=/(hidden|clip|scroll|auto)/.test(c.overflowX),hasY=/(hidden|clip|scroll|auto)/.test(c.overflowY);if(hasX||hasY){clippingAncestors.push({tag:parent.tagName.toLowerCase(),box:{x:r.x,y:r.y,width:r.width,height:r.height},overflowX:c.overflowX,overflowY:c.overflowY});if(hasX){clip.left=Math.max(clip.left,r.left);clip.right=Math.min(clip.right,r.right);}if(hasY){clip.top=Math.max(clip.top,r.top);clip.bottom=Math.min(clip.bottom,r.bottom);}}}
   const samples=textRects.slice(0,12).flatMap(r=>[Math.min(0.5/r.width,0.1),0.02,0.2,0.5,0.8,0.98,1-Math.min(0.5/r.width,0.1)].map(f=>({x:r.x+r.width*f,y:r.y+r.height/2,sampleScope:'text'}))).concat(target.matches('button,a,input,select,[role=button],[role=link]')?[{x:box.left+Math.min(1,box.width/4),y:box.top+box.height/2,sampleScope:'control-surface'},{x:box.right-Math.min(1,box.width/4),y:box.top+box.height/2,sampleScope:'control-surface'}]:[]).filter(p=>p.x>=0&&p.x<innerWidth&&p.y>=0&&p.y<innerHeight).map(p=>{
    const top=document.elementFromPoint(p.x,p.y);let opaqueCover:Element|null=null;
    for(let cover=top;cover&&!cover.contains(target);cover=cover.parentElement){
     const css=getComputedStyle(cover),color=css.backgroundColor;const alpha=color.startsWith('rgba')?Number(color.split(',').at(-1)?.replace(')','')):color.startsWith('rgb')?1:0;
     let hasOpaqueAncestors=true;for(let ancestor:Element|null=cover;ancestor;ancestor=ancestor.parentElement){const ac=getComputedStyle(ancestor);if(Number(ac.opacity)!==1||ac.filter!=='none'||ac.mixBlendMode!=='normal'||ac.transform!=='none'||ac.clipPath!=='none')hasOpaqueAncestors=false;}
     if(alpha>=0.99&&hasOpaqueAncestors&&css.visibility==='visible'){opaqueCover=cover;break;}
    }
    const coveringIndex=opaqueCover?elements.indexOf(opaqueCover):-1;
    return{...p,hasTargetOnTop:Boolean(top&&(top===target||target.contains(top))),hasOpaqueCover:Boolean(opaqueCover),...(coveringIndex>=0?{coveringElementRef:`e${coveringIndex}`}:{ }),topTag:top?.tagName.toLowerCase()??null};});
   const isModal=target.matches('dialog[open]')&&target.matches(':modal')||target.getAttribute('role')==='dialog'&&target.getAttribute('aria-modal')==='true';
   const modalScopes=Array.from(document.querySelectorAll('dialog:modal,[role="dialog"][aria-modal="true"]')).filter(el=>{const rect=el.getBoundingClientRect(),style=getComputedStyle(el);return rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth&&style.visibility==='visible'&&style.display!=='none'&&Number(style.opacity)>0;});
   const hasUniqueActiveModal=isModal&&modalScopes.length===1&&modalScopes[0]===target;
   const active=document.activeElement;const activeIndex=active?elements.indexOf(active):-1;
   return{tag:target.tagName.toLowerCase(),box:{x:box.x,y:box.y,width:box.width,height:box.height},textRects,clippingAncestors,clip,samples,hasSensitiveContent,isModal,hasUniqueActiveModal,hasFocusInside:Boolean(active&&target.contains(active)),hasDocumentFocus:document.hasFocus(),activeElement:active?{tag:active.tagName.toLowerCase(),...(activeIndex>=0?{elementRef:`e${activeIndex}`}:{})}:null,
    style:{visibility:css.visibility,opacity:css.opacity,overflowX:css.overflowX,overflowY:css.overflowY,clipPath:css.clipPath,transform:css.transform,pointerEvents:css.pointerEvents},hasComplexPainting:(()=>{for(let el:Element|null=target;el;el=el.parentElement){const style=getComputedStyle(el);if(style.clipPath!=='none'||style.transform!=='none'||style.filter!=='none'||style.mixBlendMode!=='normal'||style.pointerEvents==='none'||Number(style.opacity)!==1)return true;}return false;})(),measuredAt:new Date().toISOString()};
  },index);
  if(measurement.tag!==observed.tag||(['x','y','width','height'] as const).some(key=>Math.abs(measurement.box[key]-observed.boundingBox[key])>1))throw new PolicyError('stale-observation','Target geometry changed after capture');
  return measurement;
 });}
 async releasePhysicalContext():Promise<BrowserPhysicalContext|undefined>{
  this.isClosed=true;this.postAbort.abort();await this.startPromise?.catch(()=>{});await this.clearModalBinding();for(const binding of this.dismissBindings.values())await binding.handle.dispose().catch(()=>{});this.dismissBindings.clear();for(const handle of this.observationElements.values())await handle.dispose().catch(()=>{});this.observationElements.clear();this.latestElements=undefined;
  const physical=this.physical;if(!physical||physical.owner!==this||!physical.browser.isConnected()||physical.page.isClosed())return;
  physical.owner=undefined;this.physical=undefined;this.browser=undefined;this.context=undefined;this.page=undefined;return physical;
 }
 async close():Promise<void>{this.isClosed=true;this.postAbort.abort();await this.startPromise?.catch(()=>{});await this.clearModalBinding();for(const binding of this.dismissBindings.values())await binding.handle.dispose().catch(()=>{});this.dismissBindings.clear();for(const handle of this.observationElements.values())await handle.dispose().catch(()=>{});this.observationElements.clear();await this.browser?.close().catch(()=>{});}
}
