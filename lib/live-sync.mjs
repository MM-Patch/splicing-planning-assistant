// Source reads only. No mutations; publish only a complete requested-board batch.
export const BOARD_IDS=['18391791372','5077578194'];
const fields=`id name updated_at group { title } column_values { id text value column { title type } ... on MirrorValue { display_value } ... on BoardRelationValue { linked_item_ids display_value } } updates(limit:5) { id text_body created_at creator { id name } }`;
export function normalizeItem(b,it,observedAt){
 const cvs=it.column_values||[], cols=Object.fromEntries(cvs.map(c=>[c.column?.title||c.id,c.display_value||c.text||'']));
 const pick=(...keys)=>keys.map(k=>cols[k]).find(v=>v!==undefined&&v!==null&&String(v).trim())||'';
 const rawStatus=pick('Project Status','Status','Fiber Zone Status','Fiber Status');
 const rfs=pick('Fiber Team RFS','RFS Date','RFS','Initial RFS Date');
 return {id:'monday:'+it.id,itemId:String(it.id),sourceBoardId:String(b.id),sourceBoard:b.name,source:b.name,sourceUrl:`https://visionary-broadband.monday.com/boards/${b.id}/pulses/${it.id}`,name:it.name,city:pick('City','Market'),owner:pick('PM','Owner','Project Manager','Construction Manager')||'Unassigned',assignedResource:pick('Assigned Splicer','Splicer','Assigned Resource','Resource')||'Unassigned',type:pick('Order Type','Type','Project Type')||'Unspecified',zoneType:pick('Zone Type'),fiberStatus:pick('Fiber Zone Status','Fiber Status'),rawStatus,status:/^(closed|cancelled|canceled|complete|completed)$/i.test(rawStatus)?'Complete':/block|hold/i.test(rawStatus)?'Blocked':/^ready|^rfs$/i.test(rawStatus)?'Ready':'Conditional',score:'',blocker:pick('Blocker','Dependency','Materials/access blocker'),action:pick('Next Action','Action'),rfs,installDate:pick('New Zone Install Date','Install Date'),workDate:rfs,priority:pick('Priority'),projectId:pick('Project ID#','Project ID'),updateCount:(it.updates||[]).length,updatesLimitedTo:5,updates:(it.updates||[]).map(u=>({id:u.id,author:u.creator?.name||'',date:u.created_at,text:u.text_body||''})),rawColumns:cols,sourceRelations:cvs.filter(c=>c.linked_item_ids?.length).map(c=>({columnId:c.id,columnTitle:c.column?.title,linkedItemIds:c.linked_item_ids.map(String)})),columnEvidence:cvs.filter(c=>c.value||c.text||c.display_value).map(c=>({id:c.id,title:c.column?.title,type:c.column?.type,text:c.display_value||c.text||''})),updatedAt:it.updated_at,observationSource:'Monday sync',observedAt};
}
export async function readBoards(graphql,boardIds=BOARD_IDS,{pageSize=50,onProgress=()=>{}}={}){
 const ids=[...new Set(boardIds.map(String))];if(!ids.length||ids.some(id=>!BOARD_IDS.includes(id)))throw Error('Only configured D2D and Project Tracker boards are allowed.');
 const startedAt=new Date().toISOString(),records=[],boards=[];
 for(const id of ids){
  const d=await graphql(`query($ids:[ID!]!,$limit:Int!){boards(ids:$ids){id name items_page(limit:$limit){cursor items{${fields}}}}}`,{ids:[id],limit:pageSize});
  const b=d.boards?.find(x=>String(x.id)===id);if(!b)throw Error('Requested board unavailable: '+id);
  let page=b.items_page,pages=0,count=0;const seen=new Set();
  do{if(!page||!Array.isArray(page.items))throw Error('Missing items page for '+id);pages++;for(const it of page.items){if(seen.has(String(it.id)))throw Error('Duplicate item in pagination: '+it.id);seen.add(String(it.id));records.push(normalizeItem(b,it,startedAt));count++;}onProgress({boardId:id,pages,records:count,totalRecords:records.length});if(!page.cursor)break;if(pages>=200)throw Error('Pagination limit reached; not publishing partial data');const next=await graphql(`query($cursor:String!,$limit:Int!){next_items_page(cursor:$cursor,limit:$limit){cursor items{${fields}}}}`,{cursor:page.cursor,limit:pageSize});page=next.next_items_page;}while(true);
  boards.push({id,name:b.name,records:count,pages,complete:true});
 }
 await enrichIdentity(graphql,records,startedAt,onProgress);
 return {syncedAt:new Date().toISOString(),startedAt,complete:true,scope:'active board items; latest five updates per item; subitems not included',boards,records};
}
export function activeRecords(seed,live){
 if(live?.complete&&live.syncedAt)return (live.records||[]).map(r=>({...r,observationSource:'Monday sync',observedAt:live.syncedAt}));
 return (seed?.records||[]).map(r=>({...r,observationSource:'packaged snapshot',observedAt:null}));
}

// Follow only explicit D2D relation edges, not name searches. Auxiliary observations
// are evidence, not extra projects in the two-board operating dataset.
export async function enrichIdentity(graphql,records,observedAt,onProgress=()=>{}){
 const known=new Set(records.map(x=>x.itemId));
 const ids=[...new Set(records.filter(x=>x.sourceBoardId===BOARD_IDS[0]).flatMap(x=>(x.sourceRelations||[]).flatMap(r=>r.linkedItemIds)))].filter(id=>!known.has(id));
 const evidence=new Map();
 for(let n=0;n<ids.length;n+=50){
 const data=await graphql('query($ids:[ID!]!){items(ids:$ids){id name board{id name} column_values{id text column{title}}}}',{ids:ids.slice(n,n+50)});
 for(const it of data.items||[]){const c=it.column_values?.find(c=>['Project ID#','Project ID'].includes(c.column?.title));if(c?.text?.trim())evidence.set(String(it.id),{itemId:String(it.id),boardId:String(it.board.id),boardName:it.board.name,name:it.name,projectId:c.text.trim(),columnId:c.id,observedAt});}
 onProgress({phase:'bridge evidence',observations:Math.min(n+50,ids.length),total:ids.length,totalRecords:records.length});
 }
 for(const r of records)r.identityEvidence=(r.sourceRelations||[]).flatMap(rel=>rel.linkedItemIds.filter(id=>evidence.has(id)).map(id=>({...evidence.get(id),relationColumnId:rel.columnId,relationColumnTitle:rel.columnTitle})));
}
