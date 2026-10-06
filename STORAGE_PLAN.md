# R22 production blocker: durable delivery custody

**NOT PRODUCTION-SAFE.** Current queue, request deduplication, delivery ledger,
audit and live sync are JSON files on Render's ephemeral filesystem. Atomic
rename and a process-local lock prevent some single-process races; they do not
provide cross-instance transactions or survival across redeploys. A warm process
restart retaining the same filesystem is not proof of redeploy durability.
During R22 inspection the R21 hosted complete sync was absent; the service had
reverted to its packaged snapshot. No historical delivery ledger should be
assumed intact. Existing production delivery must remain blocked operationally.
The API `/api/storage/status`, `/api/build`, Tuesday Prep and Queue expose this
limitation. No paid infrastructure has been provisioned in this acceptance pass.

## Exact recommendation

Use **managed Render Postgres**, in the same region as the web service, using its
internal database URL via a secret `DATABASE_URL`. Select a paid production plan
with backups and an explicitly agreed retention policy. Do not treat the free
web service's local directory as durable, or SQLite on that directory as a fix.

Minimal migration:

1. `requests`: id, cycle, recipient, exact message, source board/item, target
   board/item IDs, created timestamp, status, **UNIQUE idempotency_key**.
2. `delivery_targets`: request FK, board_id, item_id, update_id, status, attempt
   timestamp, readback item/board/content, error; unique(request_id, board_id,
   item_id). One primary-only request first; verified pair later.
3. `audit_events`: immutable event ID, timestamp, actor/recipient, message,
   exact target IDs, status and idempotency key; append-only writes in the same
   transaction as request/target transitions. Restrict retention/access because
   these records contain operational messages.
4. Transactionally claim rows with `SELECT ... FOR UPDATE SKIP LOCKED`, commit
   an in-flight marker before the remote call. A lost response stays uncertain;
   never automatically reissue a potentially successful Monday mutation.
   A known update ID allows readback-only retry. A DB cannot provide atomic
   exactly-once behavior across an external Monday API call.
5. Export and reconcile existing JSON with Patch before import. Do not mark lost
   records unsent or replay them. Apply schema migrations with backups and a
   rollback path; disable delivery during cutover. Do not enable auto-Tuesday.

Release gate: persist a harmless queue fixture, restart, then deploy a new build;
verify identical key/message/targets/audit. Run two concurrent identical queue
requests and simulated send/retry failures; assert one request and at most one
mutation per target. Test backup restore and uncertain-state manual recovery.
Only after Patch approves exact sacrificial item IDs and exact comment may the
live primary/readback/retry acceptance execute. Verified-pair testing is separate.

Render persistent disks are a possible single-instance interim choice on an
eligible paid service, but require provisioning, mounting all custody files,
migration and restart/redeploy tests. No disk is configured or claimed here.

References: https://render.com/docs/disks and https://render.com/docs/postgresql
