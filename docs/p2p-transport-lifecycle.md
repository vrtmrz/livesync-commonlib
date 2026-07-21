# P2P transport lifecycle

This guide is for developers composing Commonlib's Trystero P2P service. It describes resource ownership and shutdown semantics; it is not a general Trystero API reference.

## Ownership layers

The P2P composition has three distinct owners:

- `useP2PReplicatorFeature` owns the current `LiveSyncTrysteroReplicator` exposed to a host;
- the Commonlib P2P host owns LiveSync RPC, advertisements, client proxies, diagnostics, and one Trystero room binding; and
- Trystero owns the underlying shared WebRTC peers and Nostr relay clients.

Consumers must retain the service-feature result and resolve `result.replicator` at the point of use. A settings or database lifecycle transition can replace the replicator. A command, event listener, or view which captured the former instance could otherwise reopen a transport which the current service no longer owns.

## Normal close

`LiveSyncTrysteroReplicator.close()` serialises the close with any in-flight open operation. It stops LiveSync-owned work, closes the RPC room, calls `room.leave()`, clears instance references, pauses relay reconnection, and closes the current Nostr relay WebSockets.

Normal close deliberately does not call `close()` on the `RTCPeerConnection` values returned by `room.getPeers()`. Trystero 0.25 may share a physical peer across rooms. Leaving a room detaches its callbacks and action namespace, while Trystero may retain the idle physical peer for approximately 123 seconds for reuse. The retained peer cannot carry traffic for the departed room.

Likewise, an incoming peer-leave notification removes LiveSync advertisement and client state without directly closing the underlying peer. Trystero decides whether that peer is shared, stale, or ready for destruction.

The host command named 'Disconnect from the Signalling Server' means:

- the LiveSync P2P and RPC service stops immediately;
- room membership and room-scoped actions are removed;
- relay WebSockets close and automatic reconnection is paused; and
- an idle WebRTC object may remain under Trystero ownership until its reuse interval ends.

It is therefore a logical LiveSync disconnection and a physical signalling-server disconnection, not a synchronous destruction promise for every browser-owned WebRTC object.

## Reconnection and replacement

An explicit open resumes Trystero relay reconnection before joining the configured room. Settings application may change the relay URLs, room ID, passphrase, or TURN configuration, so the owning service closes and discards the former LiveSync instance before constructing the replacement. No fixed close-to-open delay is required: lifecycle operations are serialised, and peer readiness is observed through discovery.

Do not replace a relay socket's `onclose` handler. Trystero 0.25 shares relay clients by URL and uses its own handler to retire and recreate them. Use the exported pause and resume functions around explicit disconnection instead.

## First-device and additional-device setup

P2P has no central remote database. A first-device rebuild initialises the local database, then returns without attempting to lock, reset, or seed a remote database.

An additional-device Fetch uses one explicit peer-selection pass. The selected peer supplies the complete finite replication from the beginning, after which the rebuild service resumes database and Vault reflection. The generic second convergence pass remains appropriate for central remote types, but must not be applied to P2P: an injected Obsidian rebuild UI would otherwise ask the user to select the same peer twice and leave reflection suspended while the second dialogue waits.

## Unsupported forced close

Do not close the raw values returned by `room.getPeers()`. Both closing them before room departure and closing captured values after departure have prevented the same peer from being rediscovered within 60 seconds in the real-transport replacement test.

Commonlib consequently does not expose a forced physical-disconnection command. Such an operation requires a future Trystero API which removes and destroys peers through its shared-peer manager, followed by proof that immediate reconnection remains possible.

## Verification

Maintain all three boundaries when this lifecycle changes:

- Commonlib unit tests must prove that normal close leaves the room without directly closing Trystero-owned peers, and that overlapping open and close requests leave one current owner;
- Commonlib rebuild tests must prove that first-device P2P initialisation does not reset a remote database and that an additional-device P2P Fetch performs one explicit peer-selection pass before resuming reflection;
- the Self-hosted LiveSync Compose P2P lifecycle test must replace a current replicator, rediscover the same real peer, perform bidirectional RPC, and verify transferred content from a separate process; and
- the Self-hosted LiveSync real-Obsidian P2P Setup URI workflow must generate the second-device URI on the first device, accept both peer directions visibly, and verify a two-way note round-trip; and
- the relay-disconnect test must observe the original WebSocket reach `CLOSED`, remain closed while reconnection is paused, and be replaced after reconnection resumes.

The corresponding product decision and rejected alternatives are recorded in Self-hosted LiveSync's P2P room and transport lifecycle ADR.
