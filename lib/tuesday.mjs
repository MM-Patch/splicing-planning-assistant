import {hash,bridgeFor,readiness,planPost} from './workflow.mjs';
export function tuesdayWorkflow({allItems,files,readJson,save,deliver,plan}){
 const storeFile=files.tuesday+'.requests';
 async function audit(event,detail){const rows=await readJson(files.audit,[]);rows.unshift({event,at:new Date().toISOString(),...detail});await save(files.audit,rows);}
 async function preview(){
 const date=new Date(),day=date.getUTCDay();date.setUTCDate(date.getUTCDate()-((day+5)%7));const cycle=date.toISOString().slice(0,10);
 const items=await allItems(),links=(await readJson(files.bridge,{links:[]})).links,store=await readJson(storeFile,{}),groups={};
 for(const item of items){
 if(item.observationSource!=='Monday sync'||!item.observedAt)continue;
 if(/^(complete|closed|cancelled)$/i.test(item.status||''))continue;
 const dates=(item.updates||[]).map(u=>Date.parse(u.date||u.createdAt||u.created_at||'')).filter(Number.isFinite),last=dates.length?Math.max(...dates):null,age=last===null?null:Math.max(0,Math.floor((Date.now()-last)/86400000));
 if(age!==null&&age<7&&item.status==='Ready')continue;
 const owner=(!/^(unassigned|tbd)?$/i.test(item.owner||'')?item.owner:(!/^(unassigned|tbd)?$/i.test(item.assignedResource||'')?item.assignedResource:'Owner needed')),bridge=bridgeFor(item,items,links);
 const text=`${owner} — please update ${item.name} before the RFS call. Confirm RFS ${item.rfs||'not recorded'}, install ${item.installDate||'not recorded'}, next checkpoint, blockers and evidence. ${item.sourceUrl||''}`;
 let p;try{p=planPost({item,bridge,text,destinations:'primary'});}catch{continue;}
 const id=hash({cycle,recipient:owner,itemId:String(item.itemId),target:[p.planned[0].boardId,p.planned[0].itemId]});
 (groups[owner]||=[]).push({id,itemId:String(item.itemId),name:item.name,observationSource:item.observationSource,observedAt:item.observedAt,sourceBoard:item.sourceBoard||item.source,rfs:item.rfs,installDate:item.installDate,status:item.rawStatus||item.status,readiness:readiness(item).score,blocker:item.blocker,action:item.action,lastUpdateAgeDays:age,linked:bridge.linked,bridgeStatus:bridge.status,text,destinations:'primary',targets:p.planned,dedupKey:id,cycle,requestStatus:store[id]?.status||'Preview only'});
 }return {ok:true,automaticEnabled:false,liveOnly:true,excludedSnapshotRecords:items.filter(x=>x.observationSource!=='Monday sync').length,cycle,timeZone:'UTC; weekly cycle begins Tuesday',groups:Object.entries(groups).map(([owner,items])=>({owner,count:items.length,items,message:items.map(x=>x.text).join('\n\n')}))};
 }
 async function action(body){
 if(!['queue','send','copy','export','mark-sent'].includes(body.action))throw Object.assign(Error('Unknown action'),{status:400});
 if(['send','mark-sent'].includes(body.action)&&body.confirmed!==true)throw Object.assign(Error('Explicit confirmation required'),{status:400});
 if(!Array.isArray(body.requests)||!body.requests.length)throw Object.assign(Error('Select requests first'),{status:400});
 const prep=await preview(),valid=new Map(prep.groups.flatMap(g=>g.items.map(it=>[it.id,{...it,owner:g.owner}]))),store=await readJson(storeFile,{}),results=[];
 for(const req of body.requests){
 const it=valid.get(req.id);if(!it)throw Object.assign(Error('Request expired or unknown; refresh preview'),{status:409});
 const text=String(req.text||it.text).trim();if(!text)throw Object.assign(Error('Message required'),{status:400});
 if(['queue','send','mark-sent'].includes(body.action)&&['Read-back confirmed','Marked sent externally','Sending','Failed/uncertain'].includes(store[it.id]?.status)){results.push({id:it.id,status:'Duplicate blocked'});await audit('tuesday_duplicate_blocked',{requestId:it.id});continue;}
 if(body.action==='send'){
 store[it.id]={status:'Sending',text,at:new Date().toISOString()};await save(storeFile,store);
 const result=await deliver({itemId:it.itemId,text,destinations:'primary',confirmed:true},it.id);
 store[it.id]={status:result.readbackConfirmed?'Read-back confirmed':'Failed/uncertain',text,result};results.push({id:it.id,...result});
 }else if(body.action==='queue'){
 const q=await readJson(files.queue,[]);if(q.some(e=>e.cycleKey===it.id)){results.push({id:it.id,status:'Duplicate blocked'});await audit('tuesday_duplicate_blocked',{requestId:it.id});continue;}
 const p=await plan({itemId:it.itemId,text,destinations:'primary'});q.unshift({...p,id:it.id,key:it.id,cycleKey:it.id,itemName:it.name,message:text,status:'queued',createdAt:new Date().toISOString()});await save(files.queue,q);store[it.id]={status:'Queued',text};results.push({id:it.id,status:'Queued'});
 }else if(body.action==='mark-sent'){store[it.id]={status:'Marked sent externally',text,note:'Manual attestation; no Monday readback claimed'};results.push({id:it.id,status:'Marked sent externally'});}
 else results.push({id:it.id,owner:it.owner,project:it.name,targets:it.targets,text,status:'Export/copy prepared — not sent'});
 await save(storeFile,store);await audit('tuesday_'+body.action,{requestId:it.id,cycle:it.cycle,recipient:it.owner,itemId:it.itemId,target:it.targets.map(t=>({boardId:t.boardId,itemId:t.itemId})),status:store[it.id]?.status||'Preview only'});
 }return {ok:true,results,cycle:prep.cycle};
 }
 return {preview,action,audit,storeFile};
}
