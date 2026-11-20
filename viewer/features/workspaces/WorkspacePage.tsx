import {useCallback,useEffect,useLayoutEffect,useRef,useState,type FormEvent,type RefObject} from 'react';
import {ArrowRight,ExternalLink,ImagePlus,Send} from 'lucide-react';
import {Button} from '../../shared/goodcase/components/basic/button';
import {TextArea} from '../../shared/goodcase/components/basic/text-area';
import {Input} from '../../shared/goodcase/components/basic/input';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {ActionMenu} from '../../shared/ActionMenu';
import {LinkButton} from '../../shared/LinkButton';
import {Breadcrumb} from '../../shared/PageNavigation';
import {Dialog} from '../../shared/goodcase/components/overlays/dialog';
import {Disclosure} from '../../shared/Disclosure';
import {toViewerImage} from '../../shared/CaptureImageViewer';
import {ImageGallery} from '../../shared/goodcase/components/composed/image-gallery';
import {createBrowserId} from '../../shared/browser/id';
import type {PublicWorkspaceDetail,PublicWorkspaceRequest,ReviewProject,ReviewWorkspace} from '../../../src/workspace-contract';
import type {ReportDetail} from '../reports/types';
import {reportsApi} from '../reports/api';
import {CaptureConditions,ReportContent,WorkspaceReportTabs} from '../reports/ReportPage';
import {ReportMetadataEditor} from '../reports/ReportMetadataEditor';
import {FocusedReview} from '../focus/FocusedReview';
import type {ImageRegion} from '../focus/geometry';
import {Badge} from '../../shared/goodcase/components/basic/badge';
import {evaluationLabel,findingImageIndex} from '../reports/presentation';
import {canEnterReviewCredentials,uploadImage} from '../tasks/api';
import {ReviewStart} from '../tasks/ReviewStart';
import {navigateLink,projectsHref,workspaceReportHref} from '../../app/route';
import {RegionCapture,type CaptureSelection} from './RegionCapture';
import {WorkspaceShell} from './WorkspaceSidebar';
import {WorkspaceRequestError,workspacesApi} from './api';
import {InitialReview} from './InitialReview';
import {hasExecutionDate,reportIdsNeedingMetadata,workspaceReportAttempts,type WorkspaceReportMetadata} from './report-picker';
import './workspaces.css';
import './workspace-report.css';
const statuses:Record<string,string>={'awaiting-start':'시작 대기',queued:'대기 중',running:'검토 중',completed:'검토 완료',partial:'일부 완료',failed:'실행 실패',cancelled:'취소'};
const activeRequestStatuses=new Set(['awaiting-start','queued','running']);
const activePhases:Record<string,string>={'manual-login':'열린 Chromium 창에서 로그인하고 기준 화면으로 이동하세요.',preparing:'화면 준비',restoring:'이전 상태 확인',discovering:'조작 대상 확인',acting:'화면 조작',waiting:'결과 준비 대기',evaluating:'결과 검토'};
const phases:Record<string,string>={'awaiting-start':'실행 시작 대기',queued:'실행 대기',...activePhases,completed:'완료',failed:'실행 실패',cancelled:'취소'};
const message=(cause:unknown)=>cause instanceof Error?cause.message:String(cause);
const reportExecutionDate=new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
function Handoff({request,onDone}:{request:PublicWorkspaceRequest;onDone:()=>void}){
 const [file,setFile]=useState<File>(),[comment,setComment]=useState(''),[isSubmitting,setIsSubmitting]=useState(false),[error,setError]=useState('');const submission=useRef({signature:'',id:''}),uploaded=useRef(new Map<File,string>());
 async function submit(event:FormEvent){event.preventDefault();if(!file)return;setIsSubmitting(true);setError('');try{const assetId=uploaded.current.get(file)??await uploadImage(file);uploaded.current.set(file,assetId);const body={assetId,comment:comment.trim()};const signature=JSON.stringify(body);if(submission.current.signature!==signature)submission.current={signature,id:createBrowserId()};await workspacesApi.importImage(request.requestId,{...body,submissionId:submission.current.id});onDone();}catch(cause){setError(message(cause));}finally{setIsSubmitting(false);}}
 return <form className="workspace-handoff" onSubmit={submit}><h3>이미지로 이어서 검토</h3><p>준비한 화면과 설명을 이 요청에 연결합니다. 가져온 이미지를 검토하며 실제 웹 동작을 확인한 것으로 처리하지 않습니다.</p><label>이미지<Input required type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>setFile(event.target.files?.[0])}/></label><TextArea label="화면 설명" required maxLength={4000} value={comment} onChange={event=>setComment(event.target.value)} placeholder="이 화면을 준비한 방법과 확인할 내용"/>{error&&<p role="alert" className="workspace-error">{error}</p>}<Button type="submit" variant="secondary" isLoading={isSubmitting}><ImagePlus size={16}/>이미지 검토 접수</Button></form>;
}
function Membership({detail,projects,workspaces,onDone}:{detail:PublicWorkspaceDetail;projects:ReviewProject[];workspaces:ReviewWorkspace[];onDone:()=>void}){
 const [projectId,setProjectId]=useState(detail.workspace.projectId),[requestId,setRequestId]=useState(''),[targetId,setTargetId]=useState(''),[isSubmitting,setIsSubmitting]=useState(false),[error,setError]=useState('');
 async function move(kind:'workspace'|'request'){setIsSubmitting(true);setError('');try{if(kind==='workspace')await workspacesApi.moveWorkspace(detail.workspace.workspaceId,projectId,detail.workspace.version);else await workspacesApi.moveRequest(requestId,targetId,detail.workspace.version);onDone();}catch(cause){setError(message(cause));}finally{setIsSubmitting(false);}}
 return <div className="workspace-membership"><p>원본 요청과 실행 근거는 보존하고 현재 소속만 바꿉니다.</p><h3>이 작업공간: {detail.workspace.name}</h3><Select label="프로젝트" value={projectId} onValueChange={setProjectId} options={projects.map(project=>({value:project.projectId,label:project.name}))}/><Button variant="secondary" disabled={projectId===detail.workspace.projectId} isLoading={isSubmitting} onClick={()=>void move('workspace')}>프로젝트 변경</Button>
 {detail.requests.length>0&&<><h3>다른 화면으로 분류할 요청</h3><Select label="변경할 요청" value={requestId} onValueChange={setRequestId} options={detail.requests.map(request=>({value:request.requestId,label:request.instruction}))}/><Select label="연결할 작업공간" value={targetId} onValueChange={setTargetId} options={workspaces.filter(workspace=>workspace.workspaceId!==detail.workspace.workspaceId).map(workspace=>({value:workspace.workspaceId,label:`${projects.find(project=>project.projectId===workspace.projectId)?.name??''} / ${workspace.name}`}))}/><Button variant="secondary" disabled={!requestId||!targetId} isLoading={isSubmitting} onClick={()=>void move('request')}>요청 소속 변경</Button><a href={`/?project=${encodeURIComponent(detail.workspace.projectId)}`}>새 UI 검토 작업공간 만들기 →</a></>}{error&&<p role="alert" className="workspace-error">{error}</p>}{Boolean(detail.membershipEvents?.length)&&<Disclosure title="소속 변경 내역">{detail.membershipEvents!.map(event=><p key={event.movementId}><time>{new Date(event.createdAt).toLocaleString('ko-KR')}</time><br/>{event.reason}</p>)}</Disclosure>}</div>;
}
function TrashWorkspaceDialog({workspace,hasDraft,onTrash,isOpen,onClose,returnFocusRef}:{workspace:ReviewWorkspace;hasDraft:boolean;onTrash:()=>void;isOpen:boolean;onClose:()=>void;returnFocusRef:RefObject<HTMLButtonElement|null>}){
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [error,setError]=useState('');
 const cancelRef=useRef<HTMLButtonElement>(null);
 async function moveToTrash(){
  setError('');
  setIsSubmitting(true);
  try{
   await workspacesApi.trash(workspace.workspaceId,workspace.version);
   onTrash();
  }catch(cause){
   setError(message(cause));
   setIsSubmitting(false);
  }
 }
 return <Dialog
  isOpen={isOpen}
  onOpenChange={next=>{if(!next&&!isSubmitting){setError('');onClose();}}}
  shouldCloseOnOutsideClick={false}
  shouldCloseOnEscape={!isSubmitting}
  initialFocusRef={cancelRef}
  className="workspace-trash-dialog"
  returnFocusRef={returnFocusRef}
  title="작업공간을 휴지통으로 이동할까요?"
  description="검토 요청, 보고서와 캡처도 함께 이동합니다. 휴지통에서 14일 동안 복원할 수 있으며 이후에는 영구 삭제됩니다."
  footer={<><Button ref={cancelRef} variant="secondary" disabled={isSubmitting} onClick={()=>{setError('');onClose();}}>취소</Button><Button variant="danger" isLoading={isSubmitting} onClick={()=>void moveToTrash()}>휴지통으로 이동</Button></>}
 ><p><strong>{workspace.name}</strong></p>{hasDraft&&<p className="muted">작성 중인 요청은 사라집니다.</p>}{error&&<p className="workspace-error" role="alert">{error}</p>}</Dialog>;
}
type ReviewComposer='screen'|'focus'|'comparison';
type WorkspaceManagement='metadata'|'membership'|'trash';
interface WorkspacePageProps {
 workspaceId:string;
 selectedReportId:string;
 tab:string;
 hasExplicitReportView:boolean;
 onSelectReport:(reportId:string)=>void;
 onTab:(tab:string,reportId:string)=>void;
 onTrash:()=>void;
 onNavigate:(href:string)=>void;
}

export function WorkspacePage(props:WorkspacePageProps){
 const {workspaceId,onNavigate}=props;
 const [loadedWorkspace,setLoadedWorkspace]=useState<{workspaceId:string;project:ReviewProject}>();
 const [projects,setProjects]=useState<ReviewProject[]>([]);
 const [workspaces,setWorkspaces]=useState<ReviewWorkspace[]>([]);
 const [catalogError,setCatalogError]=useState('');
 const [catalogRevision,setCatalogRevision]=useState(0);
 const refreshCatalog=useCallback(()=>setCatalogRevision(value=>value+1),[]);
 useEffect(()=>{
  const controller=new AbortController();
  Promise.all([workspacesApi.projects(controller.signal),workspacesApi.workspaces(undefined,controller.signal)]).then(([p,w])=>{
   if(!controller.signal.aborted){setProjects(p.projects);setWorkspaces(w.workspaces);setCatalogError('');}
  }).catch(cause=>{if(!controller.signal.aborted)setCatalogError(message(cause));});
  return()=>controller.abort();
 },[catalogRevision]);
 const activeWorkspace=workspaces.find(workspace=>workspace.workspaceId===workspaceId);
 const currentProject=loadedWorkspace?.workspaceId===workspaceId?loadedWorkspace.project:
  projects.find(item=>item.projectId===activeWorkspace?.projectId)??loadedWorkspace?.project;
 return <WorkspaceShell workspaceId={workspaceId} project={currentProject} workspaces={workspaces} onNavigate={onNavigate}>
  <WorkspaceDetailPane key={workspaceId} {...props} projects={projects} workspaces={workspaces} catalogError={catalogError}
   onWorkspaceLoaded={setLoadedWorkspace} onRefreshCatalog={refreshCatalog}/>
 </WorkspaceShell>;
}

function WorkspaceDetailPane({workspaceId,selectedReportId,tab:routeTab,hasExplicitReportView,onSelectReport,onTab,onTrash,onNavigate,projects,workspaces,catalogError,onWorkspaceLoaded,onRefreshCatalog}:WorkspacePageProps&{
 projects:ReviewProject[];
 workspaces:ReviewWorkspace[];
 catalogError:string;
 onWorkspaceLoaded:(data:{workspaceId:string;project:ReviewProject})=>void;
 onRefreshCatalog:()=>void;
}){
 const [detail,setDetail]=useState<PublicWorkspaceDetail>();
 const [hasSeenFirstReviewSummary,setHasSeenFirstReviewSummary]=useState(false);
 const tab=hasSeenFirstReviewSummary&&!hasExplicitReportView?'summary':routeTab;
 const [reportMetadata,setReportMetadata]=useState<Record<string,WorkspaceReportMetadata>>({});
 const [loadedReport,setReport]=useState<ReportDetail>();
 const [draftReportId,setDraftReportId]=useState('');
 const [reviewSourceReportId,setReviewSourceReportId]=useState('');
 const [acceptedRequests,setAcceptedRequests]=useState<PublicWorkspaceRequest[]>([]);
 const [imageIndex,setImageIndex]=useState(0);
 const [selection,setSelection]=useState<CaptureSelection|null>(null);
 const [previewRegion,setPreviewRegion]=useState<ImageRegion|null>(null);
 const [selectionRequest,setSelectionRequest]=useState(0);
 const [hasFocusDraft,setHasFocusDraft]=useState(false);
 const [comparisonDraftReportId,setComparisonDraftReportId]=useState('');
 const [reviewComposer,setReviewComposer]=useState<ReviewComposer>('screen');
 const [credentialRequestId,setCredentialRequestId]=useState<string>();
 const [management,setManagement]=useState<WorkspaceManagement|null>(null);
 const [instruction,setInstruction]=useState('');
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [pendingAction,setPendingAction]=useState('');
 const [actionError,setActionError]=useState('');
 const [detailError,setDetailError]=useState('');
 const [reportError,setReportError]=useState<{id:string;message:string}>();
 const [notice,setNotice]=useState('');
 const [tick,setTick]=useState(0);
 const [reportRevision,setReportRevision]=useState(0);
 const [selectionReset,setSelectionReset]=useState(0);
 const [comparison,setComparison]=useState<'action'|'time'>('action');
 const [previousReport,setPreviousReport]=useState<ReportDetail>();
 const captureRef=useRef<HTMLElement>(null);
 const manageRef=useRef<HTMLButtonElement>(null);
 const submission=useRef({signature:'',id:''});
 const retryKeys=useRef(new Map<string,string>());
 const isMounted=useRef(false);
 useLayoutEffect(()=>{
  isMounted.current=true;
  return()=>{isMounted.current=false;};
 },[]);
 const reportAttempts=workspaceReportAttempts(detail?.requests??[]);
 const reportMetadataKey=reportIdsNeedingMetadata(detail?.reportIds??[],reportAttempts).join(',');
 useEffect(()=>{
  if(!reportMetadataKey)return;
  const controller=new AbortController();
  workspacesApi.reportMetadata(workspaceId,controller.signal).then(({metadata})=>{
   if(!controller.signal.aborted)setReportMetadata(metadata);
  }).catch(()=>{/* The report remains selectable with its fallback label. */});
  return()=>controller.abort();
 },[workspaceId,reportMetadataKey,reportRevision]);
 useEffect(()=>{
  const controller=new AbortController();
  let isLoading=false;
  async function load(){
   if(isLoading)return;
   isLoading=true;
   try{
    const next=await workspacesApi.detail(workspaceId,controller.signal);
    if(!controller.signal.aborted){
     setDetail(next);
     if(!next.workspace.latestReportId&&!next.reportIds.length)setHasSeenFirstReviewSummary(true);
     setDetailError('');
     onWorkspaceLoaded({workspaceId,project:next.project});
    }
   }catch(cause){
    if(controller.signal.aborted)return;
    if(cause instanceof WorkspaceRequestError&&cause.status===404)setDetail(undefined);
    setDetailError(message(cause));
   }
   finally{isLoading=false;}
  }
  void load();
  const timer=setInterval(()=>void load(),4000);
  function reloadWhenVisible(){if(document.visibilityState==='visible')void load();}
  document.addEventListener('visibilitychange',reloadWhenVisible);
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',reloadWhenVisible);};
 },[workspaceId,tick,onWorkspaceLoaded]);
 useEffect(()=>{
  if(!detail)return;
  const acknowledgedIds=new Set(detail.requests.map(request=>request.requestId));
  for(const event of detail.membershipEvents??[]){
   if(event.entityType==='request'&&event.fromId===workspaceId)acknowledgedIds.add(event.entityId);
  }
  setAcceptedRequests(previous=>{
   const next=previous.filter((request,index)=>index===previous.length-1||!acknowledgedIds.has(request.requestId));
   return next.length===previous.length?previous:next;
  });
 },[detail,workspaceId]);
 const latestId=detail?.workspace.latestReportId??detail?.reportIds.at(-1)??'';
 const pinnedDraftReportId=draftReportId||comparisonDraftReportId;
 const requestedId=selectedReportId||pinnedDraftReportId||(tab==='compose'?reviewSourceReportId:'');
 useEffect(()=>{
  if(!selectedReportId||!pinnedDraftReportId||selectedReportId===pinnedDraftReportId)return;
  setDraftReportId('');
  setInstruction('');
  setSelection(null);
  setPreviewRegion(null);
  setHasFocusDraft(false);
  setComparisonDraftReportId('');
  setSelectionReset(value=>value+1);
  setNotice('다른 실행으로 이동해 이전 실행에서 작성 중이던 검토를 초기화했습니다.');
 },[selectedReportId,pinnedDraftReportId]);
 const hasMissingMembership=Boolean(detail&&requestedId&&!detail.reportIds.includes(requestedId));
 const currentId=detail&&!hasMissingMembership?requestedId||latestId:'';
 const report=loadedReport?.id===currentId?loadedReport:undefined;
 const activeReportError=reportError?.id===currentId?reportError.message:'';
 useEffect(()=>{
  if(!currentId)return;
  const controller=new AbortController();
  setReportError(undefined);
  reportsApi.detail(currentId,controller.signal).then(next=>{
   if(controller.signal.aborted)return;
   const initialImageIndex=findingImageIndex(next,next.findings[0]);
   setImageIndex(initialImageIndex>=0?initialImageIndex:Math.max(0,next.images.length-1));
   setPreviewRegion(null);
   setReport(next);
  }).catch(cause=>{
   if(!controller.signal.aborted)setReportError({id:currentId,message:message(cause)});
  });
  return()=>controller.abort();
 },[currentId,reportRevision]);
 const isLoadingReport=Boolean(currentId)&&!report&&!activeReportError;
 const selectedRequest=detail?.requests.find(request=>request.attempts.some(attempt=>attempt.reportId===currentId));
 const followup=report?.followup??(selectedRequest?.attempts.at(-1)?.reportId===currentId?selectedRequest.result:undefined);
 const previousId=selectedRequest?.parentReportId;
 useEffect(()=>{
  if(!previousId)return;
  const controller=new AbortController();
  reportsApi.detail(previousId,controller.signal).then(next=>{
   if(!controller.signal.aborted)setPreviousReport(next);
  }).catch(()=>{if(!controller.signal.aborted)setPreviousReport(undefined);});
  return()=>controller.abort();
 },[previousId]);
 const image=report?.images[imageIndex];
 const workspaceRequests=new Map((detail?.requests??[]).map(request=>[request.requestId,request]));
 const requestsById=new Map(workspaceRequests);
 for(const request of acceptedRequests){
  if(!requestsById.has(request.requestId))requestsById.set(request.requestId,request);
 }
 const movedRequests=new Map((detail?.membershipEvents??[])
  .filter(event=>event.entityType==='request'&&event.fromId===workspaceId)
  .map(event=>[event.entityId,event]));
 const isLocalRequest=(request:PublicWorkspaceRequest)=>workspaceRequests.has(request.requestId)||!movedRequests.has(request.requestId);
 const localRequests=[...requestsById.values()].filter(isLocalRequest);
 const running=localRequests.find(request=>request.attempts.at(-1)?.status==='running');
 const hasCaptureDraft=Boolean(instruction.trim()||selection||hasFocusDraft);
 const shouldOpenResultInNewTab=hasCaptureDraft||Boolean(comparisonDraftReportId)||isSubmitting;
 function refresh(){setTick(value=>value+1);}
 function rememberRequest(request:PublicWorkspaceRequest,sourceReportId?:string){
  setAcceptedRequests(previous=>[...previous.filter(item=>item.requestId!==request.requestId),request]);
  if(sourceReportId)setReviewSourceReportId(sourceReportId);
  refresh();
 }
 function handleInitialReview(request:PublicWorkspaceRequest){
  if(!isMounted.current)return;
  const requestId=request.attempts.at(-1)?.status==='awaiting-start'?request.requestId:undefined;
  setCredentialRequestId(requestId);
  if(requestId&&tab!=='summary')onTab('summary','');
  rememberRequest(request);
 }
 function chooseReport(id:string){
  if(id===currentId)return;
  if(shouldOpenResultInNewTab){
   setNotice('작성 중인 요청을 유지합니다. 입력과 영역 선택을 정리한 뒤 다른 결과를 선택하세요.');
   return;
  }
  setNotice('');
  onSelectReport(id);
 }
 function chooseImage(index:number){
  if(index===imageIndex)return true;
  if(hasCaptureDraft||isSubmitting){
   setNotice('기준 캡처를 바꾸려면 작성 중인 입력과 영역 선택을 먼저 지우세요.');
   return false;
  }
  setPreviewRegion(null);
  setImageIndex(index);
  return true;
 }
 function chooseSelection(value:CaptureSelection|null){
  setPreviewRegion(null);
  setSelection(value);
  setDraftReportId(value||instruction.trim()||hasFocusDraft?currentId:'');
 }
 function updateFocusDraft(value:boolean){
  setHasFocusDraft(value);
  setDraftReportId(value||selection||instruction.trim()?currentId:'');
 }
 function selectFocusRegion(){
  setPreviewRegion(null);
  setSelectionRequest(value=>value+1);
  captureRef.current?.scrollIntoView({block:'nearest'});
 }
 function updateComparisonDraft(hasDraft:boolean){
  setComparisonDraftReportId(previous=>hasDraft?currentId:previous===currentId?'':previous);
 }
 async function submit(event:FormEvent){
  event.preventDefault();
  if(!report||!instruction.trim())return;
  const shouldWaitForStart=(event.nativeEvent as SubmitEvent).submitter?.hasAttribute('data-waits-for-start');
  setIsSubmitting(true);
  setActionError('');
  try{
   const body={
    parentReportId:report.id,
    instruction:instruction.trim(),
    ...(shouldWaitForStart&&{shouldWaitForStart:true}),
    imageId:selection?.imageId??image?.id,
    ...(selection&&{sourceSha256:selection.sourceSha256,region:selection.region}),
   };
   const signature=JSON.stringify(body);
   if(submission.current.signature!==signature)submission.current={signature,id:createBrowserId()};
   const {request}=await workspacesApi.submit(workspaceId,{...body,submissionId:submission.current.id});
   if(!isMounted.current)return;
   submission.current={signature:'',id:''};
   setInstruction('');
   if(!hasFocusDraft){
    setSelection(null);
    setSelectionReset(value=>value+1);
    setDraftReportId('');
   }
   rememberRequest(request,report.id);
   if(shouldWaitForStart){
    setCredentialRequestId(request.requestId);
    setNotice('');
    if(tab!=='summary'||selectedReportId!==report.id)onTab('summary',report.id);
   }else setNotice('');
  }catch(cause){setActionError(message(cause));}
  finally{setIsSubmitting(false);}
 }
 async function action(request:PublicWorkspaceRequest,kind:'cancel'|'retry'){
  const attempt=request.attempts.at(-1);
  if(!attempt)return;
  setPendingAction(request.requestId);
  setActionError('');
  try{
   if(kind==='cancel')await workspacesApi.cancel(request.requestId,attempt.attemptId);
   else{
    const id=retryKeys.current.get(attempt.attemptId)??createBrowserId();
    retryKeys.current.set(attempt.attemptId,id);
    await workspacesApi.retry(request.requestId,attempt.attemptId,id);
    retryKeys.current.delete(attempt.attemptId);
   }
   refresh();
  }catch(cause){setActionError(message(cause));}
  finally{setPendingAction('');}
 }
 if(!detail)return <main className="review-workspace-main">{detailError?<div role="alert" className="workspace-error">{detailError}<Button variant="secondary" onClick={()=>{setDetailError('');refresh();}}>다시 불러오기</Button></div>:<p role="status">작업공간을 불러오는 중입니다.</p>}</main>;
 const workspaceError=actionError||detailError||catalogError;
 const comparisonReport=previousReport?.id===previousId?previousReport:undefined;
 const isImageReview=Boolean(report?.captures?.some(capture=>capture.image));
 const liveReviewUrl=selectedRequest?.targetUrl??report?.requestedUrl;
 const isStyleComparison=Boolean(selectedRequest?.comparisonUrl||selectedRequest?.comparisonUrls||report?.captures?.some(
  ({deterministicChecks})=>deterministicChecks?.autoStyleComparison||deterministicChecks?.autoStyleComparisons,
 ));
 const canPrepareCredentials=!isImageReview&&Boolean(liveReviewUrl&&canEnterReviewCredentials(liveReviewUrl)&&(selectedRequest||report?.taskContext));
 const waitingStarts=localRequests.flatMap(request=>{
  const attempt=request.attempts.at(-1);
  const targetUrl=request.targetUrl;
  if(attempt?.status!=='awaiting-start'||!targetUrl)return [];
  if(report&&tab!=='summary'&&!attempt.loginRedirect)return [];
  return [<ReviewStart key={attempt.attemptId} requestId={request.requestId} attemptId={attempt.attemptId} targetUrl={targetUrl} loginRedirect={attempt.loginRedirect} previousError={attempt.error}
   isAdditional={request.kind==='followup'} scopeLabel={request.instruction} shouldOpenCredentials={credentialRequestId===request.requestId}
   onDismissCredentials={()=>setCredentialRequestId(undefined)} onDone={refresh}/>];
 });
 const startCards=waitingStarts.length>0?<div className="workspace-review-starts">{waitingStarts}</div>:null;
 const firstReviewRequest=running??localRequests.find(request=>request.attempts.at(-1)?.status==='queued')
  ??localRequests.find(request=>request.attempts.at(-1)?.status==='awaiting-start')??localRequests.at(-1);
 const firstReviewAttempt=firstReviewRequest?.attempts.at(-1);
 const firstReviewState=firstReviewAttempt?.status;
 const firstReviewProgress=activePhases[firstReviewAttempt?.phase??firstReviewRequest?.phase??''];
 const hasFirstReviewAction=Boolean(firstReviewRequest?.canRetry||firstReviewState&&activeRequestStatuses.has(firstReviewState));
 const hasThemeComparison=report?.requestedThemeReview==='both';
 const themeImage=(theme:'light'|'dark')=>{
  const capture=report?.captures?.find(item=>item.theme?.requested===theme);
  return capture&&report?.images.find(item=>item.observationId===capture.observationId);
 };
 const firstImage=hasThemeComparison?themeImage('light'):report?.images.find(image=>image.observationId===followup?.beforeObservationId)??report?.images[0];
 const lastImage=hasThemeComparison?themeImage('dark'):report?.images.find(image=>image.observationId===followup?.afterObservationId)??report?.images.at(-1);
 const latestImage=lastImage??report?.images.at(-1);
 const oldImage=report?.baselineImages?.[0]??comparisonReport?.images.at(-1);
 const legacyReports=detail.reportIds.filter(id=>!reportAttempts.has(id));
 const runOptions=detail.reportIds.map(id=>{
  const attempt=reportAttempts.get(id);
  const metadata=reportMetadata[id];
  const title=attempt?.title || metadata?.title || (attempt?'요청 제목 미기록':`기존 검토 ${legacyReports.indexOf(id)+1}`);
  const execution=attempt?.attemptNumber===undefined?'':` · 실행 ${attempt.attemptNumber}`;
  const startedAt=hasExecutionDate(attempt?.startedAt)?attempt.startedAt:metadata?.startedAt;
  const date=hasExecutionDate(startedAt)?reportExecutionDate.format(new Date(startedAt)):'실행 날짜 미기록';
  return {value:id,label:`${title}${execution}`,description:date};
 }).reverse();
 const capture=image?.observationId?report?.captures?.find(item=>item.observationId===image.observationId):report?.captures?.length===1?report.captures[0]:undefined;
 const comparisonPanel=report&&<Disclosure className="workspace-comparison" title="화면 비교"><div className="workspace-comparison-content"><div className="workspace-compare-tabs"><Button variant={comparison==='action'?'primary':'secondary'} onClick={()=>setComparison('action')}>{hasThemeComparison?'라이트·다크':'이번 조작 전후'}</Button><Button variant={comparison==='time'?'primary':'secondary'} onClick={()=>setComparison('time')}>이전 기록과 현재</Button></div>{comparison==='action'?<>{firstImage&&lastImage&&firstImage.id!==lastImage.id?<ImageGallery key="action" className="workspace-compare-pair" label="이번 실행 캡처 비교" images={[
  toViewerImage({...firstImage,label:hasThemeComparison?firstImage.label:'이번 실행 · 처음 관찰'}),
  toViewerImage({...lastImage,label:hasThemeComparison?lastImage.label:'이번 실행 · 마지막 관찰'}),
 ]}/>:<p className="muted">{hasThemeComparison?'두 테마의 캡처를 모두 확인하지 못했습니다.':'비교할 전후 캡처가 없습니다.'}</p>}{!hasThemeComparison&&<p className="muted">준비 상태와 실제 동작 기록을 함께 확인하세요.</p>}</>:<>{oldImage&&latestImage?<ImageGallery key="time" className="workspace-compare-pair" label="이전 기록과 선택한 기록 캡처 비교" images={[
  toViewerImage({...oldImage,id:`previous-${oldImage.id}`,label:comparisonReport?.startedAt?`이전 기록 · ${new Date(comparisonReport.startedAt).toLocaleString('ko-KR')}`:'이전 기록'}),
  toViewerImage({...latestImage,id:`current-${latestImage.id}`,label:`선택한 기록 · ${new Date(report.startedAt).toLocaleString('ko-KR')}`}),
 ]}/>:<p>이전 근거를 읽지 못해 이번 근거만 확인할 수 있습니다.</p>}<p className="muted">서로 다른 시점의 비교입니다. 데이터·인증·선택 조건이 달라졌을 수 있습니다.</p></>}</div></Disclosure>;
 function requestControls(request:PublicWorkspaceRequest){
  const attempt=request.attempts.at(-1);
  return <>
   {attempt&&activeRequestStatuses.has(attempt.status)&&<Button variant="secondary" isLoading={pendingAction===request.requestId} onClick={()=>void action(request,'cancel')}>{attempt.status==='running'?'검증 중지':'대기 취소'}</Button>}
   {request.canRetry&&<Button variant="secondary" isLoading={pendingAction===request.requestId} onClick={()=>void action(request,'retry')}>같은 조건으로 재시도</Button>}
  </>;
 }
 const timeline=<div className="workspace-timeline">
  <p className="muted">각 요청이 관찰한 상태의 결과입니다. 결과를 선택해 해당 시점의 캡처와 지적을 확인하세요.</p>
  {[...detail.requests].reverse().map(request=>{
   const attempt=request.attempts.at(-1);
   const state=attempt?.runStatus??attempt?.status??'queued';
   const phase=attempt?.phase??request.phase;
   const reason=attempt?.reason??request.reason;
   const result=request.result;
   return <article className="workspace-timeline-item" key={request.requestId}>
    <div className="row-between wrap"><strong>{request.instruction}</strong><span className="workspace-status">{statuses[state]??'상태 확인 중'}</span></div>
    <time>{new Date(request.createdAt).toLocaleString('ko-KR')}</time>
    {(attempt?.phase||request.phase)&&<p>{phases[phase??'']??'검토 진행 중'}</p>}
    {(attempt?.reason||request.reason)&&<p>{reason}</p>}
    {result&&<p className="muted">이 요청에서 마지막으로 생성된 결과</p>}
    {result?.scopeDescription&&<p>확인 범위: {result.scopeDescription}</p>}
    {result?.answer&&<p>{result.answer}</p>}
    {result?.restoration.status==='failed'&&<p>이전 상태를 복원하지 못했습니다. {result.restoration.reason}</p>}
    {result&&result.history.length>0&&<Disclosure title={`관찰한 동작 ${result.history.length}개`}>
     {result.history.map(step=><p key={step.step}>{step.label??'화면 조작'}{step.optionLabel&&` / ${step.optionLabel}`} · {step.outcome==='success'?'동작 실행':step.outcome==='rejected'?'실행 거절':'동작 실패'}</p>)}
    </Disclosure>}
    {request.classification&&<p>다른 화면에서 연결됨: {request.classification.reason}</p>}
    {attempt?.error&&attempt.error!==reason&&<p className="workspace-error">{attempt.error}</p>}
    <div className="workspace-history-actions">
     {attempt?.reportId&&<Button variant="secondary" className="workspace-history-link" aria-current={attempt.reportId===currentId||undefined} onClick={()=>chooseReport(attempt.reportId!)}>이 결과 보기 <ArrowRight size={14} aria-hidden/></Button>}
     {requestControls(request)}
    </div>
    {(request.needsImageHandoff||result?.needsImageHandoff)&&<Handoff request={request} onDone={refresh}/>}
    <Disclosure title={`실행 이력 ${request.attempts.length}회`}>
     {request.attempts.map((entry,index)=><div className="workspace-history-entry" key={entry.attemptId}>
      <span>실행 {index+1} · {statuses[entry.runStatus??entry.status]??'상태 확인 중'}</span>
      {entry.reportId&&<Button variant="secondary" className="workspace-history-link" aria-current={entry.reportId===currentId||undefined} onClick={()=>chooseReport(entry.reportId!)}>결과 보기 <ArrowRight size={14} aria-hidden/></Button>}
     </div>)}
    </Disclosure>
   </article>;
  })}
  {legacyReports.map((id,index)=><article className="workspace-timeline-item" key={id}>
   <div className="workspace-history-entry">
    <strong>기존 검토 {index+1}</strong>
    <Button variant="secondary" className="workspace-history-link" aria-current={id===currentId||undefined} onClick={()=>chooseReport(id)}>이 기록 보기 <ArrowRight size={14} aria-hidden/></Button>
   </div>
  </article>)}
  {detail.requests.length===0&&detail.reportIds.length===0&&<p>아직 접수한 요청이 없습니다.</p>}
 </div>;
 const linkedScreens=detail.linkedWorkspaces.length>0&&<section className="workspace-panel workspace-linked-screens"><h2>연결된 다른 화면</h2>{detail.linkedWorkspaces.map(workspace=><a className="workspace-linked-screen" href={`/?workspace=${encodeURIComponent(workspace.workspaceId)}`} key={workspace.workspaceId} onClick={event=>navigateLink(event,onNavigate)}>{workspace.name}<ArrowRight size={16}/></a>)}</section>;
 const screenComposerLabel=isImageReview?'이미지 검토 작성':'검증 요청 작성';
 const screenOption={value:'screen' as const,label:screenComposerLabel};
 const focusOption={value:'focus' as const,label:'집중 재검토 작성'};
 const comparisonOption={value:'comparison' as const,label:isStyleComparison?'화면 스타일 다시 비교':'화면 스타일 비교'};
 const composerOptions=[
  ...(!isStyleComparison?[screenOption]:[]),
  ...(image?[focusOption]:[]),
  comparisonOption,
 ];
 const selectedComposer=composerOptions.find(option=>option.value===reviewComposer)
  ??(isStyleComparison?comparisonOption:screenOption);
 const composerKind=selectedComposer.value;
 const isComposing=tab==='compose';
 const isViewingResults=tab==='results'||tab==='suggestions';
 const isSummaryVisible=!report||tab==='summary';
 const lastAcceptedId=acceptedRequests.at(-1)?.requestId;
 const lastSettledRequest=detail.requests.findLast(request=>(request.kind!=='initial'||request.comparisonUrl||request.comparisonUrls)&&
  ['completed','failed','cancelled'].includes(request.attempts.at(-1)?.status??''));
 const visibleRequests=[...requestsById.values()].filter(request=>request.requestId===lastAcceptedId||
  request.requestId===lastSettledRequest?.requestId||(isLocalRequest(request)&&
  activeRequestStatuses.has(request.attempts.at(-1)?.status??'')))
  .sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
 const reviewQueue=visibleRequests.length>0&&<section className="workspace-review-requests" aria-label="검토 요청">
   <h3>검토 요청</h3>
   <ul>
    {visibleRequests.map(request=>{
     const attempt=request.attempts.at(-1);
     const movement=isLocalRequest(request)?undefined:movedRequests.get(request.requestId);
     const reportId=movement?.reportIds?.at(-1)??attempt?.reportId;
     const state=attempt?.status==='completed'?attempt.runStatus??attempt.status:attempt?.status;
     const label=movement?'다른 화면으로 이동':statuses[state??'']??'상태 확인 중';
     const instruction=request.comparisonUrl||request.comparisonUrls?'화면 스타일 비교':request.instruction;
     return <li key={request.requestId} className="workspace-review-request">
      <div className="workspace-review-request-description">
       <span role="status">
        <span className="sr-only">{instruction} </span>
        <Badge tone={state==='failed'?'danger':state==='partial'?'warning':'neutral'}>{label}</Badge>
       </span>
       <p>{instruction}</p>
      </div>
      {reportId&&<LinkButton variant="secondary" href={workspaceReportHref(movement?.toId??workspaceId,reportId,'results')}
       target={shouldOpenResultInNewTab?'_blank':undefined} rel={shouldOpenResultInNewTab?'noopener':undefined}
       onClick={shouldOpenResultInNewTab?undefined:event=>navigateLink(event,onNavigate)}>
       결과 보기{shouldOpenResultInNewTab&&<><ExternalLink size={14} aria-hidden/><span className="sr-only"> (새 탭 열기)</span></>}
      </LinkButton>}
      {!movement&&attempt?.status==='queued'&&<Button variant="secondary" isLoading={pendingAction===request.requestId} onClick={()=>void action(request,'cancel')}>대기 취소</Button>}
     </li>;
    })}
   </ul>
  </section>;
 const composer=report&&<section className="workspace-panel workspace-continue" aria-label={selectedComposer.label}>
   {composerOptions.length>1?<Select label="검토 방식" value={composerKind} options={composerOptions}
    onValueChange={value=>setReviewComposer(value as ReviewComposer)}/>:<h2>{selectedComposer.label}</h2>}
   {!isStyleComparison&&<div hidden={composerKind!=='screen'}>
    <p className="muted">{isImageReview?'제공된 이미지에 보이는 내용을 검토합니다. 클릭이나 필터 변경 등 실제 웹 동작은 확인하지 않습니다.':'웹 화면을 열어 동작을 새로 확인합니다.'}</p>
    <form className="workspace-composer" onSubmit={submit}>
     {selection&&<div className="workspace-selected-chip">선택한 캡처 영역 <Button variant="secondary" disabled={isSubmitting} onClick={()=>{chooseSelection(null);setSelectionReset(value=>value+1);}}>해제</Button></div>}
     <TextArea
      label="추가 지시" rows={4} required maxLength={4000} value={instruction} disabled={isSubmitting}
      onChange={event=>{
       setInstruction(event.target.value);
       setDraftReportId(event.target.value.trim()||selection||hasFocusDraft?currentId:'');
      }}
      placeholder={isImageReview?'선택한 영역에서 글자가 읽기 쉽고 선택 상태가 구분되는지 확인해줘':'선택한 영역에서 최신으로 전환한 뒤 목록이 바뀌는지 확인해줘'}
     />
     <div className="workspace-composer-actions">
      <Button variant="secondary" disabled={isSubmitting||(!instruction&&!selection)} onClick={()=>{
       setInstruction('');
       setSelection(null);
       setSelectionReset(value=>value+1);
       setDraftReportId(hasFocusDraft?currentId:'');
       setNotice('입력과 영역 선택을 지웠습니다.');
      }}>입력 지우기</Button>
      <div className="review-start-actions">
       <Button type="submit" disabled={!instruction.trim()} isLoading={isSubmitting}>{running?'대기에 추가':isImageReview?'이미지 검토 요청':'검증 요청'}<Send size={15}/></Button>
       {canPrepareCredentials&&<Button type="submit" variant="secondary" data-waits-for-start disabled={!instruction.trim()||isSubmitting}>로그인 정보 입력</Button>}
      </div>
     </div>
     <p className="muted">{running?'현재 검증이 끝나면 순서대로 진행합니다.':isImageReview?'현재 이미지와 지시를 바탕으로 검토 범위를 판단합니다.':canPrepareCredentials?'로그인 정보는 선택 사항입니다. 검증 요청 버튼으로 로그인 없이 시작할 수 있습니다.':'목표와 선택한 영역을 바탕으로 조작·검증 범위를 판단합니다.'}</p>
    </form>
   </div>}
   {image&&<div hidden={composerKind!=='focus'}>
    <FocusedReview key={`${report.id}/${image.id}`} reportId={report.id} image={image} sharedCapture={{
     selection,
     isDisabled:isSubmitting,
     isComposerOpen:isComposing&&composerKind==='focus',
     onSelectRegion:selectFocusRegion,
     onShowRegion:region=>{setPreviewRegion(region);captureRef.current?.scrollIntoView({block:'nearest'});},
     onDraftChange:updateFocusDraft,
    }}/>
   </div>}
   <div hidden={composerKind!=='comparison'}>
    <InitialReview key={selectedRequest?.requestId??report.id} workspaceId={workspaceId}
     comparison={{referenceUrl:liveReviewUrl,comparisonUrl:selectedRequest?.comparisonUrl,comparisonUrls:selectedRequest?.comparisonUrls}}
     onComparisonDraftChange={updateComparisonDraft}
     onDone={request=>{
      if(!isMounted.current)return;
      setNotice('');
      rememberRequest(request,report.id);
     }}/>
   </div>
   {reviewQueue}
  </section>;
 const firstReviewTitle=hasMissingMembership?'이 작업공간에서 해당 검증을 찾을 수 없습니다.'
  :isLoadingReport?'선택한 검증을 불러오는 중입니다.'
  :activeReportError?'검증 결과를 불러오지 못했습니다.'
  :firstReviewRequest?'검토 요청 접수':'첫 검토를 준비하세요';
 const firstReviewSummary=<section className="workspace-panel workspace-current-result">
  <div className="workspace-result-title">
   <h2>{firstReviewTitle}</h2>
   {!currentId&&!hasMissingMembership&&firstReviewState&&<span role="status">
    <Badge tone={firstReviewState==='failed'?'danger':'neutral'}>{statuses[firstReviewState]??'상태 확인 중'}</Badge>
   </span>}
  </div>
  {hasMissingMembership?<a href={`/?report=${encodeURIComponent(requestedId)}&tab=${encodeURIComponent(tab)}`}>보고서 위치 확인</a>
   :activeReportError?<><p role="alert">{activeReportError}</p><Button variant="secondary" onClick={()=>setReportRevision(value=>value+1)}>다시 불러오기</Button></>
   :!currentId&&<>{firstReviewRequest?<>
    {startCards}
    {firstReviewState==='running'&&firstReviewProgress&&<p className="muted" role="status">{firstReviewProgress}</p>}
    {firstReviewState==='queued'&&<p className="muted">실행 순서를 기다리고 있습니다.</p>}
    {firstReviewState==='failed'&&firstReviewAttempt?.error&&<p role="alert">{firstReviewAttempt.error}</p>}
    {hasFirstReviewAction&&<div className="review-start-actions">{requestControls(firstReviewRequest)}</div>}
   </>:<>
    {detail.workspace.goal&&<p className="muted">{detail.workspace.goal}</p>}
    <InitialReview workspaceId={workspaceId} onDone={handleInitialReview}/>
   </>}</>}
 </section>;
 return <main className="review-workspace-main">
  <Breadcrumb items={[
   {href:projectsHref,label:'리뷰 프로젝트'},
   {href:`/?project=${encodeURIComponent(detail.project.projectId)}`,label:detail.project.name},
  ]}/>
  <header className="workspace-heading">
   <h1>{detail.workspace.name}</h1>
   <div className="workspace-heading-actions">
    {runOptions.length>0&&<div className="workspace-run-selector"><Select label="보고서" shouldShowLabelInTrigger placeholder="보고서" value={currentId} onValueChange={chooseReport} options={runOptions} contentClassName="workspace-report-options" triggerClassName="gc-dropdown-trigger"/></div>}
    {latestId&&latestId!==currentId&&<Button variant="secondary" onClick={()=>chooseReport(latestId)}>새 결과 보기</Button>}
    <ActionMenu label="관리" triggerRef={manageRef} shouldRestoreFocusOnSelect={false} items={[
     ...(report?[{label:'보고서 이름과 분류 편집',onSelect:()=>setManagement('metadata')}]:[]),
     {label:'프로젝트와 화면 소속 변경',onSelect:()=>setManagement('membership')},
     {label:'휴지통으로 이동',onSelect:()=>setManagement('trash'),isDestructive:true},
    ]}/>
   </div>
  </header>
  {workspaceError&&<p role="alert" className="workspace-error">{workspaceError}</p>}{notice&&<p role="status" className="workspace-notice">{notice}</p>}
  {report&&startCards}
  <section className={`workspace-report${isSummaryVisible?' workspace-report-summary':isComposing?' workspace-report-composing':isViewingResults?' workspace-report-results':''}`}>
  {report?<ReportContent key={report.id} report={report} tab={tab} onTab={nextTab=>onTab(nextTab,nextTab==='compose'?selectedReportId:report.id)}
   workspace={{
    imageIndex,
    onImageIndex:chooseImage,
    goal:detail.workspace.goal,
    composer,
    result:<>
     <div className="workspace-result-title">
      <h2>{currentId===latestId?'현재 결과':'선택한 검증 결과'} <Badge tone={report.status==='partial'?'warning':report.status==='failed'?'danger':'neutral'}>{statuses[report.status]??evaluationLabel(report)??'상태 확인 중'}</Badge></h2>
      <time dateTime={report.startedAt}>{new Date(report.startedAt).toLocaleString('ko-KR')}</time>
     </div>
     {followup?.reason&&<p>{followup.reason}</p>}
    </>,
    renderEvidence:preferredFindingId=>image?<section className="workspace-panel workspace-report-capture" ref={captureRef} aria-label="관찰 화면">
     <RegionCapture key={image.id} reportId={report.id} images={report.images} imageIndex={imageIndex}
      resetKey={selectionReset} onChange={chooseSelection} preferredFindingId={preferredFindingId}
      selectionRequest={selectionRequest} isSelectionDisabled={isSubmitting} previewRegion={previewRegion} onClearPreview={()=>setPreviewRegion(null)}/>
     <p className="workspace-capture-meta">{image.label}{image.observationId&&` · ${image.observationId}`}</p>
     {report.images.length>1&&<div className="workspace-image-picker" role="group" aria-label="캡처 선택">{report.images.map((item,index)=>
      <Button variant={index===imageIndex?'primary':'secondary'} aria-pressed={index===imageIndex} key={item.id} disabled={isSubmitting}
       onClick={()=>chooseImage(index)}>{item.label||`${index+1}번 캡처`}</Button>)}</div>}
     <Disclosure title="관찰 조건"><CaptureConditions capture={capture}/></Disclosure>
    </section>:<section className="workspace-panel workspace-empty"><h2>이 검증에 저장된 캡처가 없습니다.</h2></section>,
   }}
  />:<WorkspaceReportTabs tab="summary" panels={{summary:firstReviewSummary}}/>}
  <div className="workspace-report-summary-details" hidden={!isSummaryVisible}>
   {comparisonPanel}
   <Disclosure title="요청과 검증 내역" shouldKeepMounted>{timeline}</Disclosure>
   {linkedScreens}
  </div>
  </section>
  <Dialog isOpen={management==='metadata'&&Boolean(report)} onOpenChange={isOpen=>{if(!isOpen)setManagement(null);}}
   title="보고서 이름과 분류 편집" returnFocusRef={manageRef}>
   {report&&<ReportMetadataEditor key={report.id} reportId={report.id}/>}
  </Dialog>
  <Dialog isOpen={management==='membership'} onOpenChange={isOpen=>{if(!isOpen)setManagement(null);}}
   title="프로젝트와 화면 소속 변경" returnFocusRef={manageRef}>
   <Membership key={`${detail.workspace.version}/${detail.workspace.projectId}`} detail={detail} projects={projects} workspaces={workspaces} onDone={()=>{refresh();onRefreshCatalog();}}/>
  </Dialog>
  <TrashWorkspaceDialog workspace={detail.workspace} hasDraft={hasCaptureDraft||Boolean(comparisonDraftReportId)} onTrash={()=>{onRefreshCatalog();if(isMounted.current)onTrash();}}
   isOpen={management==='trash'} onClose={()=>setManagement(null)} returnFocusRef={manageRef}/>
 </main>;
}
