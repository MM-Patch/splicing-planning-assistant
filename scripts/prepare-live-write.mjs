// Controlled primary-only live-write harness. Default is dry-run; this file has
// never been run with execution enabled in R22. Exact payload confirmation is
// required in two independent environment variables and a matching manifest.
import {readFile,writeFile} from 'node:fs/promises';import crypto from 'node:crypto';
const [itemId,text,...rest]=process.argv.slice(2),execute=rest.includes('--execute');
if(!/^\d+$/.test(itemId||'')||!text?.trim()||rest.filter(x=>x!=='--execute').length)throw Error('Usage: node scripts/prepare-live-write.mjs EXACT_ITEM_ID "EXACT_APPROVED_COMMENT" [--execute]');
const base=process.env.APP_URL||'https://splicing-planning-assistant.onrender.com';const get=async(path,opts)=>{const r=await fetch(base+path,opts);const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||`HTTP ${r.status}`);return j};
const detail=await get('/api/item/'+itemId);if(detail.item.observationSource!=='Monday sync')throw Error('Complete live observation required');
const plan=await get('/api/monday/dual-comment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemId,text,destinations:'primary',mentionIds:[],dryRun:true})});
const payload={boardId:String(plan.planned[0].boardId),itemId:String(plan.planned[0].itemId),text:String(text),key:plan.key};const digest=crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');const manifest={mode:'DRY-RUN',createdAt:new Date().toISOString(),base,exactComment:text,targets:[{boardId:payload.boardId,itemId:payload.itemId}],idempotencyKey:plan.key,payloadDigest:digest,sourceObservedAt:detail.item.observedAt,approvedBy:null,liveWritesExecuted:0,teamsSends:0};
await writeFile('test-results/live-write-preparation.json',JSON.stringify(manifest,null,2));
if(!execute){console.log(JSON.stringify(manifest,null,2));process.exit(0)}
if(process.env.APPROVE_LIVE_WRITE!=='true')throw Error('Execution requires APPROVE_LIVE_WRITE=true');if(process.env.LIVE_WRITE_CONFIRMATION!==digest)throw Error('LIVE_WRITE_CONFIRMATION must equal manifest payloadDigest');if(process.env.APPROVED_BOARD_ID!==payload.boardId||process.env.APPROVED_ITEM_ID!==payload.itemId||process.env.APPROVED_COMMENT!==text)throw Error('Exact approved board/item/comment env values are required');
const out=await get('/api/monday/dual-comment',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({itemId,text,destinations:'primary',mentionIds:[],confirmed:true})});if(!out.readbackConfirmed)throw Error('Live post did not pass readback confirmation');
const verify=await get('/api/item/'+itemId);manifest.mode='EXECUTED_PRIMARY_ONLY';manifest.approvedBy=process.env.APPROVED_BY||'explicit environment approval';manifest.liveWritesExecuted=1;manifest.readback=out.posted;manifest.readbackItem=verify.item.itemId;await writeFile('test-results/live-write-executed.json',JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
