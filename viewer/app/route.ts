import type {MouseEvent} from 'react';

const reportTabs = ['summary', 'findings', 'suggestions', 'measurements', 'limits'];
export const projectsHref = '/?view=projects';
export const reportSearchHref = '/?view=report-search';
export const unlinkedReportsHref = '/?view=unlinked-reports';
export type ProjectSetting = 'login' | 'post';
export type ProjectManagementAction = ProjectSetting | 'delete';

export function projectSettingParam(params:URLSearchParams):ProjectSetting|undefined {
 const setting=params.get('manage');
 return setting==='login'||setting==='post'?setting:undefined;
}

export function projectManagementHref(projectId:string,action:ProjectManagementAction):string {
 return `/?${new URLSearchParams({project:projectId,manage:action})}`;
}

export function reportRoute(search: string): {id: string; tab: string} {
 const params = new URLSearchParams(search);
 const tab = params.get('tab') ?? '';
 return {id: params.get('report') ?? '', tab: reportTabs.includes(tab) ? tab : 'summary'};
}

export function workspaceReportTab(search: string): string {
 const params = new URLSearchParams(search);
 const tab = params.get('tab') ?? '';
 if (tab === 'compose' && params.get('workspace')) return tab;
 if (tab === 'suggestions' || tab === 'measurements' || tab === 'limits') return tab;
 if (tab === 'summary' && params.get('workspace')) return tab;
 return 'results';
}

export function reportHref(id: string, tab: string): string {
 return id ? `/?${new URLSearchParams({report: id, tab})}` : unlinkedReportsHref;
}

export function workspaceReportHref(workspaceId: string, reportId: string, tab: string): string {
 const params = new URLSearchParams({workspace: workspaceId, report: reportId, tab});
 return `/?${params}`;
}

export function navigateLink(event: MouseEvent<HTMLAnchorElement>, navigate: (href: string) => void) {
 if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
 event.preventDefault();
 navigate(event.currentTarget.href);
}
