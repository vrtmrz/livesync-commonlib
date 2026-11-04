---
date: 2026-11-03
commonlib-version: "0.3.0"
self-hosted-livesync-version: "1.0.44"
status: published
---

# Architectural Decision Record: Shared Storage Path Resolution

## Conclusion

Commonlib owns strict Unicode path comparison and resolution behind a focused
`/storage` entry. Node and File System Access provide thin storage integrations;
hosts retain filesystem handles, original paths, caches, watchers, and operation
lifecycle. The [design](../design_docs/storage_path_resolution.md) defines the
accepted contract and remaining adoption work.

Accepted on 2026-11-03 against the versions recorded above. The implementation
is published in [Commonlib 0.3.1](https://www.npmjs.com/package/@vrtmrz/livesync-commonlib/v/0.3.1).
The original date and reviewed versions retain the accepted baseline.
Publication does not by itself enable NFC in WebApp or Bridge.

## Context

The Self-hosted LiveSync CLI already resolves NFC-equivalent names component by
component while preserving physical spelling. Repeating that logic in browser
and Deno hosts would duplicate ambiguity, missing-path, and rename rules.
Meanwhile, the legacy path union includes comparison keys, so removing a
namespace can appear to turn a lossy comparison value back into a file path.

## Decisions

- Separate original document paths, unprefixed file paths, NFC refinements,
  resolved storage paths, and comparison keys. Preserve the old public types;
  new namespace helpers exclude their legacy comparison-key member.
- Inject only strict directory enumeration into the resolver. Return `null`
  for absence, and propagate permission, non-directory, and other I/O failures.
  Resolve ambiguity before mutation, including when an exact spelling exists.
- Copy comparison settings for one operation or scan. Retain no cross-operation
  directory cache or persistent path mapping. Scan already resolved entries
  once per directory, and re-resolve later lookups after external changes.
- Preserve ordinary writes' physical spelling. An explicit rename may request
  another spelling of the same leaf. Mutation and replacement semantics remain
  with the storage owner; resolution is not an atomic reservation.
- Keep string-taking storage APIs and Legacy behaviour. New physical-I/O ports
  take `StoragePath`. Namespace routing and cryptographic document-ID derivation
  remain separate from filesystem resolution.
- Adopt the shared implementation in the CLI and the shared comparison and
  namespace helpers at applicable Obsidian boundaries. WebApp and Bridge NFC
  enablement remains separate work, including admission, events, and caches.

## Alternatives considered

- Duplicating the CLI resolver per host would duplicate the behavioural contract
  and its failure handling.
- Renaming all physical files to NFC would alter user-owned storage and require
  collision recovery beyond the accepted scope.
- A persistent alias map or shared directory cache would introduce invalidation,
  restart, and lifecycle obligations which current directory reads avoid.
- Combining namespace, Unicode form, and case in a family of filename types
  would conflate independent properties. Comparison keys instead name their
  purpose and their storage or document domain.

## Consequences and verification

Hosts supply trustworthy complete listings and preserve distinct names before
constructing keyed collections. Filesystems or APIs which hide aliases limit
what the resolver can observe. Host concurrency and permission checks remain
necessary after resolution.

Contract tests cover spelling, ambiguity, strict failures, snapshots, scans,
and renames. Packed-consumer tests check assignability and platform bundling.
The downstream CLI retains its behavioural suite against the exact packed
candidate. Memory-backed File System Access tests establish adapter behaviour;
real-browser permissions and Deno integration require their own host evidence.
