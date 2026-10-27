---
date: 2026-10-23
commonlib-version: "0.1.44"
self-hosted-livesync-version: "1.0.39"
status: unreleased-evidence
---

# Chunking and Transport Batching: Evidence and Experiments

This companion retains the measurements, analytical models, limitations, and
experiment-era interpretations supporting the [decision record](2026_10_chunking_and_transport_batching.md).
The decision record is authoritative for selected behaviour; the
[design document](../design_docs/chunking_and_initial_replication.md) specifies
implementation and acceptance criteria.

Earlier size-4 recommendations, the uncorrected small-cap rule, local-only
checkpoint experiments, and proposed batch sizes below describe stages of the
investigation. They are not competing current recommendations. The selected
policy is proportional rule A within `v3-rabin-karp`, with value 0 for new
configurations, a fresh-import-only Fast Fetch handoff, and native uploads with
paired checkpoints. Rule A and recommendation alignment were prototypes during
these measurements; their later production verification is recorded in the ADR
and its implementation evidence.

## Reading the evidence

- The window correction was measured through real transport paths.
- Rule A versus B and the default comparison use prototypes and local writer
  components; they do not establish mixed-version or mobile production behaviour.
- Fast Fetch measurements use real HTTP CouchDB with artificial small bodies
  and an in-memory local database; timing conditions are stated per trial.
- Upload and RTT projections are logical costs tied to observed request counts,
  rather than measured full-Vault transfer times.
- JSON evidence files below are preserved unchanged. Their proposal/status text
  records the experiment date; later decisions are recorded in the ADR.

The decision record and the tables here provide the human-readable explanation.
The dated JSON files preserve measurement conditions, source identities, and
recorded results for comparison or recalculation. Treat them as historical
snapshots: do not rewrite them to match a later implementation or decision.
Add a separately dated record when new measurements are needed.

## Analysis model

### Evaluate three synchronisation stages in three directions

Use the following matrix to assess a policy. These are analysis cases, rather
than nine settings presets.

| Stage | Sending | Receiving | Mixed |
| --- | --- | --- | --- |
| Initial synchronisation | Seed the required documents | Populate an empty local database, distinguishing Fast Fetch from ordinary replication | Reconcile two existing data sets and any conflicts |
| Ongoing operation | Send changed Metadata and new Chunks | Detect changes and obtain missing documents or Chunks | Exchange both deltas and account for reverse-direction identifier checks |
| Recovery after an extended offline period | Scan unsent changes from a retained checkpoint | Receive accumulated changes or outstanding Journal packs | Reconcile both backlogs and conflicts without discarding unsent local work |

Offline duration is not a document count. Distinguish changes-feed rows scanned,
missing revisions, payload bytes, and checkpoint continuity. Losing a
checkpoint can require a full identifier scan without requiring every document
body to be transferred again. Ordinary database compaction alone is not assumed
to invalidate incremental replication.

### Model the actual transport unit

For changes rows `C`, batch size `b`, `K = ceil(C/b)`, batches containing missing
bodies `Km`, payload bytes `B`, RTT `R`, and available bandwidth `G`, use:

```text
T ≈ trigger + connection + fixed controls + W × R + B/G + local work + reflection
```

`W` counts sequential application-level waits. Neither total HTTP requests nor
message fragment counts can be substituted for `W`.

| Path | Main waiting term and relevant behaviour |
| --- | --- |
| Ordinary CouchDB push | `(3K + Km)R`: revision difference, optional bulk write, and remote checkpoint GET then PUT. All-missing batches give `4KR` |
| Ordinary CouchDB pull with all Chunks | Changes read-ahead can overlap body fetching and checkpointing. The all-missing data-processing reference is approximately `(3K+1)R` to `4KR` |
| CouchDB on-demand Chunks | Metadata replication and groups of up to 100 missing Chunk IDs are separate paths; each group checks the remote version before its `_all_docs` request |
| Fast Fetch | A progress-target request, a status probe and stream for each page of up to 10,000 rows, and a final empty-status probe: `(2P+2)R`, before page-end waits and local work |
| P2P pull | Remote changes, local revision comparison, optional remote bulk get, and a final empty changes request: `(K + Km + 1)R`; the current internal batch size is 33 |
| S3-compatible Journal | List outstanding packs and transfer packs in sequence. Outstanding pack count, together with total bytes, determines the main network work |

These expressions assume the normal writable CouchDB checkpoint configuration,
no conflicts, and no failures. They describe the data-processing core, rather
than complete execution times. CPU, storage, request scheduling, quotas,
retries, and overlapping work remain separate constraints.

For a serial batch containing `X` bytes and requiring `κ` sequential round trips,
the corresponding throughput approximation is `X / (κR + X/G)`. Reaching 80% of
the link rate requires approximately `X >= 4κGR`, before local processing costs.
For CouchDB push at RTT 100 ms and 10 MiB/s, this is 16 MiB. The document count
needed to reach that size depends on the workload and remains constrained by
memory, request limits, and acceptable batch latency. Checkpoint waits can
limit subsequent batches without postponing reflection of a document already
delivered, so this throughput model is separate from first-visible-file latency.

PouchDB 9.0.0 processes one current replication batch at a time.
`batches_limit` controls changes read-ahead; it is not the number of concurrent
body transfers. The current selector path normally queues changes identifiers
without full bodies, so multiplying both settings by a document's full size is
also insufficient to predict actual memory use.

P2P does not use the CouchDB batch settings. Its ordinary `sync()` pulls before
asking the peer to pull back. The second phase can scan imported identifiers
whose bodies the peer already has. Sending, receiving, and a watcher performing
only a pull therefore have different waiting costs.

Journal packing checks its 250-document and 10 MiB thresholds after appending a
document, so a pack can contain 251 documents or exceed the byte threshold by
one document. Receiving old small packs cannot be modelled as repacking their
latest contents into a new large batch. A long offline backlog can therefore
have substantially more network waits than an initial upload of the same bytes.
For example, 32 MiB across 1,000 outstanding packs contributes 100 seconds of
GET waiting at RTT 100 ms; four packs contribute 0.4 seconds. Both have a
3.2-second byte-transfer term at 10 MiB/s, before controls and local work.

### Keep first use and subsequent reconciliation distinct

Fast Fetch's persisted resume cursor is separate from ordinary PouchDB
replication checkpoints, which depend on both database IDs and the selector.
A new local database can still require an initial identifier scan during its
first ordinary replication even after Fast Fetch has obtained the bodies.
Measure stream completion, file reflection, and the first ordinary
reconciliation separately. The [handoff experiment][handoff-evidence] below
measures this identifier scan against a disposable HTTP CouchDB, including a
20 ms injected-delay comparison. Its small artificial payloads and in-memory
local adapter do not measure a complete Vault rebuild or realistic WAN body
transfer.

Changing only `batch_size` or `batches_limit` preserves PouchDB 9.0.0's
checkpoint identity. Database identities, direction, and filters or selectors
are material. LiveSync's on-demand Chunk selector applies only to pull, so
changing that selector can restart pull without restarting push. Batch tuning
must remain separate from changes to the replicated document set.

Fast Fetch is not an automatic recovery choice for a mixed offline case. Its
current rebuild wrapper can reset the local database when no Fast Fetch resume
cursor exists, so unsent local changes require a separate preservation decision.

## Evidence and Rationale

The [evidence snapshot][evidence] identifies the reviewed revisions, package
digest, corpus digest, fixed settings, measurement boundaries, and numerical
results. The corpus contains 15 files totalling 13.832 MiB: repository Markdown,
generated small and large Markdown, two PNG files, and a seeded 8 MiB binary.
Each condition was repeated three times on one host, without injected WAN delay
or packet loss. HTTP measurements count bodies; P2P measurements count host
DataChannel payload, including application control and retries. These are
different measurement layers.

### Window correction and local edits

All three new regression tests failed on the unmodified implementation and
passed after the window correction. For the `customChunkSize=4` insertion case,
new binary content fell from 6.051 to 0.271 MiB. CouchDB upload bodies fell from
11.152 to 0.874 MiB, S3 bodies from 6.346 to 0.384 MiB, and P2P host payload from
8.594 to 0.688 MiB. Exact reconstruction was verified separately from reuse.

### Size versus batching

With the corrected window and existing binary thresholds, the mixed corpus
gave these initial CouchDB results:

| `customChunkSize` | Chunks | Documents including Metadata and control | Batches at 25 | Upload body MiB |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 1,026 | 1,042 | 42 | 22.574 |
| 4 | 927 | 943 | 38 | 22.524 |
| 10 | 908 | 924 | 37 | 22.515 |
| 20 | 904 | 920 | 37 | 22.513 |
| 40 | 902 | 918 | 37 | 22.512 |

At an assumed RTT of 100 ms, the batch waiting term for size 4 is 15.2 seconds
at 25 documents, 7.6 seconds at 50, and 4.0 seconds at 100. These are calculated
values, excluding bytes, CPU, and fixed controls. Increasing Chunk size from 4
to 40 saves only one batch, or 0.4 seconds, in this corpus. Increasing the batch
from 25 to 100 saves 11.2 seconds without changing stored Chunk boundaries.

In contrast, size 4 versus 40 used 0.603 versus 4.747 MiB for the measured
overwrite, and 0.874 versus 5.884 MiB for insertion. This supports considering 4
as the new default candidate while evaluating transport batching independently.
It does not establish that 4 is optimal for every workload.

These are historical measurements of the existing thresholds. The subsequent
binary-policy comparison reopens the default proposal rather than treating the
fixed-length behaviour at values 0 and 1 as unavoidable.

The 11 ordinary Markdown files had identical boundaries across all seven size
candidates and three stages. Increasing `customChunkSize` does not reduce that
part of the document count. Binary-heavy initial uploads retain a real
document-count trade-off. Values 0 and 1 clamp the binary minimum and maximum
to fixed 100 and 200 KiB pieces, weakening insertion reuse. Values 40 and 60
both reach the 4 MiB algorithmic maximum and produced identical boundaries.

Current independent identifiers in this experiment are 67 characters; the
comparison legacy encrypted hash identifiers were typically 16. A naming change
must not be treated as evidence of shorter identifiers or lower ID overhead.

### Compare proportional and two-phase binary rules

The [follow-up evidence][binary-policy-evidence] compares two experimental
rules, both retaining the continuous 48-byte Rabin–Karp window and a hard
maximum `M`. For values 0 through 4, `M` is respectively 100, 200, 300, 400, and
500 KiB. A candidate gap `A` means an approximate per-byte probability `1/A`,
not the final mean Chunk length.

| Rule | Minimum | Candidate gap | Maximum |
| --- | --- | --- | --- |
| A: proportional fixed probability | `M/4` | `M/4` throughout | `M` |
| B: two-phase normalisation | `M/4` | `M/2` before length `M/2`, then `M/8` | `M` |

The second rule applies the judgement principle of [normalised chunking in
FastCDC, section 4.4][fastcdc], without replacing Rabin–Karp with Gear. At every
tested size, the divisors are exact multiples, so every strict candidate is
also a relaxed candidate. Text below 4 MiB retains the existing adaptive rule;
larger text uses the binary thresholds while retaining UTF-8-safe cuts.

Besides replaying the original mixed corpus, the experiment used six seeded
4 MiB random byte streams. Inserting either one byte or 4 KiB at four positions
per stream gives 48 insertion cases per rule and size. Each stream also had one
4 KiB overwrite and one deletion. These cases share six source streams, rather
than representing 48 independent data sets. Three additional fixtures cover
zero-filled bytes and two periodic patterns.

The following values are new, unique **raw content KiB**, not encrypted network
payloads. Forced-cut rates use the six unedited random streams and exclude EOF
tails. A cut is forced only when the natural predicate does not match.

| Size | Forced A / B | Mean insertion KiB A / B | p95 insertion KiB A / B |
| ---: | ---: | ---: | ---: |
| 0 | 3.63% / 1.06% | 80.73 / 74.26 | 144.57 / 135.74 |
| 1 | 4.84% / 0.86% | 119.76 / 136.46 | 194.61 / 296.57 |
| 2 | 1.75% / 0% | 185.52 / 178.72 | 410.90 / 289.48 |
| 3 | 3.28% / 0% | 258.38 / 232.03 | 538.15 / 316.86 |
| 4 | 1.96% / 1.09% | 252.37 / 337.18 | 456.54 / 764.53 |

With the existing rule, sizes 0 and 1 failed to recover an offset-aligned,
identical trailing Chunk sequence before EOF in all 48 insertion cases. Both
experimental rules recovered such a suffix in every tested case at every size.
Finite-sample zero forced cuts and complete recovery are observations, not
guarantees.

Reducing forced cuts did not consistently improve reuse. At size 4, rule B
needed fewer new bytes than A in six cases, more in 28, and the same in 14. In
one traced 4 KiB insertion, three old boundaries were rejected because their
unchanged hashes matched only the relaxed predicate. The old Chunk length used
the relaxed phase, while the new length used the strict phase. At the first
missed boundary, both lengths exceeded the 125 KiB minimum: approximately
362 KiB before insertion versus 206 KiB afterwards, around a 250 KiB phase
threshold. The stable suffix began 202.34 KiB after the edit with A, versus
1,040.80 KiB with B. Nested candidate sets do not guarantee identical selected
boundaries when phase selection depends on the previous cut.

The coefficients also have different expected means. Under independent,
uniform hashes, the exponential approximation gives means of `0.48755M` for A
and `0.52116M` for B, with forced fractions of approximately 4.98% and 1.11%.
This compares concrete proposals, not all normalisation schemes at an equal
mean. Both rules still forced every non-tail cut on the three unedited
low-entropy fixtures. Repeated content can nevertheless deduplicate without
positional boundary recovery, so new bytes and recovery distance are separate
metrics.

At size 4, the mixed corpus had 949 initial unique Chunks with either candidate,
versus 927 under the existing rule. Including the previous model's 16 Metadata
and control documents gives 39 rather than 38 batches of 25, or ten batches in
both cases at 100. At 100 ms RTT, the calculated extra all-missing push wait is
0.4 seconds or zero respectively. This is not a new transport measurement.
The 8 MiB random file alone increased from 18 Chunks to 30 with A and 31 with B,
so binary-heavy initial uploads retain a larger document-count cost.

The boundary-only prototype also exposes CPU cost. For the 8 MiB random file,
three-run medians at size 0 were approximately 46 ms for the existing rule,
309 ms for A, and 328 ms for B; at size 4, they were 233, 310, and 292 ms.
These single-process measurements exclude encoding, identifier derivation,
encryption, and networking. Lower minima enable the modulus judgement over
more input positions. Mobile performance and complete candidate writers have
not been measured.

Prefer A as the simpler next implementation candidate: it removes the small-cap
degeneration without adding a length-dependent phase transition. Assess the size
default separately below, retain the maximum as a separate constraint, and do not add
new user settings or recursive subdivision from this comparison. The current
Cloudant payload caveats still apply. These proposals have not passed the
packed-writer or mixed-version transport checks of the window correction.

### Reassess the default under the proportional rule

The [default reassessment][default-evidence] proposes value **0** for new
configurations using rule A. This prioritises ongoing reuse, one storage policy
across connections, and payload headroom. It does not identify a universal
minimum-latency value or adopt a new product default in this change. The larger
handoff experiment below also rules out using Fast Fetch alone as evidence that
smaller Chunks have negligible initial-reconciliation cost.

Under A, value 0 means a 100 KiB maximum, a 25 KiB minimum, and a 25 KiB candidate
gap. It is neither disabled chunking nor fixed 100 KiB pieces. Across the six
random streams, the observed mean, including EOF tails, was approximately
49 KiB. The comparison is:

| Value | Maximum KiB | Initial mixed-corpus Chunks | Mean insertion raw KiB | p95 insertion raw KiB |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 100 | 1,170 | 80.73 | 144.57 |
| 1 | 200 | 1,033 | 119.76 | 194.61 |
| 2 | 300 | 1,003 | 185.52 | 410.90 |
| 3 | 400 | 982 | 258.38 | 538.15 |
| 4 | 500 | 949 | 252.37 | 456.54 |

Moving from 0 to 1 saves 137 initial Chunks but increases mean insertion bytes
by approximately 48% in this sample. Moving from 1 to 4 saves only another
84 Chunks while approximately doubling those bytes. The smaller value is a
reasonable general default when ongoing edits matter; this is a policy choice
informed by the sample, rather than a workload-independent optimum.

Additional local checks generated real 67-character independent keyed IDs and
used the installed Commonlib V2 encryption and JSON serialisation. New Chunk
counts and raw bytes exactly matched the earlier equality model. The sum of
initial leaf JSON objects was 23,482,350 bytes at 0 and 23,414,385 bytes at 4,
only approximately 0.29% apart. New leaf JSON for the saved overwrite and
insertion stages was 148,603 and 125,779 bytes at 0, compared with 381,031 and
542,143 bytes at 4. These figures include synthetic one-generation revision
history, but exclude Metadata, request wrappers, controls, responses, and retries.
They are not complete synchronisation traffic measurements.

Initial round trips remain a cost. Using the existing model's 16 additional
documents, an all-missing CouchDB push at 100 ms RTT has these batch waits:

| Value | Batch 25 | Batch 50 | Batch 100 |
| ---: | ---: | ---: | ---: |
| 0 | 19.2 s | 9.6 s | 4.8 s |
| 1 | 16.8 s | 8.4 s | 4.4 s |
| 4 | 15.6 s | 8.0 s | 4.0 s |

Values 0 and 4 differ by 3.6 seconds at batch 25, or 0.8 seconds at batch 100,
before transfer and local work. This is not an unconditional recommendation
for batch 100. A uniform-hash planning example for one 50 MiB binary gives
approximately 1,051, 526, and 211 Chunks at values 0, 1, and 4. At batch 100 and
100 ms RTT, the corresponding waits are approximately 4.4, 2.4, and 1.2 seconds.
The 50 MiB input follows the current new-setup preferred file-size limit; the
counts are theoretical. Larger Chunks retain a genuine advantage for mostly
immutable, binary-heavy initial uploads and full identifier audits.

CPU is another cost. A warm local initial-production pipeline, including
splitting, encoding, keyed IDs, V2 encryption, and JSON serialisation, gave
these medians over three repetitions:

| Input | Value 0 | Value 1 | Value 4 |
| --- | ---: | ---: | ---: |
| 8 MiB random binary | 597 ms | 589 ms | 554 ms |
| Mixed corpus | 1,409 ms | 1,232 ms | 1,179 ms |

Each trial used a fresh HashManager and an empty Chunk cache. Input I/O,
Metadata, local database work, networking, decryption, file reflection, and
mobile execution were excluded. Smaller new payloads do not establish lower
end-to-end latency on every connection or device.

Value 0 also has useful payload headroom. A maximum-length binary leaf is
182,353 JSON bytes under V2, or 182,360 under V1, compared with 910,529 and
910,536 at value 4. A synthetic maximum-length unencrypted NUL-text leaf is
614,613 JSON bytes at 0, versus 1,229,013 at 1. Among these candidates, only 0
fits this case within a conservative 1,000,000-byte serialised-document budget.
The valid UTF-8 safeguard can add three raw bytes; even an additional 18 JSON
bytes leave headroom in this leaf case. Cloudant's internal size accounting
and actual service acceptance remain unverified.

At 0, a bulk of 100 NUL-text leaves is still 61,461,428 bytes, close to the
64,000,000-byte request budget; 50 leaves give 30,730,728 bytes. A bulk of
100 maximum binary V2 leaves is 18,235,428 bytes. The exact JSON length formula
does not establish a general bound for Metadata, longer revision histories,
arbitrary batching, or existing stored Chunks. Final payload budgeting remains
a separate requirement.

For initial reception, the sender's stored boundaries determine the work;
changing the receiver's setting does not re-chunk existing remote content.
Fast Fetch still fits this corpus into one 10,000-row page at every candidate,
but subsequent ordinary identifier reconciliation remains separate. Ongoing
and mixed operation benefit only when writers generate the selected policy.
Offline recovery still depends on accumulated rows, payload, and checkpoints;
S3 retains historical Journal pack counts. Do not turn these distinctions into
another set of user presets.

Value 0 already matches the schema fallback and Cloudant preference. A coherent
future change would align new self-hosted and Journal setup recommendations
with it and retire the post-initial-sync recommendation of 60, without forcing
all existing explicit values to zero. A connection-specific future-Cloudant
size switch is less compelling when the standard cap is shared, although
actual compatibility and existing large documents remain separate concerns.
The unchanged number does not preserve the old v3 binary boundaries: mixed
writers, splitter-version handling, and agreed existing tweaks require a
separate implementation decision.

### Reassess Fast Fetch and the first ordinary replication

The [handoff experiment][handoff-evidence] used the installed Commonlib
streaming function, PouchDB 9.0.0, and CouchDB 3.5.0. The stable fixture contained
4,000 Metadata documents and 40,000 unique Chunks. Each Chunk held only 1 KiB
of unencrypted artificial content, to isolate request and checkpoint work.
The local adapter was in memory. Counts are measured; timings are single local
samples, with caches warming across the ascending batch-size trials. They
exclude the rebuild wrapper, its preflights and control updates, decryption,
filesystem scanning, and reflection.

The stream imported all 44,000 documents in five 10,000-row pages. Including
progress and status probes, the function made **12 HTTP requests** and took
11.51 seconds with no injected delay. It did not create ordinary replication
checkpoints. The subsequent bidirectional sync therefore still audited all
44,000 local identifiers in push, even with the default leaf-excluding pull
selector. Pull returned the 4,000 matching Metadata rows. Every revision was
already present, so neither direction wrote any document bodies.

Let `Kp = ceil(44000/b)` and `Kl = ceil(4000/b)`. Each non-empty known-only push
batch makes `_revs_diff`, remote checkpoint GET, and remote checkpoint PUT:
`3Kp` requests and approximately `3Kp` sequential RTTs. Each known-only pull
batch contributes `_changes`, asynchronous source database info, and remote
checkpoint GET and PUT: `4Kl` requests. Pull read-ahead and database-info calls
overlap other work. Both directions also run concurrently. The dominant
waiting term in this fixture is therefore `3KpR`, rather than total requests
multiplied by RTT.

| Batch size | Measured HTTP requests | Measured local time | Push wait at 50 ms RTT | Push wait at 100 ms RTT | Push wait at 200 ms RTT |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 25 | 5,927 | 36.23 s | 264 s | 528 s | 1,056 s |
| 100 | 1,487 | 13.11 s | 66 s | 132 s | 264 s |
| 250 | 599 | 9.53 s | 26.4 s | 52.8 s | 105.6 s |
| 500 | 303 | 8.40 s | 13.2 s | 26.4 s | 52.8 s |
| 1,000 | 155 | 7.90 s | 6.6 s | 13.2 s | 26.4 s |

The three right-hand columns are logical leading RTT terms, not measured
end-to-end times. Add startup, bytes, local work, and scheduling, allowing for
overlap. All five measured totals matched `3Kp + 4Kl + 7`; seven is
fixture-specific fixed and terminal overhead. At batch 25 and 100 ms RTT, the
push waiting term alone is **8.8 minutes**. With 20 ms injected per request,
batch 250 actually took 18.01 seconds, compared with 9.53 seconds without
injection. This validates a material delay cost, rather than an exact additive
prediction for arbitrary networks or devices.

The audit also transfers identifiers and revisions even without bodies. At
batch 25, measured request and response bodies totalled approximately 6.43 MiB;
at batch 1,000 they totalled approximately 5.25 MiB. More matching controls,
tombstones, conflict leaves, concurrent edits, or missing bodies change these
counts. A high `update_seq` value is not itself a changes-row count.

#### Batch changes preserve the existing checkpoint

The installed `pouchdb-generate-replication-id` implementation uses ordered
source and target IDs, applicable filter and view text, query parameters,
document IDs, and selector JSON. It does not include `batch_size` or
`batches_limit`. The experiment confirmed that a completed batch-25 sync,
followed by batch 1,000 with the same databases and selector, made only eight
fixed requests and checked no push revisions. A warm batch-25 sync had the
same count. Removing the pull selector started a fresh pull scan while push
retained its checkpoint.

A running replication must be restarted to apply its new options. Cancellation
can leave a small amount of uncheckpointed work to repeat; it is separate from
changing checkpoint identity. Missing or incompatible checkpoint histories,
database recreation, and changes to filters or selectors can require a wider
rescan. A temporary batch increase followed by restoration is consequently
possible, subject to payload and memory limits.

#### Keep the audit, reduce remote checkpoint round trips

A second experiment retained the complete revision audit but used PouchDB's
[directional checkpoint options][pouch-api]: push used `checkpoint='source'`
and pull used `checkpoint='target'`. Both therefore checkpointed the local
database during reconciliation. On successful completion, the harness used
the checkpointer to publish each verified local `last_seq` and its existing
`session_id` to the corresponding ordinary checkpoint pair. It did not invent
a sequence, substitute the remote's current sequence, or start a new session
while publishing the existing one.

At batch 250 and 20 ms injected delay, the audit fell from **599 requests and
18.01 seconds** to **212 requests and 9.60 seconds**. The latter trial used a
read-ahead limit of two instead of 25, so the timing difference does not isolate
checkpoint mode alone. The remote checkpoint request reduction is directly
observed. Publication and verification then made eight additional
requests, including two remote checkpoint PUTs; that separate phase ran at
zero injected delay and took 35 ms. Restoring normal both-sided checkpoints and
batch 25 made eight fixed requests with no all-ID push rescan. One subsequent
local edit and one remote edit propagated in their respective directions.

For this known-only case, the leading push term falls from `3KpR` to `KpR`,
plus constant publication work. At batch 250 and 100 ms RTT, those terms are
52.8 and 17.6 seconds, respectively. This is an experimental improvement
candidate, not an implemented handoff. Its design must define interruption,
cancellation, failed or partial publication, permissions, concurrent writers,
and restoration of the normal checkpoint mode. The normal mode must reconcile
conservatively after incomplete publication. Large or missing bodies still
need independent request-byte and memory bounds; a count of 1,000 must not
become an unconditional production batch size.

#### A stream cursor cannot substitute for revision completeness

This counterexample records the implementation before the full-leaf change
below. It remains the reason a persisted resume cursor alone cannot authorise
a checkpoint jump.

The stream requests `style=all_docs`, conflict information, and revision
history, but writes the row's single `doc` body rather than obtaining every
conflict leaf listed in `changes`. A separate fixture had two generation-one
conflict leaves. Fast Fetch stored one. Pulling only from the returned Fast
Fetch cursor left the other leaf absent; ordinary reconciliation from its own
checkpoint recovered it.

This counterexample rejects a blind pull checkpoint seeded from the Fast Fetch
cursor. Stream durability proves that received bodies were stored, not that
every relevant revision was received. A bridge needs conflict and
tombstone completeness, a correctly paired selector and database identity,
and a concurrency boundary. A push-only shortcut after a provably fresh,
remote-only import would need separate writer-provenance guarantees; resume
and the post-fetch filesystem scan do not supply those automatically.

#### Consequence for withdrawing the value 60

The proposed rationale is to retire `60` as the universal recommendation
because ongoing reuse and a consistent payload budget now deserve more weight,
and Fast Fetch improves the initial body-download path. It is not a claim that
large Chunks ceased to be useful or that Fast Fetch eliminated all subsequent
round trips. Small Chunks create more documents, local processing, and audit
work. Mostly immutable, binary-heavy Vaults remain a valid case for a larger
explicit value; their frequency is unmeasured.

Select value 0 under rule A as the storage-policy recommendation, paired with
the fresh-import handoff below. Its measured reception cost belongs alongside
the ongoing-edit and payload evidence, before applying new setup recommendations.
Do not silently rewrite existing agreed or explicit values, add another set
of phase-specific user presets, or present the current batch-25 handoff as
negligible.

### Measured full-leaf and fresh-handoff costs

The [fresh-import experiment][initial-forward-evidence] uses the exact packed
candidate, PouchDB 9.0.0, and a disposable CouchDB 3.5.0 with two shards. The
fixture contains 4,000 files and 40,000 unique 1 KiB Chunks. Every Metadata
winner has been updated once to generation two. Forty Metadata documents have
an additional current leaf, including one deleted leaf. Both imports retain
all **44,040 current revisions**, and all 40 conflict pairs remain present.

Full-leaf Fast Fetch makes **53–54 HTTP requests**: the former 12 stream and
status requests, plus **41–42 `_bulk_get` requests for 4,040 bodies**. Page
boundaries and sharded changes ordering can leave a partially filled group.
This replaces the earlier estimate which counted only extra conflict leaves;
updated winners also need ancestry. The 40,000 generation-one Chunks do not
need a second body fetch.

| Phase | Injected RTT | HTTP requests | Push identifiers checked | Measured time |
| --- | ---: | ---: | ---: | ---: |
| Complete Fast Fetch without handoff | 0 ms | 54 | 0 | 12.27 s |
| First ordinary batch-25 sync without handoff | 0 ms | 5,925 | 44,000 | 37.35 s |
| Prepare fresh checkpoint pairs | 100 ms | 11 | 0 | 1.16 s |
| Complete Fast Fetch for handoff | 100 ms | 53 | 0 | 15.32 s |
| Publish verified checkpoint pairs | 100 ms | 5 | 0 | 2.21 s |
| First ordinary batch-25 sync after handoff | 100 ms | 8 | 0 | 0.53 s |
| Change to batch 1,000 after handoff | 100 ms | 8 | 0 | 0.53 s |

Neither initial ordinary sync writes any document bodies. The checkpoint pairs
remove the imported-ID audit, with 16 separate preparation and publication
requests. Publication also scans the 44,000 current local documents to verify
writer provenance; this remains local work, not a free operation. The ordinary
batch-size change retains progress. A subsequent local edit and remote edit
both propagate, writing one body in each direction. A separate HTTP integration
test receives a new revision after switching to LiveSync mode.

The no-handoff count differs from the earlier 5,927 because fixed connection
and terminal requests depend on the fixture and connection state. Its 1,760
known-only push batches still contribute the same leading `5,280R` waiting
term: 528 seconds at 100 ms RTT. The handoff removes that term, rather than
merely increasing the batch size. Eight fixed requests overlap; their observed
0.53 seconds must not be modelled as eight sequential RTTs.

These are single, ordered trials, with warmed caches, artificial small bodies,
and an in-memory local adapter. The baseline audit has no injected delay,
whereas the handoff trial has 100 ms per request. The timing ratio therefore
does not isolate a speedup. Rebuild preflights, control writes, encryption,
filesystem reflection, bandwidth limits, Cloudant, and mobile resources remain
outside this measurement. The exact candidate passes package-owned tests and
downstream build checks; this is not a real-Obsidian end-to-end measurement.

This supports selecting **0 under rule A** as the common new-configuration
recommendation, alongside the measured ongoing-edit and payload benefits.
Fast Fetch plus this handoff addresses the previously dominant post-download
round trips for an eligible initial receiver. More Chunks still increase
stream pages, local inventory checks, hashing and database work, initial
upload batches, and ordinary scans after long offline periods. Mostly
immutable, binary-heavy Vaults can reasonably retain an explicit larger value.
The recommendation retires a universal 60 without claiming that every workload
is faster or that an old receiver setting re-chunks existing remote data.

### Keep large initial uploads and rebuilds on the existing Replicator

The fresh Fast Fetch handoff improves initial reception. It does not reduce
the number of new documents in a first upload or after a remote reset. Retain
the existing Replicator and its ordinary paired checkpoints for those uploads.
A dedicated bulk uploader and source-only upload checkpointing are deferred.
The [upload analysis][upload-analysis-evidence] records the following logical
costs and the historical reasons for this choice; it adds no upload code or
setting changes.

Ordinary PouchDB replication already uploads batches with `_bulk_docs` and
`new_edits=false`. For `D` changes rows, batch size `b`, and all bodies missing,
`K=ceil(D/b)` batches have approximately `4KR` of sequential remote waiting:
revision comparison, bulk write, checkpoint GET, and checkpoint PUT. The prior
15 measured initial-upload samples match `4K+32` HTTP requests; 32 is their
fixture-specific overhead, rather than another per-batch cost.

| Upload model: 4,000 files and 40,000 Chunks | Batches | Leading RTT wait at 100 ms |
| --- | ---: | ---: |
| Existing batch 25, paired checkpoints | 1,760 | 704 s |
| Batch 100, paired checkpoints: tuning hypothesis | 440 | 176 s |
| Batch 250, paired checkpoints: tuning hypothesis | 176 | 70.4 s |
| Batch 100, source-only checkpoints: deferred alternative | 440 | 88 s, plus final publication |

These are logical waiting terms, not new WAN measurements or total upload
times. A separately assumed 1 GiB of serialised, encrypted request content at
10 MiB/s adds a 102.4-second transfer term before controls, local work,
reflection, rate limits, and failures. It is not 1 GiB of raw Vault files.
A five-times-larger 20,000-file, 200,000-Chunk example multiplies the displayed
waiting terms by five. Document count therefore remains material under value 0,
even though repeated local edits can transfer less new content.

#### Distinguish the rebuild routes and later pull

A full Rebuild replaces the local database and regenerates documents from the
current authoritative files before uploading. A remote-only Rebuild retains
the local database, including existing Chunk sizes, current conflict leaves,
tombstones, and any retained unreferenced Chunks. It does not re-chunk old
content merely because the current recommendation is smaller. Limiting an
upload to one winning Metadata body or only directly referenced Chunks would
change revision or garbage-collection semantics and is outside this decision.

Both rebuild routes retain their two ordinary upload passes. The second pass
converges follow-up changes through the checkpoint retained by the first; it
is not normally another full body upload. Retain that convergence behaviour.

An upload checkpoint is separate from the later remote-to-local pull
checkpoint. Before LiveSync mode, the current implementation performs a finite
pull. With the default `readChunksOnline=true`, that pull can still inspect
4,000 known Metadata rows; with full Chunk replication it can inspect all
44,000 rows. At batch 25 and 100 ms RTT, the corresponding leading known-only
pull waiting terms are approximately 32–48 seconds and 352–528 seconds,
respectively, depending on overlap between changes read-ahead and checkpoint
work. These are code-based planning ranges, not measured startup latencies;
fixed requests, controls, and local work are excluded. Four remote requests per
non-empty known-only pull batch are not four sequential waits. A local upload
sequence cannot be substituted for the remote pull sequence. The implemented
fresh-download handoff does not authorise this reverse shortcut.

#### Why the former Chunk pre-send is not reinstated

Bulk pre-send was introduced for 0.23.21 in September 2024. A later commit
buffered it after out-of-memory failures, and another disabled it by default.
In the maintainer's [Issue #505 explanation][bulk-ordering-report], its
automatic path broke the chunks-before-Metadata ordering guarantee; its
original purpose had been faster remote rebuilds. The automatic path was
removed for 0.24.0. The current explicit maintenance Resend still calls the
Chunk-send method, but it is not the normal initial-upload path.

Sending Chunks before ordinary replication does not create the ordinary
replication checkpoint. The later push can therefore still scan every source
identifier. If Metadata is distributed through the source changes batches,
many batches still need their bulk write after the Chunks have been pre-sent.
Pre-send can add work without removing those waits. A separate Chunk-transfer
cursor and an ID-existence check do not prove complete ordinary replication.

The retained method also does not inspect the per-document error results of
its bulk write, and estimates batch bytes before the remote encryption and
serialisation boundary. These are code-review findings, not newly reproduced
production failures or fixes. CouchDB's [bulk API][bulk-api] is non-atomic and
can return document errors in an otherwise successful HTTP response. A new
uploader would have to preserve every required revision and its ancestry,
handle those errors and lost responses, bound memory and final request bytes,
and publish only a proven completed prefix. That is additional replication
machinery, rather than a transport-only replacement.

#### Scope of future tuning

Keep native revision enumeration, retry behaviour, per-document failure
handling, and paired checkpoints. The current finite-transfer path treats
PouchDB `denied` events as failures. Temporary initial-upload batching remains
a possible later experiment, with unchanged replication identity, but larger
counts require a final-byte and memory bound. A remote-only Rebuild can still
contain old large Chunks: assuming that every document follows rule A at value
0 would be unsafe. Even a small new Chunk policy does not bound arbitrary
Metadata or all legacy documents.

Cloudant's 1 MB document and 64 MB request limits still apply; batching does
not remove document-based write consumption or provisioned-throughput limits.
An illustrative direct uploader filling 8 MiB requests would need at least
128 bulk writes for the assumed 1 GiB, or 12.8 seconds of serial RTT waiting
before every other cost. This is only a lower bound: partial packing, document
count limits, Chunk and Metadata ordering, acknowledgements, checkpoints, and
later pull remain. That attractive lower bound does not justify replacing
working replication machinery in this change.

Retain 0 under rule A as the common new-configuration recommendation, with the
explicit cost that first uploads and large rebuilds can be slower. Its basis
is ongoing reuse and payload headroom, not minimum first-upload time. Mostly
immutable, binary-heavy Vaults retain a valid reason for a larger explicit
value. Initial-upload optimisation is a separate bounded follow-up; neither
the former persistent bulk-send switch nor a new uploader is added here.

### Cloudant constrains both documents and requests

IBM documents limits of 1 MB per JSON document and 64 MB per request body.
Chunks use JSON documents, so the separate attachment allowance is inapplicable.
The conservative probes used 1,000,000 and 64,000,000 bytes.

A 512,000-byte binary Chunk at size 4 produced a 910,529-byte V2 encrypted JSON
document including replication fields. Size 5 produced 1,092,573 bytes and was
rejected by the local document-limit model. Fifty documents of the former
class occupy approximately 45.55 MB; 100 occupy approximately 91.07 MB.

This is not a universal guarantee for size 4 or batch size 50. An unencrypted
control-character text document occupied 3,072,213 wire bytes; a synthetic
25-document bulk request was rejected by the 64 MB request-limit model, whereas
20 were accepted. CouchDB's parsed-body size estimate differs from escaped
wire JSON, and Cloudant's internal accounting was not verified. Metadata and
multiple conflicting revisions must also fit the relevant limits.

A future compatibility policy therefore needs final-document and actual bulk
payload constraints. Count-only tuning cannot guarantee compatibility. Bulk
HTTP requests can also consume multiple Cloudant throughput units; batching
does not remove service quotas. The probes modelled limits locally and did not
measure IBM Cloudant service performance. See [IBM limits][cloudant-limits] and
[throughput accounting][cloudant-throughput].

## Verification

The earlier window-only candidate passed Commonlib types, 2,416 unit tests, boundary
and release-tool checks, and its packed consumer. The exact packed candidate
passed downstream LiveSync checks, 1,297 unit tests with one skip, and the
plug-in, CLI, WebApp, and WebPeer builds. Existing lint warnings remain.

The transport experiment verified 1,890 file-stage digests and 84 persisted
configurations, in addition to the 90 mixed-version file checks. The analytical
model reproduced the observed initial CouchDB request count `4K+32` for all 15
saved samples; 32 is fixture-specific. Model replay and limit cases were checked
without running new WAN measurements. These checks do not validate future
default changes or claim that the reporter's issue is resolved.

The separate binary-policy experiment checked 45 corpus digests, 555 boundary
sequences against the installed window-fixed splitter, 2,160 content
reconstructions, 15 deterministic replays, and six focused harness tests. Its
90 timing samples cover three repeats, two inputs, five sizes, and three rules.
These checks validate the experiment, not an implemented replacement policy.

The default reassessment checked 45 corpus input digests, 15,403 keyed identity
generations, and 5,177 encryption/decryption round trips. The 18 measured
production-pipeline timing trials reproduced their expected Chunk counts and,
for the mixed corpus, exact leaf JSON totals. No new remote, Cloudant-service,
mobile, packed-candidate, or mixed-version tests were performed for rule A.

The separate handoff experiment completed 17 measured phases against a
disposable CouchDB. All five cold audits checked 44,000 push revisions without
body writes and matched their request formula. It verified batch-change
continuity, local-then-both checkpoint publication, subsequent two-way edits,
and the missing-conflict-leaf counterexample. The delay comparison injected
20 ms per HTTP request. It did not validate production failure recovery,
Cloudant service behaviour, full Obsidian rebuilds, mobile resources, or
multi-gigabyte transfer. That experiment changed neither production handoff nor settings; the subsequent
fresh-import implementation is described above.


The complete fresh-import candidate passes Commonlib types, 2,437 unit tests,
11 focused real-CouchDB integration tests, boundary and release-tool checks,
and the packed consumer gate. Full-leaf regression fixtures fail before their
respective fixes, including missing conflict leaves, winner ancestry, and
scattered missing-revision grouping. The fresh-handoff tests cover provenance,
checkpoint guards, partial publication, batch and directional identity, and
subsequent edits. Both npm 10.9.4 clean installation and the normal npm clean
installation pass.

With that exact packed artefact installed, Self-hosted LiveSync passes
`npm run check`, 1,298 unit tests with one skip, and the plug-in, CLI, WebApp,
and WebPeer builds. Its focused resource and provider tests pass 25 cases.
The unit command excludes `.bench/**`, because a retained source copy from an
earlier experiment is not a maintained downstream test and requires Commonlib's
own aliases. The first unrestricted run's only failed suite is that generated
copy; all maintained suites pass. Existing lint and bundle-size warnings remain.

The fresh-import experiment verifies all 44,040 imported current revisions,
40 complete conflict pairs, zero post-handoff push-ID scans and body writes,
batch-change continuity, and subsequent two-way edits. Its eight measured
phases and the separate LiveSync-mode integration test validate the narrowed
initial handoff, not arbitrary-time or automatic recovery behaviour. No new
rule-A splitter, setup default, mixed-version migration, Cloudant-service test,
or real-Obsidian rebuild is claimed by this implementation.

[issue]: https://github.com/vrtmrz/obsidian-livesync/issues/1180#issuecomment-6261651086
[evidence]: evidence/2026_10_chunking_and_transport_batching.json
[binary-policy-evidence]: evidence/2026_10_binary_policy_comparison.json
[default-evidence]: evidence/2026_10_proportional_chunk_default.json
[handoff-evidence]: evidence/2026_10_fast_fetch_handoff.json
[pouch-api]: https://pouchdb.apache.org/api.html#replication
[fastcdc]: https://www.usenix.org/system/files/conference/atc16/atc16-paper-xia.pdf
[cloudant-limits]: https://cloud.ibm.com/docs/Cloudant?topic=Cloudant-limits
[cloudant-throughput]: https://cloud.ibm.com/docs/Cloudant?topic=Cloudant-faq-provisioned-throughput-capacity-model

[initial-forward-evidence]: evidence/2026_10_initial_fast_forward.json

[upload-analysis-evidence]: evidence/2026_10_initial_upload_analysis.json
[bulk-ordering-report]: https://github.com/vrtmrz/obsidian-livesync/issues/505#issuecomment-2419243551
[bulk-api]: https://docs.couchdb.org/en/stable/api/database/bulk-api.html#db-bulk-docs
