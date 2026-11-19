import {useMemo,useState} from 'react';
import type {Meta,StoryObj} from '@storybook/react-vite';
import {ReportPage} from './ReportPage';
import {ReportMetadataEditor} from './ReportMetadataEditor';
import {RecommendationError,type RecommendationApi} from './recommendation-api';
import type {ReportRecommendation} from './types';
import {sample} from './fixtures';
const base:ReportRecommendation={schemaVersion:1,reportId:sample.id,sourceHash:'storybook',inputHash:'storybook',promptVersion:'storybook-example',status:'suggested',revision:1,screenName:'주문 확인',featureCategories:['결제 내역','주문 요약'],evidenceRefs:['storybook'],confidence:'medium',rationale:'상태 검증용 예시이며 실제 추천이 아닙니다.',provider:'codex',requestedModel:null,actualModel:null,createdAt:'2026-11-11',updatedAt:'2026-11-11',generatedAt:'2026-11-11',attemptId:'storybook',attemptCount:1,error:null,usage:null};
function Screen({mode='suggested'}:{mode?:string}){const [saved,setSaved]=useState<ReportRecommendation|undefined>(),[tab,setTab]=useState('findings');const api=useMemo<RecommendationApi>(()=>{let value={...base,status:mode==='loading'?'pending':mode==='error'?'error':mode==='confirmed'?'confirmed':'suggested'} as ReportRecommendation;let hasConflicted=false;return{get:async()=>value,ensure:async()=>{value={...value,status:'suggested',revision:value.revision+1};return value;},save:async(_id,input)=>{if(mode==='saving')await new Promise(resolve=>setTimeout(resolve,1800));if(mode==='save-error')throw new Error('저장 중 연결이 끊어졌습니다. 입력은 유지됩니다.');if(mode==='conflict'&&!hasConflicted){hasConflicted=true;value={...value,revision:2,screenName:'다른 창에서 저장한 이름'};throw new RecommendationError('revision conflict',409);}value={...value,...input,status:input.shouldConfirm?'confirmed':'edited',revision:value.revision+1};return value;}};},[mode]);const report={...sample,recommendation:saved};return <ReportPage detail={{status:'ready',data:report}} tab={tab} onTab={setTab} onRetryDetail={()=>{}} metadataEditor={<ReportMetadataEditor reportId={sample.id} api={api} onSaved={setSaved}/>}/>;}
const meta={title:'Reports/Metadata workflow',component:Screen} satisfies Meta<typeof Screen>;export default meta;type Story=StoryObj<typeof meta>;
export const Suggested:Story={args:{}};
export const Loading:Story={args:{mode:'loading'}};
export const GenerationError:Story={args:{mode:'error'}};
export const Saving:Story={args:{mode:'saving'}};
export const SaveError:Story={args:{mode:'save-error'}};
export const Conflict:Story={args:{mode:'conflict'}};
export const Confirmed:Story={args:{mode:'confirmed'}};
