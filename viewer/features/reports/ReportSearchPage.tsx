import {useEffect,useId,useLayoutEffect,useRef,useState} from 'react';
import {ArrowRight,ImageOff,RefreshCw} from 'lucide-react';
import {navigateLink,projectsHref,reportHref,workspaceReportHref} from '../../app/route';
import {Alert} from '../../shared/goodcase/components/basic/alert';
import {Button,IconButton} from '../../shared/goodcase/components/basic/button';
import {TextField} from '../../shared/goodcase/components/basic/text-field';
import {Select} from '../../shared/goodcase/components/overlays/select';
import {PageBackLink} from '../../shared/PageNavigation';
import {reportName,reportPartialCauseLabels} from './presentation';
import {emptyReportFilters,filterReports,reportListStatusLabel,reportSources,reportStatuses} from './report-list';
import type {LoadState} from './ReportPage';
import type {ReportList,ReportScope,ReportsApi} from './types';
import './report-list.css';

export interface ReportSearchMemory {
 filters:typeof emptyReportFilters;
 scrollY:number;
 selectedId?:string;
}

const statusOptions=[{value:'all',label:'모든 상태'},...Object.entries(reportStatuses).map(([value,label])=>({value,label}))];
const sourceOptions=[{value:'all',label:'모든 유형'},...Object.entries(reportSources).map(([value,label])=>({value,label}))];
const dateFormat=new Intl.DateTimeFormat('ko-KR',{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});

function ReportThumbnail({url}:{url?:string}){
 const [hasError,setHasError]=useState(false);
 return <span className="report-result-thumbnail" aria-hidden>
  {url&&!hasError?<img src={url} alt="" loading="lazy" decoding="async" onError={()=>setHasError(true)}/>:<ImageOff size={18}/>}
 </span>;
}

export function ReportSearchPage({scope,api,memory,onNavigate}:{
 scope:ReportScope;
 api:ReportsApi;
 memory:ReportSearchMemory;
 onNavigate:(href:string)=>void;
}){
 const [filters,setFilters]=useState(memory.filters);
 const [list,setList]=useState<LoadState<ReportList>>({status:'loading'});
 const [revision,setRevision]=useState(0);
 const searchId=useId();
 const headingRef=useRef<HTMLHeadingElement>(null);
 const isLinked=scope==='linked';
 const title=isLinked?'보고서 검색':'미연결 보고서';

 useLayoutEffect(()=>{
  if(!memory.selectedId)headingRef.current?.focus({preventScroll:true});
 },[memory]);
 useEffect(()=>{
  const controller=new AbortController();
  api.list(controller.signal,scope).then(data=>{
   if(!controller.signal.aborted)setList({status:'ready',data});
  }).catch(error=>{
   if(!controller.signal.aborted)setList({status:'error',error:error instanceof Error?error.message:String(error)});
  });
  return()=>controller.abort();
 },[api,revision,scope]);
 useLayoutEffect(()=>{
  if(list.status!=='ready')return;
  if(memory.selectedId)document.getElementById('report-result-'+memory.selectedId)?.focus({preventScroll:true});
  window.scrollTo(0,memory.scrollY);
 },[list.status,memory]);

 function updateFilters(next:typeof filters){
  memory.filters=next;
  memory.selectedId=undefined;
  setFilters(next);
 }
 function refreshList(){
  memory.scrollY=window.scrollY;
  setList({status:'loading'});
  setRevision(value=>value+1);
 }

 const allReports=list.data?.reports??[];
 const reports=filterReports(allReports,filters);
 const hasFilters=Boolean(filters.query.trim()||filters.status||filters.source);

 return <main className="review-project-main report-search-main">
  <PageBackLink href={projectsHref} label="리뷰 프로젝트" onClick={event=>navigateLink(event,onNavigate)}/>
  <div className="row-between">
   <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
   <IconButton label="보고서 목록 새로고침" onClick={refreshList} isLoading={list.status==='loading'}>
    <RefreshCw size={17} aria-hidden/>
   </IconButton>
  </div>
  <div className="report-search-controls">
   <TextField id={searchId} type="search" label="보고서 검색" placeholder={isLinked?'프로젝트, 작업공간, 화면 이름 또는 URL':'화면 이름, 작업명 또는 URL'}
    value={filters.query} onChange={event=>updateFilters({...filters,query:event.target.value})}/>
   <Select label="상태" value={filters.status||'all'} options={statusOptions} onValueChange={value=>updateFilters({...filters,status:value==='all'?'':value})}/>
   <Select label="입력 유형" value={filters.source||'all'} options={sourceOptions} onValueChange={value=>updateFilters({...filters,source:value==='all'?'':value})}/>
  </div>
  <div className="report-search-caption">
   <span role="status">{list.data?(hasFilters?`검색 결과 ${reports.length}개 / 전체 ${allReports.length}개`:`${allReports.length}개 보고서`):list.status==='loading'?'보고서를 불러오는 중입니다.':''}</span>
   {hasFilters&&<Button variant="secondary" onClick={()=>{updateFilters(emptyReportFilters);document.getElementById(searchId)?.focus();}}>초기화</Button>}
  </div>
  {list.status==='error'&&<Alert tone="danger" title="목록을 불러오지 못했습니다" action={<Button variant="secondary" onClick={refreshList}>다시 시도</Button>}>{list.error}</Alert>}
  {list.status==='ready'&&!reports.length&&<p className="workspace-empty">{hasFilters?'조건에 맞는 보고서가 없습니다.':isLinked?'작업공간에 연결된 보고서가 없습니다.':'미연결 보고서가 없습니다.'}</p>}
  {reports.length>0&&<ul className="report-results" aria-label="보고서 목록">
   {reports.map(report=>{
    const context=report.workspaceContext;
    const href=context?workspaceReportHref(context.workspaceId,report.id,'summary'):reportHref(report.id,'summary');
    const causes=reportPartialCauseLabels(report);
    return <li key={report.id}>
     <a id={'report-result-'+report.id} href={href} className="report-result" onClick={event=>navigateLink(event,nextHref=>{
      memory.scrollY=window.scrollY;
      memory.selectedId=report.id;
      onNavigate(nextHref);
     })}>
      <ReportThumbnail url={report.thumbnailUrl}/>
      <span className="report-result-text">
       <strong>{reportName(report)}</strong>
       {context&&<span>{context.projectName} / {context.workspaceName}</span>}
       <span className="report-result-details">
        <span>{reportListStatusLabel(report)}</span>
        {Number.isFinite(Date.parse(report.startedAt))&&<time dateTime={report.startedAt}>{dateFormat.format(new Date(report.startedAt))}</time>}
       </span>
       {causes.length>0&&<span>{causes.join(' · ')}</span>}
      </span>
      <ArrowRight size={17} aria-hidden/>
     </a>
    </li>;
   })}
  </ul>}
  {list.data?.warnings.map(warning=><p className="report-search-warning" key={warning}>{warning}</p>)}
 </main>;
}
