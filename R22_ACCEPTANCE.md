# R22 acceptance repair — not production readiness

Scope: R21's inspector latency, Tuesday review narrowing, storage blocker and
safe write preparation only. No automatic Tuesday sending or Teams delivery.

## Inspector

Selection paints the already-loaded, timestamped full live batch immediately,
including bridge and readiness; it does not pretend to issue a new Monday read
on each click. Source sync is still explicit. The old path waited sequentially
for `/api/item/:id` and `/api/ui/options` and recreated all 3,101 records on each
request. Now dropdowns are derived synchronously from that batch, server record
arrays are cached by file inode/mtime/ctime/size, and selection updates only card
highlighting instead of rebuilding the whole list/calendar/filter controls.
Explicit detail refresh uses an epoch guard and captures edits at response time.

Acceptance target: **<2,000 ms from card click to matching editable inspector**,
including two animation frames. `tests/inspector-live.mjs` requires real complete
live observations and performs five actual clicks on each board, checks blank
inspector, stale-response draft isolation and JavaScript errors. It refuses all
non-GET API calls. It records full measured evidence in ignored `test-results`.
Initial page load is separately measured, not mislabeled selection latency.

## Tuesday

Default next 14 days; AND-combinable filters for this week, missing/stale update,
owner needed, blocked source status, unknown/failed readiness gates, observed
RFS/install changes, PM/owner/resource, source board and verified vs primary-only.
Group by owner or resource. Show total/filtered counts; >50 prompts more narrowing,
never silent truncation. Week is Monday–Sunday in Chicago; date window matches
RFS OR install; missing dates excluded from due windows. All-candidates option
is explicit. Date changes require two completed source observations and show
baseline unknown otherwise; a generic item update is not date-change proof.

Each row/message retains project names, board/item IDs, dates, blocker/action,
update age, PM/resource and verified destination when available. Filter changes
warn before discarding edited messages. Preview/copy/export do not send. Queue
is app-only and explicitly not durable. Existing simulated dedup tests remain.

## Remaining gates

See `STORAGE_PLAN.md`: managed Render Postgres recommended; no provisioning or
durability claim. API and UI flag the production blocker. Request audit records
contain target IDs, recipient, message, timestamp, status and idempotency key.

`scripts/prepare-live-write.mjs` prepares primary-only dry runs, records exact
manifest fields and readback/retry steps; it has **no execution branch**. Patch
must approve exact sacrificial IDs and exact comment before a separately reviewed
live test. Mock primary/dual-post tests verify update ID/content/item/board and
retry without another mutation. These are not live-write acceptance proof.
