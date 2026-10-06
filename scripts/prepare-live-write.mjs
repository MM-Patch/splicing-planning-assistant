// PREPARATION ONLY. This harness has no execution/mutation branch.
// After Patch approves an exact manifest, a separate reviewed change can enable
// the sacrificial post, exact readback and readback-only retry acceptance.
import {writeFile} from 'node:fs/promises';
const [itemId,text,...extra]=process.argv.slice(2);
if(!/^\d+$/.test(itemId||'')||!text?.trim()||extra.length)throw Error('Usage: node scripts/prepare-live-write.mjs EXACT_ITEM_ID "EXACT_COMMENT". Preparation only; no --execute support.');
const base=process.env.APP_URL||'https://splicing-planning-assistant.onrender.com';
const call=async(path,body)=>{const r=await fetch(base+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...body,dryRun:true})}:{});const j=await r.json();if(!r.ok||!j.ok)throw Error(j.error||'Preview failed');return j;};
const detail=await call('/api/item/'+itemId);if(detail.item.observationSource!=='Monday sync')throw Error('Complete live observation required; snapshot is not approval evidence');
const plan=await call('/api/monday/dual-comment',{itemId,text,destinations:'primary',mentionIds:[]});
const manifest={mode:'PREPARATION ONLY — NOT APPROVED',createdAt:new Date().toISOString(),base,approvedBy:null,approvedAt:null,exactComment:text,targets:plan.planned.map(({boardId,itemId,projectName})=>({boardId,itemId,projectName})),idempotencyKey:plan.key,sourceObservedAt:detail.item.observedAt,nextAcceptance:['Patch approves exact item IDs and exact comment in conversation','Post primary-only once; save update ID before readback','Read back update ID, exact normalized content, item ID and board ID','Retry same request; assert same update ID and no extra mutation','Only later: separately approved verified linked-pair dual-post'],linkedPairEligible:detail.bridge.verified,liveWritesExecuted:0,teamsSends:0};
await writeFile('test-results/live-write-preparation.json',JSON.stringify(manifest,null,2));console.log(JSON.stringify(manifest,null,2));
