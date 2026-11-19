import {useId,useState,type FormEvent} from 'react';
import {
 normalizeReviewTargetOrigin,
 normalizeSupabaseAuthOrigin,
 PROJECT_SUPABASE_AUTH_BINDING_LIMIT,
} from '../../../src/supabase-auth-policy';
import type {ReviewProject} from '../../../src/workspace-contract';
import {createBrowserId} from '../../shared/browser/id';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {WorkspaceRequestError,workspacesApi} from '../workspaces/api';
import {ProjectSettingsDialog,type ProjectSettingsProps} from './ProjectSettingsDialog';
import './project-supabase-auth.css';

type Binding=ReviewProject['supabaseAuthBindings'][number];
type BindingRow=Binding & {id:string};
type BindingDraft={version:number;rows:BindingRow[]};
const createRow=(binding:Binding={targetOrigin:'',origin:''}):BindingRow=>({...binding,id:createBrowserId()});

export function ProjectSupabaseAuth({project,onProjectChange,onClose,returnFocusRef}:ProjectSettingsProps){
 const formatId=useId();
 const [draft,setDraft]=useState<BindingDraft>();
 const [error,setError]=useState(''),[notice,setNotice]=useState('');
 const [isStale,setIsStale]=useState(false),[isSaving,setIsSaving]=useState(false),[isReloading,setIsReloading]=useState(false);
 const current=project.supabaseAuthBindings??[];
 const pending=draft?.rows
  .map(({targetOrigin,origin})=>({targetOrigin:targetOrigin.trim(),origin:origin.trim()}))
  .filter(({targetOrigin,origin})=>targetOrigin||origin)??[];
 const hasChanges=pending.length!==current.length||pending.some(binding=>!current.some(saved=>
  saved.targetOrigin===binding.targetOrigin&&saved.origin===binding.origin));
 const isBusy=isSaving||isReloading;

 function edit(){
  setDraft({version:project.version,rows:current.length?current.map(createRow):[createRow()]});
  setError('');setNotice('');setIsStale(false);
 }
 function discard(){
  setDraft(undefined);setError('');setIsStale(false);
 }
 function updateRow(id:string,field:keyof Binding,value:string){
  setDraft(previous=>previous&&({...previous,rows:previous.rows.map(row=>row.id===id?{...row,[field]:value}:row)}));
  setError('');
 }
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!draft||isBusy||isStale||!hasChanges)return;
  const bindings:Binding[]=[];
  for(const binding of pending){
   const targetOrigin=normalizeReviewTargetOrigin(binding.targetOrigin);
   const origin=normalizeSupabaseAuthOrigin(binding.origin);
   if(!targetOrigin||!origin){
    setError('경로 없이 검토 사이트의 HTTPS 출처와 Supabase 프로젝트 출처를 입력하세요.');return;
   }
   if(bindings.some(saved=>saved.targetOrigin===targetOrigin)){
    setError('검토 사이트 출처마다 Supabase 출처 한 개를 연결할 수 있습니다.');return;
   }
   bindings.push({targetOrigin,origin});
  }
  setIsSaving(true);setError('');setNotice('');
  try{
   const result=await workspacesApi.saveProjectSupabaseAuthBindings(project.projectId,bindings,draft.version);
   onProjectChange(result.project);setDraft(undefined);setNotice('Supabase 로그인 출처를 저장했습니다.');
  }catch(cause){
   if(cause instanceof WorkspaceRequestError&&cause.status===409){
    setIsStale(true);setError('설정이 다른 곳에서 변경됐습니다. 저장된 설정을 다시 불러온 뒤 수정하세요.');
   }else setError(cause instanceof Error?cause.message:'Supabase 로그인 출처를 저장하지 못했습니다.');
  }finally{setIsSaving(false);}
 }
 async function reload(){
  setIsReloading(true);setError('');
  try{
   const data=await workspacesApi.projects();
   const latest=data.projects.find(item=>item.projectId===project.projectId);
   if(!latest)throw new Error('프로젝트를 찾지 못했습니다.');
   onProjectChange(latest);setDraft(undefined);setIsStale(false);setNotice('저장된 설정을 다시 불러왔습니다.');
  }catch(cause){setError(cause instanceof Error?cause.message:'저장된 설정을 불러오지 못했습니다.');}
  finally{setIsReloading(false);}
 }

 return <ProjectSettingsDialog title={`Supabase 로그인 출처 ${current.length}개`} project={project}
  onClose={onClose} returnFocusRef={returnFocusRef} isBusy={isBusy} hasUnsavedChanges={Boolean(draft)&&hasChanges}>
  <div className="project-supabase-auth">
   <p>로그인을 사용하는 URL 검토에서 검토 사이트와 짝지은 Supabase 출처에 인증 요청을 보냅니다.</p>
   {!draft?<>
    {current.length>0?<ul className="project-supabase-auth-list">{current.map(binding=><li key={binding.targetOrigin}>
     <code>{binding.targetOrigin}</code> → <code>{binding.origin}</code>
    </li>)}</ul>:<p className="muted">등록한 연결이 없습니다.</p>}
    <div className="task-actions"><Button variant="secondary" onClick={edit}>로그인 출처 수정</Button></div>
   </>:<form onSubmit={save} aria-describedby={formatId}>
    <p className="muted" id={formatId}>경로를 제외한 HTTPS 출처를 입력하세요. 사이트마다 Supabase 프로젝트 한 개를 연결할 수 있습니다.</p>
    <fieldset disabled={isBusy||isStale}>
     {draft.rows.map((row,index)=><div className="project-supabase-auth-row" key={row.id}>
      <label><span>검토 사이트 출처 {index+1}</span><Input value={row.targetOrigin} maxLength={300} inputMode="url" placeholder="https://app.example.com" autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={event=>updateRow(row.id,'targetOrigin',event.target.value)}/></label>
      <label>Supabase 출처 {index+1}<Input value={row.origin} maxLength={300} inputMode="url" placeholder="https://project-ref.supabase.co" autoCapitalize="none" autoComplete="off" spellCheck={false} onChange={event=>updateRow(row.id,'origin',event.target.value)}/></label>
      <Button variant="secondary" aria-label={`로그인 출처 연결 ${index+1} 삭제`} onClick={()=>{
       setDraft({...draft,rows:draft.rows.filter(item=>item.id!==row.id)});setError('');
      }}>삭제</Button>
     </div>)}
     <div className="task-actions"><Button variant="secondary" disabled={draft.rows.length>=PROJECT_SUPABASE_AUTH_BINDING_LIMIT} onClick={()=>{
      setDraft({...draft,rows:[...draft.rows,createRow()]});setError('');
     }}>연결 추가</Button></div>
    </fieldset>
    <div className="task-actions">
     {isStale?<Button variant="secondary" isLoading={isReloading} onClick={()=>void reload()}>저장된 설정 다시 불러오기</Button>:<Button type="submit" isLoading={isSaving} disabled={!hasChanges}>저장</Button>}
     <Button variant="secondary" disabled={isBusy} onClick={discard}>취소</Button>
    </div>
   </form>}
   {error&&<p role="alert" className="workspace-error">{error}</p>}
   {notice&&<p role="status">{notice}</p>}
  </div>
 </ProjectSettingsDialog>;
}
