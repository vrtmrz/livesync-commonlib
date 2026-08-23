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

| Signal or phase                                | Becomes ready or occurs when                                                                                                                                      | Does not guarantee                                                                                                               |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Physical database handle                       | `LiveSyncLocalDB.initializeDatabase()` has created the PouchDB handle and its managers                                                                            | Manager initialisation, accepted readiness hooks, a Vault scan, or application readiness                                         |
| `LiveSyncLocalDB.isReady`                      | Manager initialisation has completed and the close and remote-chunk handlers have been installed, immediately before `onDatabaseHasReady()`                       | That `onDatabaseHasReady()` accepted the transition, that the Vault has been scanned, or that application operations are enabled |
| `DatabaseEventService.onDatabaseHasReady()`    | The local database readiness flag has already been set                                                                                                            | Wider application readiness; this is a gate within physical database initialisation                                              |
| Vault scan                                     | `prepareDatabaseForUse()` has opened a locally ready database and invokes `scanVault()`                                                                           | A durable readiness state; scan completion is currently only a phase in the wider initialisation sequence                        |
| `DatabaseEventService.onDatabaseInitialised()` | The ordinary wider initialisation path has completed its requested database-open and conditional Vault-scan phases                                                | That current batch waits have been released or that queued storage events have finished processing                               |
| `AppLifecycleService.isReady()`                | The ordinary wider initialisation path has accepted `onDatabaseInitialised()`; rebuild and Fast Fetch paths may set it earlier after reopening the local database | One uniform completion point across every workflow                                                                               |
| `AppLifecycleService.onReady()`                | A host dispatches its plug-in or application lifecycle notification                                                                                               | A change to `AppLifecycleService.isReady()`; the event and the boolean readiness flag are separate compatibility surfaces        |

`LiveSyncLocalDB.isReady` is cleared before an explicit close or reset, and by the PouchDB `close` event. `AppLifecycleService.isReady()` is cleared when `prepareDatabaseForUse()` begins and when opening the settings-selected database fails.

The ordinary `prepareDatabaseForUse()` sequence is:

1. clear application readiness;
2. open and initialise the settings-selected local database when reopening was requested;
3. create the physical handle and managers;
4. dispatch `onDatabaseInitialisation()`;
5. initialise the managers and install the database handlers;
6. set `LiveSyncLocalDB.isReady` and dispatch `onDatabaseHasReady()`;
7. scan the Vault when the local database is ready;
8. dispatch `onDatabaseInitialised()`;
9. set application readiness; and
10. request release of current file-event batch waits.

The historical `commitPendingFileEvents()` name is stronger than its current result contract. Its maintained handler releases the batch waits which exist when the call begins. It does not wait for every buffered event, already running file operation, or follow-up event to finish. Moving application readiness after this existing call would remove a short premature-ready window without adding another scan or another I/O pass, but it would not establish a full queue-drain guarantee.

### Rejected readiness transitions

A readiness flag represents an accepted transition, not only that an implementation reached the line which assigns it. An implementation may need to expose `LiveSyncLocalDB.isReady` temporarily while `onDatabaseHasReady()` handlers initialise services against the new local database. If that hook returns `false`, throws, or loses the database handle while it is running, the transition has not been accepted and the flag must not remain set after `initializeDatabase()` returns.

The same rule applies at the wider application boundary. Application readiness must remain clear, or be cleared again, when a required post-scan hook fails, when the current batch-wait release reports failure, or when a fetch or rebuild fails after setting readiness early. Closing, resetting, or destroying the active local database also invalidates physical readiness independently of application state.

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

A destructive workflow must use `resetDatabaseForCurrentSettings()` after applying an identity-affecting setting. Calling `resetDatabase()` after only changing the setting can destroy the previously active database while leaving the intended target untouched.

## Event phases

| Surface                                                     | Phase                                                                                                                  | Failure meaning                                                                                                                                                         |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseService.onOpenDatabase(vaultName)`                 | After a new active instance has been selected, but before its physical initialisation                                  | Host state tied to the selected name, such as UI stores, may be prepared here. The existing open path does not yet enforce the hook's boolean result.                   |
| `DatabaseEventService.onDatabaseInitialisation(db)`         | After the physical handle and managers have been constructed, but before manager initialisation                        | This is a preparation gate. The existing implementation logs a `false` result and continues; changing that legacy behaviour requires a separate failure-cleanup design. |
| `DatabaseEventService.onDatabaseHasReady()`                 | After manager initialisation and before `LiveSyncLocalDB.initializeDatabase()` reports success                         | A `false` result makes initialisation return `false`. The compatibility name is retained even though it is not idiomatic English.                                       |
| `DatabaseEventService.onDatabaseInitialised(showingNotice)` | After the wider application initialisation has completed its requested database-open and conditional Vault-scan phases | A `false` result prevents the application lifecycle from being marked ready. This is not the physical PouchDB initialisation event.                                     |
| `DatabaseEventService.onResetDatabase(db)`                  | Before destruction of the active physical database                                                                     | A `false` result vetoes destruction. Replicators, key-value stores, and other dependent resources release or reset state here.                                          |
| `DatabaseService.onDatabaseReset()`                         | After destruction and successful reinitialisation of the active database                                               | A `false` result means dependent post-reset state was not rebuilt successfully, so the reset command reports failure and callers must stop.                             |
| `EVENT_DATABASE_REBUILT`                                    | After the rebuild or fetch workflow has completed its successful local reset step                                      | This application event may restart facilities which depend on a ready local database. It must not be emitted for a failed or vetoed reset.                              |

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

The current Standard Fetch and Fast Fetch paths call `AppLifecycleService.markIsReady()` before their remaining work. This is compatibility behaviour rather than the intended lifecycle boundary. Standard Fetch uses the flag to pass the application-readiness checks in `replicateAllFromRemote()`. Fast Fetch does not require wider application readiness for its streaming import, but currently marks it after opening the local database. Rebuild Everything similarly reaches application readiness through the ordinary initialisation command before its remote replacement work has completed.

The readiness correction separates these responsibilities:

1. entering a destructive local fetch or rebuild clears application readiness, including when the command began in an already ready host;
2. opening and initialising the selected local database establishes only physical database readiness;
3. the owning rebuild workflow may perform its bounded import or export when the local database, selected replicator, and suspension policy satisfy that operation's prerequisites, without claiming wider application readiness;
4. the requested Vault scan, reflection resumption, and completion hooks run without adding a duplicate open, scan, or remote pass; and
5. application readiness is set only after the owning workflow has completed those phases successfully.

When a fetch deliberately leaves reflection suspended, application readiness must remain clear until the host performs the explicit completion step. This is particularly important for Fast Setup, where Commonlib completes the streaming database import before the LiveSync host performs its selected storage reflection and removes the setup flag.

## Failure boundary

The reset result is a workflow gate. A failed open, vetoed reset, failed reinitialisation, or failed completion hook must prevent:

- `EVENT_DATABASE_REBUILT`;
- remote database reset;
- upload of local documents; and
- marking a fetch or rebuild as resolved.

The previously active physical database is deliberately preserved during a suffix transition. Removing inactive databases is a separate, explicit maintenance operation; suffix selection alone is not deletion authority.

## Deferred lifecycle clean-up

The compatibility surface still contains lifecycle ambiguities which are outside the suffix-reset defect:

- `onCloseDatabase` is registered by maintained key-value database services but is not dispatched consistently;
- `onUnloadDatabase` can currently be requested through both `onunload()` and `close()`;
- `onOpenDatabase` does not yet enforce its boolean result;
- `onDatabaseInitialisation` does not yet enforce its boolean result;
- `LiveSyncLocalDB.isReady` is set before `onDatabaseHasReady()`, and a rejected hook currently leaves that flag and partially initialised dependent state in place even though initialisation reports failure;
- the ordinary Vault scan returns a boolean result which `prepareDatabaseForUse()` does not currently use as a readiness gate;
- application readiness is set before current file-event batch waits are released, so a later release failure does not roll the flag back; the existing operation is not a full queue drain;
- rebuild and Fast Fetch paths can set application readiness directly before their remaining workflow steps, although their bounded work requires narrower local capabilities rather than ordinary application readiness;
- the `onReady()` lifecycle notification does not define or update the application readiness flag; and
- the command-shaped `initialiseDatabase` dispatcher remains on `DatabaseEventService`.

These should be changed only with focused ordering and failure-cleanup tests. The target-reset correction must not silently redefine their behaviour.
