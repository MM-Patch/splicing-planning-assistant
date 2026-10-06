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
const relationCache=new WeakMap();
export function relationLinks(items){
 if(relationCache.has(items))return relationCache.get(items);
 const byId=new Map(items.filter(x=>x.observationSource==='Monday sync').map(x=>[String(x.itemId),x]));const links=new Map();
 for(const it of byId.values())for(const rel of it.sourceRelations||[])for(const id of rel.linkedItemIds){
 const other=byId.get(String(id));if(!other||other.sourceBoardId===it.sourceBoardId||![it.sourceBoardId,other.sourceBoardId].every(x=>['18391791372','5077578194'].includes(String(x))))continue;
 const d=String(it.sourceBoardId)==='18391791372'?it:other,t=d===it?other:it;
 const key=d.itemId+':'+t.itemId;links.set(key,{d2dItemId:String(d.itemId),trackerItemId:String(t.itemId),note:`Monday relation column ${rel.columnTitle} (${rel.columnId}) on item ${it.itemId}; observed ${it.observedAt}`,authority:'Monday board relation'});
  }
 // Exact project identifiers reached through explicit source relations. Conflicting
 // pairs are retained so bridgeFor rejects ambiguity rather than choosing a name.
 for(const d of byId.values())if(String(d.sourceBoardId)==='18391791372')for(const e of d.identityEvidence||[]){
 if(!e.projectId||!e.observedAt)continue;
 for(const t of byId.values())if(String(t.sourceBoardId)==='5077578194'&&t.projectId&&t.projectId.trim().toUpperCase()===e.projectId.trim().toUpperCase()){
 links.set(d.itemId+':'+t.itemId,{d2dItemId:d.itemId,trackerItemId:t.itemId,authority:'Explicit relation plus exact project identifier',note:`D2D relation ${e.relationColumnTitle} (${e.relationColumnId}) → ${e.boardName} board ${e.boardId}, item ${e.itemId} → Project ID ${e.projectId} (${e.columnId}) equals Tracker Project ID; observed ${e.observedAt}.`,evidence:e});
 }}const result=[...links.values()];relationCache.set(items,result);return result;
}
export function bridgeFor(item,items,links=[],candidate=null){
 const merged=new Map(relationLinks(items).map(l=>[l.d2dItemId+':'+l.trackerItemId,l]));for(const l of links)merged.set(l.d2dItemId+':'+l.trackerItemId,l);links=[...merged.values()];
 const id=String(item.itemId); const matches=links.filter(l=>String(l.d2dItemId)===id||String(l.trackerItemId)===id);
 const link=matches[0];const a=link&&items.find(x=>String(x.itemId)===String(link.d2dItemId)&&String(x.sourceBoardId)==='18391791372');
 const b=link&&items.find(x=>String(x.itemId)===String(link.trackerItemId)&&String(x.sourceBoardId)==='5077578194');
 const unique=link&&links.filter(l=>String(l.d2dItemId)===String(link.d2dItemId)||String(l.trackerItemId)===String(link.trackerItemId)).length===1;
 const verified=Boolean(a&&b&&unique);
 return {status:verified?'verified':matches.length?'unmatched':candidate?.tracker&&candidate?.d2d?'possible':'primary-only',verified,reason:verified?`Explicit source bridge; both board/item records resolved. ${link.note||'Manual mapping.'}`:matches.length?'Bridge missing a record or has conflicting links.':'No verified bridge. Name similarity is only a candidate; primary-only is available.',confidence:verified?'explicit link':'unverified',primary:sourceRecord(item),linked:verified?sourceRecord(String(a.itemId)===id?b:a):null,d2d:a?sourceRecord(a):String(item.sourceBoardId)==='18391791372'?sourceRecord(item):null,tracker:b?sourceRecord(b):String(item.sourceBoardId)==='5077578194'?sourceRecord(item):null};
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
