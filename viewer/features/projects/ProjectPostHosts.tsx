import {useId,useState,type FormEvent} from 'react';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {createBrowserId} from '../../shared/browser/id';
import {WorkspaceRequestError,workspacesApi} from '../workspaces/api';
import {ProjectSettingsDialog,type ProjectSettingsProps} from './ProjectSettingsDialog';
import './project-post-hosts.css';

const hostLimit=10;
type HostRow={id:string;value:string};
type HostDraft={version:number;rows:HostRow[]};
const createRow=(value=''):HostRow=>({id:createBrowserId(),value});

export function ProjectPostHosts({project,onProjectChange,onClose,returnFocusRef}:ProjectSettingsProps){
 const warningId=useId(),formatId=useId();
 const [draft,setDraft]=useState<HostDraft>(),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [isStale,setIsStale]=useState(false),[isSaving,setIsSaving]=useState(false),[isReloading,setIsReloading]=useState(false);
 const current=project.postAllowedHosts??[];
 const hosts=draft?.rows.map(row=>row.value.trim().toLowerCase()).filter(Boolean)??[];
 const hasChanges=hosts.length!==current.length||hosts.some(host=>!current.includes(host));
 const isBusy=isSaving||isReloading;

 function edit(){
  setDraft({version:project.version,rows:(current.length?current:['']).map(createRow)});
  setError('');setNotice('');setIsStale(false);
 }
 function discard(){
  setDraft(undefined);setError('');setIsStale(false);
 }
 function updateRow(id:string,value:string){
  setDraft(previous=>previous&&({...previous,rows:previous.rows.map(row=>row.id===id?{...row,value}:row)}));
  if(!isStale)setError('');
 }
 async function save(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!draft||isBusy||isStale||!hasChanges)return;
  if(hosts.some(host=>!host.includes('.')||host.split('.').some(label=>!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))||!/[a-z]/.test(host.split('.').at(-1)!))){
   setError('주소나 경로 없이 API 호스트 이름만 입력하세요. 예: api.example.com');return;
  }
  if(new Set(hosts).size!==hosts.length){setError('같은 호스트를 두 번 입력할 수 없습니다.');return;}
  setIsSaving(true);setError('');setNotice('');
  try{
   onProjectChange((await workspacesApi.saveProjectPostHosts(project.projectId,hosts,draft.version)).project);
   setDraft(undefined);setNotice('POST 허용 호스트를 저장했습니다.');
  }catch(cause){
   if(cause instanceof WorkspaceRequestError&&cause.status===409){
    setIsStale(true);setError('설정이 다른 곳에서 변경됐습니다. 저장된 설정을 다시 불러온 뒤 수정하세요.');
   }else setError(cause instanceof Error?cause.message:'POST 허용 호스트를 저장하지 못했습니다.');
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

 return <ProjectSettingsDialog title={`POST 허용 호스트 ${current.length}개`} project={project}
  onClose={onClose} returnFocusRef={returnFocusRef} isBusy={isBusy} hasUnsavedChanges={Boolean(draft)&&hasChanges}>
  <div className="project-post-hosts">
   <p id={warningId}>등록한 호스트의 <strong>모든 HTTPS 경로에 POST를 허용</strong>합니다. POST 요청은 실제 데이터를 변경할 수 있으므로 신뢰하는 API 호스트만 등록하세요.</p>
   <p className="muted">추가한 호스트는 새로 접수하는 검토에 적용됩니다. 제거한 호스트는 대기 중이거나 실행 중인 검토에서도 이후 POST 요청을 차단합니다.</p>
   {!draft?<><p className="muted" hidden={current.length>0}>등록한 호스트가 없습니다.</p>
    {current.length>0&&<ul className="project-post-hosts-list">{current.map(host=><li key={host}><code>{host}</code></li>)}</ul>}
    <div className="task-actions"><Button variant="secondary" onClick={edit}>허용 호스트 수정</Button></div></>:(
    <form onSubmit={save} aria-describedby={warningId}>
     <p className="muted" id={formatId}>최대 {hostLimit}개. 프로토콜, 포트, 경로, 와일드카드 없이 정확한 호스트 이름만 입력하세요.</p>
     <fieldset disabled={isBusy||isStale}>
      {draft.rows.map((row,index)=><div className="project-post-hosts-row" key={row.id}>
       <label>API 호스트 {index+1}<Input value={row.value} maxLength={253} placeholder="api.example.com" autoCapitalize="none" autoComplete="off" spellCheck={false} aria-describedby={formatId} onChange={event=>updateRow(row.id,event.target.value)}/></label>
       <Button variant="secondary" aria-label={`API 호스트 ${index+1} 삭제`} onClick={()=>{setDraft({...draft,rows:draft.rows.filter(item=>item.id!==row.id)});setError('');}}>삭제</Button>
      </div>)}
      <div className="task-actions"><Button variant="secondary" disabled={draft.rows.length>=hostLimit} onClick={()=>{setDraft({...draft,rows:[...draft.rows,createRow()]});setError('');}}>호스트 추가</Button></div>
     </fieldset>
     <div className="task-actions">
      {isStale?<Button variant="secondary" isLoading={isReloading} onClick={()=>void reload()}>저장된 설정 다시 불러오기</Button>:<Button type="submit" isLoading={isSaving} disabled={!hasChanges}>저장</Button>}
      <Button variant="secondary" disabled={isBusy} onClick={discard}>취소</Button>
     </div>
    </form>)}
   {error&&<p role="alert" className="workspace-error">{error}</p>}
   {notice&&<p role="status">{notice}</p>}
  </div>
 </ProjectSettingsDialog>;
}
