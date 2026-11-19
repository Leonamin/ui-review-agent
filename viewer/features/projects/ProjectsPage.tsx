import {LinkButton} from '../../shared/LinkButton';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,FolderOpen,Plus,Search} from 'lucide-react';
import {navigateLink,projectsHref,reportSearchHref,unlinkedReportsHref,type ProjectManagementAction} from '../../app/route';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {TextField} from '../../shared/goodcase/components/basic/text-field';
import {ThemeReviewCheckbox} from '../../shared/ThemeReviewCheckbox';
import {TextArea} from '../../shared/goodcase/components/basic/text-area';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {ActionMenu} from '../../shared/ActionMenu';
import {PageBackLink} from '../../shared/PageNavigation';
import {createBrowserId} from '../../shared/browser/id';
import {canEnterReviewCredentials,uploadImage} from '../tasks/api';
import {reportsApi} from '../reports/api';
import {reportName,evaluationLabel} from '../reports/presentation';
import type {ReportSummary} from '../reports/types';
import type {ReviewProject,ReviewWorkspace} from '../../../src/workspace-contract';
import {workspacesApi,workspaceRequest} from '../workspaces/api';
import {ProjectManagement} from './ProjectManagement';
import {selectProjectCards,type ProjectCatalogView,type ProjectReportFilter,type ProjectSort} from './catalog';
import '../workspaces/workspaces.css';
import './projects.css';

const projectReportOptions=[
 {value:'all',label:'전체'},
 {value:'with-reports',label:'보고서 있음'},
 {value:'without-reports',label:'보고서 없음'},
] satisfies {value:ProjectReportFilter;label:string}[];
const projectSortOptions=[
 {value:'name-asc',label:'이름 오름차순'},
 {value:'name-desc',label:'이름 내림차순'},
 {value:'created',label:'최근 생성순'},
 {value:'latest-report',label:'최근 보고서순'},
] satisfies {value:ProjectSort;label:string}[];

function NewWorkspace({project,onDone,onCancel}:{project:ReviewProject;onDone:(workspaceId:string,shouldWaitForStart:boolean)=>void;onCancel:()=>void}){
 const [name,setName]=useState(''),[goal,setGoal]=useState(''),[kind,setKind]=useState('url'),[url,setUrl]=useState(''),[shouldCheckBothThemes,setShouldCheckBothThemes]=useState(false),[file,setFile]=useState<File>(),[reportId,setReportId]=useState(''),[reports,setReports]=useState<ReportSummary[]>([]),[isSubmitting,setIsSubmitting]=useState(false),[hasCreatedWorkspace,setHasCreatedWorkspace]=useState(false),[error,setError]=useState('');
 const created=useRef<ReviewWorkspace|undefined>(undefined),submission=useRef({signature:'',id:''}),uploaded=useRef(new Map<File,string>());
 const canPrepareCredentials=kind==='url'&&canEnterReviewCredentials(url.trim());
 useEffect(()=>{const controller=new AbortController();reportsApi.list(controller.signal).then(data=>setReports(data.reports)).catch(()=>{});return()=>controller.abort();},[]);
 async function submit(event:FormEvent<HTMLFormElement>){event.preventDefault();const shouldWaitForStart=canPrepareCredentials&&((event.nativeEvent as SubmitEvent).submitter?.hasAttribute('data-waits-for-start')??false);setIsSubmitting(true);setError('');try{
  if(!created.current){created.current=(await workspacesApi.createWorkspace({projectId:project.projectId,name:name.trim(),goal:goal.trim()})).workspace;setHasCreatedWorkspace(true);}
  const workspace=created.current;
  if(kind==='existing'){if(!reportId)throw new Error('연결할 보고서를 선택하세요.');await workspacesApi.attach(workspace.workspaceId,{reportId,expectedVersion:workspace.version});}
  else{let assetId:string|undefined;if(kind==='image'){if(!file)throw new Error('이미지 파일을 선택하세요.');assetId=uploaded.current.get(file)??await uploadImage(file);uploaded.current.set(file,assetId);}
   const body={target:kind==='url'?{kind:'url',url:url.trim(),viewport:{width:1440,height:900},...(shouldWaitForStart&&{shouldWaitForStart:true}),...(shouldCheckBothThemes?{themeReview:{mode:'both'}}:{})}:{kind:'image',assetId}};const signature=JSON.stringify(body);if(submission.current.signature!==signature)submission.current={signature,id:createBrowserId()};await workspacesApi.initial(workspace.workspaceId,{...body,submissionId:submission.current.id});
  }onDone(workspace.workspaceId,shouldWaitForStart);
 }catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setIsSubmitting(false);}}
 return <form className="workspace-create-form" onSubmit={submit}><div className="row-between"><h1>새 UI 검토 작업공간</h1><Button variant="secondary" onClick={onCancel}>취소</Button></div><p className="muted">{project.name}에서 한 화면이나 기능의 요청과 검증 결과를 이어서 확인합니다.</p><fieldset disabled={isSubmitting}><label>화면 또는 기능 이름<Input required maxLength={160} value={name} disabled={hasCreatedWorkspace} onChange={event=>setName(event.target.value)} placeholder="홈 화면의 카테고리 필터"/></label><TextArea label="확인할 내용" required maxLength={4000} disabled={hasCreatedWorkspace} value={goal} onChange={event=>setGoal(event.target.value)} placeholder="화면에서 사용자가 하려는 일과 확인할 동작"/><Select label="시작할 자료" value={kind} onValueChange={setKind} options={[{value:'url',label:'사이트 URL'},{value:'image',label:'준비한 이미지'},{value:'existing',label:'기존 보고서 연결'}]} isDisabled={isSubmitting}/>
 {kind==='url'?<><label>화면 URL<Input required type="url" value={url} onChange={event=>setUrl(event.target.value)} placeholder="https://…"/></label><ThemeReviewCheckbox isChecked={shouldCheckBothThemes} onChange={setShouldCheckBothThemes} isDisabled={isSubmitting}/></>:kind==='image'?<label>이미지<Input type="file" accept="image/png,image/jpeg,image/webp" required onChange={event=>setFile(event.target.files?.[0])}/><small>PNG/JPEG/WebP, 최대 5 MiB. 개인정보를 제거한 이미지를 사용하세요.</small></label>:<Select label="연결할 기존 보고서" value={reportId} onValueChange={setReportId} options={reports.map(report=>({value:report.id,label:`${reportName(report)} · ${new Date(report.startedAt).toLocaleString('ko-KR')} · ${evaluationLabel(report)}`}))} isDisabled={isSubmitting}/>}
 {hasCreatedWorkspace&&<p role="status">작업공간은 생성되었습니다. 첫 검토 접수만 다시 진행합니다.</p>}{kind!=='existing'&&<p className="workspace-submit-note">서버 설정으로 AI 검토를 시작합니다. {canPrepareCredentials?'로그인 정보는 작업공간을 만든 뒤 입력할 수 있습니다. ':''}결제와 계정 변경은 자동으로 진행하지 않습니다.</p>}{error&&<p role="alert" className="workspace-error">{error}</p>}<div className="review-start-actions">
  <Button type="submit" isLoading={isSubmitting} disabled={kind==='existing'&&!reportId}>{kind==='existing'?'기존 보고서 연결':'작업공간 만들고 검토 시작'}</Button>
  {canPrepareCredentials&&<Button type="submit" variant="secondary" data-waits-for-start disabled={isSubmitting}>로그인 정보 입력</Button>}
 </div></fieldset></form>;
}
export function ProjectsPage({projectId='',onNavigate,managementAction,onOpenManagement,onCloseManagement}:{
 projectId?:string;
 onNavigate:(href:string)=>void;
 managementAction?:ProjectManagementAction;
 onOpenManagement:(action:ProjectManagementAction)=>void;
 onCloseManagement:()=>void;
}){
 const [catalog,setCatalog]=useState<ProjectCatalogView>({projects:[],hasMoreReports:false}),[project,setProject]=useState<ReviewProject>(),[projectWorkspaces,setProjectWorkspaces]=useState<ReviewWorkspace[]>([]),[reports,setReports]=useState<ReportSummary[]>([]),[search,setSearch]=useState(''),[sort,setSort]=useState<ProjectSort>('name-asc'),[reportFilter,setReportFilter]=useState<ProjectReportFilter>('all'),[name,setName]=useState(''),[description,setDescription]=useState(''),[isCreatingProject,setIsCreatingProject]=useState(false),[isCreatingWorkspace,setIsCreatingWorkspace]=useState(false),[isSubmitting,setIsSubmitting]=useState(false),[isLoading,setIsLoading]=useState(true),[error,setError]=useState(''),[tick,setTick]=useState(0);
 useEffect(()=>{
  const controller=new AbortController(),{signal}=controller;
  setIsLoading(true);
  async function load(){
   if(!projectId){setCatalog(await workspaceRequest<ProjectCatalogView>('/api/review-projects?view=catalog',undefined,signal));return;}
   const [projectResult,workspaceResult,reportResult]=await Promise.all([workspacesApi.projects(signal),workspacesApi.workspaces(projectId,signal),reportsApi.list(signal)]);
   const selectedProject=projectResult.projects.find(item=>item.projectId===projectId);
   if(!selectedProject)throw new Error('프로젝트를 찾을 수 없습니다.');
   setProject(selectedProject);setProjectWorkspaces(workspaceResult.workspaces);setReports(reportResult.reports);
  }
  load().then(()=>setError('')).catch(cause=>{if(!signal.aborted)setError(cause.message);}).finally(()=>{if(!signal.aborted)setIsLoading(false);});
  return()=>controller.abort();
 },[projectId,tick]);
 const visibleWorkspaces=projectWorkspaces.filter(item=>item.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
 const visibleProjects=projectId?[]:selectProjectCards(catalog.projects,search,reportFilter,sort);
 async function createProject(event:FormEvent){event.preventDefault();setIsSubmitting(true);setError('');try{const result=await workspacesApi.createProject({name:name.trim(),description:description.trim()||undefined});location.assign(`/?project=${encodeURIComponent(result.project.projectId)}`);}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setIsSubmitting(false);}}
 if(project&&isCreatingWorkspace)return <main className="review-project-main"><NewWorkspace project={project} onDone={(id,shouldWaitForStart)=>location.assign(`/?workspace=${encodeURIComponent(id)}${shouldWaitForStart?'&tab=summary':''}`)} onCancel={()=>setIsCreatingWorkspace(false)}/></main>;
 return <main className="review-project-main"><div className="row-between wrap">
  <div>
   {project&&<PageBackLink href={projectsHref} label="리뷰 프로젝트"/>}
   <h1>{project?.name??'리뷰 프로젝트'}</h1>
   {project?.description&&<p className="muted">{project.description}</p>}
  </div>
  <div className="project-index-actions">
   {!projectId&&<>
    <LinkButton variant="secondary" href={reportSearchHref} onClick={event=>navigateLink(event,onNavigate)}>
     <Search size={16} aria-hidden/>보고서 검색
    </LinkButton>
    <ActionMenu label="관리" items={[
     {label:'미연결 보고서',href:unlinkedReportsHref,onClick:event=>navigateLink(event,onNavigate)},
    ]}/>
   </>}
   {project&&!project.isUncategorized&&<ProjectManagement key={project.projectId} project={project}
    action={managementAction} onOpen={onOpenManagement} onClose={onCloseManagement} onProjectChange={setProject} onDeleted={result=>{
    if(result.mode==='cascade')location.assign('/?view=trash');
    else location.assign(result.destinationProjectId?`/?project=${encodeURIComponent(result.destinationProjectId)}`:projectsHref);
   }}/>}
   {(!projectId||project)&&<Button onClick={()=>project?setIsCreatingWorkspace(true):setIsCreatingProject(true)}><Plus size={16}/>{project?'새 UI 검토':'새 프로젝트'}</Button>}
  </div>
 </div>
 {error&&<div role="alert" className="workspace-error">{error}<Button variant="secondary" onClick={()=>setTick(value=>value+1)}>다시 불러오기</Button></div>}{isLoading&&<p role="status">프로젝트를 불러오는 중입니다.</p>}
 {isCreatingProject&&<form className="workspace-project-form" onSubmit={createProject}><h2>새 리뷰 프로젝트</h2><label>프로젝트 이름<Input required maxLength={160} value={name} onChange={event=>setName(event.target.value)} placeholder="사이트 또는 제품 이름"/></label><TextArea label="설명 (선택)" maxLength={2000} value={description} onChange={event=>setDescription(event.target.value)} placeholder="여러 도메인이나 화면을 한 제품으로 묶을 수 있습니다."/><div className="task-actions"><Button type="submit" isLoading={isSubmitting}>만들기</Button><Button variant="secondary" onClick={()=>setIsCreatingProject(false)}>취소</Button></div></form>}
 <div className="project-catalog-controls">
  <TextField type="search" label={projectId?'작업공간 검색':'프로젝트 검색'} placeholder={projectId?'화면 또는 기능 이름':'이름 또는 설명'} value={search} onChange={event=>setSearch(event.target.value)}/>
  {!projectId&&<>
   <Select label="보고서" value={reportFilter} onValueChange={value=>setReportFilter(value as ProjectReportFilter)} options={projectReportOptions}/>
   <Select label="정렬" value={sort} onValueChange={value=>setSort(value as ProjectSort)} options={projectSortOptions}/>
  </>}
 </div>
 {!projectId&&catalog.hasMoreReports&&<p className="muted project-catalog-notice">조회 범위를 넘은 보고서의 생성 시각은 정렬에 반영되지 않을 수 있습니다.</p>}
 <div className="review-project-grid">
  {project?visibleWorkspaces.map(workspace=>{const report=reports.find(item=>item.id===workspace.latestReportId);return <a className="review-project-card" href={`/?workspace=${encodeURIComponent(workspace.workspaceId)}`} key={workspace.workspaceId}><FolderOpen size={24}/><h2>{workspace.name}</h2><p className="muted">{workspace.goal}</p><div className="row-between"><span>{report?(report.status==='partial'?'일부 완료':report.status==='completed'?'검토 완료':evaluationLabel(report)??'상태 확인 중'):'첫 검토 전'}</span><ArrowRight size={18}/></div></a>;}):visibleProjects.map(item=>(
   <a className="review-project-card" href={`/?project=${encodeURIComponent(item.projectId)}`} key={item.projectId}>
    <ProjectIcon name={item.name} url={item.iconUrl}/>
    <h2>{item.name}</h2>
    {item.description&&<p className="muted">{item.description}</p>}
    <div className="row-between"><span>UI 검토 작업공간 {item.workspaceCount}개</span><ArrowRight size={18} aria-hidden/></div>
    <small className="muted project-card-dates">
     <span>생성 {new Date(item.createdAt).toLocaleDateString('ko-KR')}</span>
     <span>{item.latestReportTime===undefined?(item.hasReports?'보고서 시간 확인 불가':'보고서 없음'):`최근 보고서 ${new Date(item.latestReportTime).toLocaleDateString('ko-KR')}`}</span>
    </small>
   </a>
  ))}
 </div>
 {!isLoading&&!error&&(project?visibleWorkspaces.length===0:visibleProjects.length===0)&&<p className="workspace-empty" role="status">
  {project?(projectWorkspaces.length?'검색에 맞는 작업공간이 없습니다.':'이 프로젝트의 첫 화면을 추가하세요.'):(catalog.projects.length?'검색과 필터에 맞는 프로젝트가 없습니다.':'프로젝트를 만들고 검토할 화면을 추가하세요.')}
 </p>}
 </main>;
}

function ProjectIcon({name,url}:{name:string;url?:string}) {
 const [failedUrl,setFailedUrl]=useState<string>();
 return <span className="project-initial" aria-hidden>{url&&url!==failedUrl
  ?<img src={url} alt="" width={26} height={26} onError={()=>setFailedUrl(url)}/>
  :Array.from(name)[0]}
 </span>;
}
