import type {ReviewProject} from '../../../src/workspace-contract';

export type ProjectSort='name-asc'|'name-desc'|'created'|'latest-report';
export type ProjectReportFilter='all'|'with-reports'|'without-reports';
export interface ProjectCatalogView {projects:ProjectCard[];hasMoreReports:boolean;}

const compareName=new Intl.Collator('ko',{numeric:true,sensitivity:'base'});

export interface ProjectCard extends Pick<ReviewProject,'projectId'|'name'|'description'|'createdAt'> {
 workspaceCount:number;
 hasReports:boolean;
 latestReportTime?:number;
 iconUrl?:string;
}

function creationTime(value:string):number|undefined {
 const timestamp=Date.parse(value);
 return Number.isFinite(timestamp)?timestamp:undefined;
}

export function selectProjectCards(cards:ProjectCard[],search:string,filter:ProjectReportFilter,sort:ProjectSort) {
 const query=search.trim().toLocaleLowerCase();
 const direction=sort==='name-desc'?-1:1;
 return cards
  .filter(card=>[card.name,card.description].some(value=>value.toLocaleLowerCase().includes(query))
   &&(filter==='all'||card.hasReports===(filter==='with-reports')))
  .sort((first,second)=>{
   if(sort==='latest-report'){
    const byReport=compareRecent(first.latestReportTime,second.latestReportTime);
    if(byReport)return byReport;
   }
   if(sort==='latest-report'||sort==='created'){
    const byCreation=compareRecent(creationTime(first.createdAt),creationTime(second.createdAt));
    if(byCreation)return byCreation;
   }
   return direction*compareName.compare(first.name,second.name)||first.projectId.localeCompare(second.projectId);
  });
}

function compareRecent(first:number|undefined,second:number|undefined):number {
 if(first===second)return 0;
 if(first===undefined)return 1;
 if(second===undefined)return -1;
 return second-first;
}
