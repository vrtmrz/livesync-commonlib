---
date: 2026-10-23
commonlib-version: "0.1.44"
self-hosted-livesync-version: "1.0.39"
status: accepted-unreleased
---

# Design: Corrected V3 Chunking and Initial Replication

## Purpose and implementation status

The [ADR](../adr/2026_10_chunking_and_transport_batching.md) selects proportional
rule A within `v3-rabin-karp`, a common new-configuration recommendation of 0,
complete initial reception, and native uploads. This document defines the
implementation boundaries and checks needed to deliver that decision.

| Work | Status |
| --- | --- |
| Continuous Rabin–Karp window | Implemented in the unpublished candidate |
| Full-current-leaf Fast Fetch | Implemented in the unpublished candidate |
| Fresh-import checkpoint handoff | Implemented in the unpublished candidate |
| Rule A in V3 | Implemented and regression-tested |
| New-setup and Doctor recommendation alignment | Implemented and tested; existing values retained |
| Rule-A packed-writer, mixed-writer, and host validation | Local package, CLI transport matrix, and Linux Obsidian checks pass |
| Upload batching, general Fast-forward, and Cloudant certification | Outside this implementation |

No additional splitter version, persistent migration marker, automatic Rebuild,
or phase-specific preset is part of this design.

## Chunking contract

### Continuous rolling hash

The 48-byte Rabin–Karp window follows the input position. Moving the current
Chunk's start does not restart the removal of outgoing bytes or reset the
rolling state. Boundary selection and byte reconstruction remain separate
assertions.

### Proportional binary thresholds

Retain the existing maximum calculation and floor. For the binary path:

```text
requestedMaximum = floor(102400 * (customChunkSize + 1))
M = min(4 MiB, max(30 KiB, requestedMaximum))
minimum = min(M, max(minimumChunkSize, floor(M / 4)))
candidateGap = max(1, floor(M / 4))
naturalBoundary = length >= minimum && unsignedHash % candidateGap == 1
forcedBoundary = length >= M
```

These equations describe the normal non-negative setting domain and the
existing explicit minimum override. They do not introduce a new setting-input
normalisation policy. Preserve current handling outside that domain and cover
accepted edge values before changing it.

At the normal `minimumChunkSize=20`, values 0 and 1 now allow content-defined
boundaries before their 100 and 200 KiB maxima. The maximum remains a forced
cut, rather than a target which triggers recursive splitting. The existing
UTF-8 safeguard may extend a text boundary by at most three bytes.
EOF can produce a tail below the minimum.

Text below 4 MiB retains the existing adaptive thresholds. Text at or above
4 MiB uses the binary thresholds while keeping UTF-8-safe boundaries. Worker
and direct execution must produce identical boundaries, identifiers, and
reconstructed contents.

The approximately 49 KiB observed mean at value 0 is a sample statistic.
The 25 KiB candidate gap describes the probability after the minimum; it is
not a promise that every Chunk is 25 KiB or that low-entropy input avoids
forced cuts.

Owners: [splitter](../../src/string_and_binary/chunks.ts),
[parameter mapping](../../src/ContentSplitter/ContentSplitterBase.ts), and
[worker/direct routing](../../src/ContentSplitter/ContentSplitterRabinKarp.ts).

## Compatibility and when new Chunks appear

Keep `chunkSplitterVersion='v3-rabin-karp'`. Stored Metadata still refers to
content-addressed Chunks with the existing encoding, identifiers, and read
format. Old and corrected writers can generate different valid boundaries
from identical content. Readers reconstruct from the stored references; they
do not rerun the writer's splitting algorithm to interpret a file.

This is compatible but lossy for reuse. It does not discard file bytes or
conflict branches. A mixed-version Vault may accumulate multiple Chunk layouts
and spend more storage or transfer on rewritten files. The decision accepts
that cost; mixed-writer tests must establish the read/write contract before
shipping. The earlier window-only interoperability result does not prove rule A.

| Event | Expected effect |
| --- | --- |
| Install or restart with the corrected splitter | No rewrite is scheduled merely because the algorithm changed |
| Ordinary save proves identical content | Return before splitting; no new Chunk layout |
| Edit a file | Split that file with the current writer; unchanged regions may acquire new boundaries |
| Force a write or recreate Chunks | The write path may split again even when input bytes match |
| Full Rebuild from authoritative files | Generate the replacement database using the current writer |
| Remote-only Rebuild | Send retained local revisions and Chunks; no automatic re-chunking |
| Receive existing Metadata and Chunks | Preserve their stored references and bytes |

The unchanged-content check belongs to
[ServiceFileHandlerBase](../../src/serviceModules/ServiceFileHandlerBase.ts)
and
[ServiceDatabaseFileAccessBase](../../src/serviceModules/ServiceDatabaseFileAccessBase.ts).
The lower-level
[Chunk writer](../../src/managers/EntryManager/EntryManagerImpls.ts)
splits whenever it is invoked. Therefore, the public explanation is 'updating
does not trigger a full re-chunk', rather than an unconditional guarantee for
every API call with identical bytes.

No automatic cleanup of old Chunks is added. Existing references, conflict
retention, and Garbage Collection continue to determine their lifetime.

## Recommendation and settings transitions

Use one new-configuration recommendation, independent of the active transport.
Keep storage-policy selection distinct from runtime batch settings.

| Entry or transition | Required behaviour |
| --- | --- |
| Missing key in an existing stored configuration | Keep the established schema fallback of 0; add no rewrite or reconstruction migration |
| Brand-new Vault | V3 with value 0 |
| Explicit new CouchDB, Cloudant, or Object Storage setup | Select value 0 consistently; preserve unrelated service-specific settings |
| New P2P setup | Inherit the same base recommendation; add no P2P-specific Chunk-size variant |
| Setup URI or Markdown import | Preserve supplied values and existing import/adoption rules |
| Join a configured remote | Honour its agreed tweaks through the existing compatibility flow |
| Select another remote profile | Apply the existing profile/adoption contract; do not merge new-setup defaults merely because a profile is selected |
| Run Setting Doctor | Remove the universal recommendation to increase V3 to 60; do not treat every larger explicit value as erroneous |
| Existing compatible tweak auto-alignment | Preserve timestamp, opt-out, and adoption semantics; the default change grants no new authority to overwrite agreed values |
| Load an existing Cloudant configuration | Retain the existing Cloudant-specific constraint in this change; do not describe it as proof that old documents fit |

Define the new Doctor rule set by inheriting 1.0.33 and setting
`customChunkSize: undefined`. Preserve the historical 1.0.33 rule and deliberately
retain its consultation version. Withdrawing a recommendation does not warrant
repeating unchanged recommendations after dismissal. An explicit forced rescan
still checks remaining rules; neither path deletes or rewrites the user's
Chunk-size setting.

Primary owners are
[preferred settings](../../src/common/models/setting.const.preferred.ts),
[schema fallbacks](../../src/common/models/setting.const.defaults.ts),
[Doctor rules](../../src/common/configForDoc.ts),
[tweak classification](../../src/common/models/tweak.definition.ts), and
[settings loading](../../src/services/base/SettingService.ts).
See [Settings lifecycle](../settings-lifecycle.md) for the current distinction
between schema fallbacks, new Vaults, explicit setup, and imported settings.

Downstream acceptance covers the Obsidian Setup Wizard, standard setup,
Setup URI producers and consumers, profile activation, Doctor, and
`ModuleResolveMismatchedTweaks`. P2P and Object Storage use their existing
setup and compatibility paths. Avoid the Cartesian product of all settings:
exercise each entry path, each distinct adoption rule, and representative
transport boundaries.

Current documentation contains stale batch defaults and descriptions of
read-ahead in older translations. The primary-language settings documentation
now describes the unchanged schema defaults of 25 and their actual roles.
Translation changes remain separate work.

The standalone Deno tools retain their own immutable Commonlib 0.1.34 pin.
Their existing release and the local candidate both pass generator tests;
candidate validation uses a temporary import map, including the spawned Deno
process. Release integration must update the facades, version constant, and
lockfile together to the reviewed immutable library release. The tools inherit
the policy of their selected package rather than duplicating the value.

## Full-current-leaf Fast Fetch

### Revision completeness

For every row in `_changes?style=all_docs`:

1. enumerate all current leaf revision references, including deleted leaves;
2. compare them with the local revision inventory;
3. use an included winner only when its ancestry is valid;
4. construct root ancestry only for an exact generation-one revision;
5. fetch missing bodies and required ancestry with `_bulk_get?revs=true`;
6. store using `new_edits=false`, checking storage results; and
7. advance the durable contiguous prefix only after every leaf required by
   those rows is stored.

This obtains current leaves and their ancestry identifiers, not every
historical revision body. A missing required body is an error, not evidence
that the row can be skipped. A purged or inaccessible revision therefore
cannot authorise progress past that row.

Separate the missing-revision buffer from inline generation-one Chunks.
The current implementation bounds requests to 100 revision references and a
512 KiB reference buffer. A response exceeding 512 KiB splits a multi-reference
group recursively. A single revision can exceed that threshold because it
must be read in full. The response has already arrived before its size can
be checked; this is not a hard network-memory or Cloudant limit.

Report successfully stored identities through `onStoredRevisions` before
reporting the associated durable cursor. Preserve authentication, custom
headers, decoding, and existing error/cursor handling.

Owner: [StreamingFetch](../../src/pouchdb/StreamingFetch.ts).

### Fresh-import checkpoint handoff

The handoff is optional host capability `initial-fetch-fast-forward`.
A caller-owned private CouchDB resource binds one effective settings snapshot
and disposes its connection; it does not replace the active Replicator.
Hosts without that resource keep the existing flow.

| Stage | Required condition or action |
| --- | --- |
| Admit | Start from zero into an empty local database, without pre-existing ordinary checkpoint pairs; keep file watching and reflection suspended |
| Prepare | Create native push and pull checkpoint pairs at zero, with native replication IDs, session UUIDs, and histories |
| Import | Record stored `(id, rev)` pairs in memory and the durable opaque remote cursor |
| Verify | Check all current local leaves against the imported set; require unchanged local sequence, database binding, settings, selector, and checkpoint guards |
| Publish push | Use the verified local sequence in the ordinary local-to-remote pair |
| Publish pull | Use the durable remote cursor in the ordinary remote-to-local pair |
| Finish | Complete the existing rebuild finalisation before local writing resumes; dispose the resource |

The importer must remain the sole local document writer through publication.
Sequence checks detect observed interference; they do not replace that
lifecycle precondition. Normal remote document edits may continue and remain
after the captured remote cursor.

The imported-identity set is capped at 100,000 revisions. Exceeding it disables
checkpoint advancement, not the underlying stream. The set is operation-local
and does not survive restart. Persisted Fast Fetch resume cursors cannot
certify full-leaf completeness from a previous run or implementation.

The remote database must not be deleted and recreated during the operation.
PouchDB's HTTP database identity is server UUID plus database name, not an
incarnation identifier. Session and revision guards reject observed replacement
but cannot atomically prevent deletion/recreation racing checkpoint writes.
This is an explicit scope boundary, not a solved fencing mechanism.

Owners: [fresh-import handoff](../../src/replication/couchdb/fastForward.ts),
[CouchDB Replicator](../../src/replication/couchdb/LiveSyncReplicator.ts),
[resource contract](../../src/replication/RemoteResource.ts), and
[Rebuilder](../../src/serviceModules/Rebuilder.ts).

### Ineligibility and failures

| Condition | Behaviour |
| --- | --- |
| Resume cursor, non-empty target, existing pair, unavailable capability, or incompatible transport/settings | Do not admit this handoff; retain the existing fetch path |
| Provenance budget exceeded or local verification fails | Do not advance to the imported sequences |
| Missing leaf, invalid ancestry, or storage failure | Do not advance the durable prefix past incomplete work; retain existing fetch failure handling |
| Lost or changed checkpoint guard | Reject publication; never recreate a missing guard as proof of the old import |
| Partial checkpoint publication | Preserve native reconciliation semantics and existing rebuild error handling; do not claim both directions completed |
| Disposal | Release the private resource through the caller's existing finalisation |

No new action starts ordinary replication because missing Chunks or unsent
changes are suspected. Existing later replication can reconcile conservative
checkpoints, but the optimisation does not add a separate recovery controller.

## Ordinary uploads, LiveSync mode, and offline recovery

Retain native revision enumeration, `_revs_diff`, `_bulk_docs`,
per-document failures, and paired checkpoints. Both rebuild routes keep their
existing second upload pass for convergence. Remote-only Rebuild can include
old large Chunks, conflicts, tombstones, and retained unreferenced Chunks.

Push and pull checkpoint sequences remain separate. Upload completion does
not establish the later pull checkpoint, including the finite pull before
LiveSync mode. Do not use the fresh-download helper to infer reverse progress.

With unchanged database identities and effective selectors, finite, directional,
bidirectional, and LiveSync replication reuse their corresponding native
pairs. Batch-size changes preserve identity; changing the pull selector can
restart pull independently of push. Keep the current batch settings; no
temporary batch override is introduced in this work.

For extended-offline and mixed cases, preserve unsent local changes and use
ordinary retained-checkpoint replication. A fresh Fast Fetch can replace a
local database and therefore is not an automatic substitute for reconciliation.

## Payload scope

Value 0 gives useful headroom for the sampled encrypted binary and escaped
text leaves. It does not bound every Metadata document, legacy Chunk,
revision history, or bulk request. All writers and stored data must satisfy a
service's limits before calling a Vault compatible with that service.

A future Cloudant-intent control, compatibility migration, request-byte
budgeter, or upload batch experiment requires its own design. None is needed
to implement the agreed V3 correction and common new-setup recommendation.

## Acceptance and verification

The smallest regressions failed on the unmodified thresholds and
recommendations before their respective production edits: three splitter
failures and four setup/Doctor failures. The corrected fixtures pass while
retaining the earlier rolling-window scenarios and explicit-setting coverage.

| Area | Acceptance evidence |
| --- | --- |
| V3 thresholds | Values 0 and 1 permit natural cuts on selected fixtures; hard caps, EOF tails, low-entropy input, UTF-8 safety, and explicit minimum overrides remain correct |
| Boundary recovery | Insert, overwrite, and delete fixtures reconstruct exactly and recover reusable suffixes; compare against prototype evidence without requiring every random case to improve |
| Execution parity | Worker and direct paths agree for binary, ordinary Markdown, large text, and boundary values including the 4 MiB cap |
| Unchanged Vault | Ordinary unchanged saves and restart processing retain Metadata revision and Chunk inventory; explicit repair/rebuild paths remain distinct |
| Mixed writers | Old-to-corrected and corrected-to-old reads and subsequent edits preserve bytes and conflicts on CouchDB, P2P, and Journal; measure reuse separately |
| Settings | Each transition above preserves supplied/agreed values; new setup consistently selects 0; Doctor no longer recommends 60 universally |
| Full-leaf fetch | Every required current leaf and ancestry is present before cursor publication, including deleted conflicts and updated winners |
| Fresh handoff | No imported-ID rescan after success; later edits in both directions and LiveSync mode work; failures and ineligible/resumed imports do not invent progress |
| Package boundary | Packed Commonlib passes its package gate and the exact downstream consumer checks |
| Host flow | Focused real-Obsidian fresh setup, suspension, file reflection, and restart checks exercise the exact candidate |

The initial candidate passed 2,454 Commonlib unit tests, 11 focused real-CouchDB
integration tests, package checks, and the downstream check/build gate with
1,299 unit tests passing and one skipped. The downstream suite excludes the
retained generated source copy under `.bench/**`.

The subsequent PR follow-up passes 2,458 Commonlib unit tests, types, boundary
checks, the packed-package gate, and the downstream check and unit suite
(1,299 passed, one skipped) against its exact tarball. It restores the
historical Doctor rules, preserves consultation
version 1.0.33, and renames the function module to `fastForward.ts`. Its
[separate evidence](../adr/evidence/2026_10_rule_a_pr_followup.json) preserves
the source and artefact identities without rewriting earlier measurement
snapshots.

The mixed CLI matrix checks 810 file-stage digests over three size values,
three stages, three transports, and both writer directions. Those fixtures
cover exact content interoperability, with conflict retention checked by the
separate revision and full-leaf suites. Worker-message processing agrees with
direct splitting for ordinary Markdown, small-cap binary, and large UTF-8 text.

The real-Obsidian manual CouchDB workflow verifies size 0 and eight 32 KiB
content-defined binary pieces, records the complete local Chunk inventory,
and requires the same Metadata revision and inventory after restart. It also
rebuilds, generates a Setup URI, performs Fast Fetch on a second device, and
checks exact binary bytes and bidirectional note transfer. An initial attempt
stopped at the fixture's server-requirements check; provisioning that disposable
CouchDB with the maintained script allowed the workflow to pass without a
production change. This does not test mobile or an actual Cloudant service.

The [implementation evidence](../adr/evidence/2026_10_rule_a_implementation.json)
records artefact and CLI identities, conditions, and coverage. The release
boundary is the immutable Commonlib dependency, including the independently
pinned Deno utilities; no further algorithm-version decision is pending.

Integration is planned for Commonlib 0.2.0. The downstream draft keeps its
published dependency while that release is pending; the new resource contract
requires the integrated package. Replace the exact package dependency, update
the independent Deno pins and lockfile, and validate the resulting consumer
before marking that draft ready for review.

## Release-note contract

The Unreleased note must explain that existing content remains readable,
installing the correction does not re-chunk the whole Vault, and an edited or
explicitly rewritten file can produce additional Chunks under the corrected
boundaries. Avoid the unexplained word 'lossy' in end-user wording.

The Unreleased note includes the small-cap reuse improvement and the common
value-0 recommendation for new setup. It preserves larger existing choices and
describes first-upload costs without claiming universal performance gains.
