---
date: 2026-11-02
commonlib-version: "0.3.0"
self-hosted-livesync-version: "1.0.44"
status: unreleased
---

# CouchDB response caching and Security Seed changes

An encrypted remote Rebuild can preserve document IDs and revisions while
replacing the Security Seed and ciphertext. CouchDB uses the revision as the
ETag for ordinary documents, so revalidation can accept an earlier encrypted
body even though it no longer matches the current Seed. This affects Metadata
and Chunks. Reading the current Seed alone does not invalidate those responses.

## Request boundary

The CouchDB connection prepares read URLs through a private cache policy.
For encrypted connections which accept HKDF, GET and HEAD requests below the
database path carry `_livesync_epoch`. Its value is the hexadecimal SHA-256
digest of `UTF8(startupUnixSeconds + ':') || SecuritySeedBytes`. The startup
time and Seed are hashed together, so the URL contains neither a separate
timestamp nor a stable Seed fingerprint. Identical Seed bytes use the same
value across connections in that process; a different startup second or Seed
selects another URL without changing document IDs, revisions, or stored data.

The policy uses the connection's existing Seed callback, also used by its
encryption transform. It observes refreshed parameters rather than keeping a
second remote-generation record. No passphrase is included in the URL, and no
additional state is persisted. Writes retain their existing URLs.

Database information and `_local` document reads omit the extra parameter.
In particular, `_local/obsidian_livesync_sync_parameters` must remain readable
before a Seed is available. CouchDB 3.5.3 includes the local document body in
its ETag, so a changed Seed also changes that ETag even when a recreated local
document has the same revision.

`useCouchDBCacheControlHeadersOnly` is an optional compatibility setting which
defaults to `false` for both new and existing settings. When `true`, GET and
HEAD requests retain their original URLs and use `cache: 'no-store'`. Hosts
must translate that mode into both cache suppression and revalidation headers
for a native adapter. Use it only when a server or proxy rejects the additional
query parameter: header-only control can still reuse stale encrypted bodies
on affected native caches. Seed refresh before replication remains active in
both modes. The replicator captures this choice with its connection settings;
direct `RemoteService.connect` consumers can supply the same optional property
in `RemoteConnectionOpenOptions`.

With the default policy, all GET and HEAD requests request `cache: 'no-cache'`: contact the server for
validation while allowing reuse of a validated body from the same Seed. A host
which implements a native request adapter must carry that mode into request
headers. Commonlib applies the same URL and mode to a diagnostic native fallback.
The host and server determine whether validation returns 304 or a full body;
a stable URL does not guarantee a cache hit.

## Replication preparation

Each CouchDB one-shot attempt refreshes synchronisation parameters before
connectivity checks or transfer. This includes directional Fetch and Send,
which need not pass through a host's ordinary readiness checks. Continuous
replication's initial catch-up uses the same preparation. Seed preparation
retains its existing position outside the bounded connectivity preflight.

Direct connection consumers remain responsible for preparing current remote
parameters before encrypted access. An active transfer is not an atomic live
migration across remote Rebuilds. Keep the existing remote lock, participant
acceptance, and connection lifecycle rules; cache separation does not authorise
an old device to write to a rebuilt remote.

## Verification boundary

`RemoteService.unit.spec.ts` verifies encrypted Metadata and Chunk reads after
a Seed change with a native-cache model which reuses matching revision ETags,
including legacy settings which accept HKDF. `couchdbHttpCache.unit.spec.ts`
covers URL stability, Seed changes, bootstrap reads, request preservation, and
independent connection callbacks. CouchDB replicator tests cover Seed refresh
before ordinary and directional replication checks.

The maintained Obsidian cache workflow warms an earlier HTTP response, performs
a remote Rebuild, and reads through an owned Commonlib connection. It checks
changed URLs after Seed replacement, stable URLs across connections with the
same Seed, decoded Metadata, and subsequent replication. Native iPadOS cache
behaviour still requires validation on that platform.
