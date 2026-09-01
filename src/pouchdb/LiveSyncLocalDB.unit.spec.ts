import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import { DEFAULT_SETTINGS, type DocumentID, type EntryDoc } from "@lib/common/types";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { LiveSyncLocalDB } from "./LiveSyncLocalDB";

const managerLifecycle = vi.hoisted(() => ({
    initialise: vi.fn(async () => undefined),
    teardown: vi.fn(async () => undefined),
}));

vi.mock("@lib/managers/LiveSyncManagers.ts", () => ({
    LiveSyncManagers: class {
        chunkManager = { emitEvent: vi.fn() };
        initialise = managerLifecycle.initialise;
        teardownManagers = managerLifecycle.teardown;
        clearCaches = vi.fn();
        prepareHashFunction = vi.fn(async () => undefined);
    },
}));

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(replication);

let databaseSequence = 0;

function chunk(id: string, data = id): EntryDoc {
    return {
        _id: id as DocumentID,
        type: "leaf",
        data,
    };
}

function revision(id: string, rev: string, history: string[], children: string[]): EntryDoc {
    return {
        _id: id as DocumentID,
        _rev: rev,
        _revisions: {
            start: Number(rev.split("-")[0]),
            ids: history,
        },
        type: "plain",
        path: id,
        children,
        ctime: 1,
        mtime: 1,
        size: children.length,
        eden: {},
    } as unknown as EntryDoc;
}

function subjectFor(database: PouchDB.Database<EntryDoc>): LiveSyncLocalDB {
    const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
    Object.assign(subject, { localDatabase: database });
    return subject;
}

describe("LiveSyncLocalDB.allChunks", () => {
    let database: PouchDB.Database<EntryDoc>;
    let subject: LiveSyncLocalDB;

    beforeEach(() => {
        databaseSequence++;
        database = new PouchDB(`all-chunks-${databaseSequence}`, { adapter: "memory" });
        subject = subjectFor(database);
    });

    afterEach(async () => {
        await database.destroy();
    });

    it("marks a chunk which is referenced only by an obsolete linear revision as collectible", async () => {
        await database.bulkDocs([chunk("h:old"), chunk("h:current")]);
        const firstRevision = revision("note.md", "1-base", ["base"], ["h:old"]);
        delete firstRevision._rev;
        delete firstRevision._revisions;
        await database.put(firstRevision);
        await database.put({
            ...(await database.get("note.md")),
            children: ["h:current"],
        });

        const { used, existing } = await subject.allChunks();

        expect([...existing.keys()]).toEqual(expect.arrayContaining(["h:old", "h:current"]));
        expect(used).toEqual(new Set(["h:current"]));
    });

    it("keeps a shared chunk while another live document still references it", async () => {
        await database.bulkDocs([chunk("h:shared"), chunk("h:replacement")]);
        const firstRevision = revision("first.md", "1-first", ["first"], ["h:shared"]);
        delete firstRevision._rev;
        delete firstRevision._revisions;
        await database.put(firstRevision);
        await database.put({
            ...(await database.get("first.md")),
            children: ["h:replacement"],
        });
        await database.put(revision("second.md", "1-second", ["second"], ["h:shared"]), {
            new_edits: false,
        } as PouchDB.Core.PutOptions);

        const { used } = await subject.allChunks();

        expect(used).toEqual(new Set(["h:replacement", "h:shared"]));
    });

    it("keeps every live conflict leaf and their nearest available shared ancestor", async () => {
        await database.bulkDocs([
            chunk("h:base"),
            chunk("h:left"),
            chunk("h:middle"),
            chunk("h:right"),
            chunk("h:unreachable"),
        ]);
        await database.bulkDocs(
            [
                revision("conflicted.md", "1-base", ["base"], ["h:base"]),
                revision("conflicted.md", "2-left", ["left", "base"], ["h:left"]),
                revision("conflicted.md", "2-middle", ["middle", "base"], ["h:middle"]),
                revision("conflicted.md", "2-right", ["right", "base"], ["h:right"]),
            ],
            { new_edits: false }
        );

        const conflicted = await database.get("conflicted.md", { conflicts: true });
        expect(conflicted._conflicts).toHaveLength(2);

        const { used } = await subject.allChunks();

        expect(used).toEqual(new Set(["h:base", "h:left", "h:middle", "h:right"]));
        expect(used.has("h:unreachable")).toBe(false);
    });

    it("releases the losing branch and shared ancestor after the conflict is resolved", async () => {
        await database.bulkDocs([chunk("h:base"), chunk("h:left"), chunk("h:right")]);
        await database.bulkDocs(
            [
                revision("resolved.md", "1-base", ["base"], ["h:base"]),
                revision("resolved.md", "2-left", ["left", "base"], ["h:left"]),
                revision("resolved.md", "2-right", ["right", "base"], ["h:right"]),
            ],
            { new_edits: false }
        );
        const conflicted = await database.get("resolved.md", { conflicts: true });
        const losingRevision = conflicted._conflicts?.[0];
        expect(losingRevision).toBeDefined();
        await database.remove("resolved.md", losingRevision!);

        const resolved = await database.get("resolved.md", { conflicts: true });
        expect(resolved._conflicts).toBeUndefined();

        const { used } = await subject.allChunks();

        expect(used).toEqual(new Set(resolved.children));
        expect(used.has("h:base")).toBe(false);
    });

    it("replicates collection safely and later replicates a recreated chunk", async () => {
        const target = new PouchDB<EntryDoc>(`all-chunks-target-${databaseSequence}`, { adapter: "memory" });
        try {
            await database.bulkDocs([chunk("h:obsolete"), chunk("h:current"), chunk("h:shared")]);
            const firstRevision = revision("first.md", "1-first", ["first"], ["h:obsolete"]);
            delete firstRevision._rev;
            delete firstRevision._revisions;
            await database.put(firstRevision);
            await database.put({
                ...(await database.get("first.md")),
                children: ["h:current"],
            });
            const secondRevision = revision("second.md", "1-second", ["second"], ["h:shared"]);
            delete secondRevision._rev;
            delete secondRevision._revisions;
            await database.put(secondRevision);

            const { used, existing } = await subject.allChunks();
            const unused = [...existing.entries()].filter(([id]) => !used.has(id));
            expect(unused.map(([id]) => id)).toEqual(["h:obsolete"]);
            await database.bulkDocs(
                unused.map(([id, entry]) => ({
                    _id: id as DocumentID,
                    _rev: entry._rev,
                    _deleted: true,
                }))
            );

            await database.replicate.to(target);

            await expect(target.get("h:obsolete")).rejects.toMatchObject({ status: 404 });
            await expect(target.get("h:current")).resolves.toMatchObject({ type: "leaf" });
            await expect(target.get("h:shared")).resolves.toMatchObject({ type: "leaf" });
            await expect(target.get("second.md")).resolves.toMatchObject({ children: ["h:shared"] });

            await database.put(chunk("h:obsolete"));
            await database.replicate.to(target);

            await expect(target.get("h:obsolete")).resolves.toMatchObject({
                _id: "h:obsolete",
                type: "leaf",
            });
        } finally {
            await target.destroy();
        }
    });
});

describe("LiveSyncLocalDB reset lifecycle", () => {
    it("retires database consumers before tearing down managers", async () => {
        const order: string[] = [];
        const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
        Object.assign(subject, {
            isReady: true,
            _managers: {
                teardownManagers: vi.fn(async () => {
                    order.push("managers");
                }),
            },
            env: {
                services: {
                    replicator: {
                        onCloseActiveReplication: vi.fn(async () => {
                            order.push("replication");
                        }),
                        getActiveReplicator: vi.fn(() => {
                            order.push("replication");
                            return { closeReplication: vi.fn() };
                        }),
                    },
                    databaseEvents: {
                        onResetDatabase: vi.fn(async () => {
                            order.push("reset");
                            return true;
                        }),
                    },
                },
            },
            localDatabase: {
                destroy: vi.fn(async () => {
                    order.push("destroy");
                }),
            },
            initializeDatabase: vi.fn(async () => {
                order.push("initialise");
                return true;
            }),
            _log: vi.fn(),
        });

        await expect(subject.resetDatabase()).resolves.toBe(true);

        expect(order).toEqual(["replication", "reset", "managers", "destroy", "initialise"]);
    });

    it("uses the Replicator owner boundary and waits for retirement before dependent teardown", async () => {
        const order: string[] = [];
        let releaseRetirement!: () => void;
        const retirement = new Promise<void>((resolve) => {
            releaseRetirement = resolve;
        });
        const onCloseActiveReplication = vi.fn(async () => {
            order.push("retirement-started");
            await retirement;
            order.push("retirement-finished");
            return true;
        });
        const getActiveReplicator = vi.fn(() => undefined);
        const teardownManagers = vi.fn(async () => {
            order.push("managers");
        });
        const destroy = vi.fn(async () => {
            order.push("destroy");
        });
        const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
        Object.assign(subject, {
            isReady: true,
            _managers: { teardownManagers },
            env: {
                services: {
                    replicator: { onCloseActiveReplication, getActiveReplicator },
                    databaseEvents: {
                        onResetDatabase: vi.fn(async () => {
                            order.push("reset");
                            return true;
                        }),
                    },
                },
            },
            localDatabase: { destroy },
            initializeDatabase: vi.fn(async () => {
                order.push("initialise");
                return true;
            }),
            _log: vi.fn(),
        });

        const reset = subject.resetDatabase();
        await Promise.resolve();

        expect(onCloseActiveReplication).toHaveBeenCalledOnce();
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(teardownManagers).not.toHaveBeenCalled();
        expect(destroy).not.toHaveBeenCalled();
        expect(order).toEqual(["retirement-started"]);

        releaseRetirement();
        await expect(reset).resolves.toBe(true);

        expect(order).toEqual([
            "retirement-started",
            "retirement-finished",
            "reset",
            "managers",
            "destroy",
            "initialise",
        ]);
    });

    it("clears physical readiness when a reset hook rejects the transition", async () => {
        const destroy = vi.fn(async () => undefined);
        const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
        Object.assign(subject, {
            isReady: true,
            _managers: {
                teardownManagers: vi.fn(async () => undefined),
            },
            env: {
                services: {
                    replicator: {
                        onCloseActiveReplication: vi.fn(async () => true),
                        getActiveReplicator: vi.fn(() => undefined),
                    },
                    databaseEvents: {
                        onResetDatabase: vi.fn(async () => false),
                    },
                },
            },
            localDatabase: {
                destroy,
            },
            _log: vi.fn(),
        });

        await expect(subject.resetDatabase()).resolves.toBe(false);

        expect(subject.isReady).toBe(false);
        expect(destroy).not.toHaveBeenCalled();
    });

    it("reports failure when the destroyed database cannot be reinitialised", async () => {
        const initialise = vi.fn(async () => false);
        const destroy = vi.fn(async () => undefined);
        const subject = Object.create(LiveSyncLocalDB.prototype) as LiveSyncLocalDB;
        Object.assign(subject, {
            _managers: {
                teardownManagers: vi.fn(async () => undefined),
            },
            env: {
                services: {
                    replicator: {
                        onCloseActiveReplication: vi.fn(async () => true),
                        getActiveReplicator: vi.fn(() => undefined),
                    },
                    databaseEvents: {
                        onResetDatabase: vi.fn(async () => true),
                    },
                },
            },
            localDatabase: {
                destroy,
            },
            initializeDatabase: initialise,
            _log: vi.fn(),
        });

        await expect(subject.resetDatabase()).resolves.toBe(false);

        expect(destroy).toHaveBeenCalledOnce();
        expect(initialise).toHaveBeenCalledOnce();
    });
});

describe("LiveSyncLocalDB initialisation readiness", () => {
    function createSubject(
        onDatabaseHasReady: () => Promise<boolean>,
        onDatabaseInitialisation = vi.fn(async () => true)
    ) {
        let closeHandler: (() => void) | undefined;
        let closed = false;
        const database = {
            removeAllListeners: vi.fn(() => {
                closeHandler = undefined;
            }),
            close: vi.fn(async () => {
                if (!closed) {
                    closed = true;
                    closeHandler?.();
                }
            }),
            info: vi.fn(async () => ({ db_name: "readiness" })),
            on: vi.fn((event: string, handler: () => void) => {
                if (event === "close") closeHandler = handler;
            }),
        };
        const closeReplication = vi.fn();
        const onCloseActiveReplication = vi.fn(async () => true);
        const getActiveReplicator = vi.fn(() => ({ closeReplication }));
        const onCloseDatabase = vi.fn(async () => true);
        const onUnloadDatabase = vi.fn(async () => true);
        const context = createServiceContext();
        const subject = new LiveSyncLocalDB("readiness", {
            services: {
                context,
                API: { addLog: vi.fn() } as never,
                setting: {
                    currentSettings: vi.fn(() => ({ ...DEFAULT_SETTINGS })),
                } as never,
                path: {} as never,
                database: {
                    createPouchDBInstance: vi.fn(() => database),
                } as never,
                databaseEvents: {
                    onDatabaseInitialisation,
                    onDatabaseHasReady,
                    onCloseDatabase,
                    onUnloadDatabase,
                } as never,
                replicator: {
                    finiteReplicationActivityCount: { value: 0 },
                    onCloseActiveReplication,
                    getActiveReplicator,
                } as never,
            },
        });
        return {
            closeReplication,
            database,
            getActiveReplicator,
            onCloseActiveReplication,
            onCloseDatabase,
            onDatabaseInitialisation,
            onUnloadDatabase,
            subject,
        };
    }

    beforeEach(() => {
        managerLifecycle.initialise.mockClear();
        managerLifecycle.teardown.mockClear();
    });

    it("rolls back physical readiness when a required ready handler rejects the transition", async () => {
        const onDatabaseHasReady = vi.fn(async () => false);
        const { closeReplication, database, getActiveReplicator, onCloseActiveReplication, onUnloadDatabase, subject } =
            createSubject(onDatabaseHasReady);

        await expect(subject.initializeDatabase()).resolves.toBe(false);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalled();
        expect(onCloseActiveReplication).toHaveBeenCalledOnce();
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(closeReplication).not.toHaveBeenCalled();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);

        await subject.close();
        expect(onUnloadDatabase).toHaveBeenCalledOnce();
    });

    it("rolls back physical readiness before propagating a required ready-handler error", async () => {
        const error = new Error("local node information could not be initialised");
        const { database, onUnloadDatabase, subject } = createSubject(async () => Promise.reject(error));

        await expect(subject.initializeDatabase()).rejects.toBe(error);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalled();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);
    });

    it("rolls back physical dependencies before propagating an initialisation-hook error", async () => {
        const error = new Error("key-value database could not be initialised");
        const onDatabaseInitialisation = vi.fn(async () => Promise.reject(error));
        const { database, onUnloadDatabase, subject } = createSubject(async () => true, onDatabaseInitialisation);

        await expect(subject.initializeDatabase()).rejects.toBe(error);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalledOnce();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);
    });

    it("rejects physical readiness when an initialisation hook reports failure", async () => {
        const onDatabaseInitialisation = vi.fn(async () => false);
        const onDatabaseHasReady = vi.fn(async () => true);
        const { database, onUnloadDatabase, subject } = createSubject(onDatabaseHasReady, onDatabaseInitialisation);

        await expect(subject.initializeDatabase()).resolves.toBe(false);

        expect(subject.isReady).toBe(false);
        expect(onDatabaseHasReady).not.toHaveBeenCalled();
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalledOnce();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);
    });

    it("rolls back physical dependencies before propagating a manager initialisation error", async () => {
        const error = new Error("manager initialisation failed");
        managerLifecycle.initialise.mockRejectedValueOnce(error);
        const { database, onUnloadDatabase, subject } = createSubject(async () => true);

        await expect(subject.initializeDatabase()).rejects.toBe(error);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalledOnce();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);
    });

    it("rolls back physical dependencies before propagating a database inspection error", async () => {
        const error = new Error("database information could not be read");
        const { database, onUnloadDatabase, subject } = createSubject(async () => true);
        database.info.mockRejectedValueOnce(error);

        await expect(subject.initializeDatabase()).rejects.toBe(error);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.initialise).not.toHaveBeenCalled();
        expect(managerLifecycle.teardown).toHaveBeenCalledOnce();
        expect(onUnloadDatabase).toHaveBeenCalledWith(subject);
    });

    it("does not tear down dependencies twice when a ready handler closes the database", async () => {
        const onDatabaseHasReady = vi.fn<() => Promise<boolean>>();
        const { closeReplication, database, getActiveReplicator, onCloseActiveReplication, onUnloadDatabase, subject } =
            createSubject(onDatabaseHasReady);
        onDatabaseHasReady.mockImplementation(async () => {
            await database.close();
            return true;
        });

        await expect(subject.initializeDatabase()).resolves.toBe(false);

        expect(subject.isReady).toBe(false);
        expect(database.close).toHaveBeenCalledOnce();
        expect(managerLifecycle.teardown).toHaveBeenCalledOnce();
        expect(onCloseActiveReplication).toHaveBeenCalledOnce();
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(closeReplication).not.toHaveBeenCalled();
        expect(onUnloadDatabase).toHaveBeenCalledOnce();
    });

    it("notifies unload handlers once when host unload is followed by close", async () => {
        const { onUnloadDatabase, subject } = createSubject(async () => true);
        await expect(subject.initializeDatabase()).resolves.toBe(true);

        subject.onunload();
        await subject.close();

        expect(onUnloadDatabase).toHaveBeenCalledOnce();
    });

    it("settles close handlers before closing the physical database", async () => {
        const order: string[] = [];
        const { database, onCloseDatabase, subject } = createSubject(async () => true);
        onCloseDatabase.mockImplementationOnce(async () => {
            order.push("handler");
            return true;
        });
        database.close.mockImplementationOnce(async () => {
            order.push("database");
        });
        await expect(subject.initializeDatabase()).resolves.toBe(true);

        await subject.close();

        expect(order).toEqual(["handler", "database"]);
    });

    it("uses owner retirement during close without probing for a missing active publication", async () => {
        const { closeReplication, getActiveReplicator, onCloseActiveReplication, subject } = createSubject(
            async () => true
        );
        await expect(subject.initializeDatabase()).resolves.toBe(true);

        await subject.close();

        expect(onCloseActiveReplication).toHaveBeenCalledOnce();
        expect(getActiveReplicator).not.toHaveBeenCalled();
        expect(closeReplication).not.toHaveBeenCalled();
    });

    it("still closes the physical database when close cleanup reports failure", async () => {
        const { database, onCloseDatabase, subject } = createSubject(async () => true);
        onCloseDatabase.mockResolvedValueOnce(false);
        await expect(subject.initializeDatabase()).resolves.toBe(true);

        await subject.close();

        expect(onCloseDatabase).toHaveBeenCalledWith(subject);
        expect(database.close).toHaveBeenCalledOnce();
    });
});
