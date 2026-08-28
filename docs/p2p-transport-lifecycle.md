---
date: 2026-08-28
commonlib-version: "0.1.19"
self-hosted-livesync-version: "1.0.21"
status: unreleased
---

# P2P service and transport lifecycle

This design document records the implemented Commonlib Trystero P2P service. It defines the current resource owners, demand and automation lifecycles, replacement fences, and shutdown semantics. It is not a migration plan or a general Trystero API reference.

## Ownership layers

The P2P composition deliberately separates stable host policy from one replaceable room membership:

- `useP2PReplicatorFeature` composes one stable `LiveSyncP2PService` for the host lifetime and registers non-owning active-provider adapters over it;
- `LiveSyncP2PService` owns explicit-connect and explicit-disconnect intent, the disconnect veto, application lifecycle generation, delayed AutoStart work, and the seven public contract views;
- `P2PRoomSessionOwner` owns persistent and finite room demands, serialised room construction and retirement, effective-binding comparison, publication of the current session, and the stable `P2PAutomationCoordinator`;
- `P2PAutomationCoordinator` owns baseline-transfer de-duplication across room replacement, including in-flight work until settlement and completed peer baselines for the current automation generation and logical database identity;
- each `P2PRoomSession` owns one Trystero room binding, its LiveSync RPC surface, advertisements, client proxies, diagnostics, its session-lifetime controller, and the finite replication operations admitted through that room; and
- Trystero owns the underlying shared WebRTC peers and Nostr relay clients.

The implemented ownership topology is:

```text
host composition
└── useP2PReplicatorFeature()
    └── LiveSyncP2PService                         stable policy and public-view owner
        ├── seven focused views                    non-owning capability projections
        ├── compatibility Replicator               deprecated, non-owning façade
        └── P2PRoomSessionOwner                    stable session owner and lifecycle queue
            ├── P2PAutomationCoordinator           stable across room replacement
            └── current P2PRoomSession             replaceable room-membership owner
                ├── P2PHost and TrysteroReplicator session-bound RPC and transfer state
                └── Trystero room                  membership and action namespace
                    └── Trystero runtime           shared relay clients and physical peers
```

Only `P2PRoomSessionOwner` constructs, publishes, replaces, and retires the current `P2PRoomSession`. `LiveSyncP2PService` owns the intent which changes the owner's demand set; views, active-provider adapters, and the compatibility Replicator do not acquire session ownership.

| Owner                      | State which survives room replacement                                                            | State retired with one room session                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `LiveSyncP2PService`       | explicit-disconnect veto, lifecycle generation, contract-view identity                           | delayed AutoStart callback is cancelled or invalidated before lifecycle retirement                                                 |
| `P2PRoomSessionOwner`      | persistent and finite room-demand bookkeeping, lifecycle queue, automation coordinator           | published session and its effective binding                                                                                        |
| `P2PAutomationCoordinator` | completed baseline peer names for the current generation and in-flight promises until settlement | none merely because a room session retires; a lifecycle or identity change clears completed records and prevents stale publication |
| `P2PRoomSession`           | none                                                                                             | room, host, Replicator, advertisements, clients, callbacks, feeds, and admitted finite-operation controllers                       |
| Trystero                   | implementation-owned relay clients and potentially shared physical peers                         | the departed LiveSync room's membership, action namespace, and callbacks are detached through the Trystero room API                |

Ordinary consumers use the seven focused views returned by the service feature. They do not receive the room session, raw host, raw peer connection, or concrete Replicator. `ReplicatorService` receives a fresh non-owning active adapter when it selects P2P as the main remote. Disposing or replacing that adapter neither leaves the service-owned room nor cancels work owned by another service consumer. The explicit stop capability cancels current finite transfers without retiring the room.

The seven view getters currently return the same stable `LiveSyncP2PService` object. They are capability boundaries for consumers, not separately allocated owners. A consumer receives only the views it needs.

| View                       | Implemented responsibility                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `P2PTransportLifecycle`    | observe the current connection and accept explicit connect or disconnect intent                                          |
| `P2PPeerDirectory`         | supply a current peer advertisement snapshot                                                                             |
| `P2PPeerAdmission`         | apply or revoke temporary and persisted acceptance decisions                                                             |
| `P2PTargetedTransfer`      | pull, request push, synchronise one peer, or execute the persisted configured-target set without peer-selection dialogue |
| `P2PChangeRelay`           | watch or unwatch a peer and enable or disable local-change broadcast                                                     |
| `P2PConfigurationExchange` | retrieve configuration from one explicitly selected peer                                                                 |
| `P2PDiagnostics`           | request status and project RTC metrics without exposing the room or peer connection                                      |

The optional host UI factory is an explicit compatibility boundary. Commonlib supplies both the deprecated compatibility Replicator and the stable views. Maintained modal transport and status controls use the views; legacy interactive execution and rebuild-specific setup markers may still use the compatibility Replicator. Receiving that façade does not transfer ownership of the room. `UseP2PReplicatorResult.replicator` remains deprecated for the same bounded migration work.

## Room demands and automation generations

`P2PRoomSessionOwner` opens a room while at least one room demand exists. Persistent demands are currently `explicit`, `automatic`, and `rebuild-continuation`. A finite target operation receives an unexported symbol demand for its own lifetime. Removing one demand cannot close a room retained by another persistent or finite demand.

Acquiring a finite room demand opens or reuses a session and then supplies that session to the operation. `P2PRoomSession.runFiniteOperation()` has a different responsibility: it admits one abortable transfer into an already owned session. It does not acquire or release a room demand. Configured-target discovery and execution are admitted as one such session operation, so retirement cancels and awaits the outer orchestration as well as any peer transfer which it has started. This separation prevents the settlement of one transfer from closing a room retained by AutoStart or another operation.

`LiveSyncP2PService` owns the explicit-disconnect veto. A finite demand or AutoStart cannot reopen the room while that veto is set. A later explicit connect clears it. A completed Rebuild may acquire the distinct `rebuild-continuation` demand because that action continues an already authorised workflow; it does not clear the veto for later AutoStart work.

AutoStart is scheduled against the current application lifecycle generation. Suspension, unload, explicit disconnect, and other lifecycle closes invalidate the generation and clear the delayed callback. The callback re-reads current settings before it asks the owner to add the `automatic` demand. WebPeer and other maintained hosts dispatch the shared resumed-lifecycle hook rather than scheduling a second raw room open.

The stable `P2PAutomationCoordinator` de-duplicates the initial baseline for one normalised peer name across AutoSync and configured-target synchronisation. A transport-only or policy-only room replacement does not repeat a completed baseline when the peer namespace and local database identity remain unchanged. A new application lifecycle, a changed P2P peer namespace, or a different local database object clears completed baselines. In-flight operations are neither cancelled nor cleared by the coordinator: a request for the same normalised peer name may continue to share the existing promise until it settles. Work admitted under an older generation may settle, but cannot publish completion into the current generation. AutoWatch is not another baseline transfer: after an accepted peer advertises that it is broadcasting, it subscribes to later changes.

## Unattended target orchestration

Configured `P2P_SyncOnReplication` targets use `P2PTargetedTransfer.synchroniseConfiguredTargets()`. The generic unattended OneShot provider delegates to the same operation without peer-selection or peer-acceptance dialogues. The operation:

1. acquires a finite room demand;
2. waits for configured peer advertisements for a bounded period;
3. evaluates each advertised peer against persisted and automatic admission policy without prompting;
4. shares an accepted peer's baseline with AutoSync through `P2PAutomationCoordinator`; and
5. returns an explicit completed, partial, blocked, cancelled, or failed provider outcome.

Missing, rejected, and undecided targets remain visible in the target result rather than being reported as a successful headless operation. Denial takes precedence over acceptance. A headless undecided peer is not prompted and is not synchronised.

Peer replication uses the ordinary common readiness gates, but declares central-remote preparation as not applicable. It therefore retains online, version, pending-file, clean-up, and host policy checks without trying to retrieve or initialise a CouchDB Security Seed. CouchDB and Object Storage providers declare central-remote preparation as required.

## Active transfer cancellation

The provider's active-transfer stop capability asks the current `P2PRoomSession` to cancel every finite replication operation which it has admitted. The request returns after cancellation has been delivered; the operations then settle cooperatively. The session keeps the room, peer discovery, and RPC service available for later work. Stopping an active transfer is therefore distinct from disconnecting or replacing the P2P transport.

Each finite operation receives an effective abort signal derived from the session lifetime, its operation controller, and any caller or incoming RPC request signal. Cancellation is cooperative: an atomic database write which has already begun may settle, and its matching checkpoint may be recorded, before the operation reports cancellation. It is not a rollback promise.

Retiring the session first rejects new finite work, then aborts and awaits all admitted operations before releasing the room. Code admitted into the session must observe its effective signal and must not detach unowned work.

Configuration exchange and diagnostic reads are session-scoped requests, but are not finite replication operations. A request admitted before retirement may therefore settle against its originating session. Peer-admission decisions are persisted policy changes and intentionally settle independently of room replacement. None of these operations is included in active-transfer cancellation; peer callback and status fencing remains part of session retirement.

## Normal close

The transport lifecycle view delegates an explicit disconnect to `LiveSyncP2PService`. The service sets its disconnect veto, invalidates delayed automation, and asks `P2PRoomSessionOwner.close()` to clear every current demand and serialise retirement with any in-flight open operation. Retirement stops LiveSync-owned work, closes the RPC room, calls `room.leave()`, clears instance references, pauses relay reconnection, and closes the current Nostr relay WebSockets.

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

The room-session owner compares the selected profile, effective room and transport settings, session-bound automation settings, device identity, and local database object on every open. An unchanged binding keeps the serving transport, while a changed binding serialises retirement of the complete session before opening and publishing its replacement. Each transport binding and session-bound Replicator capture their P2P settings, device identity, and database object when they are created; later service lookups cannot replace those captured values while retirement is settling. Host callbacks which deliberately inspect current policy settings remain outside this transport-binding isolation. After the candidate room opens, the owner rechecks the current binding and publishes the candidate only when it still matches. This prevents changed credentials, policy, or database state from being applied partly to the former room or exposed through a stale candidate. No fixed close-to-open delay is required: lifecycle operations are serialised, and peer readiness is observed through discovery.

The stable service also participates directly in the local database lifecycle. Reset preparation and explicit database close await room retirement before the database managers are torn down and the physical PouchDB handle is destroyed or closed. The later database-initialisation hook remains a defensive retirement boundary before a replacement session is opened. The non-owning active adapter does not provide this fencing.

Saving settings reconciles only the demand owned by AutoStart. Disabling AutoStart removes the `automatic` demand but leaves a room retained by explicit connect, a Rebuild continuation, or finite work. Disabling P2P clears every demand and retires the room through the lifecycle queue, including an in-flight open. An explicit disconnect establishes a service-lifetime veto which a later automatic-start event cannot clear; a later explicit connect clears it.

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

- Commonlib unit tests must prove that normal close leaves the room without directly closing Trystero-owned peers, that database close handlers all settle before physical close, that disabling P2P cancels a pending open, that removing one policy demand retains a room held by another demand, that concurrent replacement requests leave one current owner, that a changed effective binding replaces a serving transport while an unchanged binding remains idempotent, that a rebuild-owned continuation can reopen independently of an automatic-start veto, and that retired peer callbacks and host subscriptions cannot reach a replacement;
- target-aware automation tests must prove bounded delayed advertisement discovery, non-interactive acceptance outcomes, explicit partial and blocked results, baseline de-duplication across AutoSync and configured targets, cancellation of delayed AutoStart after suspension, and a finite demand beside an AutoStart-held room;
- Commonlib rebuild tests must prove that first-device P2P initialisation does not reset a remote database and that an additional-device P2P Fetch performs one explicit peer-selection pass before resuming reflection;
- the Self-hosted LiveSync Compose P2P lifecycle test must replace a current replicator, rediscover the same real peer, perform bidirectional RPC, and verify transferred content from a separate process;
- the Self-hosted LiveSync real-Obsidian P2P Setup URI workflow must generate the second-device URI on the first device, accept both peer directions visibly, and verify a two-way note round-trip; and
- the relay-disconnect test must observe the original WebSocket reach `CLOSED`, remain closed while reconnection is paused, and be replaced after reconnection resumes.

The corresponding product decision and rejected alternatives are recorded in Self-hosted LiveSync's P2P room and transport lifecycle ADR.
