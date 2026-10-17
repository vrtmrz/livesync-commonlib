---
date: 2026-10-17
commonlib-version: "0.1.41"
self-hosted-livesync-version: "1.0.37"
status: unreleased
---

# File-reflection content hash decision

This document records the accepted choice of SHA-256 for device-local file-reflection provenance. The versions above identify the reviewed source bases; the implementation was not published in Commonlib 0.1.41. Commonlib owns the record format, hash helper, and unchanged-file classification. Self-hosted LiveSync owns its persistent store and the Review Harness used to measure the helper on actual devices.

## Context

An unchanged file can outlive its recorded database revision. Reproduction for [Self-hosted LiveSync issue #1207](https://github.com/vrtmrz/obsidian-livesync/issues/1207) showed that a receiving PouchDB database with `revs_limit: 100` could prune that revision after 100 remote updates. The provenance record and old Chunks could still exist, but the handler could no longer reconstruct the exact recorded snapshot for comparison. Conservative preservation then created an unnecessary independent conflict branch.

The [file-provenance contract](conflict-resolution.md#file-reflection-provenance) now retains a hash and byte length of the exact immutable content successfully saved or reflected. When the old revision is unavailable, this evidence can establish that current storage is unchanged under the existing reflection policy. A false match could instead classify a genuine edit as unchanged and allow incoming content to overwrite it. There is no old body available for a confirming byte-for-byte comparison in that case.

## Decision and alternatives

Use Web Crypto SHA-256, persisted as `sha256:<lowercase hexadecimal>` alongside the byte length. This is a content fingerprint, not authentication, encryption, or a replacement for the revision identity. Hash equality remains probabilistic; the length check does not distinguish different contents of the same size.

We compared the existing xxHash64 implementation because it offers a faster, smaller fingerprint and is already available through `octagonal-wheels`. [xxHash documents XXH64 as a 64-bit, non-cryptographic hash](https://github.com/Cyan4973/xxHash#xxhash---extremely-fast-hash-algorithm). Non-cryptographic hashing is not categorically unsuitable for accidental-change detection, and this feature does not introduce an adversarial authentication requirement. Our choice favours SHA-256's wider digest and cryptographic collision resistance because the fingerprint can be the remaining content evidence before an overwrite. It is not a claim that an xxHash64 collision was observed or is likely in an ordinary Vault.

The measured mobile cost was acceptable for this decision: the 1-MiB difference was 0.9 ms on the tested Android device and below the visible timing difference on the tested iPhone. Larger inputs and the desktop environment showed a material advantage for xxHash64, which we accept as a cost of the current choice. We did not establish a universal performance threshold. XXH3-128 and other wider non-cryptographic hashes were not measured; these results do not reject them on performance grounds.

Byte-for-byte comparison against an exact readable revision remains available. Relying on that comparison alone cannot address the pruned-revision case. Existing Chunk ID algorithms and independent ID derivation have separate contracts and are unchanged by this decision.

## Measured cost

Measurements were taken on 17th October 2026 with the same local Self-hosted LiveSync 1.0.37 build and packed Commonlib candidate. The desktop result came from the real-Obsidian Review Harness scenario; the Android and iOS results came from maintainer-supplied reports. The table shows medians in milliseconds for the larger inputs.

| Environment | Input | SHA-256 | xxHash64 |
| --- | --- | ---: | ---: |
| Linux ARM desktop | 1 MiB | 15.10 | 3.50 |
| Linux ARM desktop | 50 MiB | 578.40 | 83.90 |
| Android 13, Obsidian 1.14.4 | 1 MiB | 4.90 | 4.00 |
| Android 13, Obsidian 1.14.4 | 50 MiB | 130.10 | 89.90 |
| iOS 18.7, Obsidian 1.14.5 | 1 MiB | 1.00 | 1.00 |
| iOS 18.7, Obsidian 1.14.5 | 50 MiB | 34.00 | 24.00 |

Each algorithm had three samples per fixed in-memory Blob at 4 KiB, 64 KiB, 1 MiB, and 50 MiB. Timings included Blob reading and hashing, with input construction, engine initialisation, and warm-up excluded. Calls ran serially, alternated algorithm order, and yielded to the interface between calls. SHA-256 used the production `computeFileContentHash(Blob)` helper; xxHash64 used `xxhashNew().h64Raw` after separate engine initialisation.

Three samples do not establish a device-wide performance guarantee. Small inputs were noisy or below the visible clock resolution, so a reported zero does not mean zero execution time. The measurements exclude filesystem I/O and full synchronisation; they do not establish battery cost, interface responsiveness during bulk work, or peak memory use. Approximate JavaScript heap samples were available on Android and unavailable on iOS.

## Consequences and reconsideration

Hashing is serialised before Blob reading to limit simultaneous whole-file buffers, and a handler reuses a result only for the same immutable Blob. This is not a streaming implementation: it allocates the complete file buffer, and [Web Crypto's digest operation copies its input bytes](https://www.w3.org/TR/webcrypto/#SubtleCrypto-method-digest). Memory cost therefore remains a reason to revisit the implementation for large attachments.

Records keep an explicit algorithm prefix. Older records are upgraded only after their exact revision and bytes can be verified; unsupported evidence or a hashing failure retains conservative handling. A future algorithm change needs an explicit compatibility policy for persisted records. There is no user-selectable hash-method setting.

Revisit this choice if representative device or bulk-synchronisation measurements show that hashing or whole-file allocation is a material bottleneck. Compare alternatives through the same production-path benchmark, assess the overwrite consequence and persisted-record compatibility, and retain regression coverage for real edits and pruned history. The present measurements justify the accepted trade-off; they do not close off a later, evidence-based revision.
