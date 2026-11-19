import type {ReviewService} from '../../src/review-service.js';
import type {ProjectCard} from '../features/projects/catalog.js';
import type {ReportSummary} from '../features/reports/types.js';

// 호스트 이름으로 프로젝트 아이콘을 정한다. 예시 항목이며 필요한 호스트를 추가해 쓴다.
const projectIcons=new Map([
 ['example.com','/ui-review-agent-icon.svg'],
 ['www.example.com','/ui-review-agent-icon.svg'],
]);
const projectAliases=new Map([
 ['sample admin','example.com'],
]);

function timeFrom(value:string|undefined):number|undefined {
 const timestamp=value?Date.parse(value):NaN;
 return Number.isFinite(timestamp)?timestamp:undefined;
}

export function projectCards(catalog:Awaited<ReturnType<ReviewService['projectCatalog']>>,reports:ReportSummary[]):ProjectCard[] {
 const cards=new Map<string,ProjectCard>(catalog.projects.map(({projectId,name,description,createdAt})=>[
  projectId,{projectId,name,description,createdAt,workspaceCount:0,hasReports:false},
 ]));
 for(const workspace of catalog.workspaces){
  const card=cards.get(workspace.projectId);
  if(card)card.workspaceCount++;
 }
 for(const {projectId} of catalog.reportWorkspaceContexts.values()){
  const card=cards.get(projectId);
  if(card)card.hasReports=true;
 }
 const representativeByProject=new Map<string,{hostname:string;time:number}>();
 for(const report of reports){
  if(report.hasReadError)continue;
  const projectId=catalog.reportWorkspaceContexts.get(report.id)?.projectId;
  const card=projectId?cards.get(projectId):undefined;
  if(!card)continue;
  const timestamp=timeFrom(report.endedAt)??timeFrom(report.startedAt);
  if(timestamp!==undefined&&(card.latestReportTime===undefined||timestamp>card.latestReportTime))card.latestReportTime=timestamp;
  const url=URL.parse(report.target);
  if(url?.protocol!=='http:'&&url?.protocol!=='https:')continue;
  const representative=representativeByProject.get(card.projectId);
  const time=timestamp??-Infinity;
  if(!representative||time>representative.time)representativeByProject.set(card.projectId,{hostname:url.hostname,time});
 }
 for(const card of cards.values()){
  const representative=representativeByProject.get(card.projectId);
  const name=card.name.trim().toLowerCase();
  card.iconUrl=projectIcons.get(representative?.hostname??projectAliases.get(name)??name);
 }
 return [...cards.values()];
}
