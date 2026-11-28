import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import type { DocumentID, EntryDoc, FilePathWithPrefix, LoadedEntry, MetaEntry, UXFileInfo } from "@lib/common/types";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "./ServiceDatabaseFileAccessBase";
import { storeDeletionByPathAtRevision } from "@lib/managers/EntryManager/EntryManagerImpls";
import { EVENT_FILE_SAVED } from "@lib/events/coreEvents";

PouchDB.plugin(MemoryAdapter);
PouchDB.plugin(replication);

let databaseSequence = 0;

function createEntry(id: DocumentID, path: FilePathWithPrefix, content: string): EntryDoc {
    return {
        _id: id,
        path,
        type: "plain",
        datatype: "plain",
        data: [content],
        ctime: 1,
        mtime: 1,
        size: content.length,
        children: [],
        eden: {},
    } as unknown as EntryDoc;
}

type RevisionReader = (
    path: FilePathWithPrefix,
    options?: PouchDB.Core.GetOptions,
    dump?: boolean,
    waitForReady?: boolean,
    includeDeleted?: boolean,
    localOnly?: boolean
) => Promise<LoadedEntry | false>;
type MetadataReader = (
    path: FilePathWithPrefix,
    options?: PouchDB.Core.GetOptions,
    includeDeleted?: boolean
) => Promise<MetaEntry | false>;
type RawReader = (id: DocumentID, options?: PouchDB.Core.GetOptions) => Promise<unknown>;

function createService(
    database: PouchDB.Database<EntryDoc>,
    id: DocumentID,
    readRevision?: RevisionReader,
    readMetadata?: MetadataReader,
    readRaw?: RawReader
) {
    const getEntry = async (_path: FilePathWithPrefix, options?: PouchDB.Core.GetOptions) => {
        try {
            return (await database.get(id, options)) as LoadedEntry;
        } catch {
            return false;
        }
    };
    const dependencies = {
        events: createLiveSyncEventHub(),
        API: { addLog: vi.fn() },
        vault: { isTargetFile: vi.fn().mockResolvedValue(true) },
        storageAccess: {},
        path: {},
        database: {
            localDatabase: {
                getDBEntryMeta: readMetadata ?? getEntry,
                getDBEntry: readRevision ?? getEntry,
                readDBEntry: readRevision ?? getEntry,
                getRaw: readRaw ?? ((documentId: DocumentID, options?: PouchDB.Core.GetOptions) =>
                    database.get(documentId, options)),
            },
        },
    } as unknown as ServiceDatabaseFileAccessDependencies;
    return new ServiceDatabaseFileAccessBase(dependencies);
}

describe("ServiceDatabaseFileAccessBase local database observers", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];

    afterEach(async () => {
        await Promise.all(databases.splice(0).map((database) => database.destroy()));
    });

    it("reads the exact original revision path and distinguishes absence from failure", async () => {
        const id = "tasks/note.md" as DocumentID;
        const path = "Tasks/Note.md" as FilePathWithPrefix;
        const database = new PouchDB<EntryDoc>(`revision-spelling-${++databaseSequence}`, { adapter: "memory" });
        databases.push(database);
        const first = await database.put(createEntry(id, path, "old content"));
        const current = await database.put({ ...createEntry(id, id as unknown as FilePathWithPrefix, "new content"), _rev: first.rev });
        const service = createService(database, id);

        await expect(service.readRevisionPath(id, first.rev)).resolves.toBe(path);
        await expect(service.readRevisionPath(id, current.rev)).resolves.toBe(id);
        await expect(service.readRevisionPath(id, "2-missing")).resolves.toBeUndefined();

        const failure = new Error("database unavailable");
        const unavailable = createService(database, id, undefined, undefined, vi.fn().mockRejectedValue(failure));
        await expect(unavailable.readRevisionPath(id, current.rev)).rejects.toMatchObject({
            failure: { documentId: id, revision: current.rev, resources: ["local-database"], cause: failure },
        });
    });

    it("loads only name-matching live leaves when an observed filename is supplied", async () => {
        const id = "note.md" as DocumentID;
        const path = "Note.md" as FilePathWithPrefix;
        const database = new PouchDB<EntryDoc>(`named-leaf-${++databaseSequence}`, { adapter: "memory" });
        databases.push(database);
        const matching = { ...createEntry(id, path, "same bytes"), _rev: "1-matching" };
        const other = { ...createEntry(id, "note.md" as FilePathWithPrefix, "same bytes"), _rev: "1-other" };
        await database.bulkDocs([matching, other], { new_edits: false });
        const readRevision = vi.fn<RevisionReader>(async (_file, options) => {
            if (options?.rev === other._rev) {
                throw new Error("other filename's Chunk unavailable");
            }
            return matching as LoadedEntry;
        });
        const service = createService(database, id, readRevision);

        await expect(service.readLiveContentRevisions(path, "same bytes", { path, normalizationVersion: 0 }))
            .resolves.toEqual([matching._rev]);
        expect(readRevision).toHaveBeenCalledExactlyOnceWith(path, { rev: matching._rev }, false, true, true, true);
        await expect(service.readLiveContentRevisions(path, "same bytes")).rejects.toThrow("Chunk unavailable");
    });

    it("reports a local InvalidStateError before live-content discovery returns no matches", async () => {
        const id = "database-id-not-path" as DocumentID;
        const path = "local-revision-read.md" as FilePathWithPrefix;
        const database = new PouchDB<EntryDoc>(`local-revision-read-${++databaseSequence}`, { adapter: "memory" });
        databases.push(database);
        const metadata = {
            _id: id,
            _rev: "2-current",
            path,
            children: [],
            type: "plain",
        } as unknown as MetaEntry;
        const failure = Object.assign(new Error("database is closed"), { name: "InvalidStateError" });
        const readRaw = vi.fn().mockRejectedValue(failure);
        const service = createService(database, id, undefined, async () => metadata, readRaw);
        await expect(service.readLiveContentRevisions(path, "local bytes")).rejects.toMatchObject({
            failure: { documentId: id, resources: ["local-database"], cause: failure },
        });
        expect(readRaw).toHaveBeenCalledExactlyOnceWith(id, { open_revs: "all" });
        await expect(service.findLiveContentRevisions(path, "local bytes")).resolves.toEqual([]);
    });

    it("passes the per-call observer to conflicted-revision metadata reads", async () => {
        const id = "local-conflicts.md" as DocumentID;
        const path = "local-conflicts.md" as FilePathWithPrefix;
        const database = new PouchDB<EntryDoc>(`local-conflicts-${++databaseSequence}`, { adapter: "memory" });
        databases.push(database);
        const metadata = { _id: id, _conflicts: ["2-other"] } as unknown as MetaEntry;
        const readMetadata = vi.fn().mockResolvedValue(metadata);
        const service = createService(database, id, undefined, readMetadata);
        await expect(service.readConflictedRevs(path)).resolves.toEqual(["2-other"]);
        expect(readMetadata).toHaveBeenCalledExactlyOnceWith(id, { conflicts: true }, true);
    });
});

describe("ServiceDatabaseFileAccessBase.hasContentInRevisionHistory", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];

    afterEach(async () => {
        await Promise.all(databases.splice(0).map((database) => database.destroy()));
    });

    it("matches only current leaves, even when an ancestor has identical content", async () => {
        const id = "current-leaves.md" as DocumentID;
        const path = "current-leaves.md" as FilePathWithPrefix;
        const database = new PouchDB<EntryDoc>(`current-leaves-${++databaseSequence}`, { adapter: "memory" });
        databases.push(database);
        const root = await database.put(createEntry(id, path, "old content"));
        await database.put({ ...createEntry(id, path, "new content"), _rev: root.rev });
        const service = createService(database, id);

        await expect(service.findContentRevisions(path, "old content")).resolves.toContain(root.rev);
        await expect(service.findLiveContentRevisions(path, "old content")).resolves.toEqual([]);
        await expect(service.findLiveContentRevisions(path, "new content")).resolves.toHaveLength(1);
    });

    it("recognises content from a resolved losing branch as synchronised history", async () => {
        databaseSequence += 1;
        const source = new PouchDB<EntryDoc>(`revision-history-source-${databaseSequence}`, { adapter: "memory" });
        const target = new PouchDB<EntryDoc>(`revision-history-target-${databaseSequence}`, { adapter: "memory" });
        databases.push(source, target);

        const path = "note.md" as FilePathWithPrefix;
        const id = "note.md" as DocumentID;
        await source.put(createEntry(id, path, "base"));
        await source.replicate.to(target);

        const sourceBase = await source.get(id);
        const targetBase = await target.get(id);
        await source.put({ ...sourceBase, data: ["edited on source"], mtime: 2 });
        await target.put({ ...targetBase, data: ["edited on target"], mtime: 3 });
        await source.replicate.to(target);

        const conflicted = await target.get(id, { conflicts: true });
        expect(conflicted._conflicts).toHaveLength(1);
        const losingRev = conflicted._conflicts![0];
        const losingEntry = await target.get(id, { rev: losingRev });
        const losingContent = Array.isArray(losingEntry.data) ? losingEntry.data.join("") : losingEntry.data;

        await target.remove(id, losingRev);
        const resolved = await target.get(id, { conflicts: true });
        expect(resolved._conflicts).toBeUndefined();

        const service = createService(target, id);
        await expect(service.hasContentInRevisionHistory(path, losingContent, resolved._rev)).resolves.toBe(true);
        const winningContent = Array.isArray(resolved.data) ? resolved.data.join("") : resolved.data;
        await expect(service.hasContentInRevisionHistory(path, winningContent, resolved._rev)).resolves.toBe(true);
        await expect(
            service.hasContentInRevisionHistory(path, "a new unsynchronised local edit", resolved._rev)
        ).resolves.toBe(false);
    });

    it("stops after matching current content before an unreadable older revision", async () => {
        databaseSequence += 1;
        const database = new PouchDB<EntryDoc>(`revision-short-circuit-${databaseSequence}`, {
            adapter: "memory",
        });
        databases.push(database);

        const path = "short-circuit.md" as FilePathWithPrefix;
        const id = "short-circuit.md" as DocumentID;
        await database.put(createEntry(id, path, "older content"));
        const base = await database.get(id);
        const current = await database.put({ ...base, data: ["current content"], mtime: 2 });
        const readRevision = vi.fn<RevisionReader>(async (_path, options) => {
            if (options?.rev !== current.rev) {
                return false;
            }
            return (await database.get(id, { rev: current.rev })) as LoadedEntry;
        });
        const service = createService(database, id, readRevision);

        await expect(service.hasContentInRevisionHistory(path, "current content", current.rev)).resolves.toBe(true);

        expect(readRevision).toHaveBeenCalledTimes(1);
        expect(readRevision).toHaveBeenCalledWith(path, { rev: current.rev }, false, true, true);
    });

    it("returns every available revision with exactly matching content", async () => {
        databaseSequence += 1;
        const source = new PouchDB<EntryDoc>(`revision-match-source-${databaseSequence}`, { adapter: "memory" });
        const target = new PouchDB<EntryDoc>(`revision-match-target-${databaseSequence}`, { adapter: "memory" });
        databases.push(source, target);

        const path = "same.md" as FilePathWithPrefix;
        const id = "same.md" as DocumentID;
        await source.put(createEntry(id, path, "base"));
        await source.replicate.to(target);
        const sourceBase = await source.get(id);
        const targetBase = await target.get(id);
        await source.put({ ...sourceBase, data: ["same content"], mtime: 2 });
        await target.put({ ...targetBase, data: ["same content"], mtime: 3 });
        await source.replicate.to(target);

        const conflicted = await target.get(id, { conflicts: true });
        expect(conflicted._conflicts).toHaveLength(1);
        const service = createService(target, id);

        await expect(service.findContentRevisions(path, "same content", conflicted._rev)).resolves.toEqual(
            expect.arrayContaining([conflicted._rev, conflicted._conflicts![0]])
        );
    });

    it("stores a conflict-time deletion as a visible logical child of the selected revision", async () => {
        databaseSequence += 1;
        const source = new PouchDB<EntryDoc>(`revision-delete-source-${databaseSequence}`, { adapter: "memory" });
        const target = new PouchDB<EntryDoc>(`revision-delete-target-${databaseSequence}`, { adapter: "memory" });
        databases.push(source, target);

        const path = "deleted.md" as FilePathWithPrefix;
        const id = "deleted.md" as DocumentID;
        await source.put(createEntry(id, path, "base"));
        await source.replicate.to(target);
        const sourceBase = await source.get(id);
        const targetBase = await target.get(id);
        await source.put({ ...sourceBase, data: ["source edit"], mtime: 2 });
        await target.put({ ...targetBase, data: ["displayed edit"], mtime: 3 });
        await source.replicate.to(target);

        const conflicted = await target.get(id, { conflicts: true });
        const displayedRevision = conflicted._conflicts![0];
        const host = {
            services: {
                path: { path2id: vi.fn().mockResolvedValue(id) },
                setting: {
                    currentSettings: vi.fn().mockReturnValue({
                        syncInternalFiles: true,
                        syncOnlyRegEx: "",
                        syncIgnoreRegEx: "",
                    }),
                },
            },
            serviceModules: {},
        };

        const result = await storeDeletionByPathAtRevision(
            host as never,
            { localDatabase: target },
            path,
            displayedRevision
        );

        expect(result).not.toBe(false);
        const response = result as PouchDB.Core.Response;
        const deletion = await target.get(id, { rev: response.rev, revs: true });
        expect(deletion.deleted).toBe(true);
        expect(deletion._deleted).not.toBe(true);
        expect(deletion._revisions?.ids[1]).toBe(displayedRevision.split("-")[1]);
        const after = await target.get(id, { conflicts: true });
        expect([after._rev, ...(after._conflicts ?? [])]).toContain(response.rev);
        expect(after._conflicts).toHaveLength(1);
        const service = createService(target, id);
        await expect(service.findContentRevisions(path, "displayed edit", response.rev)).resolves.not.toContain(
            response.rev
        );
    });

    it("does not invent a sibling base for a generation-one revision", async () => {
        databaseSequence += 1;
        const database = new PouchDB<EntryDoc>(`revision-generation-one-${databaseSequence}`, {
            adapter: "memory",
        });
        databases.push(database);

        const path = "root.md" as FilePathWithPrefix;
        const id = "root.md" as DocumentID;
        const root = await database.put({
            ...createEntry(id, path, ""),
            children: ["h:missing"],
        });
        const service = createService(database, id);
        const storeWithBaseRevision = vi.spyOn(service, "storeWithBaseRevision");
        const storageFile = {
            path,
            name: "root.md",
            stat: {
                ctime: 2,
                mtime: 2,
                size: 12,
                type: "file",
            },
            body: new Blob(["local bytes"]),
        } as UXFileInfo;

        await expect(service.storeAsConflictedRevisionWithResult(storageFile, root.rev, true)).resolves.toBe(false);

        expect(storeWithBaseRevision).not.toHaveBeenCalled();
        const after = await database.get(id, { conflicts: true });
        expect(after._rev).toBe(root.rev);
        expect(after._conflicts).toBeUndefined();
    });
});

describe("ServiceDatabaseFileAccessBase.storeWithLiveBaseRevision", () => {
    it("returns the exact child revision and emits the saved event only after a successful conditional write", async () => {
        const path = "restored.md" as FilePathWithPrefix;
        const id = "restored.md" as DocumentID;
        const events = createLiveSyncEventHub();
        const emitEvent = vi.spyOn(events, "emitEvent");
        const putDBEntryWithLiveBaseRevision = vi.fn().mockResolvedValue({
            ok: true,
            id,
            rev: "3-restored",
        });
        const service = new ServiceDatabaseFileAccessBase({
            events,
            API: { addLog: vi.fn() },
            vault: {},
            storageAccess: {},
            path: { path2id: vi.fn().mockResolvedValue(id) },
            database: {
                localDatabase: { putDBEntryWithLiveBaseRevision },
            },
        } as unknown as ServiceDatabaseFileAccessDependencies);
        const file = {
            path,
            name: "restored.md",
            stat: {
                ctime: 1,
                mtime: 2,
                size: 8,
                type: "file",
            },
            body: new Blob(["restored"]),
        } as UXFileInfo;

        await expect(service.storeWithLiveBaseRevision(file, "2-deleted", true)).resolves.toBe("3-restored");

        expect(putDBEntryWithLiveBaseRevision).toHaveBeenCalledWith(
            expect.objectContaining({ _id: id, path }),
            "2-deleted",
            false
        );
        expect(emitEvent).toHaveBeenCalledWith(EVENT_FILE_SAVED);

        putDBEntryWithLiveBaseRevision.mockResolvedValueOnce(false);
        emitEvent.mockClear();
        await expect(service.storeWithLiveBaseRevision(file, "2-deleted", true)).resolves.toBe(false);
        expect(emitEvent).not.toHaveBeenCalled();
    });
});
