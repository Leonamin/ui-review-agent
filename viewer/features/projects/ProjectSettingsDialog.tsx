import type {ReactNode,RefObject} from 'react';
import type {ReviewProject} from '../../../src/workspace-contract';
import {Dialog} from '../../shared/goodcase/components/overlays/dialog';

export type ProjectSettingsProps={
 project:ReviewProject;
 onClose:()=>void;
 onProjectChange:(project:ReviewProject)=>void;
 returnFocusRef:RefObject<HTMLButtonElement|null>;
};

export function ProjectSettingsDialog({project,onClose,returnFocusRef,title,isBusy,hasUnsavedChanges,children}:Omit<ProjectSettingsProps,'onProjectChange'>&{
 title:string;
 isBusy:boolean;
 hasUnsavedChanges:boolean;
 children:ReactNode;
}){
 function requestClose(nextIsOpen:boolean){
  if(nextIsOpen||isBusy)return;
  if(hasUnsavedChanges&&!window.confirm('저장하지 않은 변경사항을 버리고 닫으시겠습니까?'))return;
  onClose();
 }
 return <Dialog title={title} description={project.name} isOpen onOpenChange={requestClose}
  shouldCloseOnOutsideClick={false} shouldCloseOnEscape={!isBusy} returnFocusRef={returnFocusRef}
  className="project-settings-dialog">{children}</Dialog>;
}
