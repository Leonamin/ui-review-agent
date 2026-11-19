import {useRef,useState,type FormEvent} from 'react';
import type {PublicWorkspaceRequest} from '../../../src/workspace-contract';
import {Button} from '../../shared/goodcase/components/basic/button';
import {Input} from '../../shared/goodcase/components/basic/input';
import {ThemeReviewCheckbox} from '../../shared/ThemeReviewCheckbox';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {createBrowserId} from '../../shared/browser/id';
import {canEnterReviewCredentials,uploadImage} from '../tasks/api';
import {workspacesApi} from './api';

export function InitialReview({workspaceId,comparison,onComparisonDraftChange,onDone}:{
 workspaceId:string;
 comparison?:{referenceUrl?:string;comparisonUrl?:string};
 onComparisonDraftChange?:(hasDraft:boolean)=>void;
 onDone:(request:PublicWorkspaceRequest)=>void;
}){
 const [kind,setKind]=useState(comparison?'comparison':'url');
 const referenceUrlDefault=comparison?.referenceUrl??'';
 const comparisonUrlDefault=comparison?.comparisonUrl??'';
 const [url,setUrl]=useState(referenceUrlDefault);
 const [comparisonUrl,setComparisonUrl]=useState(comparisonUrlDefault);
 const [shouldCheckBothThemes,setShouldCheckBothThemes]=useState(false);
 const [file,setFile]=useState<File>();
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [error,setError]=useState('');
 const submission=useRef({signature:'',id:''});
 const uploaded=useRef(new Map<File,string>());
 const isStyleComparison=kind==='comparison';
 const canPrepareCredentials=kind==='url'&&canEnterReviewCredentials(url.trim());
 const hasComparisonDraft=comparison&&(url!==referenceUrlDefault||comparisonUrl!==comparisonUrlDefault);

 function changeUrls(nextUrl:string,nextComparisonUrl:string){
  setUrl(nextUrl);
  setComparisonUrl(nextComparisonUrl);
  onComparisonDraftChange?.(nextUrl!==referenceUrlDefault||nextComparisonUrl!==comparisonUrlDefault);
 }

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const shouldWaitForStart=canPrepareCredentials&&(event.nativeEvent as SubmitEvent).submitter?.hasAttribute('data-waits-for-start');
  setIsSubmitting(true);
  setError('');
  try{
   let assetId:string|undefined;
   if(kind==='image'){
    if(!file)throw new Error('이미지를 선택하세요.');
    assetId=uploaded.current.get(file)??await uploadImage(file);
    uploaded.current.set(file,assetId);
   }
   const target=kind!=='image'?{
    kind:'url',url:url.trim(),viewport:{width:1440,height:900},
    ...(shouldWaitForStart&&{shouldWaitForStart:true}),
    ...(kind==='url'&&shouldCheckBothThemes&&{themeReview:{mode:'both'}}),
    ...(isStyleComparison&&{comparisonUrl:comparisonUrl.trim()}),
   }:{kind:'image',assetId};
   const signature=JSON.stringify(target);
   if(submission.current.signature!==signature)submission.current={signature,id:createBrowserId()};
   const {request}=await workspacesApi.initial(workspaceId,{submissionId:submission.current.id,target});
   if(comparison){
    submission.current={signature:'',id:''};
    changeUrls(referenceUrlDefault,comparisonUrlDefault);
   }
   onDone(request);
  }catch(cause){
   setError(cause instanceof Error?cause.message:String(cause));
  }finally{
   setIsSubmitting(false);
  }
 }

 return <form className="workspace-create-form" onSubmit={submit}>
  {!comparison&&<Select label="시작할 자료" value={kind} onValueChange={setKind} isDisabled={isSubmitting}
   options={[{value:'url',label:'사이트 URL'},{value:'image',label:'준비한 이미지'},{value:'comparison',label:'두 화면 스타일 비교'}]}/>}
  {kind!=='image'?<>
   <label>{isStyleComparison?'기준 화면 URL':'화면 URL'}<Input required type="url" value={url} disabled={isSubmitting} onChange={event=>changeUrls(event.target.value,comparisonUrl)} placeholder="https://…"/></label>
   {isStyleComparison
    ? <label>비교 화면 URL<Input required type="url" value={comparisonUrl} disabled={isSubmitting} onChange={event=>changeUrls(url,event.target.value)} placeholder="https://…"/></label>
    : <ThemeReviewCheckbox isChecked={shouldCheckBothThemes} onChange={setShouldCheckBothThemes} isDisabled={isSubmitting}/>}
  </>:<label>이미지<Input required type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>setFile(event.target.files?.[0])}/></label>}
  <p className="muted">{isStyleComparison?'같은 사이트의 두 화면에서 대응하는 요소를 찾아 스타일을 비교합니다.':'서버 설정으로 첫 AI 검토를 시작합니다.'}</p>
  {error&&<p role="alert" className="workspace-error">{error}</p>}
  <div className="review-start-actions">
   <Button type="submit" isLoading={isSubmitting}>{isStyleComparison?'스타일 비교 시작':'첫 검토 시작'}</Button>
   {hasComparisonDraft&&<Button variant="secondary" disabled={isSubmitting} onClick={()=>{changeUrls(referenceUrlDefault,comparisonUrlDefault);setError('');}}>입력 되돌리기</Button>}
   {canPrepareCredentials&&<Button type="submit" variant="secondary" data-waits-for-start disabled={isSubmitting}>로그인 정보 입력</Button>}
  </div>
 </form>;
}
