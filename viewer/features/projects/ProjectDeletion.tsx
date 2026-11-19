import {useEffect,useId,useRef,useState,type RefObject} from 'react';
import type {ProjectDeletionPreview,ProjectDeletionResult,ReviewProject} from '../../../src/workspace-contract';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Dialog} from '../../shared/goodcase/components/overlays/dialog';
import {workspacesApi} from '../workspaces/api';

type DeletionMode=ProjectDeletionResult['mode'];
type ProjectDeletionProps={
 project:ReviewProject;
 onDeleted:(result:ProjectDeletionResult)=>void;
};

export function ProjectDeletionDialog({project,onDeleted,onClose,returnFocusRef}:ProjectDeletionProps&{
 onClose:()=>void;
 returnFocusRef:RefObject<HTMLButtonElement|null>;
}){
 const [preview,setPreview]=useState<ProjectDeletionPreview>();
 const [mode,setMode]=useState<DeletionMode>();
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [error,setError]=useState('');
 const [revision,setRevision]=useState(0);
 const cancelRef=useRef<HTMLButtonElement>(null);
 const choiceId=useId();
 const projectId=project.projectId;

 useEffect(()=>{
  const controller=new AbortController();
  workspacesApi.projectDeletionPreview(projectId,controller.signal).then(({preview})=>{
   if(!controller.signal.aborted)setPreview(preview);
  }).catch(cause=>{
   if(!controller.signal.aborted)setError(cause instanceof Error?cause.message:'삭제 범위를 확인하지 못했습니다.');
  });
  return ()=>controller.abort();
 },[projectId,revision]);

 function reload(){
  setPreview(undefined);
  setMode(undefined);
  setError('');
  setRevision(current=>current+1);
 }

 const canDelete=Boolean(preview&&mode&&!preview.hasActiveReviews&&
  (mode==='project-only'||!preview.hasExternalDependencies));

 async function submit(){
  if(!preview||!mode||!canDelete||isSubmitting)return;
  setError('');
  setIsSubmitting(true);
  try{
   onDeleted(await workspacesApi.deleteProject(projectId,{mode,scopeVersion:preview.scopeVersion}));
  }catch(cause){
   setError(cause instanceof Error?cause.message:'프로젝트를 삭제하지 못했습니다.');
  }finally{
   setIsSubmitting(false);
  }
 }

 return <Dialog
  isOpen
  onOpenChange={isOpen=>{if(!isOpen&&!isSubmitting)onClose();}}
  shouldCloseOnOutsideClick={false}
  shouldCloseOnEscape={!isSubmitting}
  initialFocusRef={cancelRef}
  returnFocusRef={returnFocusRef}
  className="project-deletion-dialog"
  title="리뷰 프로젝트 삭제"
  description={project.name}
  footer={<>
   <Button ref={cancelRef} variant="secondary" disabled={isSubmitting} onClick={onClose}>취소</Button>
   <Button variant="danger" disabled={!canDelete} isLoading={isSubmitting} onClick={()=>void submit()}>
    {mode==='cascade'?'휴지통으로 이동':'프로젝트 삭제'}
   </Button>
  </>}
 >
  {preview?<fieldset className="project-deletion-choices" disabled={isSubmitting||preview.hasActiveReviews}>
   <legend>삭제 범위</legend>
   <p className="muted">작업공간 {preview.workspaceCount}개 · 요청 {preview.requestCount}건 · 보고서 {preview.reportCount}건</p>
   <label className="project-deletion-choice">
    <input type="radio" name={choiceId} checked={mode==='project-only'} onChange={()=>setMode('project-only')}
     aria-labelledby={`${choiceId}-project`} aria-describedby={`${choiceId}-project-detail`}/>
    <span>
     <strong id={`${choiceId}-project`}>프로젝트만 삭제</strong>
     <span id={`${choiceId}-project-detail`}>작업공간과 검토 이력은 미분류로 옮깁니다. 작업공간과 보고서 주소는 그대로 사용할 수 있습니다. 이 프로젝트의 POST 허용 및 Supabase 로그인 권한은 해제됩니다.</span>
    </span>
   </label>
   <label className="project-deletion-choice">
    <input type="radio" name={choiceId} checked={mode==='cascade'} onChange={()=>setMode('cascade')} disabled={preview.hasExternalDependencies}
     aria-labelledby={`${choiceId}-cascade`} aria-describedby={`${choiceId}-cascade-detail`}/>
    <span>
     <strong id={`${choiceId}-cascade`}>하위까지 포함 삭제</strong>
     <span id={`${choiceId}-cascade-detail`}>프로젝트와 작업공간, 검토 기록을 휴지통으로 옮깁니다. 14일간 함께 복원할 수 있습니다.</span>
    </span>
   </label>
  </fieldset>:!error&&<p role="status">삭제 범위를 확인하는 중입니다.</p>}
  {!!preview?.trashedWorkspaceCount&&<p className="muted">이미 휴지통에 있는 작업공간 {preview.trashedWorkspaceCount}개는 기존 삭제 예정일을 유지합니다.</p>}
  {preview?.hasActiveReviews&&<p className="muted">대기 중이거나 실행 중인 검토를 마친 뒤 다시 확인하세요.</p>}
  {preview?.hasExternalDependencies&&<p className="muted">다른 프로젝트에서 이 검토 기록을 사용 중이므로 프로젝트만 삭제할 수 있습니다.</p>}
  {error&&<p className="workspace-error" role="alert">{error}</p>}
  {(error||preview?.hasActiveReviews||preview?.hasExternalDependencies)&&
   <div><Button variant="secondary" disabled={isSubmitting} onClick={reload}>삭제 범위 다시 확인</Button></div>}
 </Dialog>;
}
