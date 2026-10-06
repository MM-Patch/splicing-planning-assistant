import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

test('UI controls are not orphaned', async()=>{
 const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
 assert.match(html,/onclick="run\(\)"/);
 const ui=await readFile(new URL('../public/workflow-ui.js',import.meta.url),'utf8'); assert.match(ui,/applyTuesdayFilters/);
 assert.match(html,/id="scheduleBoardExport"[^>]*readonly/);

 assert.match(html,/onclick="copyScheduleBoardExport\(\)"/);
 assert.match(html,/onclick="openSettings\(\)"/);
 const kyle=await readFile(new URL('../public/kyle.html',import.meta.url),'utf8');
 assert.match(kyle,/id="routeExport"[^>]*readonly/);
});
