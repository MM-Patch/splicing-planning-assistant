import crypto from 'node:crypto';
export const release='R20-workflow';
export const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
export const gateNames={constructionAccepted:'Construction accepted',scopePrintsCurrent:'Scope/prints current',materialsReady:'Materials ready',testLightPath:'Test/light path',networkCutoverNamed:'Network/cutover',customerAccessClear:'Customer/access/install clear',crewDurationBumpRule:'Crew/duration/backup assigned'};
export function readiness(item={}){
 const details=Object.entries(gateNames).map(([key,label])=>{
  const e=item.readinessEvidence?.[key];
  // Explicit, attributable observations only. Absence of blocker words is never proof.
  const valid=e&&['pass','fail'].includes(e.state)&&e.source&&e.reference&&e.observedAt;
  return {key,label,state:valid?e.state:'unknown',source:valid?e.source:null,reference:valid?e.reference:null,observedAt:valid?e.observedAt:null,ownerAsk:valid&&e.state==='pass'?'':`${item.owner||'Owner needed'}: confirm ${label.toLowerCase()} and provide dated source evidence.`};
 });
 const complete=details.filter(x=>x.state==='pass').length;
 const exception=item.readinessException?.approver&&item.readinessException?.reason&&item.readinessException?.at?item.readinessException:null;
 return {details,gates:Object.fromEntries(details.map(x=>[x.key,x.state==='pass'])),complete,total:7,score:`${complete}/7`,ready:complete===7,dispatchEligible:complete===7||Boolean(exception),exception,sourceStatus:item.status||'Unknown'};
}
export function sourceRecord(item){return {itemId:String(item.itemId||item.id||''),boardId:String(item.sourceBoardId||''),name:item.sourceBoard||item.source||'Unknown board',projectName:item.name,url:item.sourceUrl||'',sourceKind:String(item.sourceBoardId)==='18391791372'?'D2D':String(item.sourceBoardId)==='5077578194'?'Project Tracker':item.source||'Source'};}
export function bridgeFor(item,items,links=[],candidate=null){
 const id=String(item.itemId); const matches=links.filter(l=>String(l.d2dItemId)===id||String(l.trackerItemId)===id);
 const link=matches[0];const a=link&&items.find(x=>String(x.itemId)===String(link.d2dItemId)&&String(x.sourceBoardId)==='18391791372');
 const b=link&&items.find(x=>String(x.itemId)===String(link.trackerItemId)&&String(x.sourceBoardId)==='5077578194');
 const unique=link&&links.filter(l=>String(l.d2dItemId)===String(link.d2dItemId)||String(l.trackerItemId)===String(link.trackerItemId)).length===1;
 const verified=Boolean(a&&b&&unique);
 return {status:verified?'verified':matches.length?'unmatched':candidate?.tracker&&candidate?.d2d?'possible':'primary-only',verified,reason:verified?'Explicit source bridge; both board/item records resolved.':matches.length?'Bridge missing a record or has conflicting links.':'No verified bridge. Name similarity is only a candidate; primary-only is available.',confidence:verified?'explicit link':'unverified',primary:sourceRecord(item),linked:verified?sourceRecord(String(a.itemId)===id?b:a):null,d2d:a?sourceRecord(a):String(item.sourceBoardId)==='18391791372'?sourceRecord(item):null,tracker:b?sourceRecord(b):String(item.sourceBoardId)==='5077578194'?sourceRecord(item):null};
}
export function planPost({item,bridge,text,destinations='primary',mentionIds=[]}){
 if(!item||!String(text||'').trim())throw Object.assign(Error('Select a project and enter a draft.'),{status:400});
 if(!['primary','linked','both'].includes(destinations))throw Object.assign(Error('Unknown destination.'),{status:400});
 if(destinations!=='primary'&&!bridge.verified)throw Object.assign(Error('Verified bridge required. Select primary/source record only.'),{status:409});
 const targets=destinations==='primary'?[bridge.primary]:destinations==='linked'?[bridge.linked]:[bridge.primary,bridge.linked];
 if(targets.some(t=>!/^\d+$/.test(t.itemId)||!/^\d+$/.test(t.boardId)))throw Object.assign(Error('Exact numeric board and item IDs required.'),{status:409});
 const ids=[...new Set(mentionIds.map(String))].sort();
 if(ids.some(x=>!/^\d+$/.test(x)))throw Object.assign(Error('Invalid Monday user ID.'),{status:400});
 return {planned:targets.map(t=>({...t,text:String(text).trim()})),mentionIds:ids,key:hash({targets:targets.map(t=>[t.boardId,t.itemId]).sort(),text:String(text).trim(),ids}),warning:bridge.verified?null:'Primary-only: no verified linked destination.'};
}
export function workflowFilter(items,key){return items.filter(r=>{
 switch(key){case 'All open':return !/^(complete|closed|cancelled)$/i.test(r.status||'');case 'Ready':case 'Conditional':case 'Blocked':return r.status===key;case 'Unassigned resource':return !r.assignedResource||/^(unassigned|tbd)$/i.test(r.assignedResource);case 'Needs update':return !(r.updates||[]).length||!r.updateCount;case 'Readiness blockers':return !readiness(r).dispatchEligible;case 'Source bridge gaps':return !r.bridge?.verified;case 'Schedule candidates':return readiness(r).dispatchEligible;default:return true;}
 });}
