import {useEffect,useRef,useState} from 'react';
import {RotateCcw} from 'lucide-react';
import type {TrashedProject,TrashedWorkspace} from '../../../src/workspace-contract';
import {Button} from '../../shared/goodcase/components/basic/button';
import {WorkspaceRequestError,workspacesApi} from './api';
import './workspaces.css';
import './workspace-trash.css';

const dateTime=new Intl.DateTimeFormat('ko-KR',{dateStyle:'medium',timeStyle:'short'});

type TrashItem={
 id:string;
 kind:'project'|'workspace';
 name:string;
 subtitle:string;
 trashedAt:string;
 expiresAt:string;
};

export function WorkspaceTrashPage(){
 const [trash,setTrash]=useState<{projects:TrashedProject[];workspaces:TrashedWorkspace[]}>();
 const [loadError,setLoadError]=useState('');
 const [revision,setRevision]=useState(0);
 const [restoringId,setRestoringId]=useState('');
 const [restoreError,setRestoreError]=useState('');
 const [restored,setRestored]=useState<Pick<TrashItem,'id'|'kind'|'name'>>();
 const restoredLink=useRef<HTMLAnchorElement>(null);
 const listLoad=useRef<AbortController>(null);

 useEffect(()=>{
  const controller=new AbortController();
  listLoad.current=controller;
  Promise.all([workspacesApi.projectTrashList(controller.signal),workspacesApi.trashList(controller.signal)]).then(([{projects},{workspaces}])=>{
   if(!controller.signal.aborted){setTrash({projects,workspaces});setLoadError('');}
  }).catch(cause=>{
   if(controller.signal.aborted)return;
   setLoadError(cause instanceof WorkspaceRequestError&&cause.status===404
    ?'현재 서버에서 휴지통을 사용할 수 없습니다.'
    :cause instanceof Error?cause.message:'휴지통을 불러오지 못했습니다.');
  });
  return()=>controller.abort();
 },[revision]);

 useEffect(()=>{if(restored)restoredLink.current?.focus();},[restored]);

 async function restore({id,kind}:TrashItem){
  setRestoringId(id);
  setRestoreError('');
  setRestored(undefined);
  try{
   if(kind==='project'){
    const {project}=await workspacesApi.restoreProject(id);
    setTrash(current=>current&&{...current,projects:current.projects.filter(entry=>entry.project.projectId!==id)});
    setRestored({id,kind,name:project.name});
   }else{
    const {workspace}=await workspacesApi.restore(id);
    setTrash(current=>current&&{...current,workspaces:current.workspaces.filter(entry=>entry.workspace.workspaceId!==id)});
    setRestored({id,kind,name:workspace.name});
   }
  }catch(cause){
   setRestoreError(cause instanceof Error?cause.message:'복원하지 못했습니다.');
  }finally{
   listLoad.current?.abort();
   setRevision(value=>value+1);
   setRestoringId('');
  }
 }

 const items:TrashItem[]=trash?[
  ...trash.projects.map(({project,workspaceCount,requestCount,reportCount,trashedAt,expiresAt})=>({
   id:project.projectId,kind:'project' as const,name:project.name,trashedAt,expiresAt,
   subtitle:`리뷰 프로젝트 / 작업공간 ${workspaceCount}개 / 요청 ${requestCount}건 / 보고서 ${reportCount}건`,
  })),
  ...trash.workspaces.map(({workspace,project,requestCount,reportCount,trashedAt,expiresAt})=>({
   id:workspace.workspaceId,kind:'workspace' as const,name:workspace.name,trashedAt,expiresAt,
   subtitle:`${project.name} / 요청 ${requestCount}건 / 보고서 ${reportCount}건`,
  })),
 ].sort((a,b)=>b.trashedAt.localeCompare(a.trashedAt)):[];
 const restoredLabel=restored?.kind==='project'?'프로젝트':'작업공간';

 return <main className="review-project-main workspace-trash-main">
  <h1>휴지통</h1>
  <p className="muted">휴지통으로 이동한 프로젝트, 작업공간과 검토 기록은 14일 동안 복원할 수 있습니다.</p>
  {restored&&<div className="workspace-trash-feedback">
   <p role="status">{restored.name} {restoredLabel}을 복원했습니다.</p>
   <a ref={restoredLink} href={`/?${restored.kind}=${encodeURIComponent(restored.id)}`}>복원한 {restoredLabel} 열기</a>
  </div>}
  {restoreError&&<p role="alert" className="workspace-error">{restoreError}</p>}
  {loadError&&<div className="workspace-trash-feedback">
   <p role="alert" className="workspace-error">{loadError}</p>
   <Button variant="secondary" onClick={()=>{setLoadError('');setRevision(value=>value+1);}}>다시 불러오기</Button>
  </div>}
  {!loadError&&(!trash?<p role="status" className="workspace-trash-placeholder">휴지통을 불러오는 중입니다.</p>
   :items.length===0?<p className="workspace-trash-placeholder">휴지통이 비어 있습니다.</p>
   :<ul className="workspace-trash-list" role="list" aria-label="휴지통 항목">{items.map(item=>{
    const {id,kind,name,subtitle,expiresAt}=item;
    return <li key={`${kind}:${id}`} className="workspace-trash-item">
     <div>
      <h2>{name}</h2>
      <p className="muted">{subtitle}</p>
      <p className="workspace-trash-expiry">영구 삭제 예정 <time dateTime={expiresAt}>{dateTime.format(new Date(expiresAt))}</time></p>
     </div>
     <Button variant="secondary" aria-label={kind==='project'?`${name} 프로젝트 복원`:`${name} 복원`} isLoading={restoringId===id} disabled={Boolean(restoringId)} onClick={()=>void restore(item)}><RotateCcw size={16} aria-hidden/>{kind==='project'?'프로젝트 복원':'복원'}</Button>
    </li>;
   })}</ul>)}
 </main>;
}
