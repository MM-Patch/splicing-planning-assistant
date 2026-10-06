const dayMs=86400000;
export const unassigned=value=>!String(value||'').trim()||/^(unassigned|tbd|owner needed)$/i.test(String(value).trim());
export function filterTuesday(rows,filters={},now=new Date()){
 // Operational dates are date-only; use the PMO's Chicago calendar, not browser timezone.
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Chicago',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
 const start=Date.parse(today+'T00:00:00Z'),day=new Date(start).getUTCDay();
 const weekStart=start-((day+6)%7)*dayMs,weekEnd=weekStart+7*dayMs;
 const on=k=>filters[k]===true||filters[k]==='1';
 return rows.filter(r=>{
  if(filters.window==='week'||filters.window==='14'){
   const low=filters.window==='week'?weekStart:start,high=filters.window==='week'?weekEnd:start+14*dayMs;
   if(![r.rfs,r.installDate].some(value=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(value||''))return false;const t=Date.parse(value+'T00:00:00Z');return t>=low&&t<high;}))return false;
  }
  if(on('missingUpdate')&&r.lastUpdateAgeDays!==null&&r.lastUpdateAgeDays<7)return false;
  if(on('ownerNeeded')&&!unassigned(r.pm))return false;
  if(on('blocked')&&!r.blocked)return false;
  if(on('readinessBlocker')&&!r.readinessBlocker)return false;
  if(on('dateChanged')&&!(r.dateChanges||[]).some(c=>Date.parse(c.observedAt)>=now.getTime()-14*dayMs))return false;
  if(filters.person&&!`${r.pm||''} ${r.resource||''}`.toLowerCase().includes(filters.person.toLowerCase()))return false;
  if(filters.source&&String(r.sourceBoardId)!==String(filters.source))return false;
  if(filters.bridge==='verified'&&r.bridgeStatus!=='verified')return false;
  if(filters.bridge==='primary'&&r.bridgeStatus==='verified')return false;
  return true;
 });
}
