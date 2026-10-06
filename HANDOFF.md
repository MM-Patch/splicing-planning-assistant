# Splicing Planning Assistant — R20 workflow handoff

## Scope and UI
Original dark shell, navigation, project list, inspector and optional meeting runner are retained. No RADAR/OCE or other PMO app changes. Monday is source truth. Embedded/packaged data is explicitly a snapshot, not a live connection.

New logic is in `lib/workflow.mjs`, `lib/workflow-server.mjs`, `lib/tuesday.mjs` and `public/workflow-ui.js`. Replaced browser handlers were removed from the original inline script rather than appended as duplicate definitions. Existing unrelated features remain.

## Implemented
- Generalized workflow bubbles, actual project single-click selection and one shared editor in the expanded meeting runner.
- Source board/item IDs, exact bridge information, local field controls, note extraction, draft review, primary/linked/both targeting, queue and confirmed post.
- Explicitly labelled local/draft/queued/dry-run/post/readback/partial-failure states. These are comment workflows; no Monday column mutation is implemented.
- Manual bridge only: name similarity never authorizes a dual post. Broken/ambiguous links block linked/both targets. Exact IDs are required.
- Delivery journal with per-target update ID and remote content/item/board readback; serialized requests within one server process. A failed/uncertain mutation is NOT blindly retried. Readback failure retries readback, not posting.
- Seven evidence gates: absent evidence is unknown, not pass. Source Ready is distinct from qualified dispatch. Explicit dated source references are required; structured `readinessEvidence` is supported. No arbitrary comment text is promoted to gate proof.
- Cached/live Monday people lookup; selected name/ID shown. Native mention delivery is intentionally unqualified/blocked. Text tags are explicitly labelled. API user lookup currently returns at most 100 users; full pagination remains needed for larger accounts.
- Schedule fields for job type, date, resource, duration, complexity, splicer count, state, access/materials, network dependency, partial scope and notes. Local persistence, manual ordering, date/resource/market sequencing, approximate city map links and Teams export. Not geocoded travel-time optimization or a dispatch commitment.
- Build API/visible label: version, commit, dirty state, environment, deployment time when supplied, tested Monday connectivity, last sync and source counts.

## Tuesday RFS — high-priority behavior
- Automatic timer disabled. Legacy reminder endpoints are preview-only even if old saved settings enabled auto-post.
- Preview groups stale/missing-update work by owner, falling back to resource. Per-person message editable; each selected item receives exactly the displayed group message. Review group content if only a subset is selected.
- Each row shows source/linked IDs, dates, status/evidence score, blocker/action and update age (unknown when date unparseable).
- Preview all, Queue selected, Copy selected, Send selected manually, Mark sent externally, Export request list.
- Dedup key: Tuesday-start UTC week + recipient + item ID + exact primary board/item delivery target. No automatic timezone schedule. Explicit future timezone changes must preserve dedup semantics.
- Queue does not send. Manual send requires confirmation and exact source IDs. Mark sent externally is an attestation, NOT a Monday readback claim. Audit records preview, queue, copy/export preparation, sending and duplicate blocking.
- Live sends use the exact primary source record only. Linked destination is visible; Tuesday both-board send is deferred rather than silently inferred.

## Verification commands
```sh
npm ci
npm run check
npm test
npm run test:browser
APP_URL=https://splicing-planning-assistant.onrender.com EXPECTED_COMMIT=<full-sha> npm run test:hosted
```
Browser defaults to macOS Google Chrome; set BROWSER_EXECUTABLE for another installed compatible Chromium executable. Browser tests isolate data using SPA_DATA_DIR and do not load local Monday secrets. Tests use synthetic projects for local acceptance. Mock Monday mutation/readback tests are simulations, NOT live writeback proof.

Outputs: `test-results/browser-results.json`, `delivery.test.mjs` test output, screenshots, `test-results/hosted-results.json`. Test artifacts are ignored, not committed. A failing hosted deployment check cannot be replaced with local PASS.

## Remaining / deferred before production signoff
- Approved sacrificial live comment/readback on one verified pair and real native mention evidence. No operational posts authorized or executed during this work.
- Readiness evidence adapters for actual board columns/comments. Current unqualified source records deliberately show unknown; do not infer seven passed gates from status.
- Full natural-language reasoning and multi-project transcript extraction are not proven; extraction is deterministic and human-reviewed. Invalid/conflicting date proposals are withheld.
- Production SSO/authentication and external webhook authentication review remain outstanding. Existing inbound webhook automatic mutation is paused: without authenticated events and shared dedup it could echo the new dual posts and create duplicates. Challenge handling remains; events do not post. Do not equate an exposed endpoint with a verified mirror subscription.
- Durable delivery/queue/audit storage. Render free ephemeral filesystem is NOT durable across redeploys. Use a persistent SPA_DATA_DIR and one worker, or migrate journal/queue locking to a transactional database before relying on dedup across deployment or replicas. Do not claim global exactly-once delivery.
- Existing live sync may be capped; a count of loaded records is not completeness proof. User lookup pagination >100 remains deferred.
- Tuesday messages with multiple projects require human content/target review. There is no unattended sending.
- Existing alternate `/operator` and `/kyle` are not acceptance surfaces and do not replace `/`.

## Exact safe live-write procedure
1. Obtain Patch's explicit approval of sacrificial board/item IDs and exact comment, plus any intended notification recipients. Do not use an operational item implicitly.
2. Verify the hosted commit and durable storage; confirm both records and bridge IDs with Monday. Capture pre-test update IDs.
3. Dry-run chosen destination. Show full text, board/item IDs, dedup key. For mentions, label text tags; do NOT promise native notification.
4. User confirms one post. Record each returned update ID; read back its item, board and body. Partial write/readback failure is not success.
5. Retry identical approved request; verify no new update is created. If a mutation timed out before returning an ID, inspect Monday externally and reconcile the journal before any further post.
6. Document actual results and any remaining gaps. Do not delete/update real records during cleanup without authorization.

## R20 test observations (2026-10-05)
- Local domain/delivery suite: 12 tests passed. Monday responses here are simulated; they prove control logic, not remote service behavior.
- Local served browser suite: 11 grouped scenarios passed, including all ten generalized workflow buttons, actual single/double clicks, extraction/draft, bridge denial/dry-run, cached user IDs, manual Tuesday queue/copy/export/dedup, and three-job schedule.
- A real async selection race was reproduced and corrected: old source loads could clear newly typed notes. Editors now disable until loading completes, and stale loads are rejected.
- Hosted pre-deployment probe returned 404 for `/api/build`; therefore the prior hosted version was NOT R20. A subsequent hosted test must be recorded separately after deployment.
- No live Monday comment, native notification, operational field write or Teams delivery performed.

## R21 live-source qualification (2026-10-05)
- R20 deployment was proven, but its single large Monday query timed out, leaving only packaged records.
- Sync now exhausts cursor pages for D2D 18391791372 and Tracker 5077578194, 50 items per query, and atomically publishes a complete batch. UI starts background sync and displays progress; status is `/api/monday/sync/status`.
- A complete batch replaces (does not union with) packaged snapshots. Source mode, timestamps and per-board counts are shown. Tuesday preparation excludes packaged records. Scope: active board items, latest five updates/item, not subitems.
- Bridge verification accepts exact explicit relations, or D2D relation → linked FTTH record's exact Project ID → unique Tracker Project ID. Evidence includes source column, intermediate board/item, ID, timestamp. Name similarity never verifies. Ambiguous many-to-one/one-to-many mappings remain unmatched/primary-only.
- Initial read-only source investigation found 419 D2D and 2,682 Tracker items. These are not hosted deployment proof; hosted sync must be run after deploy.
- Safe live-write preparation: choose explicitly approved sacrificial item IDs AND exact text first; primary dry-run must show board/item/text, then confirmed post, then remote readback verifies update ID, body, item and board. Retry uses the same delivery key and does not blindly repost uncertain mutations. Until approved, use dry-run only. No native mention delivery or live writeback is claimed by local fixture tests.
- Automatic Tuesday sending stays disabled. Queue/copy/export do not post. Queues on Render's ephemeral filesystem are not durable across deployments; do not treat this as production persistence.
- Adversarial source review caught a shared project code mapping a D2D zone to a POP-fence sub-scope. Exact Project ID alone is insufficient. Indirect automatic bridges additionally require equivalent normalized project scope/name (only housing descriptors/counts/punctuation removed). Mismatched scope and duplicate parent/child mappings stay unverified. Direct board relations remain explicit evidence. A regression test covers the shared-code/different-scope case.
