import type {ReportsApi} from './types';
async function get<T>(url:string,signal?:AbortSignal):Promise<T>{const response=await fetch(url,{signal,credentials:'same-origin'});const body=await response.json();if(!response.ok)throw new Error(body.error??'보고서를 불러오지 못했습니다.');return body;}
export const reportsApi:ReportsApi={
 list:(signal,scope)=>get(scope?`/api/reports?scope=${scope}`:'/api/reports',signal),
 detail:(id,signal)=>get(`/api/reports/${encodeURIComponent(id)}`,signal),
};
