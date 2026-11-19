import {canUseReviewCredentials} from '../../../src/review-credentials';
export async function taskRequest<T>(path:string,body?:unknown):Promise<T>{
 const response=await fetch(path,{credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
 const result=await response.json();if(!response.ok)throw new Error(result.error??'요청을 처리하지 못했습니다.');return result;
}

export function canEnterReviewCredentials(targetUrl:string){
 return window.isSecureContext&&canUseReviewCredentials(window.location.origin)&&canUseReviewCredentials(targetUrl);
}

export async function uploadImage(file:File):Promise<string>{
 if(file.size>5*1024*1024)throw new Error('이미지는 파일당 5 MiB 이하여야 합니다.');
 const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=()=>reject(new Error('이미지를 읽지 못했습니다.'));reader.readAsDataURL(file);});
 const result=await taskRequest<{asset:{assetId:string}}>('/api/review-assets',{fileName:file.name,base64});return result.asset.assetId;
}
