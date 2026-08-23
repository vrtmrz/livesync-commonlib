---
date: 2026-08-23
commonlib-version: "0.1.18"
self-hosted-livesync-version: "1.0.17"
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

`DatabaseService` owns the active database identity. It is the only service which selects, replaces, or resets the active `LiveSyncLocalDB` instance.

`LiveSyncLocalDB` owns the physical PouchDB handle and its managers. It performs physical initialisation, close, and destruction after the surrounding services have coordinated through `DatabaseEventService`.

`DatabaseEventService` coordinates dependent services around one physical lifecycle transition. Its hooks do not select a database identity.

Rebuild and fetch workflows own user intent and settings changes. They must ask `DatabaseService` to reset the database selected by the resulting settings, and must stop before remote mutation if that local operation fails.

## Readiness model

Readiness is not one state. The current implementation exposes the following distinct signals:

| Signal or phase                                | Becomes ready or occurs when                                                                                                                                        | Does not guarantee                                                                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Physical database handle                       | `LiveSyncLocalDB.initializeDatabase()` has created the PouchDB handle and its managers                                                                              | Manager initialisation, accepted readiness hooks, a Vault scan, or application readiness                                             |
| `LiveSyncLocalDB.isReady`                      | Manager initialisation and handler installation have completed, and `onDatabaseHasReady()` has accepted the transition                                              | That the Vault has been scanned or that application operations are enabled                                                           |
| `DatabaseEventService.onDatabaseHasReady()`    | The local readiness flag is temporarily visible so handlers can initialise against the selected physical database                                                   | Wider application readiness; rejection or handle loss rolls the physical transition back                                             |
| Vault scan                                     | `prepareDatabaseForUse()` or an owning rebuild workflow invokes `scanVault()` against a physically ready local database                                             | A durable readiness state; a `false` result prevents the wider transition                                                            |
| `DatabaseEventService.onDatabaseInitialised()` | The wider initialisation path has completed its requested database-open and Vault-scan phases                                                                       | That current batch waits have been released or that queued storage events have finished processing                                   |
| `Rebuilder.finishRebuild()`                    | The owning fetch has resumed reflection when required, completed its final scan and replication pre-check, released the current batch waits, and persisted settings | That every buffered or follow-up file event has finished; it establishes application readiness only when all required phases succeed |
| `AppLifecycleService.isReady()`                | Ordinary initialisation or explicit rebuild completion has accepted every required phase through the current batch-wait release                                     | Future remote availability or a full drain of every queued file operation                                                            |
| `AppLifecycleService.onReady()`                | A host dispatches its plug-in or application lifecycle notification                                                                                                 | A change to `AppLifecycleService.isReady()`; the event and the boolean readiness flag are separate compatibility surfaces            |

`LiveSyncLocalDB.isReady` is cleared before an explicit close or reset, and by the PouchDB `close` event. `AppLifecycleService.isReady()` is cleared when ordinary initialisation or a local fetch or rebuild begins. It remains clear when opening the settings-selected database or any later required completion phase fails.

The ordinary `prepareDatabaseForUse()` sequence is:

1. clear application readiness;
2. open and initialise the settings-selected local database when reopening was requested;
3. create the physical handle and managers;
4. dispatch `onDatabaseInitialisation()`;
5. initialise the managers and install the database handlers;
6. set `LiveSyncLocalDB.isReady` and dispatch `onDatabaseHasReady()`;
7. scan the Vault when the local database is ready;
8. dispatch `onDatabaseInitialised()`;
9. request release of current file-event batch waits; and
10. set application readiness.

The historical `commitPendingFileEvents()` name is stronger than its result contract. Its maintained handler releases the batch waits which exist when the call begins. It does not wait for every buffered event, already running file operation, or follow-up event to finish. Application readiness follows this existing call, which removes the premature-ready window without adding another scan or another I/O pass, but does not establish a full queue-drain guarantee.

### Rejected readiness transitions

A readiness flag represents an accepted transition, not only that an implementation reached the line which assigns it. An implementation may need to expose `LiveSyncLocalDB.isReady` temporarily while `onDatabaseHasReady()` handlers initialise services against the new local database. If that hook returns `false`, throws, or loses the database handle while it is running, the transition has not been accepted and the flag must not remain set after `initializeDatabase()` returns.

The same rule applies at the wider application boundary. Application readiness remains clear when a required scan or post-scan hook fails, when the current batch-wait release reports failure, or when a fetch or rebuild cannot complete. Closing, resetting, or destroying the active local database also invalidates physical readiness independently of application state.

Rolling a flag back is not sufficient when a handler has already created dependent state. Failure handling must also dispose the partially initialised managers and replicator, and return target-file filtering to a waitable state which a later successful database opening can release. This preserves the existing ability of `onDatabaseHasReady()` handlers to use the local database during dispatch without allowing later callers to observe a rejected database as ready.

Temporary remote unavailability does not by itself invalidate a usable local database. A physical-readiness rollback is required when a mandatory handler rejects the local transition, such as failure to establish the local node information or another local dependency, rather than merely because an ordinary replication attempt cannot currently reach its remote.

`EVENT_DATABASE_REBUILT` belongs to the local reset workflow. It means that the selected local database completed reset and reinitialisation; it does not itself mean that the ordinary Vault-scan and application-readiness sequence has completed.

## Commands

| Command                                                   | Target                                                                          | Result                                                                                                                                                                                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService.openDatabase(params)`                    | The database selected by settings when the command begins                       | Closes the former active instance, selects a new active instance, and initialises it. It does not destroy the former physical database.                                                                                                |
| `DatabaseService.resetDatabase()`                         | The current active database only                                                | Runs the reset preparation hooks, destroys the active physical database, reinitialises it, and runs the reset-completion hooks.                                                                                                        |
| `DatabaseService.resetDatabaseForCurrentSettings(params)` | The database selected by current settings                                       | Selects and opens that database when it is not already active, then resets it. A formerly active database with another identity is closed but preserved.                                                                               |
| `DatabaseEventService.initialiseDatabase(...)`            | Application initialisation, optionally reopening the settings-selected database | Requests the wider host sequence: database opening, Vault scan, post-scan handlers, application readiness, and queued file events. Despite its historical location, this is a command dispatcher rather than a lifecycle notification. |
| `ReplicationService.replicateAll*ForRebuild(...)`         | An active rebuild which owns the selected physical database and its remote work | Performs the same bounded full transfer as the ordinary API while requiring physical database readiness instead of wider application readiness. It is not a general readiness bypass.                                                  |
| `Rebuilder.finishRebuild(...)`                            | Final completion of a local fetch                                               | Runs the existing final reflection scan and replication pre-check, releases current batch waits, persists resumed reflection settings when applicable, and marks application readiness last.                                           |

A destructive workflow must use `resetDatabaseForCurrentSettings()` after applying an identity-affecting setting. Calling `resetDatabase()` after only changing the setting can destroy the previously active database while leaving the intended target untouched.

## Event phases

| Surface                                                     | Phase                                                                                                                  | Failure meaning                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService.onOpenDatabase(vaultName)`                 | After a new active instance has been selected, but before its physical initialisation                                  | Host state tied to the selected name, such as UI stores, may be prepared here. The existing open path does not yet enforce the hook's boolean result.                                                           |
| `DatabaseEventService.onDatabaseInitialisation(db)`         | After the physical handle and managers have been constructed, but before manager initialisation                        | This is a preparation gate. The existing implementation logs a `false` result and continues; changing that legacy behaviour requires a separate failure-cleanup design.                                         |
| `DatabaseEventService.onDatabaseHasReady()`                 | After manager initialisation and before `LiveSyncLocalDB.initializeDatabase()` reports success                         | A `false` result, thrown error, or closed handle rolls back readiness and disposes the partially initialised database dependencies. The compatibility name is retained even though it is not idiomatic English. |
| `DatabaseEventService.onDatabaseInitialised(showingNotice)` | After the wider application initialisation has completed its requested database-open and conditional Vault-scan phases | A `false` result prevents the application lifecycle from being marked ready. This is not the physical PouchDB initialisation event.                                                                             |
| `DatabaseEventService.onResetDatabase(db)`                  | Before destruction of the active physical database                                                                     | A `false` result vetoes destruction. Replicators, key-value stores, and other dependent resources release or reset state here.                                                                                  |
| `DatabaseService.onDatabaseReset()`                         | After destruction and successful reinitialisation of the active database                                               | A `false` result means dependent post-reset state was not rebuilt successfully, so the reset command reports failure and callers must stop.                                                                     |
| `EVENT_DATABASE_REBUILT`                                    | After the rebuild or fetch workflow has completed its successful local reset step                                      | This application event may restart facilities which depend on a ready local database. It must not be emitted for a failed or vetoed reset.                                                                      |

## Settings-selected reset sequence

When a rebuild or fetch assigns a new database suffix, the sequence is:

1. suspend synchronisation and reflection as required by the workflow;
2. persist or apply the new suffix;
3. resolve the settings-selected database name;
4. close, but do not destroy, a differently named active database;
5. open the settings-selected database without scanning the Vault;
6. run `onResetDatabase` and stop if any preparation handler fails;
7. destroy and reinitialise the selected physical database;
8. run `onDatabaseReset` and stop if any completion handler fails; and
9. emit `EVENT_DATABASE_REBUILT` before the workflow continues to reflection or remote mutation.

Opening the selected database before destruction initialises its in-memory managers, but it does not scan the Vault. Rebuild and fetch workflows already suspend ordinary synchronisation across this boundary. This keeps the existing `LiveSyncLocalDB.resetDatabase()` destruction path, including its dependent-service hooks, while ensuring that it acts on the intended identity.

`DatabaseService` rechecks the active identity after opening. If another settings transition selected a different database during the operation, the reset fails without destroying that unexpected database.

## Rebuild and application readiness

A local fetch or rebuild is a controlled maintenance workflow, not an application-ready state. During the workflow, the local database may be empty or only partly populated, file reflection is normally suspended, and the remote may be locked, reset, or still converging. Advertising application readiness during that interval can admit ordinary watchers, replication requests, and host actions against an intentionally incomplete state.

Standard Fetch, Fast Fetch, and Rebuild Everything separate these responsibilities:

1. entering a destructive local fetch or rebuild clears application readiness, including when the command began in an already ready host;
2. opening and initialising the selected local database establishes only physical database readiness;
3. the owning rebuild workflow uses the explicitly named rebuild transfer API to perform its bounded import or export when the local database, selected replicator, and suspension policy satisfy that operation's prerequisites, without claiming wider application readiness;
4. workflow-specific preparation hooks and final reflection run at their existing boundaries without adding a duplicate open, scan, or remote pass; and
5. application readiness is set only after the owning workflow has completed those phases successfully.

When a fetch deliberately leaves reflection suspended, application readiness remains clear until the host performs the explicit completion step. This is particularly important for Fast Setup, where Commonlib completes the streaming database import before the LiveSync host performs its selected storage reflection and removes the setup flag.

Fetches which must preserve existing local files first run a preparation scan, dispatch `onDatabaseInitialised()`, and release the current batch waits before their remote transfer. A remote-first Fetch and Fast Fetch skip that preparation hook, matching their earlier lifecycle. Their final reflection scan is a distinct post-transfer phase.

`finishRebuild()` is the Commonlib fetch-completion boundary. It clears application readiness before attempting finalisation, and then performs the existing final scan and replication pre-check, releases the current batch waits, persists resumed reflection settings when this workflow controls them, and marks application readiness last. It does not synthesise an ordinary `onDatabaseInitialised()` event for workflows which did not previously dispatch one. A `false` result or error leaves the application unready. When finalisation fails after temporarily resuming reflection, the in-memory suspension settings are restored; the host retains responsibility for its setup flag and restart policy.

Rebuild Everything has no inbound document phase after its preparation scan. It therefore retains the existing single scan and completion-hook pass before upload, verifies the current batch waits again after the final upload, and marks application readiness without adding a second scan.

## Failure boundary

The reset result is a workflow gate. A failed open, vetoed reset, failed reinitialisation, or failed completion hook must prevent:

- `EVENT_DATABASE_REBUILT`;
- remote database reset;
- upload of local documents; and
- marking a fetch or rebuild as resolved.

The previously active physical database is deliberately preserved during a suffix transition. Removing inactive databases is a separate, explicit maintenance operation; suffix selection alone is not deletion authority.

## Deferred lifecycle clean-up

The compatibility surface still contains lifecycle ambiguities which are outside this readiness correction:

- `onCloseDatabase` is registered by maintained key-value database services but is not dispatched consistently;
- `onUnloadDatabase` can currently be requested through both `onunload()` and `close()`;
- `onOpenDatabase` does not yet enforce its boolean result;
- `onDatabaseInitialisation` does not yet enforce its boolean result;
- the `onReady()` lifecycle notification does not define or update the application readiness flag; and
- the command-shaped `initialiseDatabase` dispatcher remains on `DatabaseEventService`.

These should be changed only with focused ordering and failure-cleanup tests.
