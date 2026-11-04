---
date: 2026-11-04
commonlib-version: "0.3.1"
self-hosted-livesync-version: "1.0.44"
status: unreleased
---

# Journal receive failures and recovery

This document describes unreleased receive behaviour. Hosts choose when to
offer the manual skip operation and remain responsible for Vault reflection
and conflict handling.

## Stop and retry by default

A per-Journal decode, record-processing, or write failure stops receipt. The
failed Journal and all later Journals remain unacknowledged. The next normal
receive attempt retries the failed Journal before proceeding to later Journals.
Partial progress does not change this rule.

Chunks are written before Metadata, so a Chunk failure prevents that Journal's
Metadata stage. Metadata retains its received revision ancestry through
`new_edits: false`, whose empty success result is valid. Successfully written
records remain in the database when another record fails. There is no rollback.

A retry avoids rewriting existing records and delivers accepted Metadata to
the host again, including revisions saved before an earlier partial failure.
The host must tolerate repeated delivery. Chunk-arrival events describe only
successful writes. The `knownIDs` set suppresses unnecessary
outbound transfer; it does not prove that a receive has completed locally.

Warnings identify the failed Journal key and the stage where receipt stopped,
without logging document contents. A stop request lets current I/O settle and
closes the receive operation; it is not a Journal failure.

## Skip the stopped Journal and resume

When receipt stops on a Journal failure, a host may offer the explicit
'Skip stopped Journal and resume' operation. It accepts the exact stopped
failure snapshot, marks only that Journal received, and resumes receipt of the
remaining Journals. If another Journal fails, receipt stops at that Journal
and requires a separate decision.

Skipping does not roll back partial writes. It can leave content or revision
history missing, and receipt of later Journals does not prove that every file
can be reconstructed or reflected to storage. Each skip acknowledges the
failed Journal despite its warning.

The stopped failure is runtime state, not a persistent skip mode or failure
queue. After a restart, normal receipt must encounter the failure again before
the host can offer a skip for it.

## Replay and host boundaries

The existing 'Reset journal received history' operation clears `receivedFiles`
and `knownIDs`, while retaining the local database and `sentFiles`. After the
failure has been corrected, resetting this history lets receipt replay remote
Journals other than those sent by this device. Replay requires the affected
remote objects to remain available and readable; resetting history cannot
recreate missing remote bytes.

A host operation which replaces the local database, such as CLI Fetch, has
separate reconstruction and completion rules. Repeating Fetch is not the
same-database retry described above. Journal receipt also remains separate
from Vault reflection and conflict handling; hosts must preserve their own
failure and content-protection checks.
