# P2P transport lifecycle

This guide is for developers composing Commonlib's Trystero P2P service. It describes resource ownership and shutdown semantics; it is not a general Trystero API reference.

## Ownership layers

The P2P composition has three distinct owners:

- `useP2PReplicatorFeature` owns one stable P2P service and one `P2PRoomSessionOwner`, while the compatibility façade resolves the owner's currently published session;
- each `P2PRoomSession` owns one Trystero room binding, its LiveSync RPC surface, advertisements, client proxies, diagnostics, and the finite replication operations admitted through that room; and
- Trystero owns the underlying shared WebRTC peers and Nostr relay clients.

Ordinary consumers use the seven focused views returned by the service feature. They do not receive the room session, raw host, raw peer connection, or concrete Replicator. `ReplicatorService` receives a fresh non-owning active adapter when it selects P2P as the main remote. Disposing or replacing that adapter neither leaves the service-owned room nor cancels work owned by another service consumer. The explicit stop capability cancels current finite transfers without retiring the room. The concrete `result.replicator` façade remains only as a deprecated migration boundary for existing panes.

## Active transfer cancellation

The provider's active-transfer stop capability asks the current `P2PRoomSession` to cancel every finite replication operation which it has admitted. The request returns after cancellation has been delivered; the operations then settle cooperatively. The session keeps the room, peer discovery, and RPC service available for later work. Stopping an active transfer is therefore distinct from disconnecting or replacing the P2P transport.

Each finite operation receives an effective abort signal derived from the session lifetime, its operation controller, and any caller or incoming RPC request signal. Cancellation is cooperative: an atomic database write which has already begun may settle, and its matching checkpoint may be recorded, before the operation reports cancellation. It is not a rollback promise.

Retiring the session first rejects new finite work, then aborts and awaits all admitted operations before releasing the room. Code admitted into the session must observe its effective signal and must not detach unowned work.

Configuration exchange and diagnostic reads are session-scoped requests, but are not finite replication operations. A request admitted before retirement may therefore settle against its originating session. Peer-admission decisions are persisted policy changes and intentionally settle independently of room replacement. None of these operations is included in active-transfer cancellation; peer callback and status fencing remains part of session retirement.

## Normal close

The transport lifecycle view delegates an explicit disconnect to the stable room-session owner. Its `close()` operation serialises the close with any in-flight open operation and retires the current room session. It stops LiveSync-owned work, closes the RPC room, calls `room.leave()`, clears instance references, pauses relay reconnection, and closes the current Nostr relay WebSockets.

Normal close deliberately does not call `close()` on the `RTCPeerConnection` values returned by `room.getPeers()`. Trystero 0.25 may share a physical peer across rooms. Leaving a room detaches its callbacks and action namespace, while Trystero may retain the idle physical peer for approximately 123 seconds for reuse. The retained peer cannot carry traffic for the departed room.

A host which constructs a raw `TrysteroReplicator` for a finite probe must call `dispose()` when it discards that object. `close()` releases the current transport while preserving host-lifetime subscriptions for a possible later open; `dispose()` performs that close and then releases those subscriptions permanently.

Likewise, an incoming peer-leave notification removes LiveSync advertisement and client state without directly closing the underlying peer. Trystero decides whether that peer is shared, stale, or ready for destruction.

The host command named 'Disconnect from the Signalling Server' means:

- the LiveSync P2P and RPC service stops immediately;
- room membership and room-scoped actions are removed;
- relay WebSockets close and automatic reconnection is paused; and
- an idle WebRTC object may remain under Trystero ownership until its reuse interval ends.

It is therefore a logical LiveSync disconnection and a physical signalling-server disconnection, not a synchronous destruction promise for every browser-owned WebRTC object.

## Reconnection and replacement

An explicit connect resumes Trystero relay reconnection before joining the configured room. Active-provider adapter acquisition is independent of that room lifecycle and cannot replace or close the service owner.

The room-session owner compares the selected profile, effective room and transport settings, session-bound automation settings, device identity, and local database object on every open. An unchanged binding keeps the serving transport, while a changed binding serialises retirement of the complete session before opening and publishing its replacement. Each session captures its P2P settings, device identity, and database object when it is created; it cannot observe replacements through later service lookups while retirement is settling. After the candidate room opens, the owner rechecks the current binding and publishes the candidate only when it still matches. This prevents changed credentials, policy, or database state from being applied partly to the former room or exposed through a stale candidate. No fixed close-to-open delay is required: lifecycle operations are serialised, and peer readiness is observed through discovery.

The stable service also participates directly in the local database lifecycle. Reset preparation and explicit database close await room retirement before the database managers are torn down and the physical PouchDB handle is destroyed or closed. The later database-initialisation hook remains a defensive retirement boundary before a replacement session is opened. The non-owning active adapter does not provide this fencing.

Saving settings with P2P or automatic start disabled always asks the stable service to close the room, even when it has not started serving. This cancels an in-flight open through the same lifecycle queue, so a connection cannot appear after the disabling setting has been applied. An explicit disconnect establishes a service-lifetime veto which a later automatic-start event cannot clear; a later explicit connect clears it.

A successful rebuild notification is a separately authorised continuation of the owning rebuild workflow, rather than an automatic-start request. It may therefore reopen the room independently of that automatic-start veto after the replacement database is ready.

Peer arrival and departure callbacks are bound directly to the `P2PRoomSession` which created the host. The global peer events remain available for status, logs, and legacy observation, but maintained service composition does not route them back into whichever session happens to be current. Retiring a session detaches its peer callbacks before closing the room, so a late advertisement from the former host cannot start work in its replacement. Once the host is disposed, delayed callbacks can no longer publish peer or status events which might overwrite the replacement's UI state. Host-lifetime subscriptions are released when that session is disposed, rather than during the temporary transport shutdown used before a room join.

Do not replace a relay socket's `onclose` handler. Trystero 0.25 shares relay clients by URL and uses its own handler to retire and recreate them. Use the exported pause and resume functions around explicit disconnection instead.

## First-device and additional-device setup

P2P has no central remote database. A first-device rebuild initialises the local database, then returns without attempting to lock, reset, or seed a remote database.

An additional-device Fetch uses one explicit peer-selection pass. The selected peer supplies the complete finite replication from the beginning, after which the rebuild service resumes database and Vault reflection. The generic second convergence pass remains appropriate for central remote types, but must not be applied to P2P: an injected Obsidian rebuild UI would otherwise ask the user to select the same peer twice and leave reflection suspended while the second dialogue waits.

## Unsupported forced close

Do not close the raw values returned by `room.getPeers()`. Both closing them before room departure and closing captured values after departure have prevented the same peer from being rediscovered within 60 seconds in the real-transport replacement test.

Commonlib consequently does not expose a forced physical-disconnection command. Such an operation requires a future Trystero API which removes and destroys peers through its shared-peer manager, followed by proof that immediate reconnection remains possible.

## Verification

Maintain all five boundaries when this lifecycle changes:

- Commonlib unit tests must prove that normal close leaves the room without directly closing Trystero-owned peers, that database close handlers all settle before physical close, that disabling settings cancel a pending open, that concurrent replacement requests leave one current owner, that a changed effective binding replaces a serving transport while an unchanged binding remains idempotent, that a rebuild-owned continuation can reopen independently of an automatic-start veto, and that retired peer callbacks and host subscriptions cannot reach a replacement;
- Commonlib rebuild tests must prove that first-device P2P initialisation does not reset a remote database and that an additional-device P2P Fetch performs one explicit peer-selection pass before resuming reflection;
- the Self-hosted LiveSync Compose P2P lifecycle test must replace a current replicator, rediscover the same real peer, perform bidirectional RPC, and verify transferred content from a separate process;
- the Self-hosted LiveSync real-Obsidian P2P Setup URI workflow must generate the second-device URI on the first device, accept both peer directions visibly, and verify a two-way note round-trip; and
- the relay-disconnect test must observe the original WebSocket reach `CLOSED`, remain closed while reconnection is paused, and be replaced after reconnection resumes.

The corresponding product decision and rejected alternatives are recorded in Self-hosted LiveSync's P2P room and transport lifecycle ADR.
