import type {ReactNode} from 'react';
import {ChevronDown} from 'lucide-react';
import {Accordion as RadixAccordion} from 'radix-ui';
import {Accordion} from './goodcase/components/overlays/accordion';

/** A single disclosure using the same Goodcase keyboard and motion contract. */
export function Disclosure({title,children,className='',shouldKeepMounted=false,isInitiallyOpen=false}:{title:string;children:ReactNode;className?:string;shouldKeepMounted?:boolean;isInitiallyOpen?:boolean}){
 if(shouldKeepMounted)return <div className={`viewer-disclosure ${className}`}>
  <RadixAccordion.Root type="single" collapsible defaultValue={isInitiallyOpen?'content':undefined} className="gc-accordion viewer-disclosure-persistent">
   <RadixAccordion.Item value="content">
    <RadixAccordion.Header>
     <RadixAccordion.Trigger>{title}<ChevronDown size={16}/></RadixAccordion.Trigger>
    </RadixAccordion.Header>
    <RadixAccordion.Content forceMount><div>{children}</div></RadixAccordion.Content>
   </RadixAccordion.Item>
  </RadixAccordion.Root>
 </div>;
 return <div className={`viewer-disclosure ${className}`}><Accordion items={[{value:'content',title,content:children}]}/></div>;
}
