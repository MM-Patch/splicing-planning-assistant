import test from 'node:test';import assert from 'node:assert/strict';import {filterTuesday} from '../lib/tuesday-filters.mjs';import {trackDateChanges} from '../lib/live-sync.mjs';
const now=new Date('2026-10-06T02:00:00Z'); // Monday evening Chicago
const base={pm:'PM A',resource:'Crew B',sourceBoardId:'18391791372',bridgeStatus:'verified',rfs:'2026-10-05',lastUpdateAgeDays:9,blocked:true,readinessBlocker:true,dateChanges:[{observedAt:'2026-10-05T00:00:00Z'}]};
test('Tuesday windows use Chicago Monday–Sunday and today plus thirteen days; both date fields work',()=>{
 const rows=['2026-10-04','2026-10-05','2026-10-11','2026-10-12','2026-10-18','2026-10-19',''].map(rfs=>({...base,rfs}));
 assert.deepEqual(filterTuesday(rows,{window:'week'},now).map(r=>r.rfs),['2026-10-05','2026-10-11']);
 assert.deepEqual(filterTuesday(rows,{window:'14'},now).map(r=>r.rfs),['2026-10-05','2026-10-11','2026-10-12','2026-10-18']);
 assert.equal(filterTuesday([{...base,rfs:'',installDate:'2026-10-07'}],{window:'14'},now).length,1);
});
test('each Tuesday filter and conjunction narrow exact rows without truncation',()=>{
 const reject={...base,pm:'Unassigned',resource:'Other',sourceBoardId:'5077578194',bridgeStatus:'primary-only',lastUpdateAgeDays:1,blocked:false,readinessBlocker:false,dateChanges:[]};
 for(const filters of [{missingUpdate:'1'},{blocked:'1'},{readinessBlocker:'1'},{dateChanged:'1'},{person:'crew b'},{source:'18391791372'},{bridge:'verified'}])assert.deepEqual(filterTuesday([base,reject],filters,now),[base]);
 assert.deepEqual(filterTuesday([base,reject],{ownerNeeded:'1',bridge:'primary'},now),[reject]);
 assert.equal(filterTuesday([base],{person:'other',blocked:'1'},now).length,0);
 assert.equal(filterTuesday(Array(75).fill(base),{},now).length,75);
 assert.equal(filterTuesday([{...base,lastUpdateAgeDays:null}],{missingUpdate:'1'},now).length,1);
});
test('date-change evidence requires prior complete same-board/item observation and survives subsequent sync',()=>{
 const initial={complete:true,syncedAt:'2026-10-05T00:00:00Z',records:[{itemId:'1',sourceBoardId:'2',rfs:'2026-10-08',installDate:''}]};
 trackDateChanges(initial,{});assert.equal(initial.records[0].dateChangeBaseline,null);assert.deepEqual(initial.records[0].dateChanges,[]);
 const next={complete:true,syncedAt:'2026-10-06T00:00:00Z',records:[{itemId:'1',sourceBoardId:'2',rfs:'2026-10-09',installDate:'2026-10-11'}]};trackDateChanges(next,initial);assert.equal(next.records[0].dateChanges.length,2);assert.equal(next.records[0].dateChanges[0].from,'2026-10-08');
 const same=structuredClone(next);same.syncedAt='2026-10-07T00:00:00Z';trackDateChanges(same,next);assert.equal(same.records[0].dateChanges.length,2);
});
