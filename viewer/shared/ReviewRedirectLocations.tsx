export function reviewLocation(url?:string){
 if(!url)return undefined;
 try{
  const address=new URL(url);
  return `${address.origin}${address.pathname}`;
 }catch{return undefined;}
}

export function ReviewRedirectLocations({requestedUrl,observedUrl,observedLabel}:{requestedUrl?:string;observedUrl?:string;observedLabel:string}){
 return <dl className="capture-conditions review-redirect-locations">
  <dt>요청한 주소</dt><dd>{reviewLocation(requestedUrl)??'미기록'}</dd>
  <dt>{observedLabel}</dt><dd>{reviewLocation(observedUrl)??'미기록'}</dd>
 </dl>;
}
