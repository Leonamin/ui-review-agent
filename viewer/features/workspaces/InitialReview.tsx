import {useRef,useState,type FormEvent} from 'react';
import {MAX_STYLE_COMPARISON_TARGETS} from '../../../src/automatic-style-comparison';
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
 comparison?:{referenceUrl?:string;comparisonUrl?:string;comparisonUrls?:string[]};
 onComparisonDraftChange?:(hasDraft:boolean)=>void;
 onDone:(request:PublicWorkspaceRequest)=>void;
}){
 const [kind,setKind]=useState(comparison?'comparison':'url');
 const referenceUrlDefault=comparison?.referenceUrl??'';
 const defaultComparisonUrls=comparison?.comparisonUrls??[comparison?.comparisonUrl??''];
 const [url,setUrl]=useState(referenceUrlDefault);
 const [comparisonUrls,setComparisonUrls]=useState(defaultComparisonUrls);
 const [shouldCheckBothThemes,setShouldCheckBothThemes]=useState(false);
 const [file,setFile]=useState<File>();
 const [isSubmitting,setIsSubmitting]=useState(false);
 const [error,setError]=useState('');
 const submission=useRef({signature:'',id:''});
 const uploaded=useRef(new Map<File,string>());
 const isStyleComparison=kind==='comparison';
 const canOpenLoginBrowser=isStyleComparison&&['localhost','127.0.0.1','[::1]'].includes(window.location.hostname);
 const canPrepareCredentials=kind==='url'&&canEnterReviewCredentials(url.trim());
 const hasDifferentUrls=(nextUrl:string,nextComparisonUrls:string[])=>nextUrl!==referenceUrlDefault||
  nextComparisonUrls.length!==defaultComparisonUrls.length||
  nextComparisonUrls.some((value,index)=>value!==defaultComparisonUrls[index]);
 const hasComparisonDraft=comparison&&hasDifferentUrls(url,comparisonUrls);

 function changeUrls(nextUrl:string,nextComparisonUrls:string[]){
  setUrl(nextUrl);
  setComparisonUrls(nextComparisonUrls);
  onComparisonDraftChange?.(hasDifferentUrls(nextUrl,nextComparisonUrls));
 }

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  const submitter=(event.nativeEvent as SubmitEvent).submitter;
  const shouldWaitForStart=canPrepareCredentials&&submitter?.hasAttribute('data-waits-for-start');
  const shouldWaitForLogin=canOpenLoginBrowser&&submitter?.hasAttribute('data-manual-style-login');
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
    ...(shouldWaitForLogin&&{shouldWaitForLogin:true}),
    ...(kind==='url'&&shouldCheckBothThemes&&{themeReview:{mode:'both'}}),
    ...(isStyleComparison&&(comparisonUrls.length===1
     ?{comparisonUrl:comparisonUrls[0].trim()}
     :{comparisonUrls:comparisonUrls.map(value=>value.trim())})),
   }:{kind:'image',assetId};
   const signature=JSON.stringify(target);
   if(submission.current.signature!==signature)submission.current={signature,id:createBrowserId()};
   const {request}=await workspacesApi.initial(workspaceId,{submissionId:submission.current.id,target});
   if(comparison){
    submission.current={signature:'',id:''};
    changeUrls(referenceUrlDefault,defaultComparisonUrls);
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
   options={[{value:'url',label:'사이트 URL'},{value:'image',label:'준비한 이미지'},{value:'comparison',label:'화면 스타일 비교'}]}/>}
  {kind!=='image'?<>
   <label>{isStyleComparison?'기준 화면 URL':'화면 URL'}<Input required type="url" value={url} disabled={isSubmitting} onChange={event=>changeUrls(event.target.value,comparisonUrls)} placeholder="https://…"/></label>
   {isStyleComparison
    ? <>
     {comparisonUrls.map((value,index)=><div className="style-comparison-input" key={index}>
      <label>{index===0?'비교 화면 URL':`비교 화면 ${index+1} URL`}
       <Input required type="url" value={value} disabled={isSubmitting}
        onChange={event=>changeUrls(url,comparisonUrls.map((item,position)=>position===index?event.target.value:item))}
        placeholder="https://…"/>
      </label>
      {index>0&&<Button type="button" variant="secondary" disabled={isSubmitting} aria-label={`비교 화면 ${index+1} 삭제`}
       onClick={()=>changeUrls(url,comparisonUrls.filter((_,position)=>position!==index))}>삭제</Button>}
     </div>)}
     {comparisonUrls.length<MAX_STYLE_COMPARISON_TARGETS&&<Button type="button" variant="secondary" disabled={isSubmitting}
      onClick={()=>changeUrls(url,[...comparisonUrls,''])}>비교 화면 추가</Button>}
    </>
    : <ThemeReviewCheckbox isChecked={shouldCheckBothThemes} onChange={setShouldCheckBothThemes} isDisabled={isSubmitting}/>}
  </>:<label>이미지<Input required type="file" accept="image/png,image/jpeg,image/webp" onChange={event=>setFile(event.target.files?.[0])}/></label>}
  <p className="muted">{isStyleComparison?'같은 사이트에서 기준 화면과 최대 4개 화면의 스타일을 비교합니다.':'서버 설정으로 첫 AI 검토를 시작합니다.'}</p>
  {error&&<p role="alert" className="workspace-error">{error}</p>}
  <div className="review-start-actions">
   <Button type="submit" isLoading={isSubmitting}>{isStyleComparison?'스타일 비교 시작':'첫 검토 시작'}</Button>
   {hasComparisonDraft&&<Button variant="secondary" disabled={isSubmitting} onClick={()=>{changeUrls(referenceUrlDefault,defaultComparisonUrls);setError('');}}>입력 되돌리기</Button>}
   {canOpenLoginBrowser&&<Button type="submit" variant="secondary" data-manual-style-login disabled={isSubmitting}>로그인 후 비교</Button>}
   {canPrepareCredentials&&<Button type="submit" variant="secondary" data-waits-for-start disabled={isSubmitting}>로그인 정보 입력</Button>}
  </div>
 </form>;
}
