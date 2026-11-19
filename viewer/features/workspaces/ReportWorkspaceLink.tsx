import {LinkButton} from '../../shared/LinkButton';
import {useEffect,useState} from 'react';
import type {ReviewProject,ReviewWorkspace} from '../../../src/workspace-contract';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {workspaceReportHref} from '../../app/route';
import {WorkspaceRequestError,workspacesApi} from './api';
import './workspaces.css';

export function ReportWorkspaceLink({reportId}:{reportId:string}){
 const [context,setContext]=useState<{workspace?:ReviewWorkspace;project?:ReviewProject}>();
 const [contextError,setContextError]=useState('');
 const [contextRevision,setContextRevision]=useState(0);
 const [projects,setProjects]=useState<ReviewProject[]>([]),[workspaces,setWorkspaces]=useState<ReviewWorkspace[]>([]),[projectId,setProjectId]=useState(''),[workspaceId,setWorkspaceId]=useState(''),[isExpanded,setIsExpanded]=useState(false),[isSubmitting,setIsSubmitting]=useState(false),[error,setError]=useState('');
 useEffect(()=>{
  const controller=new AbortController();
  workspacesApi.context(reportId,controller.signal).then(value=>{
   if(!controller.signal.aborted)setContext(value);
  }).catch(cause=>{
   if(controller.signal.aborted)return;
   if(cause instanceof WorkspaceRequestError&&cause.status===404)setContext({});
   else setContextError(cause instanceof Error?cause.message:'작업공간 연결을 확인하지 못했습니다.');
  });
  return()=>controller.abort();
 },[reportId,contextRevision]);
 useEffect(()=>{if(!isExpanded)return;const controller=new AbortController();Promise.all([workspacesApi.projects(controller.signal),workspacesApi.workspaces(undefined,controller.signal)]).then(([p,w])=>{setProjects(p.projects);setWorkspaces(w.workspaces);}).catch(cause=>{if(!controller.signal.aborted)setError(cause.message);});return()=>controller.abort();},[isExpanded]);
 async function attach(){const workspace=workspaces.find(value=>value.workspaceId===workspaceId);if(!workspace)return;setIsSubmitting(true);setError('');try{await workspacesApi.attach(workspaceId,{reportId,expectedVersion:workspace.version});location.assign(workspaceReportHref(workspaceId,reportId,'results'));}catch(cause){setError(cause instanceof Error?cause.message:String(cause));}finally{setIsSubmitting(false);}}
 if(contextError)return <section className="workspace-report-context"><p role="alert">{contextError}</p><Button variant="secondary" onClick={()=>{setContextError('');setContextRevision(value=>value+1);}}>연결 확인 다시 시도</Button></section>;
 if(!context)return null;
 if(context.workspace){
  const href=workspaceReportHref(context.workspace.workspaceId,reportId,'results');
  return <section className="workspace-report-context">
   <p>{context.project&&`${context.project.name} / `}{context.workspace.name}</p>
   <LinkButton href={href}>이 화면에서 이어서 검토 →</LinkButton>
  </section>;
 }
 return <section className="workspace-report-context">
  <p>원본 보고서를 보존하고 화면별 작업공간에서 검토를 이어갈 수 있습니다.</p><Button variant="secondary" onClick={()=>setIsExpanded(value=>!value)} aria-expanded={isExpanded}>작업공간에 연결</Button>
  {isExpanded&&<div className="workspace-report-context-form"><Select label="프로젝트" value={projectId} onValueChange={value=>{setProjectId(value);setWorkspaceId('');}} options={projects.map(project=>({value:project.projectId,label:project.name}))}/><Select label="UI 검토 작업공간" value={workspaceId} onValueChange={setWorkspaceId} options={workspaces.filter(workspace=>workspace.projectId===projectId).map(workspace=>({value:workspace.workspaceId,label:workspace.name}))}/><Button isLoading={isSubmitting} disabled={!workspaceId} onClick={()=>void attach()}>기존 보고서 연결</Button><a href="/?view=projects">새 프로젝트나 작업공간 만들기 →</a>{error&&<p className="workspace-error" role="alert">{error}</p>}</div>}
 </section>;
}
