import {useId,useRef,useState,type CSSProperties,type KeyboardEvent,type PointerEvent,type ReactNode} from 'react';
import {ArrowLeft,PanelLeftClose,PanelLeftOpen} from 'lucide-react';
import {navigateLink} from '../../app/route';
import {Button} from '../../shared/goodcase/components/basic/button';
import {TextField} from '../../shared/goodcase/components/basic/text-field';
import {Select} from '../../shared/goodcase/components/overlays/select';
import type {ReviewProject,ReviewWorkspace} from '../../../src/workspace-contract';
import './workspace-sidebar.css';

const minimumWidth=184;
const maximumWidth=360;
const collapsedWidth=52;
const collapseThreshold=132;
const workspaceSortOptions=[
 {value:'newest',label:'최신 생성순'},
 {value:'oldest',label:'오래된 생성순'},
];

interface WorkspaceShellProps {
 workspaceId:string;
 project?:ReviewProject;
 workspaces:ReviewWorkspace[];
 onNavigate:(href:string)=>void;
 children:ReactNode;
}

export function WorkspaceShell({workspaceId,project,workspaces,onNavigate,children}:WorkspaceShellProps){
 const [width,setWidth]=useState(224);
 const [isOpen,setIsOpen]=useState(true);
 const [isMobileOpen,setIsMobileOpen]=useState(false);
 const [isDragging,setIsDragging]=useState(false);
 const contentId=useId();
 const drag=useRef<{pointerId:number;x:number;width:number;openWidth:number}|null>(null);
 function startDrag(event:PointerEvent<HTMLDivElement>){
  if(event.button!==0||!event.isPrimary)return;
  event.preventDefault();
  event.currentTarget.focus();
  event.currentTarget.setPointerCapture(event.pointerId);
  drag.current={pointerId:event.pointerId,x:event.clientX,width:isOpen?width:collapsedWidth,openWidth:width};
  setIsDragging(true);
 }
 function moveDrag(event:PointerEvent<HTMLDivElement>){
  const start=drag.current;
  if(!start||start.pointerId!==event.pointerId)return;
  const next=start.width+event.clientX-start.x;
  setIsOpen(next>=collapseThreshold);
  setWidth(next<collapseThreshold?start.openWidth:Math.min(maximumWidth,Math.max(minimumWidth,next)));
 }
 function endDrag(){
  drag.current=null;
  setIsDragging(false);
 }
 function resizeWithKeyboard(event:KeyboardEvent<HTMLDivElement>){
  switch(event.key){
   case 'ArrowLeft':
    if(isOpen&&width>minimumWidth)setWidth(Math.max(minimumWidth,width-16));
    else setIsOpen(false);
    break;
   case 'ArrowRight':
    if(isOpen)setWidth(Math.min(maximumWidth,width+16));
    else setIsOpen(true);
    break;
   case 'Home': setIsOpen(false);break;
   case 'End': setWidth(maximumWidth);setIsOpen(true);break;
   case 'Enter': setIsOpen(value=>!value);break;
   default:return;
  }
  event.preventDefault();
 }
 return <div className="review-workspace-shell"
  data-sidebar-open={isOpen} data-mobile-sidebar-open={isMobileOpen} data-sidebar-dragging={isDragging}
  style={{'--workspace-sidebar-width':`${isOpen?width:collapsedWidth}px`} as CSSProperties}>
  <aside className="review-workspace-sidebar" aria-label="작업공간 목록">
   <div className="workspace-sidebar-heading">
    {project&&<a className="workspace-back" href={`/?project=${encodeURIComponent(project.projectId)}`}><ArrowLeft size={16} aria-hidden/>{project.name}</a>}
    <Button className="workspace-sidebar-toggle workspace-sidebar-toggle-desktop" variant="secondary"
     aria-label={isOpen?'작업공간 목록 접기':'작업공간 목록 열기'} aria-controls={contentId} aria-expanded={isOpen}
     onClick={()=>setIsOpen(value=>!value)}>{isOpen?<PanelLeftClose size={18} aria-hidden/>:<PanelLeftOpen size={18} aria-hidden/>}</Button>
    <Button className="workspace-sidebar-toggle workspace-sidebar-toggle-mobile" variant="secondary"
     aria-controls={contentId} aria-expanded={isMobileOpen} onClick={()=>setIsMobileOpen(value=>!value)}>
     {isMobileOpen?<PanelLeftClose size={16} aria-hidden/>:<PanelLeftOpen size={16} aria-hidden/>}작업공간 목록
    </Button>
   </div>
   <div className="workspace-sidebar-content" id={contentId}>
    {project&&<WorkspaceSidebarList key={project.projectId} workspaceId={workspaceId} project={project} workspaces={workspaces} onNavigate={onNavigate}/>}
   </div>
   <div className="workspace-sidebar-resizer" role="separator" tabIndex={0} aria-label="작업공간 목록 너비"
    aria-controls={contentId} aria-orientation="vertical" aria-valuemin={collapsedWidth} aria-valuemax={maximumWidth}
    aria-valuenow={isOpen?width:collapsedWidth} aria-valuetext={isOpen?`${width}픽셀`:'접힘'}
    onLostPointerCapture={endDrag} onPointerDown={startDrag} onPointerMove={moveDrag} onKeyDown={resizeWithKeyboard}/>
  </aside>
  {children}
 </div>;
}

function WorkspaceSidebarList({workspaceId,project,workspaces,onNavigate}:{
 workspaceId:string;
 project:ReviewProject;
 workspaces:ReviewWorkspace[];
 onNavigate:(href:string)=>void;
}){
 const [search,setSearch]=useState('');
 const [sort,setSort]=useState('newest');
 const query=search.trim().toLocaleLowerCase();
 const visibleWorkspaces=workspaces
  .filter(workspace=>workspace.projectId===project.projectId&&workspace.name.toLocaleLowerCase().includes(query))
  .sort((left,right)=>{
   const byCreation=Date.parse(right.createdAt)-Date.parse(left.createdAt);
   return (sort==='oldest'?-byCreation:byCreation)||left.name.localeCompare(right.name,'ko-KR');
  });
 return <>
  <div className="workspace-sidebar-controls">
   <TextField type="search" label="작업공간 이름 검색" placeholder="이름 검색" value={search} onChange={event=>setSearch(event.target.value)}/>
   <Select label="생성일 정렬" triggerClassName="gc-dropdown-trigger" value={sort} onValueChange={setSort} options={workspaceSortOptions}/>
  </div>
  <nav className="workspace-sidebar-list" aria-label="프로젝트의 작업공간">
   {query&&visibleWorkspaces.length===0&&<p className="muted workspace-sidebar-empty" role="status">검색에 맞는 작업공간이 없습니다.</p>}
   {visibleWorkspaces.map(workspace=>
    <a href={`/?workspace=${encodeURIComponent(workspace.workspaceId)}`} aria-current={workspace.workspaceId===workspaceId?'page':undefined}
     key={workspace.workspaceId} onClick={event=>{navigateLink(event,href=>{if(workspace.workspaceId!==workspaceId)onNavigate(href);});}}>{workspace.name}</a>)}
  </nav>
 </>;
}
