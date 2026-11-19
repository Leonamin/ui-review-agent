import type {MoneyLabelRelation} from './types.js';
/** Runs only as a statically shipped browser function; no model code or selector is accepted. */
export function collectMoneyRelations(data:{candidateElements:Element[]}|Element[]):Record<string,MoneyLabelRelation>{
 const candidates=Array.isArray(data)?data:data.candidateElements;const result:Record<string,MoneyLabelRelation>={};
 const helpers={
  isVisible(el:Element):boolean{const box=el.getBoundingClientRect();if(box.width<=0||box.height<=0||box.bottom<=0||box.right<=0||box.top>=innerHeight||box.left>=innerWidth)return false;for(let node:Element|null=el;node;node=node.parentElement){const style=getComputedStyle(node);if(style.display==='none'||style.visibility!=='visible'||Number(style.opacity)===0)return false;}return true;},
  isSafe(el:Element):boolean{return !el.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])')&&!el.querySelector('input,textarea,select,[contenteditable]:not([contenteditable="false"])');},
  text(el:Element):string{return ((el as HTMLElement).innerText??el.textContent??'').replace(/\s+/g,' ').trim();},
  hasHiddenText(el:Element):boolean{return [...el.querySelectorAll('*')].some(child=>Boolean(child.textContent?.trim())&&!helpers.isVisible(child));},
  isMoney(text:string):boolean{return /^(?:₩|\$|€|KRW|USD|EUR)?\s*[-−]?\d[\d,.]*\s*(?:원|KRW|USD|EUR|달러|유로)?$/.test(text)&&/(?:₩|\$|€|KRW|USD|EUR|원|달러|유로)/.test(text);}
 };
 for(let index=0;index<candidates.length;index++){
  const target=candidates[index];if(!helpers.isVisible(target)||!helpers.isSafe(target))continue;
  const value=helpers.text(target);if(!helpers.isMoney(value))continue;
  const possibilities:{source:NonNullable<MoneyLabelRelation['source']>;labels:Element[]}[]=[];let reason='No supported explicit label/value relationship';
  const aria=target.getAttribute('aria-labelledby');
  if(aria){const ids=aria.trim().split(/\s+/);const labels=ids.map(id=>document.getElementById(id));if(ids.length>4||labels.some(el=>!el)||ids.some(id=>Array.from(document.querySelectorAll('[id]')).filter(el=>el.id===id).length!==1)||new Set(ids).size!==ids.length){result[`e${index}`]={status:'unsupported',labelRefs:[],reason:'Missing or duplicate aria-labelledby target'};continue;}possibilities.push({source:'aria-labelledby',labels:labels as Element[]});}
  if(target.id&&target.matches('output,meter,progress,button')){if(Array.from(document.querySelectorAll('[id]')).filter(el=>el.id===target.id).length!==1){result[`e${index}`]={status:'unsupported',labelRefs:[],reason:'Duplicate labelable target ID'};continue;}const labels=Array.from(document.querySelectorAll('label')).filter(label=>label.htmlFor===target.id);if(labels.length)possibilities.push({source:'html-label',labels});}
  const dd=target.closest('dd');
  if(dd&&dd.closest('dl')){const previous=dd.previousElementSibling;const hasUniqueValue=helpers.text(dd)===value;const hasUniqueLabel=previous?.tagName==='DT'&&previous.previousElementSibling?.tagName!=='DT'&&dd.nextElementSibling?.tagName!=='DD';if(hasUniqueValue&&hasUniqueLabel)possibilities.push({source:'definition-list',labels:[previous!]});else reason='Definition list has multiple labels or values';}
  const td=target.closest('td');
  if(td&&helpers.text(td)===value){
   const table=td.closest('table');const row=td.closest('tr');
   const hasSpans=Array.from(row?.children??[]).some(cell=>Number(cell.getAttribute('colspan')??1)!==1||Number(cell.getAttribute('rowspan')??1)!==1);
   if(hasSpans)reason='Spanning table cells are ambiguous';
   else if(td.hasAttribute('headers')){const ids=td.getAttribute('headers')!.trim().split(/\s+/).filter(Boolean);const headers=ids.map(id=>document.getElementById(id));if(ids.length&&ids.length<=4&&new Set(ids).size===ids.length&&ids.every(id=>Array.from(document.querySelectorAll('[id]')).filter(el=>el.id===id).length===1)&&headers.every(header=>header?.tagName==='TH'&&header.closest('table')===table))possibilities.push({source:'table-headers',labels:headers as Element[]});else reason='Invalid table header relationship';}
   else{const headers=Array.from(row?.children??[]).filter(cell=>cell.matches('th[scope="row"]'));if(headers.length===1&&Array.from(row?.children??[]).filter(cell=>cell.tagName==='TD').length===1)possibilities.push({source:'table-row-header',labels:headers});else reason='No unique explicit table row header';}
  }
  // A bounded structural row is weaker than semantic HTML, so require exactly two
  // direct cells and a single value. Never walk to a wider arbitrary ancestor.
  if(!possibilities.length&&!aria&&!dd&&!td){const parent=target.parentElement;const cells=Array.from(parent?.children??[]);const display=parent?getComputedStyle(parent).display:'';
   if(parent&&cells.length===2&&['flex','inline-flex','grid','inline-grid'].includes(display)&&cells.includes(target)){
    const label=cells.find(cell=>cell!==target)!;const hasOutsideText=Array.from(parent.childNodes).some(node=>node.nodeType===Node.TEXT_NODE&&Boolean(node.textContent?.trim()));
    if(!hasOutsideText&&helpers.isVisible(label)&&helpers.isSafe(label)&&!helpers.hasHiddenText(label)&&!/[0-9₩$€]/.test(helpers.text(label)))possibilities.push({source:'two-cell-row',labels:[label]});else reason='Two-cell row is hidden, sensitive or has competing numeric content';
   }
  }
  if(!possibilities.length){result[`e${index}`]={status:'unsupported',labelRefs:[],reason};continue;}
  const keys=possibilities.map(item=>item.labels.map(label=>candidates.indexOf(label)).join(','));
  if(new Set(keys).size!==1){result[`e${index}`]={status:'unsupported',labelRefs:[],reason:'Conflicting explicit label relationships'};continue;}
  const chosen=possibilities[0];const labels=chosen.labels;const labelRefs=labels.map(label=>`e${candidates.indexOf(label)}`);
  if(!labels.length||new Set(labels).size!==labels.length||labels.some(label=>label===target||label.contains(target)||target.contains(label)||!helpers.isVisible(label)||!helpers.isSafe(label)||helpers.hasHiddenText(label)||candidates.indexOf(label)<0)){
   result[`e${index}`]={status:'unsupported',labelRefs:[],reason:'Label is hidden, sensitive, contains the value, duplicated or outside the bounded observation'};continue;
  }
  const text=labels.map(label=>helpers.text(label)).join(' ');
  if(!text||text.length>250||/[0-9₩$€]/.test(text)||helpers.hasHiddenText(target)){result[`e${index}`]={status:'unsupported',labelRefs:[],reason:'Label/value content is ambiguous or hidden'};continue;}
  result[`e${index}`]={status:'resolved',source:chosen.source,labelRefs,labelText:text};
 }
 return result;
}
