# Railway Nooks capture

This component lives in `mchien-truewind/leads-update` alongside the existing
Slack/HubSpot application. Build the two SDR services with
`cloud/sdr/Dockerfile`; the repository root Dockerfile and npm startup continue
to serve the existing application. This source transfer does not change Railway
service source pins, credentials, volumes or live completion configuration.

Two isolated services provide a stable public webhook and private signature
verification. With default configuration this captures the original test contact
only. Optional supervised exact-task completion requires the separate scope and
approval configuration below. No scheduling, enrollment or dialing is implemented.

Use the existing `ai-sdr` Railway project and its production environment, adding
`nooks-receiver` and `nooks-verifier`. Preserve the existing `sdr-bridge`, its
domain, credentials, PostgreSQL and data. Both new services build this directory's
Dockerfile from the exact independently reviewed GitHub commit. Set one replica
per service, healthcheck `/healthz`, port 8080, no sleep, no cron. Expose only the
receiver with a Railway-generated domain; the verifier uses private networking.

## Configuration

Both services need `SDR_ROLE` (`receiver` or `verifier`) and `CAPTURE_SCOPE`, a
non-secret JSON object with `workspace_id`, `prospect_id`, `not_before` and
`expires_at`. Timestamps are integer UTC seconds; the window is at most 48 hours.
The prospect must be the explicitly selected HubSpot contact in the configured
Nooks workspace. Capture cannot prove that CRM relationship: independently verify
the Nooks record's HubSpot link before any later completion is authorized.
Unknown/mismatched prospect IDs are rejected. Scope changes cannot overwrite an
existing durable inbox without an explicitly reviewed migration.

The receiver requires a new dedicated volume mounted at `/data` (start with
500 MB) and `VERIFIER_URL=http://nooks-verifier.railway.internal:8080`. It refuses
ephemeral storage. Configure the verifier's private endpoint as `nooks-verifier`.
The receiver holds an exclusive volume lock. SQLite transactions use FULL
synchronization; ACK follows commit. Duplicate call IDs are idempotent, changed
replays and additional calls hold the test, and the inbox is bounded to 100 calls.
It stores only normalized IDs, timestamps and a disposition label, never raw
webhooks, notes, recordings, signatures, email addresses or phone numbers.

Railway mounts volumes as root. The cloud-only launcher initializes the new
state directory, then drops privileges before serving: UID502 for the receiver,
UID503 for the verifier. It rejects non-Linux or non-Railway execution. Development
and tests on the Mini remain under agentwork UID502; no sudo is used there.

## Identity and secrets

On first boot the receiver generates an Ed25519 identity into a private file on
its own persistent volume. `/identity` returns only its public key. After checking
the actual Railway service, domain and deployed source revision, pin that public
key in the verifier's `RECEIVER_PUBLIC_KEY`. Do not automatically repin a changed
identity. A replaced volume requires deliberate identity review. Never inspect,
return or export the private key using agent tools.

The receiver signs the operation, audience, method/path, timestamp, nonce, body
digest and Nooks signature header. The verifier authenticates this before parsing
Nooks content. A bounded in-memory nonce/rate cache rejects recent repeats;
the durable receiver inbox deduplicates calls across either service's restart.
Private requests have a fixed host/port, no redirects, no environment proxies,
bounded body/response sizes and a total exchange deadline.

Only the verifier gets `NOOKS_SIGNING_KEY`. The user enters it privately in
Railway's Variables UI; the agent never retrieves or transfers its value. Do not
copy credentials from the Mini or existing bridge. No lemlist or HubSpot keys,
Railway tokens or old admin tokens are passed to the receiver. Request bodies,
authentication headers and exceptions are not logged. Access logging is off.

## Registration and cutover

1. Deploy both services and verify the exact revision, receiver domain, one
   replica and mounted volume. Pin the receiver public key as described above.
2. When the user is ready to save the stable Nooks URL, set the receiver's
   `REGISTRATION_ID` to a fresh 32-character lowercase hex identifier and
   `REGISTRATION_DEADLINE` to a UTC epoch no more than one hour ahead. This is a
   public one-shot setup ACK, not authentication. Normal signed verification
   runs first, so a real selected-contact call is captured during setup too.
   The setup fallback accepts only an empty probe or a completed inbound/outbound
   call-shaped probe with explicit workspace/prospect IDs outside this test's
   selected pair. Selected or ambiguous calls that fail verification receive
   retryable errors and never consume setup. No out-of-scope probe is retained.
   The consumption record survives restart; expiry does not crash the service.
3. Save `https://<verified-railway-domain>/api/sdr/webhooks/nooks` in Nooks once.
   If Nooks issues a new signing key, the user stores it privately on the verifier.
   Close setup by clearing both registration variables to empty/zero and deploy.
   `/ready` must show `registration_open:false` and `verifier_ready:true`.
4. Preserve the local test journal; stop local ingress and never run the local
   completion command against this cloud experiment. No dual workers exist in
   this release. A later hosted completion release must reconcile the selected
   lemlist task afresh and consume this durable inbox under independent review.
5. Receive a real finalized call for the selected contact. Verify successful
   signed capture, duplicate delivery and retained count/identity after redeploy.
   A healthy process, generated URL or setup ACK does not prove signed capture.

Public health, readiness, identity and aggregate event count expose no contact
records. There is no public event-read, arm, completion or provider forwarding
endpoint. The optional worker accesses normalized durable evidence internally.

Recovery: preserve the receiver volume and key identity. Roll back to the prior
reviewed source revision using Railway without reverting unrelated settings or
credentials. The local experiment's source/state and original blocked controller
task remain intact. Do not restore old configuration over later operator changes.

## Validation

From the repository checkout under `/Users/agentwork/apps`, as UID502:

```
python3 -m venv .venv
.venv/bin/python -m pip install -r cloud/sdr/requirements.txt
.venv/bin/python -B -m unittest discover -s tests -p 'test_cloud*.py' -v
```

Run `DOCKER_HOST=unix:///path/to/isolated/docker.sock .venv/bin/python -B tests/cloud_container_smoke.py` against a dedicated agentwork-owned Docker daemon for the Linux smoke check. It builds only cloud source, uses disposable containers/volume/network with dummy credentials, verifies UID/GID dropping, private HTTP verification, signed capture and volume reuse, and removes its test resources. It never mounts host directories.

Tests use dummy keys and real cryptography, in-process HTTP transport and temporary
SQLite. They do not call providers, dial or complete any task. Cloud verification
also requires an actual mounted volume, private network, installed public-key
pin, private signing-key entry and real Nooks event.


## Optional supervised lemlist completion

Do not activate this worker merely because the receiver is healthy. Deploy only
an independently reviewed worker revision with explicitly authorized configuration.

Both services require identical non-secret LEMLIST_TEST_SCOPE JSON, pinning
hubspot_contact_id, campaign_id, sequence_id, call_step_id, continuation_step_id,
task_id, lead_id, contact_id, assigned_rep_id, workspace_id, starts_at and expires_at.
The capture scope's workspace/prospect/window must match exactly. Use only the
selected test, and preserve its expiry; this is not a grant renewal.
When LEMLIST_TEST_SCOPE is configured, the verifier also requires its own dedicated
/data volume, separate from the receiver. The cloud launcher initializes its
private state directory as UID503. Missing storage prevents startup. Never replace
this volume to reset a claim; it contains the immutable test scope and write claim.
The private verifier alone receives LEMLIST_API. A reference to the existing
Railway credential expands access to that service and requires authorization
and review; never read the value, send it to the receiver, or change the legacy
service's variable. Scoped readback must establish the expected account records.

With the scope present and COMPLETION_APPROVAL absent, the receiver's background
worker can only inspect and arm the test. It must arm before the controlled call.
It repeats the exact CRM, unpaused lead/running campaign, assigned owner, pending task and
two-manual-step sequence checks through the private broker. The worker stores
its initial evidence in the same durable SQLite database as signed events.
Missing keys, mismatched scope, suppressed or paused leads, existing continuation
tasks, or changed sequence structure prevent arming. It never resets old state.

This is the user's authorized empirical one-task experiment, ported from the
installed `test_flow` contract. The approved task ID is the mutation target; its
expected originating step is a hypothesis until the completion activity proves
it afterward. Missing provider step IDs remain null, never inferred from a title
or sequence order. A known conflicting step or sequence prevents dispatch. This
exception applies only to the supervised, expiring, single-task approval; it does
not establish an immutable production task-to-step mapping or enable a general
completion queue. The original task, owner, CRM contact and two-manual-step test
campaign are independently checked immediately before the one permitted write.

After the real finalized call is durably captured, a bounded private Railway log
record named sdr_test_awaiting_confirmation reports only call_id, rep_id,
disposition_id and event_digest. Logs are diagnostics, not approval evidence.
Confirm the actual Nooks-to-HubSpot record, caller and non-suppressing disposition
in the account UI. Never infer safe completion from a disposition's name alone.

Only then configure identical COMPLETION_APPROVAL JSON on both services with
call_id, rep_id, disposition_id, event_digest, policy_digest, confirmed_contact:true and
confirmed_non_suppressing_disposition:true. These flags attest real operator/account
evidence. First deploy the private verifier's exact approval and wait for success;
then deploy the receiver's matching approval. Enabling the receiver first can
consume its single claim while the private broker still rejects the write.

The worker commits its claim before the one permitted PATCH /api/tasks operation.
It serializes accepted conflicting calls against dispatch in a worker thread;
waiting ingress storage cannot block the ASGI event loop. The private broker
rechecks the exact scope and provider state at dispatch and never launches,
resumes or skips a step. HTTP cancellation cannot release its in-flight write lock. Before dispatch, the
private verifier independently commits a FULL-synchronous SQLite claim binding
the scope and exact approval. Every later request performs inspection only, even
if the first attempt failed before sending, timed out, or the verifier restarted.
Changing the approval or scope cannot reset this claim.

The worker independently reads back task done, manualDone activity matching that
exact opportunity/sequence/expected call step, and a newly pending continuation
task. A missing continuation task or mapping remains observing, not verified.
Unknown continuation step IDs remain null. A newly pending task in the unchanged
two-step test sequence proves observable progression, not an invented immutable
binding for that next task. External task completion is held.
A timeout/crash after the committed claim permits only inspection, never another
PATCH. Without the original successful write receipt, subsequent matching state
is labeled observed_after_uncertain_write. Reads can reconcile after expiry;
mutation cannot resume. Changed or additional calls hold all further work.

The private transport uses only https://api.lemlist.com and exact allowed paths
and parameters, disables environment proxies/redirects, bounds reads and time,
and excludes raw provider errors/contact fields from results and logs. The same
private Ed25519-authenticated connection protects inspect/complete operations.
No public mutation route exists. Keep the old local completion command unused.

Run `python -B -m unittest discover -s tests -p 'test_cloud*.py' -v` for mocked
provider/ASGI and durable-state coverage, including cancellation, duplicate calls,
suppression, changed sequence/owner, uncertain writes and independent progression
evidence. These do not establish a completed live test. The current selected contact has
unknown lead-stage evidence in the installed adapter. The hosted contract now
reads GET /api/leads?id=<pinned lead> and requires exact lead/campaign/contact IDs
and isPaused:false, alongside a due task, running campaign and unsubscribed:false.
It never converts an unknown stage to running; known blocking stages still fail.
The provider documents isPaused in [Get Lead by Email or ID](https://developer.lemlist.com/api-reference/endpoints/leads/get-lead-by-email-or-id).
This additional scoped read still needs live validation before activation. Prior
live task readback omitted stepId. The supervised test verifies that missing link
afterward through the exact task's manualDone activity; unknown or conflicting
activity evidence cannot yield a verified result.


## Reviewed disposition and caller mapping

Before completion, both services require identical non-secret NOOKS_DISPOSITION_POLICY
JSON with workspace_id, nooks_rep_id, lemlist_rep_id and dispositions. These are
verified account IDs, not names. The lemlist rep must match the pinned task owner.
The dispositions object maps each reviewed Nooks ID to complete, suppress or hold.
A complete mapping makes the event eligible for the supervised one-call approval;
it does not itself enable completion. Suppress holds the test with
suppression_required and does NOT claim that provider suppression was performed.
Hold, unknown IDs and other callers also hold without a lemlist write.

The receiver may arm and capture the first controlled call without a policy to
discover the account IDs, but it reports awaiting_mapping and cannot complete.
The first explicitly configured policy binds once while the test is still armed
and has no write claim. If configured before arming, it is persisted at arm time.
Changing a bound policy fails closed; there is no reset operation. The approval includes policy_digest, the
SHA-256 of canonical policy JSON, alongside the existing exact signed-event digest.
Both receiver and private service independently enforce that mapping before a
write claim. Removing configured policy prevents a new worker approval.

Display names remain useful for operator inspection but never decide outcomes.
No real disposition/caller IDs have been configured. The first controlled call
still requires actual account mapping and the explicit prospect/disposition
confirmation; no provider suppression, scheduling or bulk completion is enabled.

The end-to-end tests in test_cloud_dispositions.py send actual signed bytes through
both HTTP apps, persist normalized evidence, complete the exact mocked task and
independently observe progression. They cover duplicate delivery/restart, forged
requests, unfinalized calls, unmapped IDs, misleading names, do-not-call, other reps,
policy changes and missing continuation. Only provider transport is mocked.


## Explicit one-time test retarget

A user-authorized contact correction can set identical non-secret `TEST_RETARGET`
on both services. Its exact fields are `from_scope` (the complete old
`LEMLIST_TEST_SCOPE`), `to_scope` (the complete replacement scope), `call_id` (the
single existing Nooks call), and `confirmed_contact: true`. Only the HubSpot
contact, lemlist contact, lead and task IDs may change. Campaign, sequence, steps,
rep, workspace and both time boundaries must stay identical; expiry is not renewed.
Read back the new CRM/task mapping before preparing this plan.

The old receiver must be armed with an empty inbox, no hold, no bound disposition
policy and no completion attempt. The private ledger must also be unclaimed.
Each service atomically archives its complete original row in `retarget_history`
before selecting the new scope. No volume, identity or claim is removed or reset.
Take the receiver owner lock before migration. A changed plan, removal of a stored
plan, or a second retarget is rejected. Retired receiver objects cannot append
calls or rearm the old scope.

Deploy the private service's reviewed source, plan and matching new scopes first,
then deploy the receiver with the identical plan/scopes. Keep completion approval
and disposition policy absent until a real signed redelivery of the pinned call
has been verified. An activity visible in HubSpot is not a signed webhook receipt.
The new task is inspected and armed with its actual current timestamp. Only this
explicitly pinned prior call may predate that new arming; the original time window,
signature freshness, disposition policy, exact-event confirmation and private
claim remain required. Delivery may precede the new worker's initial inspection;
only the single pinned event is eligible and a failed provider preflight prevents
arming. Other call IDs are rejected at both ingress and claim boundaries.

Preserve both volumes and the exact plan on restarts. If either rollout fails,
keep completion disabled and finish or repair that same migration. Do not restore
old scopes over an archived test, invent callback evidence, or repeat a provider
write. After a successful or uncertain completion, all recovery is readback only.
