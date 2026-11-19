import {useRef} from 'react';
import type {ProjectDeletionResult,ReviewProject} from '../../../src/workspace-contract';
import type {ProjectManagementAction} from '../../app/route';
import {ActionMenu} from '../../shared/ActionMenu';
import {ProjectDeletionDialog} from './ProjectDeletion';
import {ProjectPostHosts} from './ProjectPostHosts';
import {ProjectSupabaseAuth} from './ProjectSupabaseAuth';

type ProjectManagementProps={
 project:ReviewProject;
 action?:ProjectManagementAction;
 onOpen:(action:ProjectManagementAction)=>void;
 onClose:()=>void;
 onProjectChange:(project:ReviewProject)=>void;
 onDeleted:(result:ProjectDeletionResult)=>void;
};

export function ProjectManagement({project,action,onOpen,onClose,onProjectChange,onDeleted}:ProjectManagementProps){
 const triggerRef=useRef<HTMLButtonElement>(null);
 const settingsProps={project,onProjectChange,onClose,returnFocusRef:triggerRef};

 return <>
  <ActionMenu label="관리" triggerRef={triggerRef} shouldRestoreFocusOnSelect={false} items={[
   {label:'Supabase 로그인 출처',description:`${project.supabaseAuthBindings?.length??0}개`,onSelect:()=>onOpen('login')},
   {label:'POST 허용 호스트',description:`${project.postAllowedHosts?.length??0}개`,onSelect:()=>onOpen('post')},
   {label:'프로젝트 삭제',onSelect:()=>onOpen('delete'),isDestructive:true,hasSeparatorBefore:true},
  ]}/>
  {action==='login'&&<ProjectSupabaseAuth {...settingsProps}/>}
  {action==='post'&&<ProjectPostHosts {...settingsProps}/>}
  {action==='delete'&&<ProjectDeletionDialog project={project} onDeleted={onDeleted} returnFocusRef={triggerRef} onClose={onClose}/>}
 </>;
}
