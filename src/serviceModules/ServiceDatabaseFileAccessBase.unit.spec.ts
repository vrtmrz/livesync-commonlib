import { afterEach, describe, expect, it, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import type { DocumentID, EntryDoc, FilePathWithPrefix, LoadedEntry } from "@lib/common/types";
import { createLiveSyncEventHub } from "@lib/hub/hub";
import {
    ServiceDatabaseFileAccessBase,
    type ServiceDatabaseFileAccessDependencies,
} from "./ServiceDatabaseFileAccessBase";
import { storeDeletionByPathAtRevision } from "@lib/managers/EntryManager/EntryManagerImpls";

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

function createService(database: PouchDB.Database<EntryDoc>, id: DocumentID) {
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
                getDBEntryMeta: getEntry,
                getDBEntry: getEntry,
                getRaw: (documentId: DocumentID, options?: PouchDB.Core.GetOptions) =>
                    database.get(documentId, options),
            },
        },
    } as unknown as ServiceDatabaseFileAccessDependencies;
    return new ServiceDatabaseFileAccessBase(dependencies);
}

describe("ServiceDatabaseFileAccessBase.hasContentInRevisionHistory", () => {
    const databases: PouchDB.Database<EntryDoc>[] = [];

    afterEach(async () => {
        await Promise.all(databases.splice(0).map((database) => database.destroy()));
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
});
