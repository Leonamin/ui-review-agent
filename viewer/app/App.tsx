import {lazy,Suspense,useEffect,useRef,useState} from 'react';
import {CircleHelp,Scan} from 'lucide-react';
import {Button} from '../shared/goodcase/components/basic/button';
import {Dialog,DialogClose} from '../shared/goodcase/components/overlays/dialog';
import {SettingsPage} from '../features/settings/SettingsPage';
import {ReportMetadataEditor} from '../features/reports/ReportMetadataEditor';
import {ReportPage,type LoadState} from '../features/reports/ReportPage';
import {ReportSearchPage,type ReportSearchMemory} from '../features/reports/ReportSearchPage';
import {reportsApi} from '../features/reports/api';
import {emptyReportFilters} from '../features/reports/report-list';
import type {ReportDetail,ReportRecommendation,ReportsApi,ReportScope} from '../features/reports/types';
import {WorkspaceRequestError,workspacesApi} from '../features/workspaces/api';
import {projectsHref,projectManagementHref,projectSettingParam,reportHref,reportRoute,workspaceReportHref,workspaceReportTab,type ProjectManagementAction} from './route';

const ProjectsPage=lazy(()=>import('../features/projects/ProjectsPage').then(module=>({default:module.ProjectsPage})));
const WorkspacePage=lazy(()=>import('../features/workspaces/WorkspacePage').then(module=>({default:module.WorkspacePage})));
const WorkspaceTrashPage=lazy(()=>import('../features/workspaces/WorkspaceTrashPage').then(module=>({default:module.WorkspaceTrashPage})));

type WorkspaceLookup = {status:'ready'}|{status:'error';error:string};

function StandaloneReport({api,current,workspaceLookup,navigate,navigatePage,onRetryLookup}:{
 api:ReportsApi;
 current:ReturnType<typeof reportRoute>;
 workspaceLookup?:WorkspaceLookup;
 navigate:(href:string)=>void;
 navigatePage:(href:string)=>void;
 onRetryLookup:()=>void;
}) {
 const [revision,setRevision]=useState(0);
 const [loadedDetail,setDetail]=useState<LoadState<ReportDetail>>({status:'loading'});
 const canLoadDetail=workspaceLookup?.status==='ready';
 useEffect(()=>{
  if(!canLoadDetail)return;
  const controller=new AbortController();
  setDetail({status:'loading'});
  api.detail(current.id,controller.signal).then(data=>{
   if(!controller.signal.aborted)setDetail({status:'ready',data});
  }).catch(error=>{
   if(!controller.signal.aborted)setDetail({status:'error',error:error.message});
  });
  return()=>controller.abort();
 },[api,current.id,revision,canLoadDetail]);
 const detail:LoadState<ReportDetail>=workspaceLookup?.status==='error'
  ?{status:'error',error:workspaceLookup.error}
  :canLoadDetail?loadedDetail:{status:'loading'};
 function updateRecommendation(recommendation:ReportRecommendation){
  setDetail(old=>old.data?{...old,data:{...old.data,recommendation}}:old);
 }
 function retryDetail(){
  if(workspaceLookup?.status==='error')onRetryLookup();
  else setRevision(value=>value+1);
 }
 return <ReportPage detail={detail} tab={current.tab}
  onTab={tab=>navigate(reportHref(current.id,tab))}
  onBack={navigatePage}
  onRetryDetail={retryDetail}
  metadataEditor={detail.status==='ready'&&detail.data?<ReportMetadataEditor reportId={current.id} onSaved={updateRecommendation}/>:undefined}
 />;
}

export function App({api=reportsApi}:{api?:ReportsApi}) {
 const [search,setSearch]=useState(location.search);
 const searchMemory=useRef<Record<ReportScope,ReportSearchMemory>>({
  linked:{filters:emptyReportFilters,scrollY:0},
  unlinked:{filters:emptyReportFilters,scrollY:0},
 });
 const [workspaceLookup,setWorkspaceLookup]=useState<{reportId:string;result:WorkspaceLookup}>();
 const [lookupRevision,setLookupRevision]=useState(0);
 useEffect(()=>{
  const listener=()=>setSearch(location.search);
  window.addEventListener('popstate',listener);
  return()=>window.removeEventListener('popstate',listener);
 },[]);
 const params=new URLSearchParams(search);
 const view=params.get('view')??'';
 const workspaceId=params.get('workspace')??'';
 const projectId=params.get('project')??'';
 const projectAction=projectId?(projectSettingParam(params)??(
  params.get('manage')==='delete'&&history.state?.projectManagementParent===projectId?'delete':undefined
 )):undefined;
 const currentReport=reportRoute(search);
 const isWorkspace=Boolean(workspaceId);
 const reportScope:ReportScope|undefined=view==='report-search'?'linked':view==='unlinked-reports'?'unlinked':undefined;
 const isStandaloneReport=!isWorkspace&&!projectId&&!view&&Boolean(currentReport.id);
 const isSettings=!isWorkspace&&!projectId&&view==='settings';
 const isTrash=!isWorkspace&&!projectId&&view==='trash';
 const isProjects=Boolean(projectId)||!reportScope&&!isStandaloneReport&&!isSettings&&!isTrash;
 const reportIdToResolve=isStandaloneReport?currentReport.id:'';
 useEffect(()=>{
  setWorkspaceLookup(undefined);
  if(!reportIdToResolve)return;
  const controller=new AbortController();
  function markUnlinked(){
   setWorkspaceLookup({reportId:reportIdToResolve,result:{status:'ready'}});
  }
  workspacesApi.context(reportIdToResolve,controller.signal).then(({workspace})=>{
   if(controller.signal.aborted)return;
   const currentSearch=location.search;
   const currentParams=new URLSearchParams(currentSearch);
   if(currentParams.get('workspace')||currentParams.get('project')||currentParams.get('view')||currentParams.get('report')!==reportIdToResolve)return;
   if(!workspace){markUnlinked();return;}
   const href=workspaceReportHref(workspace.workspaceId,reportIdToResolve,workspaceReportTab(currentSearch));
   history.replaceState(history.state,'',href);
   setSearch(location.search);
  }).catch(error=>{
   if(controller.signal.aborted)return;
   if(error instanceof WorkspaceRequestError&&error.status===404){markUnlinked();return;}
   setWorkspaceLookup({reportId:reportIdToResolve,result:{
    status:'error',
    error:error instanceof Error?error.message:'연결된 작업공간을 확인하지 못했습니다.',
   }});
  });
  return()=>controller.abort();
 },[reportIdToResolve,lookupRevision]);
 function navigate(href:string){
  const url=new URL(href,location.href);
  if(url.href!==location.href)history.pushState(null,'',url);
  setSearch(location.search);
 }
 function navigatePage(href:string){
  navigate(href);
  window.scrollTo(0,0);
 }
 function openProjectManagement(action:ProjectManagementAction){
  history.pushState({projectManagementParent:projectId},'',projectManagementHref(projectId,action));
  setSearch(location.search);
 }
 function closeProjectManagement(){
  if(history.state?.projectManagementParent===projectId){history.back();return;}
  const url=new URL(location.href);
  url.searchParams.delete('manage');
  history.replaceState(history.state,'',url);
  setSearch(location.search);
 }
 return <>
  <nav className="workspace-nav" aria-label="작업 공간">
   <a href={projectsHref} className="workspace-brand"><Scan className="workspace-brand-mark" size={28} strokeWidth={2.5} aria-hidden="true" focusable="false"/>UI Review Agent</a>
   <div className="workspace-links">
    <a href={projectsHref} aria-current={isWorkspace||isProjects||reportScope||isStandaloneReport?'page':undefined}>리뷰 프로젝트</a>
    <a href="/?view=trash" aria-current={isTrash?'page':undefined}>휴지통</a>
    <a href="/?view=settings" aria-current={isSettings?'page':undefined}>설정</a>
   </div>
   <Dialog title="UI 리뷰 시작하기" shouldCloseOnOutsideClick={false}
    trigger={<Button variant="secondary" className="workspace-help"><CircleHelp size={18} aria-hidden/>사용 가이드</Button>}
    footer={<DialogClose><Button>확인</Button></DialogClose>}>
    <ol className="viewer-guide-steps">
     <li><strong>화면 추가</strong><p>프로젝트에 화면별 작업공간을 만들고 URL이나 이미지를 추가합니다.</p></li>
     <li><strong>확인할 내용 입력</strong><p>검토 목표를 적고, 결과 화면에서 영역과 추가 지시로 검증을 이어갑니다.</p></li>
     <li><strong>결과 확인</strong><p>리뷰 프로젝트의 보고서 검색에서 작업공간의 검사 회차를 바로 열 수 있습니다. 작업공간에 연결하지 않은 결과는 관리 메뉴의 미연결 보고서에서 열 수 있습니다.</p></li>
    </ol>
    <section><h3>새 검토와 재시도는 어떻게 다른가요?</h3><p>추가 지시는 작업공간의 새 요청으로 쌓입니다. 진행 중 접수한 지시는 순서대로 대기하며, 재시도는 같은 요청의 실행 이력에 남습니다.</p></section>
    <section><h3>분석 완료가 문제 해결을 뜻하나요?</h3><p>분석 완료는 보고서 생성이 끝났다는 뜻입니다. AI 판단과 실제 검사 결과는 구분하며, 이전 지적의 해결을 자동으로 판정하지 않습니다.</p></section>
   </Dialog>
  </nav>
  <Suspense fallback={<main className="review-project-main" role="status">화면을 불러오는 중입니다.</main>}>
   {isWorkspace?<WorkspacePage
    workspaceId={workspaceId} selectedReportId={currentReport.id} tab={workspaceReportTab(search)}
    hasExplicitReportView={Boolean(currentReport.id||params.get('tab'))} onNavigate={navigatePage}
    onSelectReport={reportId=>navigate(workspaceReportHref(workspaceId,reportId,'results'))}
    onTab={(tab,reportId)=>{
     if(new URLSearchParams(location.search).get('workspace')===workspaceId)navigate(workspaceReportHref(workspaceId,reportId,tab));
    }}
    onTrash={()=>{
     if(new URLSearchParams(location.search).get('workspace')===workspaceId)navigate('/?view=trash');
    }}
   />:isProjects?<ProjectsPage key={projectId} projectId={projectId} onNavigate={navigatePage}
    managementAction={projectAction} onOpenManagement={openProjectManagement} onCloseManagement={closeProjectManagement}/>
    :reportScope?<ReportSearchPage key={reportScope} scope={reportScope} api={api} memory={searchMemory.current[reportScope]} onNavigate={navigatePage}/>
    :isStandaloneReport?<StandaloneReport key={currentReport.id} api={api} current={currentReport}
      workspaceLookup={workspaceLookup?.reportId===reportIdToResolve?workspaceLookup.result:undefined}
      navigate={navigate} navigatePage={navigatePage} onRetryLookup={()=>setLookupRevision(value=>value+1)}
     />
    :isTrash?<WorkspaceTrashPage/>:<SettingsPage/>}
  </Suspense>
 </>;
}
