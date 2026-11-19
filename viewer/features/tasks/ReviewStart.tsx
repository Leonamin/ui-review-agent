import {useRef,useState,type FormEvent} from 'react';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {Dialog} from '../../shared/goodcase/components/overlays/dialog';
import type {ReviewCredentials} from '../../../src/review-auth';
import type {ReviewAttempt} from '../../../src/review-contract';
import {ReviewRedirectLocations} from '../../shared/ReviewRedirectLocations';
import {workspacesApi} from '../workspaces/api';
import {canEnterReviewCredentials} from './api';
import './review-start.css';

interface ReviewStartProps {
 requestId:string;
 attemptId:string;
 targetUrl:string;
 loginRedirect?:ReviewAttempt['loginRedirect'];
 previousError?:string;
 scopeLabel?:string;
 isAdditional?:boolean;
 shouldOpenCredentials?:boolean;
 onDone:()=>void;
 onDismissCredentials?:()=>void;
}

export function ReviewStart({requestId,attemptId,targetUrl,loginRedirect,previousError,scopeLabel,isAdditional,shouldOpenCredentials,onDone,onDismissCredentials}:ReviewStartProps){
 const methods=loginRedirect?.methods??['password','code'];
 const defaultMethod=methods.includes('password')?'password':'code';
 const canEnterCredentials=canEnterReviewCredentials(targetUrl)&&methods.length>0;
 const [isDialogOpen,setIsDialogOpen]=useState(Boolean(shouldOpenCredentials&&canEnterCredentials));
 const [method,setMethod]=useState<ReviewCredentials['method']>(defaultMethod);
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [hasStarted,setHasStarted]=useState(false);
 const [error,setError]=useState('');
 const origin=canEnterCredentials?new URL(targetUrl).origin:'';
 const guestLabel=loginRedirect?'현재 로그인 화면 검토':'로그인 없이 검토';
 const launcher=useRef<HTMLButtonElement>(null);
 const startFormId=`review-credentials-${attemptId}`;

 function openCredentials(){
  setMethod(defaultMethod);
  setError('');
  setIsDialogOpen(true);
 }

 function closeCredentials(){
  setIsDialogOpen(false);
  setError('');
  onDismissCredentials?.();
 }

 async function start(credentials?:ReviewCredentials){
  if(isSubmitting||hasStarted)return;
  setIsSubmitting(true);
  setError('');
  try{
   await workspacesApi.start(requestId,attemptId,credentials);
   closeCredentials();
   setHasStarted(true);
   onDone();
  }catch(cause){
   setError(cause instanceof Error?cause.message:'검토를 시작하지 못했습니다. 다시 시도하세요.');
  }finally{
   setIsSubmitting(false);
  }
 }

 function submitCredentials(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const form=event.currentTarget;
  const fields=new FormData(form);
  const credentials:ReviewCredentials=method==='code'
   ?{method,code:String(fields.get('code')??'')}
   :{method,username:String(fields.get('username')??''),password:String(fields.get('password')??'')};
  for(const input of form.querySelectorAll<HTMLInputElement>('input:not([type=radio])'))input.value='';
  void start(credentials);
 }

 return <section className="review-start" aria-labelledby={`${startFormId}-heading`}>
  <h2 id={`${startFormId}-heading`}>{loginRedirect?'로그인 화면으로 이동했습니다':isAdditional?'추가 검토 시작':'검토 시작'}</h2>
  {scopeLabel&&<p className="muted review-start-scope">{scopeLabel}</p>}
  {loginRedirect&&<ReviewRedirectLocations requestedUrl={targetUrl} observedUrl={loginRedirect.loginUrl} observedLabel="이동한 주소"/>}
  {previousError&&<p className="review-start-error" role="status">{previousError}</p>}
  {hasStarted?<p className="muted" role="status">검토 시작을 요청했습니다.</p>:<>
   <div className="review-start-action-row">
    <p className="muted" role={loginRedirect?'status':undefined}>{loginRedirect?(canEnterCredentials?'요청한 화면을 열려면 로그인이 필요합니다.':'로그인 정보 입력에는 보안 연결이 필요합니다.'):(canEnterCredentials?'로그인 정보는 선택 사항입니다.':'이 주소에서는 로그인 없이 검토할 수 있습니다.')}</p>
    <div className="review-start-actions">
     <Button variant="secondary" onClick={()=>void start()} disabled={isSubmitting}>{guestLabel}</Button>
     {canEnterCredentials&&<Button ref={launcher} onClick={openCredentials} disabled={isSubmitting}>{loginRedirect?'로그인하고 원래 화면 검토':'로그인 정보 입력'}</Button>}
    </div>
   </div>
   {!isDialogOpen&&error&&<p className="review-start-error" role="alert">{error}</p>}
  </>}
  <Dialog isOpen={isDialogOpen} onOpenChange={isOpen=>{if(!isOpen&&!isSubmitting)closeCredentials();}}
   title="로그인 정보 입력" description={`${origin} · 이번 실행에만 사용`}
   className="review-credentials-dialog" shouldCloseOnOutsideClick={false} shouldCloseOnEscape={!isSubmitting}
   returnFocusRef={launcher}
   footer={<>
    <Button variant="secondary" onClick={()=>void start()} disabled={isSubmitting}>{guestLabel}</Button>
    <Button type="submit" form={startFormId} isLoading={isSubmitting}>{loginRedirect?'로그인하고 원래 화면 검토':'로그인하고 검토'}</Button>
   </>}>
   <form id={startFormId} className="review-credentials-form" autoComplete="off" onSubmit={submitCredentials}>
    {methods.length>1&&<fieldset disabled={isSubmitting}>
     <legend>로그인 방식</legend>
     <label><input type="radio" name="method" checked={method==='password'} onChange={()=>setMethod('password')}/> ID·비밀번호</label>
     <label><input type="radio" name="method" checked={method==='code'} onChange={()=>setMethod('code')}/> 일회용 코드</label>
    </fieldset>}
    {method==='code'
     ?<label key="code">일회용 코드<Input name="code" required maxLength={512} autoComplete="off" disabled={isSubmitting}/></label>
     :<div key="password" className="review-credentials-fields">
      <label>ID<Input name="username" required maxLength={512} autoComplete="off" disabled={isSubmitting}/></label>
      <label>비밀번호<Input name="password" required type="password" maxLength={4096} autoComplete="new-password" disabled={isSubmitting}/></label>
     </div>}
    {error&&<p className="review-start-error" role="alert">{error}</p>}
   </form>
  </Dialog>
 </section>;
}
