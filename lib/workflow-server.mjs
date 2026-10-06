import {tuesdayWorkflow} from './tuesday.mjs';
import {readFile,writeFile,rename} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {bridgeFor,planPost,readiness,release,hash} from './workflow.mjs';
export const storageStatus={productionSafe:false,backend:'local JSON on ephemeral filesystem',warning:'PRODUCTION BLOCKER: queue, dedup and audit can be lost on restart/redeploy. Do not trust this queue for production delivery.',recommendation:'Managed Render Postgres: transactional outbox + UNIQUE idempotency key, per-target delivery/readback rows and append-only audit; migration and restart/redeploy acceptance required.'};
const html=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const plain=s=>String(s||'').replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/\s+/g,' ').trim();
export function createWorkflow(c){
 const {allItems,files,storage,readJson,mondayGraphql,mondayToken,parseBody,send,ROOT}=c;
 const ledgerFile=path.join(path.dirname(files.queue),'workflow-delivery.json');
 const durable=storage||null;
 const status=()=>({productionSafe:Boolean(durable?.kind==='postgres'&&process.env.STORAGE_PROOF_PASSED==='true'),backend:durable?.kind==='postgres'?'Postgres':'local JSON (development-only)',migrationsRan:durable?.kind==='postgres',restartRedeployProof:process.env.STORAGE_PROOF_PASSED==='true',automaticSendingEnabled:false,warning:durable?.kind==='postgres'?'':'Development-only storage; automatic sending disabled.'});
 let serial=Promise.resolve();const locked=fn=>{const p=serial.then(fn);serial=p.catch(()=>{});return p;};
 async function save(file,value){const tmp=file+'.tmp';await writeFile(tmp,JSON.stringify(value,null,2));await rename(tmp,file);}
 let dirty=false;try{dirty=Boolean(execFileSync('git',['status','--porcelain'],{cwd:ROOT,encoding:'utf8'}).trim());}catch{}
 let sha=process.env.RENDER_GIT_COMMIT||process.env.COMMIT_SHA||'unknown';if(sha==='unknown')try{sha=execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim();}catch{}
 async function context(id){const items=await allItems();const item=items.find(x=>String(x.itemId)===String(id));if(!item)throw Object.assign(Error('Project not found.'),{status:404});const links=(await readJson(files.bridge,{links:[]})).links;return {item,bridge:bridgeFor(item,items,links),readiness:readiness(item)};}
 async function plan(body){const {item,bridge}=await context(body.itemId);return {...planPost({item,bridge,text:body.text||body.message,destinations:body.destinations||'primary',mentionIds:body.mentionIds||[]}),itemId:String(item.itemId),destinations:body.destinations||'primary'};}
 async function verifyUpdate(updateId,target,text){
  const d=await mondayGraphql('query($ids:[ID!]!){updates(ids:$ids){id body text_body item{id board{id}}}}',{ids:[String(updateId)]});
  const u=d.updates?.find(x=>String(x.id)===String(updateId));
  const confirmed=Boolean(u&&String(u.item?.id)===target.itemId&&String(u.item?.board?.id)===target.boardId&&plain(u.text_body||u.body)===plain(text));
  return {confirmed,id:updateId,itemId:u?.item?.id||null,boardId:u?.item?.board?.id||null,content:u?.text_body||u?.body||null,contentMatches:confirmed,mentionVerification:'unverified: native mention metadata not read back'};
 }
 async function deliver(body,deliveryKey=null){
  if(body.confirmed!==true)throw Object.assign(Error('Explicit confirmation required; preview before posting.'),{status:400});
  const p=await plan(body);if(p.mentionIds.length)throw Object.assign(Error('Native mention delivery unqualified; use labelled text tags'),{status:409});if(deliveryKey)p.key=deliveryKey;const ledger=await readJson(ledgerFile,{});const entry=ledger[p.key]||{key:p.key,at:new Date().toISOString(),results:[]};
  // One resident process + local pre-send markers (NOT redeploy-durable). Ambiguous network failures never auto-repost.
  for(const t of p.planned){
   let row=entry.results.find(x=>x.itemId===t.itemId);
   if(row?.state==='read-back confirmed')continue;
   if(row&&!row.updateId)continue;
   if(!row){const verify=await mondayGraphql('query($ids:[ID!]!){items(ids:$ids){id board{id}}}',{ids:[t.itemId]});if(!verify.items?.some(x=>String(x.id)===t.itemId&&String(x.board?.id)===t.boardId))throw Object.assign(Error('Live destination board/item verification failed; no post attempted.'),{status:409});row={boardId:t.boardId,itemId:t.itemId,name:t.name,state:'posting'};entry.results.push(row);ledger[p.key]=entry;await save(ledgerFile,ledger);
    try{
     // Native mention delivery is not claimed until remote verification is supported. IDs remain in custody.
     if(p.mentionIds.length)throw Error('Native mention posting is not qualified yet. Remove selected IDs or use explicitly labelled text tags.');
     const data=await mondayGraphql('mutation($item:ID!,$body:String!){create_update(item_id:$item,body:$body){id}}',{item:t.itemId,body:html(t.text).replace(/\n/g,'<br>')});
     row.updateId=data.create_update?.id;if(!row.updateId)throw Error('No update ID returned');row.state='posted';if(durable?.targetUpdate)await durable.targetUpdate(p.key,{boardId:t.boardId,itemId:t.itemId,status:'posted',updateId:row.updateId,result:{posted:true}});await save(ledgerFile,ledger);
    }catch{row.state='failed/uncertain';row.error='Delivery not confirmed. Inspect Monday before retry; no automatic duplicate attempt.';await save(ledgerFile,ledger);continue;}
   }
   try{row.readback=await verifyUpdate(row.updateId,t,t.text);row.state=row.readback.confirmed?'read-back confirmed':'posted/read-back failed';if(durable?.targetUpdate)await durable.targetUpdate(p.key,{boardId:t.boardId,itemId:t.itemId,status:row.state,updateId:row.updateId,result:row.readback,error:row.readback.confirmed?null:'Readback mismatch'});}catch{row.state='posted/read-back failed';row.error='Readback unavailable; retry verifies existing update ID only.';}
   await save(ledgerFile,ledger);
  }
  if(durable?.requestUpdate)await durable.requestUpdate(p.key,entry.results.every(x=>x.state==='read-back confirmed')?'read-back confirmed':'incomplete',entry);
  const audit=await readJson(files.audit,[]);audit.unshift({event:'workflow_delivery',at:new Date().toISOString(),key:p.key,idempotencyKey:p.key,recipient:body.recipient||(await context(body.itemId)).item.owner||'Not specified',message:body.text||body.message,timestamp:new Date().toISOString(),status:entry.results.every(x=>x.state==='read-back confirmed')?'Read-back confirmed':'Incomplete',targets:entry.results.map(({boardId,itemId,updateId,state})=>({boardId,itemId,updateId,state}))});await save(files.audit,audit);
  const passed=entry.results.length===p.planned.length&&entry.results.every(x=>x.state==='read-back confirmed');
  return {ok:true,status:passed?'Read-back confirmed':entry.results.some(x=>x.updateId)?'Partial failure':'Failed',readbackConfirmed:passed,posted:entry.results,key:p.key};
 }
 async function enqueue(body){const p=await plan(body);const entry={...p,id:p.key,status:'queued',createdAt:new Date().toISOString(),message:body.text||body.message,recipient:body.recipient||(await context(body.itemId)).item.owner||'Not specified',itemName:(await context(body.itemId)).item.name}; if(durable) await durable.enqueue(entry); else {const q=await readJson(files.queue,[]);if(!q.some(x=>x.key===p.key)){q.unshift(entry);await save(files.queue,q);}} await (durable?durable.audit({event:'workflow_queued',requestId:entry.id,idempotencyKey:p.key,recipient:entry.recipient,message:entry.message,timestamp:entry.createdAt,status:'queued',targets:p.planned.map(({boardId,itemId})=>({boardId,itemId}))}):Promise.resolve()); return {ok:true,entry};}
 const tw=tuesdayWorkflow({allItems,files,readJson,save,deliver,plan});
 return async function handle(req,res,url){
 const p=url.pathname,m=req.method;let result;
 if(m==='POST'&&p==='/api/webhooks/monday/receive'){const b=await parseBody(req);result=b.challenge?{challenge:b.challenge}:{ok:true,mirrorPosted:false,reason:'Inbound automatic mirroring is not qualified. Use the reviewed dual-comment workflow; no automatic replay.'};}
 else if(m==='GET'&&p==='/api/webhooks/monday/status')result={ok:true,available:false,inboundWebhookMirror:false,appOriginatedMirror:true,reason:'Inbound mirror paused: authenticated delivery, deduplication and readback are not qualified. This prevents duplicate echoes of app-originated dual posts.',required:['Authenticated webhook events','Event deduplication','Remote readback acceptance'],canDoNow:['Reviewed app-originated verified-bridge dry run and confirmed comment posting']};
 else if(m==='GET'&&p==='/api/build'){
  const items=await allItems(),live=await readJson(files.live,{});let connected=false;if(await mondayToken())try{await mondayGraphql('query{me{id}}');connected=true;}catch{}
  result={ok:true,version:release,commit:sha,workingTreeDirty:dirty,environment:process.env.RENDER?'render':process.env.NODE_ENV==='production'?'unknown':'local',deploymentTime:process.env.RENDER_DEPLOY_TIMESTAMP||null,mondayConnected:connected,lastSync:live.syncedAt||null,liveRecords:(live.records||[]).length,syncComplete:live.complete===true,byBoard:items.reduce((a,x)=>(a[x.sourceBoardId]=(a[x.sourceBoardId]||0)+1,a),{}),dataMode:live.complete?'Monday sync':'packaged snapshot',counts:items.reduce((a,x)=>(a[x.source||'unknown']=(a[x.source||'unknown']||0)+1,a),{}),automaticTuesday:false,storage:status()};
 }else if(m==='GET'&&p==='/api/storage/status')result={ok:true,...status()};
 else if(m==='GET'&&p==='/api/queue'){result={ok:true,queue:durable?await durable.queue():await readJson(files.queue,[])};}
 else if(m==='GET'&&p==='/api/audit'){result={ok:true,audit:durable?await durable.auditRows():await readJson(files.audit,[])};}
 else if(m==='GET'&&p==='/api/bridge'){
 const items=await allItems(),links=(await readJson(files.bridge,{links:[]})).links;
 const rows=items.map(item=>{const b=bridgeFor(item,items,links);return {...b,name:item.name,itemId:item.itemId,owner:item.owner,needsReview:!b.verified};});
 result={ok:true,rows,counts:{total:rows.length,linked:rows.filter(r=>r.verified).length,review:rows.filter(r=>!r.verified).length}};
 }else if(m==='GET'&&p==='/api/workflow/items'){
 const items=await allItems(),links=(await readJson(files.bridge,{links:[]})).links;result={ok:true,items:items.map(item=>({...item,bridge:bridgeFor(item,items,links),readiness:readiness(item)}))};
 }else if(m==='GET'&&p.startsWith('/api/item/'))result={ok:true,...await context(decodeURIComponent(p.split('/').pop()))};
 else if(m==='GET'&&p==='/api/people'){
 const cached=await readJson(files.users,{users:[]});let users=cached.users||[],live=false;
 if(url.searchParams.get('refresh')==='1'){try{const d=await mondayGraphql('query{users(limit:100){id name enabled}}');users=d.users||[];await save(files.users,{users,syncedAt:new Date().toISOString()});live=true;}catch{result={ok:true,users:users.map(({id,name,enabled})=>({id,name,enabled})),source:'cache',warning:'Live lookup unavailable; native mentions unverified',nativeMentionVerified:false};}}
 if(!result)result={ok:true,users:users.filter(u=>u.enabled!==false).map(({id,name,enabled})=>({id,name,enabled})),source:live?'Monday API':'cache',nativeMentionVerified:false,limit:100};
 }else if(m==='POST'&&['/api/monday/dual-comment','/api/monday/comment'].includes(p)){
 const b=await parseBody(req);if(b.dryRun)result={ok:true,dryRun:true,status:'Dry run passed',...await plan(b)};else result=await locked(()=>deliver(b));
 }else if(m==='POST'&&p==='/api/queue'){result=await locked(()=>parseBody(req).then(enqueue));}
 else if(m==='POST'&&/^\/api\/queue\/[^/]+\/push$/.test(p)){
 const b=await parseBody(req);result=await locked(async()=>{const q=await readJson(files.queue,[]),e=q.find(x=>x.id===p.split('/')[3]);if(!e||!e.key)throw Object.assign(Error('Legacy queue entry must be previewed and requeued with exact targets.'),{status:409});if(e.cycleKey){const st=await readJson(tw.storeFile,{});if(['Marked sent externally','Read-back confirmed'].includes(st[e.cycleKey]?.status))return {ok:true,status:'Duplicate blocked',posted:[]};}const out=await deliver({...e,text:e.message,confirmed:b.confirmed},e.cycleKey||null);if(e.cycleKey){const st=await readJson(tw.storeFile,{});st[e.cycleKey]={status:out.readbackConfirmed?'Read-back confirmed':'Failed/uncertain',result:out};await save(tw.storeFile,st);}e.status=out.status;e.delivery=out;await save(files.queue,q);return out;});
 }else if(m==='GET'&&p==='/api/tuesday/prepare'){result=await tw.preview(Object.fromEntries(url.searchParams));result.storage=status();await locked(()=>tw.audit('tuesday_preview',{cycle:result.cycle,sent:0}));}
 else if(m==='POST'&&p==='/api/tuesday/action'){const b=await parseBody(req);result=await locked(()=>tw.action(b));}
 else if(m==='POST'&&p==='/api/tuesday/queue'){const b=await parseBody(req);result=await locked(()=>tw.action({...b,action:'queue'}));
 }else if(p==='/api/reminders/config')result={ok:true,config:{enabled:false,mode:'preview/manual',reason:'Automatic sending disabled pending live acceptance'}};
 else if(p==='/api/reminders/tuesday/run')result={...await tw.preview(),dryRun:true,posted:0,queued:0,warning:'Automatic/manual bulk send disabled. Preview, queue, then explicitly approve each queued post.'};
 else if(m==='POST'&&p==='/api/bridge/link'){
 const b=await parseBody(req);result=await locked(async()=>{const items=await allItems();if(!items.some(x=>String(x.itemId)===String(b.d2dItemId)&&String(x.sourceBoardId)==='18391791372')||!items.some(x=>String(x.itemId)===String(b.trackerItemId)&&String(x.sourceBoardId)==='5077578194'))throw Object.assign(Error('Both exact source records must exist on the expected boards.'),{status:400});const store=await readJson(files.bridge,{links:[]});store.links=store.links.filter(x=>String(x.d2dItemId)!==String(b.d2dItemId)&&String(x.trackerItemId)!==String(b.trackerItemId));store.links.push({d2dItemId:String(b.d2dItemId),trackerItemId:String(b.trackerItemId),createdAt:new Date().toISOString(),note:b.note||'Explicit manual confirmation'});await save(files.bridge,store);return {ok:true};});
 }else return false;
 send(res,200,result);return true;
 };
}
