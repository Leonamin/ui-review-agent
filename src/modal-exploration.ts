/** Page-side measurement only. No page text is executed and no coordinates are guessed. */
export function readModalSnapshot(modal:Element){
 const box=modal.getBoundingClientRect(),css=getComputedStyle(modal);
 const isVisible=modal.isConnected&&box.width>0&&box.height>0&&box.bottom>0&&box.top<innerHeight&&box.right>0&&box.left<innerWidth&&css.display!=='none'&&css.visibility==='visible';
 const text=(modal.textContent??'').replace(/\s+/g,' ').trim();
 const title=(modal.getAttribute('aria-label')||modal.getAttribute('aria-labelledby')?.split(/\s+/).map(id=>document.getElementById(id)?.textContent??'').join(' ')||modal.querySelector('h1,h2,h3,h4,[role="heading"]')?.textContent||(modal instanceof HTMLElement?modal.innerText.split('\n').find(line=>line.trim()):'')||'').replace(/\s+/g,' ').trim();
 const hasProhibitedContext=Boolean(modal.querySelector('input:not([type="radio"]):not([type="checkbox"]):not([type="hidden"]),textarea,select,[contenteditable]:not([contenteditable="false"])')||/로그인|회원가입|동의|개인정보|쿠키|권한|결제|삭제|제출|저장|구매|구독|초기화|탈퇴|보내기|전송|초대|업로드|수정하기|업데이트하기|\b(?:consent|cookies?|permissions?|log\s?in|sign\s?(?:in|up)|payment|purchase|delete|submit|subscribe|save|reset|account|send|invite|upload|update)\b/i.test(text));
 const buttons=Array.from(modal.querySelectorAll('button,[role="button"],input[type="radio"],input[type="checkbox"],[role="radio"],[role="checkbox"]')).map(button=>(button.getAttribute('aria-label')||button.textContent||'').replace(/\s+/g,' ').trim());
 const signature=JSON.stringify({title,text,tag:modal.tagName,role:modal.getAttribute('role'),box:{x:box.x,y:box.y,width:box.width,height:box.height}});
 let backdropElement:Element|null=null;let backdropPoint:{x:number;y:number}|null=null;
 // Select a point from measured exposed bands, then prove the hit belongs to a dedicated overlay.
 const bands=[{x:box.left/2,y:Math.max(1,Math.min(innerHeight-1,box.y+box.height/2))},{x:(box.right+innerWidth)/2,y:Math.max(1,Math.min(innerHeight-1,box.y+box.height/2))},{x:Math.max(1,Math.min(innerWidth-1,box.x+box.width/2)),y:box.top/2},{x:Math.max(1,Math.min(innerWidth-1,box.x+box.width/2)),y:(box.bottom+innerHeight)/2}];
 for(const point of bands){
  if(point.x<=0||point.y<=0||point.x>=innerWidth||point.y>=innerHeight||point.x>=box.left&&point.x<=box.right&&point.y>=box.top&&point.y<=box.bottom)continue;
  const hit=document.elementFromPoint(point.x,point.y);if(!hit||hit===modal||modal.contains(hit)||hit.matches('html,body,button,a,input,select,textarea,[role="button"],[role="tab"]'))continue;
  const hitBox=hit.getBoundingClientRect(),style=getComputedStyle(hit),color=style.backgroundColor;
  const alpha=color.startsWith('rgba')?Number(color.split(',').at(-1)?.replace(')','')):color.startsWith('rgb')?1:0;
  const hasOverlayRelation=hit.contains(modal)||hit.parentElement===modal.parentElement;
  const hasOtherControls=Array.from(hit.querySelectorAll('button,a,input,select,textarea,[role="button"],[role="tab"]')).some(control=>!modal.contains(control));
  if(hasOverlayRelation&&!hasOtherControls&&/^(fixed|absolute)$/.test(style.position)&&alpha>0&&style.pointerEvents!=='none'&&hitBox.left<=box.left&&hitBox.right>=box.right&&hitBox.top<=box.top&&hitBox.bottom>=box.bottom){backdropElement=hit;backdropPoint={x:point.x-hitBox.x,y:point.y-hitBox.y};break;}
 }
 return{title,signature,semanticKey:JSON.stringify({title,buttons}),isVisible,hasProhibitedContext,backdropElement,backdropPoint};
}

export function readModalButton(button:Element){
 const modal=button.closest('dialog[open],[role="dialog"],[aria-modal="true"]');
 if(!modal||!(button.tagName==='BUTTON'||['button','radio','checkbox'].includes(button.getAttribute('role')??'')||button instanceof HTMLInputElement&&['radio','checkbox'].includes(button.type))||button.closest('a[href],area[href]')||button.hasAttribute('href')||button.hasAttribute('formaction')||button.hasAttribute('download')||(button instanceof HTMLButtonElement&&(button.form!==null&&['submit','reset'].includes(button.type)))||button.matches(':disabled,[disabled],[aria-disabled="true"]')||button.closest('[inert]'))return null;
 const label=(button.getAttribute('aria-label')||button.getAttribute('title')||(button instanceof HTMLInputElement?Array.from(button.labels??[]).map(label=>label.textContent??'').join(' '):'')||button.textContent||'').replace(/\s+/g,' ').trim();
 if(!label||/로그인|회원가입|동의|쿠키|권한|결제|삭제|제출|저장|구매|구독|초기화|탈퇴|보내기|전송|초대|업로드|수정하기|업데이트하기|\b(?:consent|cookies?|permission|login|signin|signup|payment|purchase|delete|submit|subscribe|save|reset|account|send|invite|upload|update)\b/i.test(label))return null;
 const box=button.getBoundingClientRect(),css=getComputedStyle(button),hit=document.elementFromPoint(box.x+box.width/2,box.y+box.height/2);
 if(!button.isConnected||box.width<=0||box.height<=0||box.x<0||box.y<0||box.right>innerWidth||box.bottom>innerHeight||css.visibility!=='visible'||css.display==='none'||!hit||!button.contains(hit))return null;
 const kind=/^(?:(?:팝업\s*|모달\s*)?닫기|나중에|다음에|취소|close|dismiss|not now|later|cancel|[x×✕✖])$/i.test(label)?'close-button':/^(?:시작하기|시작|계속|다음|건너뛰기|확인|완료|start|continue|next|skip|ok|done)$/i.test(label)?'continue':'preference';
 return{label,kind,signature:JSON.stringify({label,kind,tag:button.tagName,isChecked:button instanceof HTMLInputElement?button.checked:button.getAttribute('aria-checked'),box:{x:box.x,y:box.y,width:box.width,height:box.height}})};
}
