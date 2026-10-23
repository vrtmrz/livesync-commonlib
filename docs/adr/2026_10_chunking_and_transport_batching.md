---
date: 2026-10-23
commonlib-version: "0.1.44"
self-hosted-livesync-version: "1.0.39"
status: accepted-unreleased
---

# Architectural Decision Record: Chunking Policy and Initial Replication

## Conclusion

Apply proportional rule A as a correction to the existing `v3-rabin-karp`
splitter, and use `customChunkSize=0` as the common recommendation for new
configurations. Preserve explicit and agreed settings on existing Vaults.
The correction preserves content and read compatibility, but can change Chunk
boundaries and reduce reuse of previously stored Chunks when a file is rewritten.
This is the project's compatible-but-lossy category: the loss concerns reuse,
not file contents.

Pair the smaller default with full-current-leaf Fast Fetch and a checkpoint
handoff limited to a fresh initial import. Keep initial uploads and rebuilds
on the existing Replicator with its normal paired checkpoints. Chunk size and
transport batching remain separate decisions.

Rule A, recommendation alignment, the continuous-window correction, full-leaf
Fast Fetch, and the fresh-import handoff are implemented in an unpublished
candidate based on Commonlib 0.1.44. The reviewed candidate is distinct from
the published artefact with the same version label. The
[implementation evidence](evidence/2026_10_rule_a_implementation.json) records
the regression results and packed-consumer validation.

## Context

[Issue #1180][issue] exposed inconsistent Chunk-size recommendations, including
a reported change from 0 to 60 after initial synchronisation. The investigation
also found two independent chunking problems:

- the rolling hash stopped removing outgoing bytes for 48 bytes after each
  boundary, although it retained the preceding hash state;
- the binary minimum was clamped to the maximum at values 0 and 1, producing
  fixed-length pieces and poor reuse after insertion.

The maintainer recalls increasing Chunk size because initial downloads before
Fast Fetch were expensive. Reducing document counts and round trips was
reasonable for that path. Fast Fetch now separates initial body reception from
ordinary replication. Its old winner-only import and missing ordinary
checkpoints nevertheless left completeness and reconciliation costs unresolved.

The [evidence companion][experiments] preserves the experiments, analytical
models, historical alternatives, and limits. The [design document][design]
defines the implementation contract and acceptance criteria.

## Decisions

| Concern | Decision |
| --- | --- |
| Rolling hash | Keep the 48-byte window continuous across boundaries |
| Binary thresholds | Use rule A within `v3-rabin-karp`; retain the current small-text policy |
| New-configuration recommendation | Use 0 across CouchDB, Cloudant, Object Storage, and P2P setup paths |
| Existing Vaults | Preserve explicit values and agreed tweaks; no upgrade-triggered re-chunking or forced Rebuild |
| Compatibility | Accept different boundaries between old and corrected writers; require exact content reconstruction in both directions |
| Initial reception | Obtain every current leaf, including deleted conflicts and required ancestry |
| Checkpoint handoff | Advance native push and pull checkpoint pairs only after a proven fresh import, before local writers resume |
| Initial sending and rebuilds | Retain native replication, paired checkpoints, and existing convergence passes |
| Transport tuning | Retain current values; larger batches remain separate, bounded experiments |
| Cloudant | Treat document compatibility as Vault-wide; a connection switch or a smaller recommendation does not repair existing oversized documents |
| Release communication | Explain compatibility, unchanged-file behaviour, possible extra Chunks on rewrite, and the cost of smaller Chunks |

### Correct V3 without adding another splitter version

For the binary path, let `M` be the effective maximum. Rule A uses a minimum
of `M/4` and an approximately `1/(M/4)` boundary probability after the
minimum, subject to the existing explicit minimum override. It forces a cut
at the maximum and retains UTF-8-safe boundaries. At value 0 with the normal
minimum setting, these are 100 KiB maximum and 25 KiB minimum and candidate
gap. The candidate gap is not the final mean length.

Use the existing splitter identifier. A separate version would preserve another
writer variant and introduce adoption and old-client fallback behaviour without
changing the stored read format. The maintainer accepts the compatible loss
of reuse from correcting V3. No new format, migration marker, compatibility
prompt, or persistent tuning preset is needed for this correction.

Installing the update does not schedule file rewrites. Ordinary saves which
prove the file unchanged return before splitting. Edited files, forced writes,
explicit Chunk recreation, or a full Rebuild can use new boundaries, including
for unchanged regions of that file. Old referenced Chunks remain readable and
may coexist with newly created Chunks under the existing retention rules.
This is not a promise that every low-level or repair write skips splitting.

### Retire 60 as a universal recommendation

Under rule A, value 0 prioritises ongoing reuse and payload headroom.
Across the sampled random streams it produced an observed mean of about
49 KiB. The mixed corpus had 1,170 initial unique Chunks at 0 versus 949 at 4,
while mean new insertion content was 80.73 KiB versus 252.37 KiB. These are
sample results, not a universal optimum. [Default evidence][defaults]

Large, mostly immutable binary Vaults retain a reason to choose a larger
explicit value: fewer documents, less initial-upload work, and fewer ordinary
audit rows. Their prevalence is unmeasured. Smaller Chunks also cost more
hashing, database work, and Metadata references. The decision accepts these
costs instead of describing all workloads as faster.

Align new-setup recommendations and remove the universal Doctor recommendation
of 60. Do not replace it with a rule which continually rewrites valid existing
values to 0. Preserve imported and remote-agreed settings through the current
tweak-resolution flow. Current Cloudant-specific enforcement remains a
separate existing constraint, rather than evidence that every stored document
fits Cloudant.

Preserve the historical Doctor rule sets and withdraw this rule in a new
inherited definition. Deliberately keep consultation version 1.0.33, because
removing a recommendation does not justify repeating unchanged recommendations
for users who already dismissed that version. A forced rescan remains available.

### Complete initial reception before advancing checkpoints

A changes cursor alone does not prove all current revision bodies are present.
Fast Fetch must store every listed current leaf, including deleted leaves, with
valid ancestry before advancing its durable prefix. Generation-one winners can
use their exact revision as root ancestry; updated winners without ancestry and
missing conflict leaves require bounded `_bulk_get?revs=true` requests.

Advance ordinary checkpoint pairs only for an import started from zero into
an empty local database, with no pre-existing pair and with local writers
suspended. Verify the imported revision inventory and local sequence before
publishing native checkpoints. Use the local sequence for push and the durable
remote cursor for pull; they are different sequence spaces.

This scope excludes persisted resume cursors as proof of completeness,
arbitrary-time Fast-forward, On Demand hole detection, and a new automatic
recovery action. The remote database must remain in place throughout import
and handoff. PouchDB's server UUID and database name do not identify a database
incarnation; checkpoint guards cannot atomically rule out deletion/recreation
racing publication. The [design][design] records these preconditions and
failure behaviour.

### Keep upload correctness in the Replicator

Ordinary replication already sends `_bulk_docs` with `new_edits=false`.
A separate uploader would need to preserve revisions and ancestry, handle
per-document errors and partial writes, resume after uncertain responses,
maintain ordering, and publish only proven progress.

The former automatic Chunk pre-send was removed after breaking the
Chunks-before-Metadata ordering guarantee. It also did not establish ordinary
replication checkpoints. Retain the existing upload and rebuild paths,
including the second convergence pass and later independent pull checkpoint.
Do not reuse the fresh-download handoff to infer upload-side or reverse
progress. [Historical explanation][bulk-history], [upload analysis][upload]

## Evidence supporting the decision

| Question | Evidence and practical implication |
| --- | --- |
| Does the window correction matter? | At size 4, one binary insertion reduced new content from 6.051 to 0.271 MiB; measured CouchDB upload bodies fell from 11.152 to 0.874 MiB |
| Why rule A rather than B? | Both recovered a stable suffix in all 48 sampled insertion cases at each tested size. B's length-dependent phase rejected otherwise reusable boundaries in some cases; fewer forced cuts did not consistently improve reuse |
| Is 0 compatible with smaller payloads? | A maximum binary V2 leaf measured 182,353 JSON bytes at 0 versus 910,529 at 4. A synthetic NUL-text leaf at 0 measured 614,613 bytes. These are local probes, not a general Cloudant acceptance guarantee |
| Does Fast Fetch alone solve the first audit? | No. For 4,000 files and 40,000 Chunks, the final no-handoff trial made 5,925 subsequent ordinary HTTP requests and checked 44,000 push IDs, with no body writes |
| Does the narrowed handoff remove that audit? | The final trial imported all 44,040 current revisions, retained all 40 conflict pairs, and reduced the next ordinary sync to eight fixed requests and no push-ID checks. Preparation/publication added 16 requests and a local inventory scan |
| What remains expensive? | At 44,000 all-missing documents, batch 25, and RTT 100 ms, native upload has a calculated leading wait of 704 seconds. Batch 100 would give 176 seconds before bytes and local work, but remains an unimplemented tuning hypothesis |

Full-leaf Fast Fetch required 53–54 requests in that fixture, including
41–42 lookups for 4,040 updated winners and extra leaves. Generation-one
Chunks were not downloaded twice. Baseline and handoff timing conditions
differed, so their elapsed-time ratio is not a measured speedup.
The fixture used 1 KiB artificial Chunks and a memory adapter; it did not
measure a complete real-Vault rebuild. [Fresh-import evidence][handoff]

## Transport and compatibility consequences

Assess initial synchronisation, ongoing operation, and extended-offline
recovery in sending, receiving, and mixed directions. This is an analysis
matrix, not nine user presets. Missing bodies, scanned rows, retained
checkpoints, and historical Journal packs determine the work; elapsed offline
time alone does not.

In PouchDB 9.0.0, changing only `batch_size` or `batches_limit` does not
change replication identity. Directional and bidirectional operations retain
their corresponding pairs, including LiveSync mode when database identities
and effective selectors match. Changing the replicated document set can
require a new scan. `batches_limit` is read-ahead, not body-transfer
parallelism; P2P and Journal have their own transfer units.

Cloudant documents limits of 1 MB per document and 64 MB per request. Final
serialised bytes, Metadata, revision history, existing large Chunks, and all
writers matter. Value 0 provides headroom, not certification. A Vault-wide
future-Cloudant policy or a final-byte batching mechanism would be separate
work; this decision adds no persistent Cloudant-intent question.
[IBM limits][cloudant]

## Alternatives not selected

- **Rule B or recursive subdivision:** more boundary-selection behaviour without
  consistent reuse improvement in the sample.
- **A new splitter version:** additional negotiation and fallback variation for
  a correction which preserves the stored format.
- **60 for every self-hosted Vault:** retains first-upload benefits but gives
  insufficient weight to ongoing edits, modern reception, and payload headroom.
- **Per-connection Chunk-size defaults:** existing data and other writers remain
  unaffected by the selected connection.
- **Blind cursor handoff or arbitrary-time Fast-forward:** lacks completeness
  and writer-provenance guarantees.
- **Dedicated bulk upload or local-only upload checkpoints:** extra replication
  and recovery machinery; retain native paired checkpoints.
- **Unconditional large batches:** count alone does not bound bytes or memory.

## Implementation and release boundary

The small-cap regressions failed in three cases before the threshold change;
the setup/Doctor regressions failed in four cases before alignment. They pass
after their respective fixes. The initial candidate passed 2,454 Commonlib unit tests,
11 focused real-CouchDB integration tests, boundary and package gates, and
downstream LiveSync checks, with 1,299 unit tests passing and one skipped.
The plug-in, CLI, WebApp, and WebPeer builds pass.

A PR follow-up preserves the historical 1.0.33 Doctor rules while keeping the
current consultation version deliberately unchanged. Its regression failed
against the initial PR implementation, then passed with dismissal and forced
rescan coverage. The renamed `fastForward.ts` follows the documented filename
convention. The follow-up passes 2,458 Commonlib unit tests, type checks,
boundary checks, and the packed-package gate. The exact resulting tarball also
passes the downstream check and unit suite, with 1,299 passed and one skipped.
The separately dated
[follow-up evidence](evidence/2026_10_rule_a_pr_followup.json) records its source
and artefact identities; earlier measurement JSON remains unchanged.

The packed old/new CLI matrix verifies 810 file-stage digests across CouchDB,
Journal, and P2P, in both directions, at values 0, 1, and 4. Initial candidate
Chunk counts match the rule-A prototype at all three values. The matrix checks
content interoperability; separate conflict and full-leaf tests cover revision
retention. A focused Linux Obsidian workflow verifies value 0 after manual
setup, content-defined binary boundaries, unchanged Metadata and Chunk inventory
across restart, exact binary reception after Fast Fetch, and two-way note
transfer. These results do not establish Cloudant-service or mobile performance.

The standalone Deno utilities separately pin Commonlib 0.1.34. Their generator
tests pass against that immutable release and against this exact local candidate
through a temporary import map. Publishing the reviewed library and updating
those pins and their lockfile remain release integration work. No hard-coded
Chunk-size override is added to bypass their package boundary.

`updates.md` records the compatibility effect, small-cap correction, and new
recommendation. This change is intended for integration into Commonlib 0.2.0.
The downstream draft retains its published dependency until the integrated
library is available. Before that draft becomes ready for review, update its
exact dependency and the independent Deno pins and lockfile to the reviewed
immutable release, and repeat the applicable consumer checks against it.

[issue]: https://github.com/vrtmrz/obsidian-livesync/issues/1180#issuecomment-6261651086
[experiments]: 2026_10_chunking_and_transport_batching_evidence.md
[design]: ../design_docs/chunking_and_initial_replication.md
[defaults]: evidence/2026_10_proportional_chunk_default.json
[handoff]: evidence/2026_10_initial_fast_forward.json
[upload]: evidence/2026_10_initial_upload_analysis.json
[bulk-history]: https://github.com/vrtmrz/obsidian-livesync/issues/505#issuecomment-2419243551
[cloudant]: https://cloud.ibm.com/docs/Cloudant?topic=Cloudant-limits
