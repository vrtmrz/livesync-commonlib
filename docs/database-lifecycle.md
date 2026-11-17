---
date: 2026-10-25
commonlib-version: "0.2.0"
self-hosted-livesync-version: "1.0.40"
status: unreleased
---

# Local database lifecycle

This document defines ownership and event ordering for the local PouchDB database. It is a developer contract for Commonlib and maintained hosts. It does not define remote database ownership or user-facing recovery policy.

## Identities

The lifecycle distinguishes three related objects:

- the **settings-selected database** is the physical database name derived from the Vault name and the current `additionalSuffixOfDatabaseName` setting;
- the **active database** is the `LiveSyncLocalDB` instance currently exposed by `DatabaseService`; and
- the **physical database** is the adapter-owned PouchDB store addressed by the active instance.

Changing `additionalSuffixOfDatabaseName` changes the settings-selected identity. It does not retarget an existing `LiveSyncLocalDB`, because that instance captures its database name when it is constructed.

## Ownership

`DatabaseService` owns the active database identity. It is the only service which selects, replaces, or resets the active `LiveSyncLocalDB` instance. It does not retain a candidate whose physical initialisation was rejected. A failed reset also discards the unusable active wrapper so later callers cannot mistake it for an operable database.

`LiveSyncLocalDB` owns the physical PouchDB handle and its managers. It performs physical initialisation, close, and destruction after the surrounding services have coordinated through `DatabaseEventService`.

`DatabaseEventService` coordinates dependent services around one physical lifecycle transition. Its hooks do not select a database identity.

Rebuild and fetch workflows own user intent and settings changes. They must ask `DatabaseService` to reset the database selected by the resulting settings, and must stop before remote mutation if that local operation fails.

## Readiness model

Readiness is not one state. The current implementation exposes the following distinct signals:

| Signal or phase                                | Becomes ready or occurs when                                                                                                                                                     | Does not guarantee                                                                                                                            |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Physical database handle                       | `LiveSyncLocalDB.initializeDatabase()` has created the PouchDB handle and its managers                                                                                           | Manager initialisation, accepted readiness hooks, a Vault scan, or application readiness                                                      |
| `LiveSyncLocalDB.isReady`                      | Preparation hooks and manager initialisation have completed, handlers have been installed, and `onDatabaseHasReady()` has accepted the transition                                | That the Vault has been scanned or that application operations are enabled                                                                    |
| `DatabaseEventService.onDatabaseHasReady()`    | The local readiness flag is temporarily visible so handlers can initialise against the selected physical database                                                                | Wider application readiness; rejection or handle loss rolls the physical transition back                                                      |
| Vault scan                                     | `prepareDatabaseForUse()` or an owning rebuild workflow invokes `scanVault()` against a physically ready local database                                                          | Complete storage/database convergence, a durable readiness state, or completion of file events admitted after a later finite local completion boundary; a `false` result prevents the wider transition |
| `DatabaseEventService.onDatabaseInitialised()` | The wider initialisation path has completed its requested database-open and Vault-scan phases                                                                                    | The finite local completion boundary which follows this hook, or work admitted after that boundary                                            |
| `Rebuilder.finishRebuild()`                    | The owning fetch has staged reflection resumption, completed its final scan and replication pre-check when required, completed its finite boundary for local operations, and persisted settings | That later watcher work or remote delivery has finished; it establishes application readiness only when all required phases succeed          |
| `AppLifecycleService.isReady()`                | Ordinary initialisation or explicit rebuild completion has accepted every required phase through the finite local completion boundary                                                  | Future local events, remote availability, or replication completion                                                                     |
| `EVENT_APPLICATION_READY`                      | `AppLifecycleService.markIsReady()` has changed `isReady()` to true, on the event channel of the service context                                                                 | That work held until readiness has continued; a host which holds such work resumes it from this event                                         |
| `AppLifecycleService.onReady()`                | A host dispatches its plug-in or application lifecycle notification                                                                                                              | A change to `AppLifecycleService.isReady()`; the event and the boolean readiness flag are separate compatibility surfaces                     |

`LiveSyncLocalDB.isReady` is cleared before an explicit close or reset, and by the PouchDB `closed` event. `AppLifecycleService.isReady()` is cleared when ordinary initialisation or a local fetch or rebuild begins. It remains clear when opening the settings-selected database or any later required completion phase fails.

`EVENT_APPLICATION_READY` is emitted only when `markIsReady()` changes the flag, after the flag is set, so every initialisation, fetch, or rebuild which establishes readiness emits it once. Clearing readiness emits nothing, and a fetch finalised in remediation mode emits nothing because it does not establish readiness. A host which holds work until the application is ready, such as applying received documents, can continue that work from this event; nothing else signals the transition, and `AppLifecycleService.onReady()` is a separate host notification.

The ordinary `prepareDatabaseForUse()` sequence is:

1. clear application readiness;
2. select the settings-selected local database, and create its physical handle and managers when reopening was requested;
3. dispatch `onDatabaseInitialisation()` and, after it succeeds, restart the managers' change feed so it uses the transforms installed by the preparation hooks;
4. inspect the physical database;
5. initialise the managers and install the database handlers;
6. expose `LiveSyncLocalDB.isReady` provisionally, dispatch `onDatabaseHasReady()`, and accept the physical transition only when that hook succeeds;
7. require the selected local database to be physically ready, including when reopening was skipped;
8. restore stored storage-event operations when applicable, and scan the Vault;
9. dispatch `onDatabaseInitialised()`;
10. complete the finite set of accepted local file operations; and
11. set application readiness, which emits `EVENT_APPLICATION_READY`.

`ChangeManager` opens a changes feed during construction, before preparation hooks can install transforms such as E2EE decryption. Restarting the feed after those hooks preserves its registered callbacks and ensures later arrivals are transformed before delivery. The restart uses `since: "now"`; it does not replay earlier events or provide an atomic delivery boundary while the preparation hooks are running. `DirectFileManipulatorV2.integration.spec.ts` covers encrypted chunks arriving after their Metadata has been read by a ready client.

`commitPendingFileEvents()` defines a finite local completion boundary. It captures admissions and file operations accepted before the call, including buffered, waiting for a timer, and already running work, releases their delays, and waits for actual handler outcomes and the ordered snapshot writes which record completion. Timer release alone is not completion. Later events do not extend the boundary, although a newer operation may satisfy an earlier one when its successful result covers the earlier intent. Handler or persistence failure is returned to the caller, and unresolved operations remain in the snapshot. The boundary does not claim a globally empty queue or remote replication.

Optional file completion follows the [selected optional handler contract](storage-events-and-reflection.md#optional-file-handlers). Typed providers wait for their actual save and receive a finite-flush signal to release captured debounce delays. Hosts which retain only the legacy boolean notification API complete notification dispatch without a new persistence guarantee. Start-up replay occurs before application readiness; optional providers must use physical database readiness and prepare their required local state without awaiting a later resume hook.

### Offline scan and stored storage-event operations

The maintained `scanVault()` handler is `performFullScan()`. Its pair states, action matrix, identity checks, and result contract are specified in [Full offline scan](offline-scanner.md).

On a subsequent start, the Offline Scanner first loads the storage-event snapshot left by the previous runtime. It contains accepted operations while buffered, waiting for a batch boundary, or in progress until their outcome is established. The snapshot carries operation intent, not durable file content or a journal of changes which the host never persisted or delivered. Each standard-file event is revalidated against current exact storage paths: an inclusion uses a current stub and content, while a deletion is admitted only when current storage still supports the observed absence. A rename between distinct document IDs validates its new-path inclusion and old-path deletion independently; a same-ID rename remains one document update. The detailed matrix is defined in [Full offline scan](offline-scanner.md).

The manager replays admitted operations without their former batch delay, waits for their actual handler outcomes and snapshot ordering, and only then collects storage and database entries for the full scan. A replay failure remains pending and is logged; it does not prevent the scanner from examining current state and independent paths. The action matrix remains authoritative, so an ambiguous pair may be deliberately skipped rather than either side being treated as unconditionally authoritative. A strict scan reports pair failures as failure; only the explicit `continueOnFileFailure` policy permits `completed-with-file-failures`. This start-up recovery boundary is separate from later watcher work.

A successful scan result means that every selected pair was either `completed` or deliberately `skipped`; it does not mean that every discovered Metadata entry was resolved or that storage and the database are identical. A `false` result, or an exception converted to `false` by the maintained `scanVault()` handler boundary, prevents `onDatabaseInitialised()`, finite local completion, and application readiness.

The scanner's `initialized` marker means that an earlier permitted invocation reached its aggregate-result boundary. It is recorded after the first aggregate `false` result as well as after `true`, so that the next runtime can restore stored operations; it is not evidence of a successful or fully converged scan. A host may maintain a separate replication-result snapshot, but that queue is outside this Offline Scanner contract.

### Rejected readiness transitions

A readiness flag represents an accepted transition, not only that an implementation reached the line which assigns it. A `false` result or exception from `onDatabaseInitialisation()`, database inspection, or manager initialisation rejects the physical transition before readiness is exposed. An implementation may then need to expose `LiveSyncLocalDB.isReady` provisionally while `onDatabaseHasReady()` handlers initialise services against the new local database. If that hook returns `false`, throws, or loses the database handle while it is running, the transition has not been accepted and the flag must not remain set after `initializeDatabase()` returns. The owning `DatabaseService` clears the rejected active candidate as well as the physical readiness flag.

The same rule applies at the wider application boundary. Application readiness remains clear when a required scan or post-scan hook fails, when finite local completion reports failure, or when a fetch or rebuild cannot complete. Closing, resetting, or destroying the active local database also invalidates physical readiness independently of application state.

Rolling a flag back is not sufficient when a handler has already created dependent state. Failure handling must also dispose the partially initialised managers and replicator, and return target-file filtering to a waitable state which a later successful database opening can release. This preserves the existing ability of `onDatabaseHasReady()` handlers to use the local database during dispatch without allowing later callers to observe a rejected database as ready.

Host unload and explicit close can overlap. Before the local database closes, the orderly lifecycle awaits `onBeforeUnload()`: the storage-event manager stops accepting watcher events, completes its captured work, and persists any unresolved operations in a final snapshot. The lifecycle settles its unload handlers even when another handler fails, so watcher shutdown and snapshot persistence still run. It records an unsuccessful result, completes remaining resource cleanup, and then reports failure; a snapshot-write failure does not count as successful completion.

Obsidian's synchronous `onunload()` callback cannot await this asynchronous boundary. The host integration catches and logs its result, while recovery relies on the pending snapshot and the next start-up scan. Keep the storage required by handlers available until the orderly stop has settled. `LiveSyncLocalDB` also memoises the `onUnloadDatabase` notification for each physical lifecycle so dependent services receive it once, while retaining both compatibility entry points.

Temporary remote unavailability does not by itself invalidate a usable local database. A physical-readiness rollback is required when a mandatory handler rejects the local transition, such as failure to establish the local node information or another local dependency, rather than merely because an ordinary replication attempt cannot currently reach its remote.

`EVENT_DATABASE_REBUILT` belongs to the local reset workflow. It means that the selected local database completed reset and reinitialisation; it does not itself mean that the ordinary Vault-scan and application-readiness sequence has completed.

## Commands

| Command                                                   | Target                                                                          | Result                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService.openDatabase(params)`                    | The database selected by settings when the command begins                       | Closes the former active instance, selects a new active instance, and initialises it. It does not destroy the former physical database.                                                                                                |
| `DatabaseService.resetDatabase()`                         | The current active database only                                                | Stops active provider work, runs the reset preparation hooks, tears down database managers, destroys the active physical database, reinitialises it, and runs the reset-completion hooks.                                              |
| `DatabaseService.resetDatabaseForCurrentSettings(params)` | The database selected by current settings                                       | Selects and opens that database when it is not already active, then resets it. A formerly active database with another identity is closed but preserved.                                                                               |
| `DatabaseEventService.initialiseDatabase(...)`            | Application initialisation, optionally reopening the settings-selected database | Requests the wider host sequence: database opening, Vault scan, post-scan handlers, finite completion of accepted local file operations, and application readiness. Despite its historical location, this is a command dispatcher rather than a lifecycle notification. |
| `ReplicationService.replicateAll*ForRebuild(...)`         | An active rebuild which owns the selected physical database and its remote work | Performs the same bounded full transfer as the ordinary API while requiring physical database readiness instead of wider application readiness. It is not a general readiness bypass.                                                  |
| `Rebuilder.finishRebuild(...)`                            | Final completion of a local fetch                                               | When applicable, stages reflection resumption, runs the existing final scan and replication pre-check, completes accepted local file operations, persists resumed reflection settings, and marks application readiness last.                       |

A destructive workflow must use `resetDatabaseForCurrentSettings()` after applying an identity-affecting setting. Calling `resetDatabase()` after only changing the setting can destroy the previously active database while leaving the intended target untouched.

## Event phases

| Surface                                                     | Phase                                                                                                                  | Failure meaning                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService.onOpenDatabase(vaultName)`                 | After a new active instance has been selected, but before its physical initialisation                                  | Host state tied to the selected name, such as UI stores, may be prepared here. The existing open path does not yet enforce the hook's boolean result.                                                                                           |
| `DatabaseEventService.onCloseDatabase(db)`                  | Immediately before an explicit `LiveSyncLocalDB.close()` closes the physical PouchDB handle                            | Every handler is settled sequentially before physical close so one failed cleanup cannot skip a later owner. The aggregate boolean result is not a close veto; reset uses its separate preparation hook.                                        |
| `DatabaseEventService.onDatabaseInitialisation(db)`         | After the physical handle and managers have been constructed, but before manager initialisation                        | This is a preparation gate. A `false` result or exception rejects the physical transition and disposes its partially initialised dependencies.                                                                                                  |
| `DatabaseEventService.onDatabaseHasReady()`                 | After manager initialisation and before `LiveSyncLocalDB.initializeDatabase()` reports success                         | A `false` result, thrown error, or closed handle rolls back readiness and disposes the partially initialised database dependencies. The compatibility name is retained even though it is not idiomatic English.                                 |
| `DatabaseEventService.onDatabaseInitialised(showingNotice)` | After the wider application initialisation has completed its requested database-open and conditional Vault-scan phases | A `false` result prevents the application lifecycle from being marked ready. This is not the physical PouchDB initialisation event.                                                                                                             |
| `DatabaseEventService.onResetDatabase(db)`                  | Before manager teardown and destruction of the active physical database                                                | A `false` result prevents manager teardown and physical destruction. This legacy handler sequence is not transactional: an earlier handler may already have released or reset dependent state, so a failed reset requires a controlled restart. |
| `DatabaseService.onDatabaseReset()`                         | After destruction and successful reinitialisation of the active database                                               | A `false` result means dependent post-reset state was not rebuilt successfully, so the reset command reports failure and callers must stop.                                                                                                     |
| `EVENT_DATABASE_REBUILT`                                    | After the rebuild or fetch workflow has completed its successful local reset step                                      | This application event may restart facilities which depend on a ready local database. It must not be emitted for a failed or vetoed reset.                                                                                                      |

## Recovering a lost local connection

This unreleased extension was reviewed against Commonlib 0.5.0 and Self-hosted LiveSync 1.0.50. The revised implementation replaces public-method interception with explicit operation-owner notifications.

`openDatabase()`, `reopenDatabase()`, `closeDatabase()`, and `resetDatabase()` serialise physical transitions through the same per-service `withLock`. Normal opens are separate ordered requests. `DatabaseService` resolves the physical name and adapter options when opening, and supplies that selection to the new local database. A recovery request names its failed owner; a requested close, replacement owner, or changed selection prevents it from closing another store. Once admitted, recovery retains that physical selection across the asynchronous drain and close.

`canReadCurrentDatabaseInfo()` calls `info()` on the existing, initialised current Pouch. It returns `false` without creating a database when there is no ready owner, and propagates a rejected operation unchanged. Success establishes only that this operation succeeded. It does not establish native-connection health, all-operation availability, or data integrity; adapters may cache information or open their own handles lazily.

Managed operation owners can request an inspection through `onLocalDatabaseError`. They preserve their own failed work and original error, and do not await recovery from work which recovery must drain. Individual errors do not authorise reopening. Hosts first inspect the current Pouch; a rejected inspection can justify one same-database reopen without inferring connection loss from an exception name, message, status, or nested cause. Raw Pouch methods are not replaced or intercepted. Pouch's public `closed` event clears readiness and starts manager teardown; explicit `close()` awaits physical closure and teardown. A native IndexedDB close is not guaranteed to emit a Pouch event.

`LiveSyncLocalDB.readFromDatabase()` binds caller waits to the captured physical lifetime. Before replacement drains its callers, `stopReads()` rejects pending read waits and refuses new ones. Metadata and required Chunk reads, replication preparation, and the existing-owner probe use this boundary. Close and rejected initialisation also retire their read lifetime. A later Pouch result cannot revive an ended wait. The Pouch object, adapter methods, and started writes remain unchanged; ending a caller wait does not cancel the underlying IO or establish that writes have completed. Chunk failure handling propagates retirement instead of entering a new delivery wait.

Replication preparation reports actual local read failures through the existing owner notification without awaiting recovery. Missing control documents, intentional compatibility rejection, and remote failures retain their existing handling. This recovery has no deadline or watchdog for an isolated operation which never settles. Such an operation can still prevent a pending-file flush from reaching replication's later `info()` call; a new `indexeddb` operation can also succeed while an earlier operation remains unfinished.

Hosts hold new dispatch, stop replication, and settle started work, including retention and persistence, before replacing the connection. `onBeforeDatabaseRecovery()` settles dependent work before physical close. After opening, the host completes captured local file work, calls `onAfterDatabaseRecovery()`, and resumes permitted replication. If an explicit open won the lock, recovery checks the replacement before releasing its hold. Failed completion does not advertise successful recovery. `onBeforeDatabaseResume()` gates foreground work before the usual pending-file flush.

`KeyValueDBService` owns a separate logical store. Settings selection and initialisation select that store; same-name Pouch replacement does not close it. Application unload releases its handle after shutdown preparation, and an explicit reset destroys its records. A retained handle is not evidence that writes succeed: each snapshot write must be awaited, and a rejected write does not establish durability. Data lifetime and connection lifetime are distinct, and no recovery reason is passed through Pouch close/unload/initialisation to bypass KV cleanup.

Connection recovery does not replay an arbitrary failed operation or destroy a database. The host's receiver owns retention, guarded reprocessing, and retry allowances. Successful reopening preserves the same store's contents; it is not a reset, rebuild, or guarantee that the original platform failure cannot recur.
