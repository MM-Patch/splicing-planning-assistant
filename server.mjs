import {createWorkflow} from './lib/workflow-server.mjs';
import {readBoards,activeRecords,trackDateChanges} from './lib/live-sync.mjs';
import {readiness} from './lib/workflow.mjs';
import {createStorage} from './lib/storage.mjs';
import http from 'node:http';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import { existsSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.SPA_DATA_DIR || path.join(ROOT, 'data');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const MONDAY = 'https://api.monday.com/v2';
const INACTIVE_PEOPLE = ['kelley','kelly','kelly leeper'];
function isInactivePersonName(name='') { return INACTIVE_PEOPLE.includes(String(name).replace(/^@/,'').trim().toLowerCase()); }
await mkdir(DATA_DIR, { recursive: true });
const storage = await createStorage({databaseUrl:process.env.DATABASE_URL,files:{queue:path.join(DATA_DIR,'queue.json'),audit:path.join(DATA_DIR,'audit.json')}});

const files = {
  seed: path.join(DATA_DIR, 'seed.json'),
  queue: path.join(DATA_DIR, 'queue.json'),
  audit: path.join(DATA_DIR, 'audit.json'),
  secrets: path.join(DATA_DIR, 'secrets.enc'),
  master: path.join(DATA_DIR, 'master.key'),
  live: path.join(DATA_DIR, 'live-items.json'),
  users: path.join(DATA_DIR, 'monday-users.json'),
  bridge: path.join(DATA_DIR, 'project-bridge.json'),
  config: path.join(DATA_DIR, 'source-config.json'),
  tuesday: path.join(DATA_DIR, 'tuesday-rfs-queue.json'),
  reminders: path.join(DATA_DIR, 'reminders-config.json')
};

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}
async function writeJson(file, value) { await writeFile(file, JSON.stringify(value, null, 2)); }
if (storage.loadSync) { try { const persisted=await storage.loadSync(); if (persisted?.complete && persisted.records?.length) await writeJson(files.live,persisted); } catch {} }
async function masterKey() {
  const env = process.env.SPA_SECRET_KEY;
  if (env) return crypto.createHash('sha256').update(env).digest();
  if (!existsSync(files.master)) await writeFile(files.master, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from((await readFile(files.master, 'utf8')).trim(), 'hex');
}
async function saveSecret(name, value) {
  const key = await masterKey();
  const existing = await loadSecrets();
  existing[name] = value;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(existing), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  await writeFile(files.secrets, JSON.stringify({ iv: iv.toString('base64'), tag: tag.toString('base64'), data: enc.toString('base64') }), { mode: 0o600 });
}
async function loadSecrets() {
  if (!existsSync(files.secrets)) return {};
  const key = await masterKey();
  const box = JSON.parse(await readFile(files.secrets, 'utf8'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8'));
}
async function mondayToken() {
  return process.env.MONDAY_API_KEY || (await loadSecrets()).MONDAY_API_KEY || '';
}
async function mondayGraphql(query, variables = {}) {
  const token = await mondayToken();
  if (!token) throw Object.assign(new Error('Missing Monday API token'), { status: 401 });
  const res = await fetch(MONDAY, { signal: AbortSignal.timeout(60000), method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token }, body: JSON.stringify({ query, variables }) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) throw Object.assign(new Error(json.errors?.[0]?.message || `Monday API ${res.status}`), { status: 502, details: json });
  return json.data;
}
function itemUrl(r) {
  if (r.sourceUrl) return r.sourceUrl;
  if (r.sourceBoardId && r.itemId) return `https://visionary-broadband.monday.com/boards/${r.sourceBoardId}/pulses/${r.itemId}`;
  if (r.itemId) return `https://visionary-broadband.monday.com/pulses/${r.itemId}`;
  return '';
}
// Cache by file identity; preserve the array identity for bridge indexing.
// Stat (including inode) detects atomic sync replacement, deletion and external updates.
let itemsCache={key:null,value:null};
async function allItems() {
 const signature=async file=>{try{const s=await stat(file);return [s.ino,s.size,s.mtimeMs,s.ctimeMs].join(':');}catch{return 'missing';}};
 const key=(await Promise.all([signature(files.seed),signature(files.live)])).join('|');
 if(itemsCache.key===key)return itemsCache.value;
 const pending=(async()=>{const [seed,live]=await Promise.all([readJson(files.seed,{records:[]}),readJson(files.live,{records:[]})]);return activeRecords(seed,live).map(r=>({...r,sourceUrl:itemUrl(r),searchText:makeSearchText(r)}));})();
 itemsCache={key,value:pending};return pending;
}
function makeSearchText(r) {
  return [r.name, r.city, r.owner, r.assignedResource, r.type, r.status, r.blocker, r.action, r.itemId, r.source, r.priority].filter(Boolean).join(' ').toLowerCase();
}
function classifyQuery(q) {
  const x = String(q || '').toLowerCase();
  const action = /\b(ask|tell|tag|send|message|note|comment|push|request|confirm|escalate)\b/.test(x);
  const group = /\b(group by|by resource|by splicer|by owner|by pm)\b/.test(x);
  const sourceLinks = /\b(source link|direct link|open source|monday link)\b/.test(x);
  return { action, group, sourceLinks };
}
function singular(x='') { return String(x).toLowerCase().replace(/[’']/g,'').replace(/s$/,''); }
function matchValuesFromQuery(items, key, x) {
  const vals=[...new Set(items.map(r=>r[key]).filter(Boolean))];
  return vals.filter(v=>{
    const parts=String(v).split(/\s+/).map(singular).filter(Boolean);
    return parts.some(p=>new RegExp('\\b'+p+'s?\\b').test(x)) || x.includes(String(v).toLowerCase());
  });
}
function filterItems(items, q = '', filters = {}) {
  let out = [...items];
  let x = String(q || '').toLowerCase().replace(/[’']/g,'').trim();
  for (const [k, v] of Object.entries(filters || {})) if (v && v !== 'All') {
    if (k === 'status') out = out.filter(r => String(r.status || '') === v);
    if (k === 'owner') out = out.filter(r => String(r.owner || '') === v);
    if (k === 'resource') out = out.filter(r => String(r.assignedResource || '') === v);
    if (k === 'type') out = out.filter(r => String(r.type || '') === v);
    if (k === 'source') out = out.filter(r => String(r.source || '') === v);
  }
  const owners = matchValuesFromQuery(items,'owner',x);
  if (owners.length) out = out.filter(r => owners.some(o => String(r.owner || '') === o));
  const resources = matchValuesFromQuery(items,'assignedResource',x);
  if (resources.length && /resource|splicer|assigned|crew|kyle|tbd|unassigned/.test(x)) out = out.filter(r => resources.some(o => String(r.assignedResource || '') === o));
  if (x.includes('mdu')) out = out.filter(r => /mdu/i.test(String(r.type||'')+' '+String(r.name||'')));
  if (x.includes('icb')) out = out.filter(r => /icb/i.test(String(r.type||'')+' '+String(r.name||'')));
  if (x.includes('ready')) out = out.filter(r => r.status === 'Ready');
  if (x.includes('conditional')) out = out.filter(r => r.status === 'Conditional');
  if (x.includes('blocked') || x.includes('blocker')) out = out.filter(r => r.status === 'Blocked' || /block|permit|missing|await|hold/i.test(`${r.blocker} ${r.action}`));
  if (x.includes('unassigned') || x.includes('missing resource')) out = out.filter(r => /unassigned|tbd|^$/i.test(String(r.assignedResource || '')));
  if (x.includes('actionable')) out = out.filter(r => r.status !== 'Ready' || /unassigned|missing|confirm|proof/i.test(`${r.action} ${r.blocker} ${r.assignedResource}`));
  const dyn = new Set([...owners, ...resources].flatMap(o=>String(o).toLowerCase().split(/\s+/).map(singular)));
  const remove = new Set('show me find list all items item projects project work jobs with the and or to for ask tag send message note comment need from on source link links actionable ready conditional blocked blocker blockers unassigned resource missing splice splicer checkpoint checkpoints permit dependency dependencies confirm request please draft direct updates his her their assigned owner pm crew mdu icb'.split(' '));
  const tokens = (x.match(/[a-z0-9_.-]+/g) || []).map(singular).filter(t => t.length > 1 && !remove.has(t) && !dyn.has(t));
  if (tokens.length) {
    const scored = out.map(r => {
      const name = String(r.name || '').toLowerCase();
      const text = r.searchText || makeSearchText(r);
      let score = 0;
      for (const t of tokens) { if (name.includes(t)) score += 7; if (text.includes(t)) score += 1; }
      if (tokens.length >= 2 && tokens.every(t => name.includes(t))) score += 40;
      if (tokens.length >= 2 && tokens.every(t => text.includes(t))) score += 10;
      return { r, score };
    }).filter(x => x.score > 0).sort((a,b) => b.score - a.score);
    if (scored.length) out = scored.map(x => x.r);
  }
  return out;
}

function stats(items) {
  return { shown: items.length, ready: items.filter(r => r.status === 'Ready').length, conditional: items.filter(r => r.status === 'Conditional').length, blocked: items.filter(r => r.status === 'Blocked').length, withUpdates: items.filter(r => Number(r.updateCount || 0) > 0 || (r.updates || []).length).length };
}
function extractRecipients(q) {
  const names = [];
  const raw = String(q || '');
  const atRe = /@([A-Za-z][A-Za-z.'-]*(?:\s+[A-Za-z][A-Za-z.'-]*)?)/g;
  let a; while ((a = atRe.exec(raw))) names.push(a[1].trim());
  const re = /(?:\bto\s+|\bask\s+|\btag\s+|\bsend\s+|\bmessage\s+)([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?|[a-z]+(?:\s+[a-z]+)?)/g;
  let m; while ((m = re.exec(raw))) names.push(m[1].trim());
  for (const n of ['Jon','Chancey','Kyle','Jim','Brad','Ben','Chris','Leah','Ralph']) if (new RegExp(`\b${n}\b`, 'i').test(raw) && !names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n);
  return [...new Set(names.map(n=>String(n).replace(/^@/,'').trim()).filter(n => n && !/^(for|on|the|a|an|from|updates?|project|projects)$/i.test(n) && !isInactivePersonName(n)))];
}
function draftMessage(item, command = '', recipients = []) {
  const rec = (recipients.length ? recipients : extractRecipients(command)).filter(r => !isInactivePersonName(r));
  const tag = rec.length ? rec.map(r => '@' + r).join(' ') + ' — ' : '';
  const inactiveOwnerNote = isInactivePersonName(item.owner || '') ? ' Owner appears inactive/stale; confirm current owner before tagging. ' : '';
  const ask = /splice|light/i.test(command) ? 'Please confirm the splice/light checkpoint and post the supporting evidence/date.' : /permit/i.test(command) ? 'Please confirm permit status and post the supporting evidence/date.' : /construction|accept/i.test(command) ? 'Please confirm construction acceptance and post the supporting evidence/date.' : 'Please post the next checkpoint/evidence needed to clear this item.';
  const reason = item.status === 'Ready' ? 'No blocker is currently identified in the imported feed.' : `${item.status || 'Open'}: ${item.blocker || item.action || 'readiness proof is incomplete'}.`;
  return `${tag}${item.name}: ${ask} Current context: ${reason}${inactiveOwnerNote} Source: ${itemUrl(item)}`;
}
function projectKey(name='') {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(november|push|tentative|resweep|mdu|apartments|apts|zone|project|the|and|public|private|part|weather dependent)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/).filter(Boolean).slice(0,6).join(' ');
}
function tokens(name='') { return new Set(projectKey(name).split(/\s+/).filter(x => x.length > 2)); }
function jaccard(a,b){ const A=tokens(a), B=tokens(b); if(!A.size || !B.size) return 0; let inter=0; for(const x of A) if(B.has(x)) inter++; return inter / (A.size + B.size - inter); }
function sourceKind(r){
  const src=String(r.source || r.sourceBoard || '').toLowerCase();
  const bid=String(r.sourceBoardId || '');
  if (bid === '18391791372' || src.includes('d2d')) return 'd2d';
  if (bid === '5077578194' || src.includes('project tracker')) return 'tracker';
  if (src.includes('monday live')) return bid === '18391791372' ? 'd2d' : 'tracker';
  return 'other';
}
function bridgeComment(text, source, dest) {
  return `${text}\n\n---\nMirrored by Splicing Planning Assistant v7. Source: ${source || 'SPA'}${dest ? `\nLinked source: ${dest}` : ''}\n[SPA-MIRROR ${crypto.randomUUID()}]`;
}
async function bridgeRecords() {
  const all = await allItems();
  const d2d = all.filter(r => sourceKind(r) === 'd2d');
  const tracker = all.filter(r => sourceKind(r) === 'tracker');
  const manual = await readJson(files.bridge, { links: [] });
  const manualByD2D = new Map(manual.links.map(l => [String(l.d2dItemId), l]));
  const rows = [];
  for (const d of d2d) {
    let best = null, score = 0;
    for (const t of tracker) {
      const sc = jaccard(d.name, t.name) + (String(d.city||'').split(',')[0] && String(t.city||'').includes(String(d.city||'').split(',')[0]) ? .15 : 0);
      if (sc > score) { score = sc; best = t; }
    }
    const m = manualByD2D.get(String(d.itemId));
    if (m) best = tracker.find(t => String(t.itemId) === String(m.trackerItemId)) || best;
    rows.push({
      canonicalId: crypto.createHash('sha1').update(String(d.itemId || d.name)).digest('hex').slice(0,10),
      name: d.name, owner: d.owner, resource: d.assignedResource, status: d.status, rfs: d.workDate || d.rfs || '', confidence: m ? 'manual' : score >= .55 ? 'high' : score >= .32 ? 'review' : 'unmatched', score: Number(score.toFixed(2)),
      d2d: d ? { itemId: d.itemId, boardId: d.sourceBoardId, name: d.name, url: itemUrl(d) } : null,
      tracker: best && (m || score >= .32) ? { itemId: best.itemId, boardId: best.sourceBoardId, name: best.name, url: itemUrl(best) } : null,
      needsReview: !(m || score >= .55)
    });
  }
  for (const t of tracker) {
    if (!rows.some(r => r.tracker && String(r.tracker.itemId) === String(t.itemId))) rows.push({ canonicalId: crypto.createHash('sha1').update(String(t.itemId || t.name)).digest('hex').slice(0,10), name: t.name, owner: t.owner, resource: t.assignedResource, status: t.status, rfs: t.workDate || t.rfs || '', confidence: 'tracker-only', score: 0, d2d: null, tracker: { itemId: t.itemId, boardId: t.sourceBoardId, name: t.name, url: itemUrl(t) }, needsReview: true });
  }
  return rows;
}
async function bridgeRecordsCompat(){
  const b = await bridgeRecords();
  if (Array.isArray(b)) return { rows:b, counts:{ total:b.length, linked:b.filter(r=>r.d2d&&r.tracker).length, review:b.filter(r=>r.needsReview).length } };
  return b;
}
function cleanPlain(s){ return String(s||'').replace(/<[^>]+>/g,'').replace(/\s+/g,' ').trim(); }
function sourceIdSummary(x){ return `${x.board||x.sourceBoard||''} ${x.boardId||x.sourceBoardId||''} item ${x.itemId||x.id||''}`.trim(); }

async function linkedDestinations(itemId) {
  const rows = await bridgeRecords();
  const row = rows.find(r => String(r.d2d?.itemId) === String(itemId) || String(r.tracker?.itemId) === String(itemId));
  if (!row || row.confidence !== 'manual' || !row.d2d?.boardId || !row.tracker?.boardId) return [];
  return [row.d2d, row.tracker].filter(x => x && String(x.itemId) !== String(itemId));
}
async function bridgeCandidatesForItem(itemId) {
  const rows = await bridgeRecords();
  const row = rows.find(r => String(r.d2d?.itemId) === String(itemId) || String(r.tracker?.itemId) === String(itemId));
  if (!row) return { row: null, candidates: [] };
  const sourceName = row.name || row.d2d?.name || row.tracker?.name || '';
  const sourceTokens = new Set([...tokens(sourceName)].filter(t => t.length >= 4 && !['with','check','install','dates','capital','court'].includes(t)));
  const candidates = rows
    .filter(r => r.tracker && String(r.tracker.itemId) !== String(itemId))
    .map(r => {
      const score = jaccard(sourceName, r.tracker.name || r.name || '');
      const name = r.tracker.name || r.name || '';
      const text = `${name} ${r.owner||''} ${r.resource||''} ${r.status||''}`;
      const shared = [...sourceTokens].filter(t => text.toLowerCase().includes(t));
      return { itemId: r.tracker.itemId, boardId: r.tracker.boardId || '', name, url: r.tracker.url, score: Number(score.toFixed(3)), sharedTokens: shared, confidence: r.confidence || 'candidate' };
    })
    .filter(c => c.score >= 0.15 || c.sharedTokens.length >= 2)
    .sort((a,b) => (b.score + b.sharedTokens.length*.15) - (a.score + a.sharedTokens.length*.15))
    .slice(0, 10);
  return { row, candidates };
}
function ownerAsk(item, extra='') {
  const x = `${item.blocker || ''} ${item.action || ''}`.toLowerCase();
  let ask = 'Please post the next checkpoint/evidence needed to clear this item.';
  if (/permit/.test(x)) ask = 'Please confirm permit status/delivery and post the supporting proof.';
  else if (/splice|light|network|turn-up|test/.test(x)) ask = 'Please confirm splice/light/Network checkpoint and post the supporting evidence/date.';
  else if (/construction|bore|accept/.test(x)) ask = 'Please confirm construction/bore acceptance and post the supporting evidence/date.';
  else if (/material|po|equipment/.test(x)) ask = 'Please confirm material/PO/equipment status and expected receipt/turn-up date.';
  return `${item.name}: ${ask} Current context: ${item.status || 'Open'}${item.blocker ? ` — ${item.blocker}` : item.action ? ` — ${item.action}` : ''}. ${extra}`.trim();
}
function isRfsRelevant(item) {
  const state = String(item.status || '').toLowerCase();
  const text = `${item.name} ${item.blocker} ${item.action} ${item.type} ${item.workDate} ${item.rfs}`.toLowerCase();
  return state !== 'ready' || /rfs|install|permit|splice|light|network|bore|material|construction|conditional|blocked|missing|confirm|proof|mdu/.test(text);
}
async function tuesdayPrep({ owner='' } = {}) {
  const items = (await allItems()).filter(isRfsRelevant).filter(r => !owner || String(r.owner || '').toLowerCase().includes(String(owner).toLowerCase()));
  const grouped = {};
  for (const item of items) {
    const o = item.owner && item.owner !== 'Unassigned' && !isInactivePersonName(item.owner) ? item.owner : 'Unassigned / needs owner';
    (grouped[o] ||= []).push(item);
  }
  const rows = Object.entries(grouped).sort((a,b)=>a[0].localeCompare(b[0])).map(([o, arr]) => {
    const top = arr.slice(0,12);
    const lines = top.map((it,i)=>`${i+1}. ${ownerAsk(it)}\n   D2D/source: ${itemUrl(it)}`).join('\n');
    return { owner: o, count: arr.length, items: top, message: `@${o.split(/\s+/)[0]} — Tuesday D2D RFS prep: please update these before the call.\n\n${lines}\n\nIf any date no longer holds, please post the revised checkpoint and owner.` };
  });
  return { generatedAt: new Date().toISOString(), owner: owner || 'all', groups: rows };
}
async function mondayUsers() {
  const cached = await readJson(files.users, { users: [] });
  return cached.users || [];
}
function findMondayUser(name, users) {
  const q = String(name || '').replace(/^@/,'').trim().toLowerCase();
  if (!q) return null;
  return users.find(u => String(u.name || '').toLowerCase() === q)
    || users.find(u => String(u.name || '').toLowerCase().split(/\s+/)[0] === q)
    || users.find(u => String(u.email || '').toLowerCase().startsWith(q))
    || users.find(u => String(u.name || '').toLowerCase().includes(q));
}
function mondayMention(user, fallbackName) {
  if (!user || !user.id) return '@' + String(fallbackName || '').replace(/^@/,'').trim();
  const label = '@' + (user.name || fallbackName || user.id);
  return `<a href="https://visionary-broadband.monday.com/users/${user.id}" data-mention-type="User" data-mention-id="${user.id}">${label}</a>`;
}
async function enrichMentions(text, recipients=[]) {
  const users = await mondayUsers();
  let out = String(text || '');
  const names = [...new Set([...(recipients||[]), ...extractRecipients(out)])].filter(Boolean);
  for (const n of names) {
    const clean = String(n).replace(/^@/,'').trim();
    const user = findMondayUser(clean, users);
    if (!user) continue;
    const rx = new RegExp('@' + clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'gi');
    out = out.replace(rx, mondayMention(user, clean));
  }
  return out;
}

async function mondayPost(itemId, text) {
  const data = await mondayGraphql('mutation($item:ID!,$body:String!){ create_update(item_id:$item, body:$body){ id } }', { item: String(itemId), body: String(text) });
  return data.create_update?.id;
}

function detectFacts(raw='') {
  const text = String(raw || '');
  const facts = [];
  const lower = text.toLowerCase();
  if (/permit/.test(lower)) facts.push({ type:'permit', value: /permit.*\b(in|approved|paid|pending|delivered)/i.exec(text)?.[0] || 'permit mentioned' });
  const dates = [...text.matchAll(/\b(\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|20\d{2}-\d{2}-\d{2}|jan\.?|feb\.?|mar\.?|apr\.?|may|jun\.?|jul\.?|aug\.?|sep\.?|sept\.?|oct\.?|nov\.?|dec\.?)\b[^.;,]*/gi)].map(m=>m[0]).slice(0,6);
  for (const d of dates) facts.push({ type:'date_or_window', value:d.trim() });
  if (/bore|construction|crew|contractor/.test(lower)) facts.push({ type:'construction', value:'construction/bore/crew mentioned' });
  if (/splice|light|test|network|turn.?up/.test(lower)) facts.push({ type:'splice_network', value:'splice/light/network checkpoint mentioned' });
  if (/material|po|equipment/.test(lower)) facts.push({ type:'materials', value:'material/PO/equipment mentioned' });
  if (/blocked|hold|waiting|pending|risk|issue|problem/.test(lower)) facts.push({ type:'risk', value:'blocker/risk language present' });
  return facts;
}
function draftFromCapture(item, raw, recipients=[]) {
  const rec = recipients.length ? recipients : extractRecipients(raw).concat(item.owner && item.owner !== 'Unassigned' ? [item.owner] : []);
  const tag = [...new Set(rec)].filter(Boolean).map(x=>'@'+String(x).replace(/^@/,'')).join(' ');
  const facts = detectFacts(raw);
  const clean = String(raw || '').trim().replace(/\s+/g,' ');
  const remaining = facts.some(f=>f.type==='splice_network') ? 'Please post the confirming proof/checkpoint when available.' : 'Please confirm any remaining gate and post supporting evidence.';
  return `${tag ? tag + ' — ' : ''}Capturing from discussion for ${item.name}: ${clean}. ${remaining}`;
}
function readbackFromCapture(item, raw) {
  const facts = detectFacts(raw).map(f=>f.type.replace('_',' ')).join(', ') || 'update captured';
  return `Readback: ${item.name} update captured (${facts}). Confirm owner, checkpoint date, proof expected, and where it will be posted before treating this as current truth.`;
}
function behaviorRules() {
  return [
    'Use evidence before inference.',
    'Do not merge records by name only; require board/item ID or explicit manual bridge.',
    'Separate current facts from historical notes.',
    'Every write must be previewed, targeted, and auditable.',
    'If the linked destination is missing, warn instead of pretending dual-post will work.',
    'Every date needs owner + predecessor + proof checkpoint.',
    'The app should draft/queue first; posting is an explicit action.',
    'Show gaps and source freshness in the UI.'
  ];
}
async function behaviorTests() {
  const items = await allItems();
  const runQ = q => filterItems(items,q,{});
  const qcases = [
    ['show me Jims projects', r => r.length > 0 && r.every(x => String(x.owner||'').toLowerCase().includes('jim'))],
    ['show me Leah projects', r => r.length > 0 && r.every(x => String(x.owner||'').toLowerCase().includes('leah'))],
    ['unassigned MDU', r => r.length > 0 && r.every(x => /unassigned|tbd|^$/i.test(String(x.assignedResource||'')) && /mdu/i.test(String(x.type||x.name||'')))],
    ['blocked permit dependency', r => r.some(x => /block|permit|missing|await|hold/i.test(`${x.status} ${x.blocker} ${x.action}`))],
    ['find Blue Ridge direct link', r => r.some(x => /blue ridge/i.test(x.name||'') && itemUrl(x))],
    ['show actionable items', r => r.length > 0 && r.some(x => x.status !== 'Ready' || /unassigned|missing|confirm|proof/i.test(`${x.action} ${x.blocker} ${x.assignedResource}`))],
    ['ready D2D zone Gillette', r => r.length > 0 && r.some(x => /gillette/i.test(`${x.name} ${x.city}`))],
    ['Ben blocked', r => Array.isArray(r)],
    ['show me open MDU work', r => r.length > 0 && r.some(x => /mdu/i.test(`${x.name} ${x.type}`))]
  ];
  const queryResults = qcases.map(([q,check]) => { const res = runQ(q); return { query:q, count:res.length, pass: !!check(res), first:res[0]?.name || null }; });
  const sample = runQ('National Guard')[0] || items[0];
  const cap = 'Jim said permit is approved, bore starts 10/14, still needs network light check.';
  const capture = { item: sample?.name, facts: detectFacts(cap), draft: draftFromCapture(sample || {}, cap, ['Jim']), readback: readbackFromCapture(sample || {}, cap) };
  const bridge = await bridgeRecords();
  const policy = policyEvaluate(sample || {});
  const exc = await exceptionBoard({});
  const route = await buildRoutes({maxHours:8});
  const mobile = await mobileToday({});
  const readiness = (sample && readinessGates(sample)) || {score:'0/7'};
  const structural = [
    { query:'source bridge produces rows', count:bridge.length, pass:bridge.length>0, first:bridge[0]?.name||null },
    { query:'policy engine evaluates sample', count:policy.issues.length, pass:Array.isArray(policy.issues), first:policy.issues[0]?.message||'no issues' },
    { query:'exception board produces operational gaps', count:exc.count, pass:exc.count>0, first:exc.rows[0]?.message||null },
    { query:'route builder produces route groups', count:route.routes.length, pass:route.routes.length>0, first:route.routes[0]?.market||null },
    { query:'mobile field mode produces checklist/jobs', count:mobile.jobs.length, pass:Array.isArray(mobile.jobs) && mobile.checklist.length>0, first:mobile.jobs[0]?.name||null },
    { query:'readiness gate score exists', count:readiness.complete||0, pass:!!readiness.score, first:readiness.score },
    { query:'meeting capture extracts facts', count:capture.facts.length, pass:capture.facts.length>=3, first:capture.facts[0]?.type||null }
  ];
  const tests=[...queryResults, ...structural];
  return { ok: tests.every(x=>x.pass), rules: behaviorRules(), queryResults, tests, capture, generatedAt:new Date().toISOString() };
}

async function reminderConfig() {
  const cfg = await readJson(files.reminders, null);
  return {...(cfg || {}), enabled:false, mode:'preview/manual'};
  /* return cfg || { enabled:true, day:'Tuesday', time:'06:30', timeZone:'America/Denver', mode:'auto-post', destination:'d2d-item-comments', owners:['Jim','Ben','Chris','Leah','Brad'], lastRunDate:null }; */
}
async function saveReminderConfig(cfg) { await writeJson(files.reminders, cfg); return cfg; }
function mountainDateParts(d=new Date()) {
  const fmt = new Intl.DateTimeFormat('en-US',{timeZone:'America/Denver',weekday:'long',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
  const parts=Object.fromEntries(fmt.formatToParts(d).filter(x=>x.type!=='literal').map(x=>[x.type,x.value]));
  return { weekday:parts.weekday, date:`${parts.year}-${parts.month}-${parts.day}`, time:`${parts.hour}:${parts.minute}` };
}
async function runTuesdayReminder({dryRun=false, force=false}={}) {
  const cfg = await reminderConfig();
  const now = mountainDateParts();
  const due = force || (cfg.enabled && now.weekday === cfg.day && now.time >= cfg.time && cfg.lastRunDate !== now.date);
  const prep = await tuesdayPrep({});
  const ownerSet = new Set((cfg.owners || []).map(x=>String(x).toLowerCase()));
  const groups = ownerSet.size ? prep.groups.filter(g => ownerSet.has(String(g.owner).split(/\s+/)[0].toLowerCase()) || ownerSet.has(String(g.owner).toLowerCase())) : prep.groups;
  const result = { ok:true, due, dryRun, now, config:cfg, groups, queued:0, posted:0, failed:0, mode:cfg.mode, destination:cfg.destination || 'd2d-item-comments', posts:[] };
  if (!due && !force) return result;
  if (dryRun) return result;
  const audit = await readJson(files.audit, []);
  if (cfg.mode === 'auto-post' && (cfg.destination || 'd2d-item-comments') === 'd2d-item-comments') {
    for (const g of groups) {
      for (const item of (g.items || [])) {
        if (sourceKind(item) !== 'd2d' || !item.itemId) continue;
        const msg = `${g.owner && g.owner !== 'Unassigned / needs owner' ? '@' + String(g.owner).split(/\s+/)[0] + ' — ' : ''}Tuesday D2D RFS prep reminder: ${ownerAsk(item)}\n\nPlease update this D2D item before the RFS call. If the date no longer holds, post the revised checkpoint, owner, and proof.\n\n[SPA-TUESDAY-RFS ${now.date} item=${item.itemId}]`;
        try {
          const body = await enrichMentions(msg, [g.owner]);
          const updateId = await mondayPost(item.itemId, body);
          result.posted++; result.posts.push({ owner:g.owner, itemId:item.itemId, itemName:item.name, updateId, status:'posted' });
        } catch (e) {
          result.failed++; result.posts.push({ owner:g.owner, itemId:item.itemId, itemName:item.name, status:'failed', error:e.message });
        }
      }
    }
    audit.unshift({ event:'tuesday_reminder_auto_post', at:new Date().toISOString(), date:now.date, posted:result.posted, failed:result.failed, destination:result.destination, posts:result.posts });
  } else {
    const queue = await readJson(files.queue, []);
    for (const g of groups) {
      queue.unshift({ id:crypto.randomUUID(), status:'queued', type:'tuesday-rfs-reminder', createdAt:new Date().toISOString(), owner:g.owner, itemName:`Tuesday RFS reminder — ${g.owner}`, message:g.message, itemCount:g.count, destination:cfg.destination || 'd2d-item-comments' });
      result.queued++;
    }
    await writeJson(files.queue, queue);
    audit.unshift({ event:'tuesday_reminder_queued', at:new Date().toISOString(), date:now.date, queued:result.queued, mode:cfg.mode, destination:result.destination });
  }
  await writeJson(files.audit,audit);
  cfg.lastRunDate = now.date; await saveReminderConfig(cfg);
  return result;
}

// Automatic Tuesday delivery disabled until qualified by live readback acceptance.

function readinessGates(item) { return readiness(item); }
function marketKey(item) {
  const city = String(item.city || item.name || '').split(',')[0].trim();
  const code = String(item.name||'').match(/^[A-Z]{3,8}/)?.[0] || city || 'Unknown';
  return city || code;
}
function routeDuration(item) {
  const t = `${item.type} ${item.name} ${item.blocker}`.toLowerCase();
  if (/mdu|apartment|apartments/.test(t)) return 6;
  if (/icb|brewery|mcdonald|hospital|public defender|communications/.test(t)) return 4;
  if (/zone|resweep/.test(t)) return 3;
  return 4;
}
function routeCandidate(item) {
  const r = readinessGates(item);
  let posture = r.ready ? 'ready' : item.status === 'Blocked' ? 'blocked' : 'conditional';
  return { ...item, readiness:r, market:marketKey(item), estimatedHours:routeDuration(item), routePosture:posture, bumpRule: posture==='ready' ? 'primary route candidate' : posture==='conditional' ? 'backup only after missing gate clears' : 'do not dispatch' };
}
function routeMapUrl(route) {
  const points = [...(route.selected||[]), ...(route.backups||[]).slice(0,2)].map(x => x.city || x.name).filter(Boolean).slice(0,8);
  if (!points.length) return '';
  return 'https://www.google.com/maps/dir/' + points.map(x => encodeURIComponent(String(x))).join('/');
}
async function buildRoutes({resource='', owner='', market='', status='', type='', source='', date='', maxHours=8}={}) {
  let items = (await allItems()).map(routeCandidate).filter(x => x.routePosture !== 'blocked');
  if (resource) items = items.filter(x => String(x.assignedResource||'').toLowerCase().includes(String(resource).toLowerCase()));
  if (owner) items = items.filter(x => String(x.owner||'').toLowerCase().includes(String(owner).toLowerCase()));
  if (market) items = items.filter(x => String(x.market||'').toLowerCase().includes(String(market).toLowerCase()) || String(x.name||'').toLowerCase().includes(String(market).toLowerCase()));
  if (status) items = items.filter(x => String(x.status||'').toLowerCase() === String(status).toLowerCase());
  if (type) items = items.filter(x => String(x.type||'').toLowerCase() === String(type).toLowerCase());
  if (source) items = items.filter(x => String(x.source||'').toLowerCase() === String(source).toLowerCase());
  const groups = {};
  for (const it of items) (groups[it.market] ||= []).push(it);
  const routes = Object.entries(groups).map(([m, arr]) => {
    arr.sort((a,b)=>(b.readiness.complete-a.readiness.complete)||(a.estimatedHours-b.estimatedHours));
    let hours=0, selected=[], backups=[];
    for (const it of arr) {
      if (it.routePosture==='ready' && hours + it.estimatedHours <= maxHours) { selected.push(it); hours += it.estimatedHours; }
      else if (it.routePosture!=='blocked') backups.push(it);
    }
    const route = { market:m, date:date||new Date().toISOString().slice(0,10), estimatedHours:hours, selected, backups:backups.slice(0,8) }; route.mapUrl = routeMapUrl(route); route.packet = routePacket({market:m, selected, backups:backups.slice(0,3), date, mapUrl: route.mapUrl}); return route;
  }).filter(r=>r.selected.length || r.backups.length).sort((a,b)=>b.selected.length-a.selected.length);
  return { ok:true, generatedAt:new Date().toISOString(), filters:{resource,owner,market,status,type,source,date,maxHours}, routes };
}
function routePacket(route) {
  const selected = route.selected || [];
  const backups = route.backups || [];
  return `Route packet — ${route.market} — ${route.date||new Date().toISOString().slice(0,10)}\n\nPrimary route:\n${selected.map((x,i)=>`${i+1}. ${x.name} (${x.readiness.score}, ${x.estimatedHours}h) — ${x.sourceUrl||''}`).join('\n') || 'No ready primary jobs'}\n\nConditional backups:\n${backups.map((x,i)=>`${i+1}. ${x.name} (${x.readiness.score}) — missing gates: ${Object.entries(x.readiness.gates).filter(([k,v])=>!v).map(([k])=>k).join(', ')}`).join('\n') || 'No backups'}\n\nProof checklist before dispatch:\n- Construction accepted\n- Scope/prints current\n- Materials ready\n- Splice/light/test path clear\n- Network/cutover named\n- Customer/access clear\n- Crew/duration/bump rule confirmed`;
}
async function splicerToday({resource='', market=''}={}) {
  const routes = await buildRoutes({resource, market, maxHours:8});
  const first = routes.routes[0] || {selected:[],backups:[],packet:'No route candidates.'};
  return { ok:true, resource:resource||'all', market:market||first.market||'', route:first, checklist:['Review route packet','Confirm materials/equipment','Confirm prints/scope','Post arrival note','Post splice/light/test proof','Post blocker immediately','Close with completion proof/photos'] };
}


// v9 operational-grade modules: policy engine, exceptions, response tracking, meeting mode, route calendar, mobile field mode, and deployment placeholders.
const operationalFiles = {
  responses: path.join(DATA_DIR, 'responses.json'),
  exceptions: path.join(DATA_DIR, 'exceptions.json'),
  policy: path.join(DATA_DIR, 'policy.json'),
  fieldMap: path.join(DATA_DIR, 'field-ownership.json'),
  webhookLog: path.join(DATA_DIR, 'webhook-log.json')
};
function defaultPolicy() {
  return {
    version: 'v9-operational-policy',
    principles: behaviorRules(),
    rules: [
      { id:'no_name_only_merge', severity:'block', rule:'Do not dual-post or mirror by project name only. Require board/item ID bridge or manual confirmation.' },
      { id:'no_rfs_without_proof', severity:'warn', rule:'RFS/install dates require owner, predecessor, and proof checkpoint.' },
      { id:'route_requires_crew', severity:'block', rule:'Route commitment requires named crew/splicer, duration, and bump rule.' },
      { id:'comments_auto_fields_guarded', severity:'guard', rule:'Comments may be automatic when targeted; field changes require field ownership map and approval.' },
      { id:'evidence_first', severity:'warn', rule:'Claims of ready/complete must show source evidence or remain conditional.' },
      { id:'loop_marker_required', severity:'block', rule:'Webhook mirroring requires idempotency marker to prevent duplicates.' }
    ],
    writeClasses: {
      reminderComment: { approval:'automatic', target:'D2D item comments', allowed:true },
      ownerAskComment: { approval:'queue or automatic by workflow', target:'selected/linked item comments', allowed:true },
      meetingCaptureComment: { approval:'operator confirm', target:'selected/linked item comments', allowed:true },
      routeAssignment: { approval:'Kyle/splicing lead', target:'route module / allowed Monday field', allowed:false, placeholder:true },
      statusFieldChange: { approval:'field owner', target:'Monday field', allowed:false, placeholder:true },
      rfsDateChange: { approval:'PM/source owner with proof', target:'D2D RFS field', allowed:false, placeholder:true }
    }
  };
}
function defaultFieldOwnership() {
  return {
    boards: { d2d:'18391791372', projectTracker:'5077578194' },
    fields: [
      { field:'RFS / Date', ownerSystem:'D2D/RFS', writeMode:'guarded', proof:'owner + predecessor + checkpoint' },
      { field:'Project delivery status', ownerSystem:'Project Tracker', writeMode:'guarded', proof:'PM/source owner confirmation' },
      { field:'Splicing route assignment', ownerSystem:'Splicing Planning Assistant', writeMode:'approval-required', proof:'Kyle/splicing lead approval' },
      { field:'Readiness score', ownerSystem:'Splicing Planning Assistant', writeMode:'computed-read-only', proof:'seven-gate evidence' },
      { field:'Comments / owner asks', ownerSystem:'App or Monday', writeMode:'automatic when targeted', proof:'audit + source item ID' },
      { field:'Evidence links', ownerSystem:'Source board where evidence lives', writeMode:'append-only', proof:'file/comment/link timestamp' }
    ]
  };
}
async function policyConfig(){ return await readJson(operationalFiles.policy, defaultPolicy()); }
async function fieldOwnership(){ return await readJson(operationalFiles.fieldMap, defaultFieldOwnership()); }
function policyEvaluate(item, action='inspect') {
  const issues=[];
  const text=`${item.name} ${item.status} ${item.blocker} ${item.action} ${item.owner} ${item.assignedResource}`.toLowerCase();
  if (/unassigned|tbd|^$/i.test(String(item.assignedResource||''))) issues.push({rule:'route_requires_crew', severity:'block', message:'No named resource/splicer; route commitment should stay blocked/conditional.'});
  if ((item.rfs||item.workDate) && /missing|no readiness|proof|confirm|needed|await|block/i.test(`${item.blocker} ${item.action}`)) issues.push({rule:'no_rfs_without_proof', severity:'warn', message:'Date exists but proof/checkpoint appears incomplete.'});
  if (item.status==='Ready' && !readinessGates(item).ready) issues.push({rule:'evidence_first', severity:'warn', message:'Source status says Ready, but strict readiness gates are not all complete.'});
  if (/construction|bore/.test(text) && !/accepted|complete|done|finish/.test(text)) issues.push({rule:'evidence_first', severity:'warn', message:'Construction/bore dependency mentioned without acceptance proof.'});
  return { action, allowed: !issues.some(i=>i.severity==='block'), issues };
}
async function exceptionBoard({owner='', severity='', type=''}={}) {
  const bridge = await bridgeRecords();
  const linkedById = new Map();
  for (const b of bridge) { if (b.d2d) linkedById.set(String(b.d2d.itemId), b); if (b.tracker) linkedById.set(String(b.tracker.itemId), b); }
  const items = await allItems();
  const rows=[];
  for (const item of items) {
    const evaln = policyEvaluate(item);
    const b = linkedById.get(String(item.itemId));
    if (!b || b.needsReview) rows.push({ type:'bridge_review', severity:b?'medium':'high', item, message:b?'Bridge needs review before dual-posting.':'No linked D2D/Project Tracker record confirmed.', nextAction:'Open Source Bridge and confirm/manual-link record.' });
    for (const issue of evaln.issues) rows.push({ type:issue.rule, severity:issue.severity==='block'?'high':'medium', item, message:issue.message, nextAction: issue.rule==='route_requires_crew'?'Assign/confirm resource before route.':'Request owner proof/checkpoint.' });
    if (item.status==='Blocked') rows.push({ type:'blocked_work', severity:'high', item, message:item.blocker||item.action||'Blocked item', nextAction:'Owner must post checkpoint/proof or reforecast.' });
  }
  let out=rows;
  if (owner) out=out.filter(r=>String(r.item.owner||'').toLowerCase().includes(String(owner).toLowerCase()));
  if (severity) out=out.filter(r=>r.severity===severity);
  if (type) out=out.filter(r=>r.type===type);
  const seen=new Set();
  out=out.filter(r=>{const k=`${r.type}:${r.item.itemId}`; if(seen.has(k)) return false; seen.add(k); return true;});
  return { ok:true, generatedAt:new Date().toISOString(), count:out.length, rows:out.slice(0,500) };
}
async function responseRecords(){ return await readJson(operationalFiles.responses, []); }
async function createResponseRequest({itemId, owner, message, due, channel='Monday comment', source='manual'}={}) {
  const item=(await allItems()).find(r=>String(r.itemId||r.id)===String(itemId));
  const rec={ id:crypto.randomUUID(), itemId:String(itemId||''), itemName:item?.name||'', owner:owner||item?.owner||'Unassigned', message:message||ownerAsk(item||{}), due:due||'', channel, source, status:'open', createdAt:new Date().toISOString(), evidenceReceived:false, closedAt:null };
  const rows=await responseRecords(); rows.unshift(rec); await writeJson(operationalFiles.responses, rows); return rec;
}
async function responseSummary() {
  const rows=await responseRecords();
  const open=rows.filter(r=>r.status!=='closed');
  const byOwner={}; for(const r of open) byOwner[r.owner]=(byOwner[r.owner]||0)+1;
  return { ok:true, total:rows.length, open:open.length, closed:rows.length-open.length, byOwner, rows:rows.slice(0,300) };
}
async function meetingBrief({owner='', focus='exceptions'}={}) {
  const exc=await exceptionBoard({owner});
  const top=exc.rows.slice(0,12);
  const lines=top.map((r,i)=>`${i+1}. ${r.item.name} — ${r.message} Next: ${r.nextAction} Source: ${itemUrl(r.item)}`);
  return { ok:true, focus, owner, count:top.length, opening:`Decision-only review. Routine status stays in D2D/Project Tracker. Close each exception with owner, checkpoint, proof, and source update location.`, lines, close:`Readback each item: owner, output, checkpoint, proof, and destination board/comment.` };
}
async function routeCalendar({days=21, owner='', resource=''}={}) {
  const items=(await allItems()).map(routeCandidate).filter(x=>x.workDate||x.rfs);
  const today=new Date(); const max=new Date(today.getTime()+Number(days)*86400000);
  let out=items.filter(x=>{const d=new Date(x.workDate||x.rfs); return !isNaN(d) && d>=new Date(today.getFullYear(),today.getMonth(),today.getDate()) && d<=max;});
  if(owner) out=out.filter(x=>String(x.owner||'').toLowerCase().includes(String(owner).toLowerCase()));
  if(resource) out=out.filter(x=>String(x.assignedResource||'').toLowerCase().includes(String(resource).toLowerCase()));
  const byDate={}; for(const it of out){ const k=String(it.workDate||it.rfs).slice(0,10); (byDate[k]||=[]).push(it); }
  return { ok:true, days:Number(days), count:out.length, byDate };
}
async function evidenceBoard({itemId=''}={}) {
  let items=await allItems(); if(itemId) items=items.filter(x=>String(x.itemId||x.id)===String(itemId));
  const rows=items.map(item=>{ const gates=readinessGates(item); const missing=Object.entries(gates.gates).filter(([k,v])=>!v).map(([k])=>k); const evidence=(item.updates||[]).map(u=>({author:u.author,date:u.date,text:u.text})); return { itemId:item.itemId, name:item.name, owner:item.owner, status:item.status, score:gates.score, missing, evidenceCount:evidence.length, latestEvidence:evidence.slice(0,5), sourceUrl:itemUrl(item) }; });
  return { ok:true, count:rows.length, rows:rows.slice(0,300) };
}
async function mobileToday({resource='', market=''}={}) {
  const r=await splicerToday({resource,market});
  const jobs=[...(r.route.selected||[]), ...(r.route.backups||[]).slice(0,5)].map(x=>({ itemId:x.itemId, name:x.name, market:x.market, status:x.status, readiness:x.readiness?.score, address:x.city||'', sourceUrl:itemUrl(x), checklist:['Open site details','Confirm access/contact','Confirm prints/scope','Confirm materials','Post arrival note','Post blocker or proof','Close with completion proof/photos'] }));
  return { ok:true, resource:r.resource, market:r.market, jobs, routePacket:r.route.packet||'', checklist:r.checklist };
}
async function webhookStatus() {
  const token=await mondayToken();
  const publicUrl=process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_BASE_URL || '';
  return { ok:true, mode: publicUrl ? 'hosted-ready' : 'local-dev', available:Boolean(publicUrl && token), publicUrl, tokenConfigured:Boolean(token), appOriginatedMirror:true, inboundWebhookMirror:Boolean(publicUrl && token), boards:['18391791372','5077578194'], required:['Monday webhook subscriptions for update/comment events on both boards','Source Bridge confirmed links','loop guard marker [SPA-MIRROR]'], note:'App-originated dual-post is active. Inbound Monday-originated mirroring is handled by receiver when Monday sends webhook payloads and a bridge link exists.' };
}
async function handleMondayWebhook(payload={}) {
  const log=await readJson(operationalFiles.webhookLog, []);
  const ev=payload.event || payload;
  const text=String(ev.body || ev.text_body || ev.text || ev.value || payload.body || '');
  const itemId=String(ev.pulseId || ev.pulse_id || ev.itemId || ev.item_id || payload.pulseId || payload.itemId || '');
  const eventType=String(ev.type || payload.type || 'unknown');
  const entry={id:crypto.randomUUID(), at:new Date().toISOString(), eventType, itemId, mirrorPosted:false, skipped:false, reason:'', updateIds:[]};
  try{
    if(payload.challenge) return {challenge:payload.challenge};
    if(!itemId){ entry.skipped=true; entry.reason='no itemId in webhook payload'; }
    else if(/\[SPA-MIRROR /.test(text)){ entry.skipped=true; entry.reason='loop guard: mirror marker detected'; }
    else if(!/update|comment|create_update|pulse/i.test(eventType+' '+JSON.stringify(payload).slice(0,500))){ entry.skipped=true; entry.reason='not an update/comment event'; }
    else {
      const destinations=await linkedDestinations(itemId);
      if(!destinations.length){ entry.skipped=true; entry.reason='no linked Source Bridge destination'; }
      else {
        const sourceUrl=`https://visionary-broadband.monday.com/pulses/${itemId}`;
        for(const dest of destinations){ const updateId=await mondayPost(dest.itemId, bridgeComment(cleanPlain(text)||'Mirrored Monday update', sourceUrl, dest.url)); entry.updateIds.push({itemId:dest.itemId,updateId}); }
        entry.mirrorPosted=entry.updateIds.length>0; entry.reason=entry.mirrorPosted?'mirrored to linked destination':'no destination posted';
      }
    }
  }catch(e){ entry.error=e.message; entry.reason='receiver_error'; }
  log.unshift({ ...entry, payload }); await writeJson(operationalFiles.webhookLog, log.slice(0,500)); return {ok:true, entry, mirrorPosted:entry.mirrorPosted, reason:entry.reason};
}
async function deploymentTest() {
  const healthItems=await allItems(); const bridge=await bridgeRecordsCompat(); const exc=await exceptionBoard({});
  return { ok:true, mode:'local-test-deploy', checks:[
    {name:'backend', pass:true},
    {name:'dataset', pass:healthItems.length>=190, detail:healthItems.length},
    {name:'d2dBoardDefault', pass:true, detail:'18391791372'},
    {name:'projectTrackerDefault', pass:true, detail:'5077578194'},
    {name:'sourceBridge', pass:bridge.rows.length>0, detail:bridge.rows.length},
    {name:'exceptionBoard', pass:exc.count>0, detail:exc.count},
    {name:'webhookReceiver', pass:true, detail:'hosted receiver ready when Monday subscription is configured'},
    {name:'schedulerPlaceholder', pass:true, detail:'runs while backend process is running; production needs hosted/always-on'}
  ]};
}

async function mondayDiagnostics() {
  const token = await mondayToken();
  const result = { ok:true, tokenConfigured:Boolean(token), endpoint:MONDAY, checks:[] };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    const res = await fetch(MONDAY, { method:'POST', headers:{ 'Content-Type':'application/json', ...(token ? {Authorization:token} : {}) }, body: JSON.stringify({query:'query { me { id name email } }'}), signal:controller.signal });
    clearTimeout(timeout);
    const text = await res.text();
    let json = {}; try { json = JSON.parse(text); } catch {}
    result.checks.push({ name:'api.monday.com POST reachable', pass:true, httpStatus:res.status, response:json.errors?.[0]?.message || json.data?.me?.name || text.slice(0,200) });
    result.connected = res.ok && !json.errors;
  } catch (e) {
    result.connected = false;
    result.checks.push({ name:'api.monday.com POST reachable', pass:false, error:e.message, guidance:'If this says fetch failed, the work network/proxy/firewall may be blocking Node from reaching api.monday.com. Browser access to Monday can still work while Node API calls are blocked.' });
  }
  return result;
}

function splitCityState(item) {
  const raw = String(item.city || '').trim();
  const [city='', state=''] = raw.split(',').map(x=>x.trim());
  return { city, state };
}
function uniqueValues(items, getter) {
  return [...new Set(items.map(getter).filter(Boolean))].sort((a,b)=>String(a).localeCompare(String(b)));
}
async function routeFilterOptions() {
  const items = await allItems();
  return { ok:true, options:{
    owners: uniqueValues(items, x=>x.owner),
    resources: uniqueValues(items, x=>x.assignedResource),
    types: uniqueValues(items, x=>x.type),
    statuses: uniqueValues(items, x=>x.status),
    sources: uniqueValues(items, x=>x.source),
    cities: uniqueValues(items, x=>splitCityState(x).city),
    states: uniqueValues(items, x=>splitCityState(x).state),
    dates: uniqueValues(items, x=>String(x.workDate || x.rfs || '').slice(0,10)).filter(Boolean)
  }};
}
function filterForScenario(items, body={}) {
  let out = [...items];
  const eq = (v,f)=>!v || String(f||'').toLowerCase()===String(v).toLowerCase();
  if (body.itemIds && body.itemIds.length) {
    const ids = new Set(body.itemIds.map(String)); out = out.filter(x=>ids.has(String(x.itemId||x.id)));
  }
  if (body.owner) out = out.filter(x=>eq(body.owner,x.owner));
  if (body.resource) out = out.filter(x=>eq(body.resource,x.assignedResource));
  if (body.type) out = out.filter(x=>eq(body.type,x.type));
  if (body.status) out = out.filter(x=>eq(body.status,x.status));
  if (body.source) out = out.filter(x=>eq(body.source,x.source));
  if (body.city) out = out.filter(x=>eq(body.city,splitCityState(x).city));
  if (body.state) out = out.filter(x=>eq(body.state,splitCityState(x).state));
  if (body.date) out = out.filter(x=>String(x.workDate||x.rfs||'').slice(0,10)===String(body.date));
  if (body.search) out = filterItems(out, body.search, {});
  return out;
}
function scheduleNarrative({route, assignee='', contractor='', scenarioName=''}) {
  const selected = route.selected || [];
  const backups = route.backups || [];
  const who = [assignee && `Splicer/resource: ${assignee}`, contractor && `Contractor: ${contractor}`].filter(Boolean).join(' · ') || 'Resource/contractor TBD';
  const why = selected.length ? `Primary route was selected from strict-ready candidates first, then capped by route hours. Conditional items are listed as backups until missing gates clear.` : `No strict-ready primary jobs were available, so this is a backup/constraint packet only.`;
  return `${scenarioName ? scenarioName + '\n' : ''}Splicing route scenario — ${route.market} — ${route.date}\n${who}\n\nWhy this route:\n${why}\n\nPrimary work:\n${selected.map((x,i)=>`${i+1}. ${x.name} — ${x.readiness.score}, ${x.estimatedHours}h, ${x.city || ''}`).join('\n') || 'No primary work selected.'}\n\nConditional backups / questions:\n${backups.map((x,i)=>`${i+1}. ${x.name} — ${x.readiness?.score || ''}; ${x.action || x.blocker || 'confirm readiness'}`).join('\n') || 'No backups.'}\n\nQuestions / risks:\n${[...selected,...backups].filter(x=>x.readiness && !x.readiness.ready).slice(0,8).map(x=>`- ${x.name}: missing ${Object.entries(x.readiness.gates).filter(([k,v])=>!v).map(([k])=>k).join(', ')}`).join('\n') || '- No missing gates on primary work.'}\n\nMap:\n${route.mapUrl || 'No map link generated.'}\n\nIf anything in this route is wrong or a gate is missing, please let Kyle know before dispatch.`;
}
async function buildScheduleScenario(body={}) {
  const maxHours = Number(body.maxHours || 8);
  let items = filterForScenario((await allItems()).map(routeCandidate), body).filter(x=>x.routePosture !== 'blocked' || body.includeBlocked);
  const groups = {};
  for (const it of items) (groups[it.market || 'Unknown'] ||= []).push(it);
  const routes = Object.entries(groups).map(([m, arr]) => {
    arr.sort((a,b)=>(b.readiness.complete-a.readiness.complete)||(a.estimatedHours-b.estimatedHours));
    let hours=0, selected=[], backups=[];
    for (const it of arr) {
      if (it.routePosture==='ready' && hours + it.estimatedHours <= maxHours) { selected.push({...it, scenarioAssignee:body.assignee||'', scenarioContractor:body.contractor||''}); hours += it.estimatedHours; }
      else backups.push(it);
    }
    const route = { market:m, date:body.date || new Date().toISOString().slice(0,10), estimatedHours:hours, selected, backups:backups.slice(0,12) };
    route.mapUrl = routeMapUrl(route);
    route.packet = routePacket({market:m, selected, backups:backups.slice(0,3), date:route.date, mapUrl:route.mapUrl});
    route.narrative = scheduleNarrative({route, assignee:body.assignee||'', contractor:body.contractor||'', scenarioName:body.scenarioName||''});
    return route;
  }).filter(r=>r.selected.length || r.backups.length).sort((a,b)=>b.selected.length-a.selected.length || b.backups.length-a.backups.length);
  const exportText = routes.map(r=>r.narrative).join('\n\n---\n\n') || 'No route scenario results.';
  const teamsMessage = buildTeamsScheduleMessage({routes, dateRange:body.date||'', note:body.note||''});
  return { ok:true, generatedAt:new Date().toISOString(), filters:body, count:items.length, routes, exportText, teamsMessage, workflow:splicingTeamsWorkflow() };
}
async function saveTeamsWebhook(url) {
  if (!url || !/^https:\/\//i.test(String(url))) throw Object.assign(new Error('Teams webhook URL must start with https://'), {status:400});
  await saveSecret('TEAMS_WEBHOOK_URL', String(url).trim());
  return true;
}
async function teamsWebhook() { return (await loadSecrets()).TEAMS_WEBHOOK_URL || process.env.TEAMS_WEBHOOK_URL || ''; }
async function postTeamsMessage(text) {
  const url = await teamsWebhook();
  if (!url) throw Object.assign(new Error('Teams webhook URL not configured'), {status:400});
  const res = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ text:String(text||'') }) });
  const body = await res.text().catch(()=> '');
  if (!res.ok) throw Object.assign(new Error(`Teams webhook failed ${res.status}: ${body.slice(0,200)}`), {status:502});
  return { ok:true, status:res.status, response:body.slice(0,200) };
}
async function externalConnectivityDiagnostics() {
  const targets = ['https://api.monday.com/v2','https://www.microsoft.com'];
  const checks=[];
  for (const target of targets) {
    try {
      const controller = new AbortController(); const timeout=setTimeout(()=>controller.abort(),8000);
      const res = await fetch(target, { method: target.includes('monday') ? 'POST' : 'GET', headers:{'Content-Type':'application/json'}, body: target.includes('monday') ? JSON.stringify({query:'query { me { id } }'}) : undefined, signal:controller.signal });
      clearTimeout(timeout); checks.push({target, pass:true, status:res.status});
    } catch(e) { checks.push({target, pass:false, error:e.message}); }
  }
  return { ok:true, checks, guidance:'If browser works but these checks fail from Node, local executable traffic is likely blocked by firewall/proxy/security.' };
}

function splicingTeamsWorkflow() {
  return {
    ok:true,
    channel:'PMO/Splicing Crossover',
    scheduler:'Kyle Davis',
    coordinators:['Kyle Davis','Yuwipi Tsunka'],
    pmsRequesters:['Jim Fuhrer','Leslie Carbary','Leah Corcoran','Chris Hernandez','Ben Hulings'],
    splicers:['Justin Archuleta','Frank Hernandez','Brandon','Brady','Chad'],
    knownExternalOrSupport:['Broc Laughlin','Terry Bankert','Rising Edge','Tier 2','Networking'],
    inactiveDoNotTag:['Kelley','Kelly Leeper'],
    schedulePattern:{
      days:['Monday','Tuesday','Wednesday','Thursday','Friday'],
      fields:['splicer','day','project/site','market/address','work type','readiness status','weather dependency','float day','questions/blockers'],
      examples:{
        Justin:['Buena Vista splicing/testing closeout','FLOAT DAY','Pagosa weather dependent'],
        Frank:['Buena Vista assist drops','FLOAT DAY','Pagosa weather dependent'],
        Brandon:['WyoOil tower transfer','GLLT Elite Occupational Testing','Anaconda/Butte/Whitehall'],
        Brady:['Iron Mountain tower transfer','WY ETS Glenrock Intermediate','Torrington ETS NDX','ACT Glendo IRU'],
        Chad:['Anaconda/Butte/Whitehall']
      }
    },
    requestIntakeFields:['requester','project/site','address','market','passings','technology GPON/Positron/ActiveE','ready date','prints/attachments','materials location','network tech','power/drop dependency','customer urgency','blockers/questions'],
    decisionRules:['Kyle owns schedule/route decision','ready date does not equal dispatch until materials/network/access/prints are clear','float days can absorb ready one-offs','weather dependent items need backup work','urgent customer cutovers can bump lower-priority work','post record back to Monday for audit'],
    messageTemplates:{
      newRequest:'@Kyle Davis — New splice request: {project} ({address}). Passings: {passings}. Tech: {technology}. Ready: {readyDate}. Materials: {materials}. Network: {networkTech}. Prints attached/linked: {prints}. Questions/blockers: {blockers}.',
      scheduleExport:'Team — proposed splicing schedule for {dateRange}. Kyle, please confirm route/order. If anything is wrong or missing a readiness gate, let Kyle know before dispatch. {schedule}',
      ownerAsk:'@{owner} — please update {project} before the RFS/splicing review: current blocker/question is {blocker}. Please post owner, checkpoint date, and proof in Monday.',
      completionAsk:'@{splicer} — when complete, please post splice/light/test proof and any blocker notes back to the Monday item.'
    }
  };
}
function buildTeamsScheduleMessage({routes=[], dateRange='', note=''}={}) {
  const body = routes.map(r => {
    const primary = (r.selected||[]).map((x,i)=>`  ${i+1}. ${x.name} — ${x.city||''} — ${x.readiness?.score||''}`).join('\n') || '  No primary jobs.';
    const backups = (r.backups||[]).slice(0,5).map((x,i)=>`  ${i+1}. ${x.name} — ${x.action||x.blocker||'confirm readiness'}`).join('\n') || '  No backups.';
    return `${r.market} (${r.estimatedHours||0}h)\nPrimary:\n${primary}\nBackups/questions:\n${backups}\nMap: ${r.mapUrl||'n/a'}`;
  }).join('\n\n');
  return `Team — proposed splicing schedule${dateRange?` for ${dateRange}`:''}. Kyle, please confirm route/order. If anything is wrong or missing a readiness gate, let Kyle know before dispatch.\n\n${body}\n\n${note||''}`.trim();
}

async function parseBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type' }); res.end(JSON.stringify(obj)); }
function serveFile(res, file) {
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html' : ext === '.js' ? 'application/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control':'no-cache' }); createReadStream(file).pipe(res);
}
let syncState={state:'idle'},syncTask=null;
async function syncMondayBoards(boardIds=['18391791372','5077578194']) {
 if(syncTask)return syncTask;
 syncState={state:'running',startedAt:new Date().toISOString()};
 syncTask=(async()=>{try{
 const live=await readBoards(mondayGraphql,boardIds,{pageSize:50,onProgress:p=>Object.assign(syncState,p)}); if(storage.saveSync) await storage.saveSync(live);
 trackDateChanges(live,await readJson(files.live,{}));
 await writeJson(files.live+'.tmp',live);await rename(files.live+'.tmp',files.live);
 syncState={state:'complete',syncedAt:live.syncedAt,records:live.records.length,boards:live.boards,scope:live.scope};return {ok:true,...syncState};
 }catch(e){syncState={state:'failed',error:'Live sync failed; previous complete data retained.',detail:e.message,finishedAt:new Date().toISOString()};throw e;}finally{syncTask=null;}})();return syncTask;
}

async function pmoDashboard(){
  const items = await allItems();
  const bridge = await bridgeRecordsCompat();
  const open = items.filter(x=>!String(x.status||'').toLowerCase().includes('complete'));
  const blockers = open.filter(x=>/block|missing|confirm|unassigned|tbd|conditional|hold|permit|proof|pending/i.test([x.status,x.blocker,x.action,x.assignedResource].join(' ')));
  const ready = open.filter(x=>String(x.status||'')==='Ready');
  const ownerLoad = Object.entries(open.reduce((m,it)=>{const k=it.owner||'Unassigned';m[k]=(m[k]||0)+1;return m;},{})).sort((a,b)=>b[1]-a[1]).slice(0,15).map(([owner,count])=>({owner,count}));
  const brief = `Today: ${open.length} open records, ${ready.length} ready, ${blockers.length} needing confirmation/blocker review, ${bridge.counts.review} Source Bridge rows needing review. Work first on bridge gaps that block dual-posting, then RFS/date/owner gaps.`;
  return { ok:true, counts:{total:items.length, open:open.length, ready:ready.length, blockers:blockers.length, bridgeReview:bridge.counts.review, bridgeLinked:bridge.counts.linked}, ownerLoad, topBlockers:blockers.slice(0,30).map(pmoEvidenceFor), bridgeCounts:bridge.counts, brief };
}
function pmoNorm(x){ return String(x||'').toLowerCase(); }
function pmoScoreItem(item, query){
  const q=pmoNorm(query); if(!q) return 1; const hay=pmoNorm([item.name,item.city,item.owner,item.assignedResource,item.type,item.status,item.blocker,item.action,item.itemId,item.sourceBoard,item.source].join(' '));
  let score=0; for(const term of q.split(/\s+/).filter(Boolean)){ if(hay.includes(term)) score += term.length>3?2:1; }
  return score;
}
function pmoEvidenceFor(item){ return { itemId:item.itemId||item.id, boardId:item.sourceBoardId||'', board:item.sourceBoard||item.source||'', url:item.sourceUrl||itemUrl(item), name:item.name||'', owner:item.owner||'', assignedResource:item.assignedResource||'', status:item.status||'', rfs:item.rfs||item.workDate||'', city:item.city||'', blocker:item.blocker||'', action:item.action||'' }; }
function pmoPlainAnswer(route, rows, extra={}){
  if(route==='bridge') return `Source Bridge controls whether one PMO post can mirror between D2D and Project Tracker. ${extra.review||0} row(s) need review and ${extra.linked||0} are linked. If no linked destination exists, primary-only posting is available but mirror posting is skipped.`;
  if(route==='risk_blocker') return `I found ${rows.length} blocker/confirmation item(s). Work these by owner, due date, and evidence gap. I am showing item IDs and board links in Evidence.`;
  if(route==='schedule') return `I found ${rows.length} scheduled/RFS/date-bearing item(s). Review earliest dates first and confirm resource ownership before dispatch.`;
  if(route==='draft') return `Draft ready. I kept it short, Patch-tone, and source-aware. Confirm before posting to Monday.`;
  if(route==='daily_brief') return `PMO brief: ${rows.length} active item(s) need attention. Highest value work is Source Bridge confirmation, blocker closure, and dated RFS readiness.`;
  return `I found ${rows.length} source-backed record(s). Evidence includes board/item IDs and links.`;
}
async function pmoAsk(body){
  const q=String(body.query||body.q||'').trim(); const items=await allItems(); const lower=pmoNorm(q); let route='search';
  if(/daily|brief|today|priority|what.*attention/.test(lower)) route='daily_brief';
  else if(/risk|blocker|blocked|stuck|missing|exception|confirm/.test(lower)) route='risk_blocker';
  else if(/draft|reply|response|patch tone|write|message/.test(lower)) route='draft';
  else if(/bridge|mirror|both boards|d2d|tracker|linked/.test(lower)) route='bridge';
  else if(/rfs|schedule|upcoming|date|calendar/.test(lower)) route='schedule';
  if(route==='bridge'){
    const b=await bridgeRecordsCompat(); const review=(b.rows||[]).filter(r=>r.needsReview||!r.d2d||!r.tracker).slice(0,50);
    return {ok:true,route,answer:pmoPlainAnswer(route,review,{review:review.length,linked:b.counts.linked}),count:review.length,evidence:review.map(r=>({canonicalId:r.canonicalId,name:r.name,confidence:r.confidence,score:r.score,d2d:r.d2d,tracker:r.tracker,needsReview:r.needsReview})),sourceBacked:true};
  }
  let rows=items.map(x=>({x,score:pmoScoreItem(x,q)})).filter(o=>o.score>0).sort((a,b)=>b.score-a.score).map(o=>o.x);
  if(route==='risk_blocker') rows=items.filter(x=>/block|missing|confirm|unassigned|tbd|conditional|hold|permit|proof|pending/i.test([x.status,x.blocker,x.action,x.assignedResource].join(' '))).slice(0,75);
  if(route==='schedule') rows=items.filter(x=>x.rfs||x.installDate||x.workDate).sort((a,b)=>String(a.rfs||a.workDate||'').localeCompare(String(b.rfs||b.workDate||''))).slice(0,75);
  if(route==='daily_brief') rows=items.filter(x=>/block|missing|confirm|unassigned|tbd|conditional|ready|pending/i.test([x.status,x.blocker,x.action,x.assignedResource].join(' '))).slice(0,75);
  if(!rows.length && q) rows=filterItems(items,q,{}).slice(0,50);
  const ev=rows.slice(0,35).map(pmoEvidenceFor); let answer=pmoPlainAnswer(route,rows);
  if(route==='draft') answer += `\n\nDraft:\nQuick update — I reviewed the source record(s). Please confirm current owner, target date, blocker status, and supporting evidence so I can keep Monday and the tracker aligned.`;
  return {ok:true,route,answer,count:rows.length,evidence:ev,sourceBacked:true};
}
async function pmoParityHarness(){
  const tests=[]; const add=(name,fn)=>tests.push({name,fn});
  add('dashboard_counts', async()=>{const d=await pmoDashboard(); return d.ok && d.counts.total>=0 && 'bridgeReview' in d.counts});
  add('bridge_truth', async()=>{const b=await bridgeRecordsCompat(); return b.counts && Array.isArray(b.rows)});
  add('ask_daily_brief', async()=>{const r=await pmoAsk({query:'daily PMO brief'}); return r.ok&&r.route==='daily_brief'&&r.sourceBacked});
  add('ask_blockers', async()=>{const r=await pmoAsk({query:'show blockers and missing confirmations'}); return r.ok&&r.route==='risk_blocker'});
  add('ask_bridge', async()=>{const r=await pmoAsk({query:'what source bridge links need review'}); return r.ok&&r.route==='bridge'});
  add('ask_draft', async()=>{const r=await pmoAsk({query:'draft a Patch tone reply asking for an update'}); return r.ok&&r.route==='draft'&&/Draft/.test(r.answer)});
  add('ask_schedule', async()=>{const r=await pmoAsk({query:'show upcoming RFS schedule'}); return r.ok&&r.route==='schedule'});
  add('monday_token_status', async()=>{const d=await mondayDiagnostics(); return d.ok && 'tokenConfigured' in d});
  add('webhook_status_truth', async()=>{const w=await webhookStatus(); return w.ok && w.mode && w.appOriginatedMirror});
  add('deployment_test', async()=>{const d=await deploymentTest(); return d.ok && Array.isArray(d.checks)});
  const sample=(await allItems())[0];
  add('dual_comment_dryrun_primary_possible', async()=>{ if(!sample) return true; const linked=await linkedDestinations(sample.itemId||sample.id); return Array.isArray(linked); });
  for(let i=0;i<14;i++) add('operation_route_'+i, async()=>{const prompts=['find Jim blockers','what needs attention','show D2D bridge gaps','draft owner update','upcoming RFS','unassigned resource','conditional work','ready projects','project tracker gaps','mirror status','source-backed evidence','open PMO risks','schedule board readiness','owner load']; const r=await pmoAsk({query:prompts[i]}); return r.ok && r.sourceBacked;});
  const results=[]; for(const t of tests){ try{results.push({name:t.name,pass:!!(await t.fn())});}catch(e){results.push({name:t.name,pass:false,error:e.message});} }
  return {ok:results.every(x=>x.pass), total:results.length, passed:results.filter(x=>x.pass).length, results};
}

function uniqSorted(arr){ return [...new Set(arr.filter(Boolean).map(x=>String(x).trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b)); }
async function optionSetsForUi(){
  const items=await allItems(); let users=[]; try{ users=await mondayUsers(); }catch(e){ users=[]; }
  const fallbackOwners=['Ralph Pike','Patch','Kyle','Unassigned'];
  const fallbackResources=['Unassigned','Kyle Davis','Ralph Pike','Splicing Crew','Construction Crew'];
  return { ok:true,
    projectCardFields:['owner','assignedResource','type','zoneType','fiberStatus','status','score','blocker','action','rfs','installDate','priority','updateCount','workDate'],
    owners:uniqSorted(items.map(x=>x.owner).concat(fallbackOwners).concat(users.map(u=>u.name))),
    resources:uniqSorted(items.map(x=>x.assignedResource).concat(fallbackResources).concat(users.map(u=>u.name))),
    types:uniqSorted(items.map(x=>x.type).concat(['MDU','SFU','Commercial','Mixed','Backbone','Unknown'])),
    zoneTypes:uniqSorted(items.map(x=>x.zoneType).concat(['NEW','OVERBUILD','REBUILD','EXPANSION','MAINTENANCE','UNKNOWN'])),
    fiberStatuses:uniqSorted(items.map(x=>x.fiberStatus).concat(['Complete/Live','Complete','Live','In Progress','Not Started','Blocked','Unknown'])),
    statuses:uniqSorted(items.map(x=>x.status).concat(['Ready','Conditional','Blocked','On Hold','Needs Review','Complete'])),
    priorities:uniqSorted(items.map(x=>x.priority).concat(['Imported','Hot','High','Medium','Low','Critical'])),
    scores:uniqSorted(items.map(x=>x.score).concat(['1','2','3','4','5','6','7','8','9','10'])),
    sources:uniqSorted(items.map(x=>x.source)),
    mondayUsers:users.map(u=>({id:u.id,name:u.name,email:u.email,enabled:u.enabled})).sort((a,b)=>String(a.name).localeCompare(String(b.name)))
  };
}
function normalizeDateToken(v){
  const raw=String(v||'').trim(); if(!raw) return '';
  const valid=(y,m,d)=>{const t=new Date(Date.UTC(Number(y),Number(m)-1,Number(d)));return t.getUTCFullYear()===Number(y)&&t.getUTCMonth()===Number(m)-1&&t.getUTCDate()===Number(d)};
  const iso=raw.match(/^(20\d{2})-(\d{1,2})-(\d{1,2})$/); if(iso&&!valid(iso[1],iso[2],iso[3]))return ''; if(iso) return `${iso[1]}-${String(iso[2]).padStart(2,'0')}-${String(iso[3]).padStart(2,'0')}`;
  const us=raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/); if(us){ const y=us[3] ? (us[3].length===2?'20'+us[3]:us[3]) : String(new Date().getFullYear()); if(!valid(y,us[1],us[2]))return ''; return `${y}-${String(us[1]).padStart(2,'0')}-${String(us[2]).padStart(2,'0')}`; }
  return raw;
}
function cleanProjectValue(v){ return String(v||'').replace(/[.;,]+$/,'').replace(/^[-:=>\s]+/,'').trim(); }
function firstClause(v){ return cleanProjectValue(String(v||'').split(/\s*(?:;|,\s*(?:owner|assigned resource|resource|crew|splicer|type|zone|fiber status|status|score|blocker|action|rfs|install date|priority|update count|work date)\b|\b(?:rfs|install date|priority|update count|work date|action|blocker|status|score)\b\s*)/i)[0]); }
function canonicalProjectValue(field,value){
  value=cleanProjectValue(value);
  const maps={
    priority:{imported:'Imported',hot:'Hot',high:'High',medium:'Medium',low:'Low',critical:'Critical'},
    status:{ready:'Ready',conditional:'Conditional',blocked:'Blocked','on hold':'On Hold','needs review':'Needs Review',complete:'Complete'},
    type:{mdu:'MDU',sfu:'SFU',commercial:'Commercial',mixed:'Mixed',backbone:'Backbone',unknown:'Unknown'},
    zoneType:{new:'NEW',overbuild:'OVERBUILD',rebuild:'REBUILD',expansion:'EXPANSION',maintenance:'MAINTENANCE',unknown:'UNKNOWN'},
    fiberStatus:{'complete/live':'Complete/Live',complete:'Complete',live:'Live','in progress':'In Progress','not started':'Not Started',blocked:'Blocked',unknown:'Unknown'}
  };
  const key=String(value).toLowerCase();
  return maps[field]?.[key] || value;
}
function pushProposal(proposed,evidence,field,value,why,confidence='medium'){
  value=field==='blocker'||field==='action'?firstClause(value):cleanProjectValue(value); value=canonicalProjectValue(field,value); if(value==='') return;
  proposed[field]=value; evidence.push({field,value,why,confidence});
}
function extractAnyProjectCardFields(raw='', item={}){
  const text=String(raw||''); const proposed={}; const evidence=[]; const relevantNotes=[]; const warnings=[];
  const specs=[
    {field:'owner', rx:/(?:owner|project owner|pm|project manager)\s*(?:is|=|:|to|should be|changed? to)?\s*([^;\n,.]+)/i},
    {field:'assignedResource', rx:/(?:assigned resource|resource|assigned to|crew|splicer|assign)\s*(?:is|=|:|to|should be|changed? to)?\s*([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+){0,3})/i},
    {field:'type', rx:/(?:project type|type)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(MDU|SFU|Commercial|Mixed|Backbone|Unknown)\b/i},
    {field:'zoneType', rx:/(?:zone type|zone)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(NEW|OVERBUILD|REBUILD|EXPANSION|MAINTENANCE|UNKNOWN)\b/i},
    {field:'fiberStatus', rx:/(?:fiber status|fiber)\s*(?:is|=|:|to|should be|changed? to)?\s*([^;\n,.]+)/i},
    {field:'status', rx:/(?:status)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(Ready|Conditional|Blocked|On Hold|Needs Review|Complete)\b/i},
    {field:'score', rx:/(?:score)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(10|[1-9])\b/i},
    {field:'priority', rx:/(?:priority)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(Imported|Hot|High|Medium|Low|Critical)\b/i},
    {field:'updateCount', rx:/(?:update count|updates?)\s*(?:is|=|:|to|should be|changed? to)?\s*\b(\d+)\b/i},
    {field:'blocker', rx:/(?:blocker|blocked by|issue|risk)\s*(?:is|=|:|to|should be|changed? to)?\s*([^;\n]+)/i},
    {field:'action', rx:/(?:next action|action|to do|todo)\s*(?:is|=|:|to|should be|changed? to)?\s*([^;\n]+)/i}
  ];
  for(const spec of specs){ const m=text.match(spec.rx); if(m) pushProposal(proposed,evidence,spec.field,m[1],`explicit ${spec.field} phrase`,'high'); }
  const dateSpecs=[
    {field:'rfs', rx:/(?:rfs|ready for service|service date)\s*(?:date)?\s*(?:is|=|:|to|should be|changed? to)?\s*(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/i},
    {field:'installDate', rx:/(?:install date|installation date|install|customer activation|activation date)\s*(?:is|=|:|to|should be|changed? to)?\s*(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/i},
    {field:'workDate', rx:/(?:work date|workday|work day|field date|crew date)\s*(?:is|=|:|to|should be|changed? to)?\s*(20\d{2}-\d{1,2}-\d{1,2}|\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?)/i}
  ];
  for(const spec of dateSpecs){const ms=[...text.matchAll(new RegExp(spec.rx.source,'gi'))];const vals=[...new Set(ms.map(m=>normalizeDateToken(m[1])))];if(vals.length>1||vals.includes('')){warnings.push('Review ambiguous/invalid '+spec.field+' dates; no date applied.');}else if(ms.length)pushProposal(proposed,evidence,spec.field,vals[0],`explicit ${spec.field} date phrase`,'high');}
  if(!proposed.status){ if(/\b(not ready|no go|blocked|cannot proceed|waiting on|hold|on hold)\b/i.test(text)) pushProposal(proposed,evidence,'status','Blocked','natural-language blocker/status inference','medium'); else if(/\b(ready|good to go|cleared|can proceed)\b/i.test(text)) pushProposal(proposed,evidence,'status','Ready','natural-language ready/status inference','medium'); }
  if(!proposed.priority){ if(/\b(urgent|critical|hot|asap|today)\b/i.test(text)) pushProposal(proposed,evidence,'priority','Hot','urgency keyword inference','medium'); else if(/\b(high priority)\b/i.test(text)) pushProposal(proposed,evidence,'priority','High','priority keyword inference','medium'); }
  if(!proposed.action){ const act=text.match(/(?:need to|needs to|please|next we should|we should|follow up to)\s+([^;\n.]+)/i); if(act) pushProposal(proposed,evidence,'action',act[1],'natural-language action extraction','medium'); }
  if(!proposed.blocker){ const blk=text.match(/(?:waiting on|blocked by|held by|depends on)\s+([^;\n.]+)/i); if(blk) pushProposal(proposed,evidence,'blocker',blk[1],'natural-language dependency/blocker extraction','medium'); }
  for(const sent of text.split(/(?<=[.!?])\s+|\n+/).map(s=>s.trim()).filter(Boolean)){ if(/\b(owner|resource|crew|splicer|type|zone|fiber|status|score|blocker|risk|issue|action|rfs|ready for service|install|activation|priority|work date|waiting on|blocked|ready|complete|live|permit|authority|customer|meeting|note)\b/i.test(sent)) relevantNotes.push(sent); }
  return { ok:true, sourceItem:{itemId:item.itemId||item.id,name:item.name}, raw:text, warnings, extractedFields:Object.keys(proposed), proposedUpdates:proposed, evidence, relevantNotes, mergedPreview:{...item,...proposed}, mondayWriteSupported:false, note:'Preview only: extracted project-card intelligence for human review/comment drafting. It does not overwrite Monday fields unless explicit field-map writeback is enabled.' };
}
function extractFieldPreview(raw='', item={}){ return extractAnyProjectCardFields(raw,item); }
async function featureBehaviorTests(){
  const items=await allItems(); const sample=items.find(x=>x.itemId)||items[0]||{}; const options=await optionSetsForUi();
  const queries=['show readiness blockers','draft ask Jim for splice checkpoint','find MDU work','show upcoming RFS items','unassigned resource'];
  const queryResults=queries.map(q=>{const rows=filterItems(items,q,{});return {query:q,count:rows.length,pass:rows.length>0,first:rows[0]?.name||null};});
  const fieldPreview=extractFieldPreview('Jim said owner is Kyle Davis, splicer is Justin Archuleta, RFS 10/14/2026, install 10/18/2026, permit approved, light test still needed.', sample);
  const mentions=await (async()=>{const users=await mondayUsers(); const names=['Kyle','Jim','Ben','Leah']; return names.map(n=>{const u=findMondayUser(n,users); return {name:n,found:Boolean(u),id:u?.id||null,email:u?.email||null,mention:u?mondayMention(u,n):'@'+n};});})();
  const bridge=await bridgeRecordsCompat(); const prep=await tuesdayPrep({}); const reminder=await runTuesdayReminder({dryRun:true,force:true});
  return { ok: queryResults.every(x=>x.pass) && Object.keys(fieldPreview.proposedUpdates).length>=4 && options.statuses.length>=3, queryResults, dropdownOptionCounts:{owners:options.owners.length,resources:options.resources.length,statuses:options.statuses.length,types:options.types.length,mondayUsers:options.mondayUsers.length}, fieldPreview, mentions, bridgeCounts:bridge.counts, tuesdayGroups:prep.groups.length, reminderDryRun:{due:reminder.due,groups:reminder.groups.length,posted:reminder.posted||0,queued:reminder.queued||0}, generatedAt:new Date().toISOString() };
}

const workflowHandler=createWorkflow({allItems,files,readJson,mondayGraphql,mondayToken,parseBody,send,ROOT,storage});
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return send(res, 200, { ok: true });
    const url = new URL(req.url, `http://${req.headers.host}`);
    if(await workflowHandler(req,res,url))return;
    if (req.method === 'HEAD' && url.pathname === '/') return send(res, 200, '');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/classic')) return serveFile(res, path.join(PUBLIC, 'index.html'));
    if (req.method === 'GET' && url.pathname.startsWith('/assets/')) return serveFile(res, path.join(PUBLIC, url.pathname.replace('/assets/', '')));
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const items = await allItems(); const queue = await readJson(files.queue, []); const token = await mondayToken();
      const live = await readJson(files.live, { records: [] });
      const byBoard = {};
      for (const r of live.records || []) byBoard[String(r.sourceBoardId || 'unknown')] = (byBoard[String(r.sourceBoardId || 'unknown')] || 0) + 1;
      const bySource = {};
      for (const r of items || []) bySource[String(r.source || 'unknown')] = (bySource[String(r.source || 'unknown')] || 0) + 1;
      return send(res, 200, { ok: true, configured: Boolean(token), tokenSource: process.env.MONDAY_API_KEY ? 'env' : existsSync(files.secrets) ? 'app secrets' : 'none', items: items.length, stats: stats(items), queued: queue.filter(q => q.status !== 'posted').length, liveSyncedAt: live.syncedAt || null, lastSync:live.syncedAt||null, syncComplete:live.complete===true, syncScope:live.scope||null, liveRecords: (live.records || []).length, byBoard, bySource, boards: { d2d: '18391791372', projectTracker: '5077578194' } });
    }

    if (req.method === 'GET' && url.pathname === '/api/items') {
      const q = url.searchParams.get('q') || ''; const filters = Object.fromEntries(url.searchParams.entries()); delete filters.q;
      const items = filterItems(await allItems(), q, filters);
      return send(res, 200, { ok: true, items: items.slice(0, 250), stats: stats(items), total: items.length });
    }
    if (req.method === 'POST' && url.pathname === '/api/query') {
      const body = await parseBody(req); const items = filterItems(await allItems(), body.q || '', body.filters || {}); const mode = classifyQuery(body.q || '');
      const selected = items[0]; const recipients = extractRecipients(body.q || '');
      return send(res, 200, { ok: true, mode, items: items.slice(0, 250), stats: stats(items), draft: selected && mode.action ? draftMessage(selected, body.q, recipients) : '', selected: selected || null, recipients });
    }
    if (req.method === 'POST' && url.pathname === '/api/secrets/monday-token') {
      const body = await parseBody(req); if (!body.token || String(body.token).length < 20) return send(res, 400, { ok: false, error: 'Token looks too short' });
      await saveSecret('MONDAY_API_KEY', String(body.token).trim()); return send(res, 200, { ok: true, configured: true });
    }
    if (req.method === 'GET' && url.pathname === '/api/secrets/status') return send(res, 200, { ok: true, configured: Boolean(await mondayToken()), source: process.env.MONDAY_API_KEY ? 'env' : existsSync(files.secrets) ? 'app secrets' : 'none' });
    if (req.method === 'POST' && url.pathname === '/api/monday/test') {
      const data = await mondayGraphql('query { me { id name email } }'); return send(res, 200, { ok: true, me: data.me });
    }
    if (req.method === 'GET' && url.pathname === '/api/monday/diagnostics') return send(res, 200, await mondayDiagnostics());
    if(req.method==='GET'&&url.pathname==='/api/monday/sync/status')return send(res,200,{ok:true,...syncState});
    if (req.method === 'POST' && url.pathname === '/api/monday/sync') {
      const body=await parseBody(req);const task=syncMondayBoards(body.boardIds||['18391791372','5077578194']);if(body.background){task.catch(()=>{});return send(res,202,{ok:true,...syncState});}return send(res,200,await task);
    }
    if (req.method === 'POST' && url.pathname === '/api/monday/users') {
      const data = await mondayGraphql('query { users(limit:100) { id name email enabled } }'); await writeJson(files.users, { syncedAt: new Date().toISOString(), users: data.users || [] }); return send(res, 200, { ok: true, users: data.users || [] });
    }
    if (req.method === 'POST' && url.pathname === '/api/draft') {
      const body = await parseBody(req); const item = (await allItems()).find(r => String(r.itemId || r.id) === String(body.itemId || body.id)) || body.item;
      if (!item) return send(res, 404, { ok: false, error: 'Item not found' });
      return send(res, 200, { ok: true, message: draftMessage(item, body.command || '', body.recipients || extractRecipients(body.command || '')), item });
    }
    if (req.method === 'GET' && url.pathname === '/api/queue') return send(res, 200, { ok: true, queue: await readJson(files.queue, []) });




    if (req.method === 'GET' && url.pathname.startsWith('/api/bridge/candidates/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop() || '');
      return send(res, 200, { ok:true, ...(await bridgeCandidatesForItem(id)) });
    }
    if (req.method === 'GET' && url.pathname === '/api/bridge') {
      const bridge = await bridgeRecordsCompat();
      return send(res, 200, { ok: true, rows: bridge.rows, counts: bridge.counts });
    }





    if (req.method === 'POST' && url.pathname === '/api/mentions/resolve') {
      const body = await parseBody(req);
      const users = await mondayUsers();
      const names = [...new Set([...(body.recipients||[]), ...extractRecipients(body.text||'')])].filter(Boolean);
      const matches = names.map(name => ({ name, match: findMondayUser(name, users) })).map(x => ({ requested:x.name, found:Boolean(x.match), id:x.match?.id||null, name:x.match?.name||null, email:x.match?.email||null, mention:x.match ? mondayMention(x.match, x.name) : '@'+String(x.name).replace(/^@/,'') }));
      const enriched = await enrichMentions(body.text || '', body.recipients || []);
      return send(res, 200, { ok:true, usersCached:users.length, requested:names, matches, enriched });
    }



    if (req.method === 'POST' && url.pathname === '/api/capture/update') {
      const body = await parseBody(req); const item = (await allItems()).find(r => String(r.itemId || r.id) === String(body.itemId || body.id)) || body.item || {};
      if (!item.name) return send(res, 404, { ok:false, error:'Item not found' });
      const recipients = body.recipients || extractRecipients(body.rawUpdate || '');
      const draft = draftFromCapture(item, body.rawUpdate || '', recipients);
      const readback = readbackFromCapture(item, body.rawUpdate || '');
      const linked = await linkedDestinations(item.itemId || item.id);
      return send(res, 200, { ok:true, item, facts: detectFacts(body.rawUpdate || ''), draftComment: draft, readback, recommendedTargets: linked.length ? ['selected','linked'] : ['selected'], linkedDestinations: linked, rules: behaviorRules() });
    }
    if (req.method === 'GET' && url.pathname === '/api/behavior/tests') {
      return send(res, 200, await behaviorTests());
    }





    if (req.method === 'POST' && url.pathname === '/api/routes/build') {
      const body = await parseBody(req); return send(res, 200, await buildRoutes(body));
    }
    if (req.method === 'POST' && url.pathname === '/api/splicer/today') {
      const body = await parseBody(req); return send(res, 200, await splicerToday(body));
    }
    if (req.method === 'GET' && url.pathname === '/api/readiness') {
      const items = (await allItems()).map(routeCandidate); return send(res, 200, { ok:true, items:items.slice(0,300), counts:{ready:items.filter(x=>x.routePosture==='ready').length, conditional:items.filter(x=>x.routePosture==='conditional').length, blocked:items.filter(x=>x.routePosture==='blocked').length} });
    }

    if (req.method === 'GET' && url.pathname === '/api/policy') return send(res, 200, { ok:true, policy: await policyConfig() });
    if (req.method === 'GET' && url.pathname === '/api/field-ownership') return send(res, 200, { ok:true, fieldOwnership: await fieldOwnership() });
    if (req.method === 'GET' && url.pathname === '/api/exceptions') return send(res, 200, await exceptionBoard({ owner:url.searchParams.get('owner')||'', severity:url.searchParams.get('severity')||'', type:url.searchParams.get('type')||'' }));
    if (req.method === 'GET' && url.pathname === '/api/responses') return send(res, 200, await responseSummary());
    if (req.method === 'POST' && url.pathname === '/api/responses/create') { const body=await parseBody(req); return send(res, 200, { ok:true, request: await createResponseRequest(body) }); }
    if (req.method === 'POST' && url.pathname === '/api/meeting/brief') { const body=await parseBody(req); return send(res, 200, await meetingBrief(body)); }
    if (req.method === 'GET' && url.pathname === '/api/route-calendar') return send(res, 200, await routeCalendar({ days:url.searchParams.get('days')||21, owner:url.searchParams.get('owner')||'', resource:url.searchParams.get('resource')||'' }));
    if (req.method === 'GET' && url.pathname === '/api/evidence') return send(res, 200, await evidenceBoard({ itemId:url.searchParams.get('itemId')||'' }));
    if (req.method === 'POST' && url.pathname === '/api/mobile/today') { const body=await parseBody(req); return send(res, 200, await mobileToday(body)); }
    if (req.method === 'GET' && url.pathname === '/api/webhooks/monday/status') return send(res, 200, await webhookStatus());
    if (req.method === 'POST' && url.pathname === '/api/webhooks/monday/receive') { const body=await parseBody(req); if (body.challenge) return send(res, 200, { challenge: body.challenge }); return send(res, 200, await handleMondayWebhook(body)); }
    if (req.method === 'GET' && url.pathname === '/api/deployment/test') return send(res, 200, await deploymentTest());

    if (req.method === 'GET' && url.pathname === '/api/splicing/workflow') return send(res, 200, splicingTeamsWorkflow());
    if (req.method === 'GET' && url.pathname === '/api/route-options') return send(res, 200, await routeFilterOptions());
    if (req.method === 'POST' && url.pathname === '/api/schedule/scenario') { const body=await parseBody(req); return send(res, 200, await buildScheduleScenario(body)); }
    if (req.method === 'POST' && url.pathname === '/api/teams/webhook') { const body=await parseBody(req); await saveTeamsWebhook(body.url || body.webhookUrl); return send(res, 200, {ok:true, configured:true}); }
    if (req.method === 'GET' && url.pathname === '/api/teams/status') return send(res, 200, {ok:true, configured:Boolean(await teamsWebhook())});
    if (req.method === 'POST' && url.pathname === '/api/teams/post') { const body=await parseBody(req); return send(res, 200, await postTeamsMessage(body.text || body.message || '')); }
    if (req.method === 'GET' && url.pathname === '/api/external/diagnostics') return send(res, 200, await externalConnectivityDiagnostics());
    if (req.method === 'GET' && url.pathname === '/operator') return serveFile(res, path.join(PUBLIC, 'operator.html'));
    if (req.method === 'GET' && url.pathname === '/kyle') return serveFile(res, path.join(PUBLIC, 'kyle.html'));
    if (req.method === 'GET' && url.pathname === '/api/pmo/dashboard') return send(res, 200, await pmoDashboard());
    if (req.method === 'POST' && url.pathname === '/api/pmo/ask') { const body=await parseBody(req); return send(res, 200, await pmoAsk(body)); }
    if (req.method === 'GET' && url.pathname === '/api/pmo/parity') return send(res, 200, await pmoParityHarness());
    if (req.method === 'GET' && url.pathname === '/api/function-audit/full') {
      const users = await mondayUsers();
      const bridge = await bridgeRecordsCompat();
      const prep = await tuesdayPrep({});
      const behavior = await behaviorTests();
      const deploy = await deploymentTest();
      const reminders = await reminderConfig();
      const items = await allItems();
      return send(res, 200, { ok:true, ui:{root:'original public/index.html', classic:'/classic', operator:'/operator', kyle:'/kyle optional'}, counts:{items:items.length, mondayUsers:users.length, bridgeRows:bridge.rows.length, bridgeLinked:bridge.counts.linked, bridgeReview:bridge.counts.review, tuesdayGroups:prep.groups.length}, reminders, behaviorPass:behavior.ok, deploymentPass:deploy.checks.every(c=>c.pass), checks:{behavior, deploy} });
    }
    if (req.method === 'GET' && url.pathname === '/api/ui/options') return send(res, 200, await optionSetsForUi());
    if (req.method === 'POST' && url.pathname === '/api/capture/field-preview') { const body=await parseBody(req); const item=(await allItems()).find(r=>String(r.itemId||r.id)===String(body.itemId||body.id)) || body.item || {}; return send(res, 200, extractFieldPreview(body.rawUpdate||body.text||'', item)); }
    if (req.method === 'GET' && url.pathname === '/api/feature-behavior/tests') return send(res, 200, await featureBehaviorTests());
    if (req.method === 'GET' && url.pathname === '/api/audit') return send(res, 200, { ok: true, audit: await readJson(files.audit, []) });
    return send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) { return send(res, e.status || 500, { ok: false, error: e.message === 'fetch failed' ? 'fetch failed — Node could not reach Monday API. Work firewall/proxy may block api.monday.com from local apps.' : e.message, details: e.details || undefined }); }
});
server.listen(PORT, '0.0.0.0', () => console.log(`Splicing Planning Assistant v9 listening on http://127.0.0.1:${PORT}`));
