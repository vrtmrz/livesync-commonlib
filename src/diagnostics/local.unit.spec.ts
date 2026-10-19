import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { EntryTypes, type DocumentID, type EntryDoc } from "../common/types.ts";
import { analyseDatabaseIntegrity } from "./integrity.ts";
import { createLocalDiagnosticSource } from "./local.ts";
import type { DatabaseIntegrityOptions } from "./types.ts";

PouchDB.plugin(MemoryAdapter);

let databaseSequence = 0;

function metadata(id: string, path: string): EntryDoc {
    return {
        _id: id as DocumentID,
        type: EntryTypes.NOTE_PLAIN,
        path,
        children: [],
        ctime: 1,
        mtime: 1,
        size: 0,
        eden: {},
    } as EntryDoc;
}

const identitySettings = {
    encrypt: false,
    usePathObfuscation: false,
    handleFilenameCaseSensitive: true,
    idDerivationVersion: 1,
    pathNormalizationVersion: 1,
};

function integrityOptions(database: PouchDB.Database<EntryDoc>): DatabaseIntegrityOptions {
    return {
        local: createLocalDiagnosticSource(database),
        path: {
            getPath: (entry) => (entry as { path: string }).path,
            path2id: async (path: string) => `doc:${path}` as DocumentID,
        },
        settings: identitySettings,
        readStorage: async () => ({ status: "not-checked" as const }),
        isConfigurationCurrent: () => true,
    };
}

describe("createLocalDiagnosticSource", () => {
    let database: PouchDB.Database<EntryDoc>;

    beforeEach(() => {
        databaseSequence++;
        database = new PouchDB<EntryDoc>(`local-diagnostics-${databaseSequence}`, { adapter: "memory" });
    });

    afterEach(async () => {
        await database.destroy();
    });

    it("pages past the 256-row boundary without losing or repeating IDs and leaves the local database usable", async () => {
        const count = 258;
        const documents = Array.from({ length: count }, (_, index) => {
            const path = `/page-${index.toString().padStart(3, "0")}.md`;
            const id = `doc:${path}`;
            return metadata(id, path);
        });
        await database.bulkDocs(documents);

        const source = createLocalDiagnosticSource(database);
        const enumeratedIds: string[] = [];
        for await (const id of source.enumerateIds()) enumeratedIds.push(id);

        expect(enumeratedIds).toEqual(documents.map((document) => document._id).sort());
        expect(new Set(enumeratedIds).size).toBe(count);

        const sequenceBefore = (await database.info()).update_seq;
        const result = await analyseDatabaseIntegrity(integrityOptions(database));
        const sequenceAfter = (await database.info()).update_seq;

        expect(result.coverage.local.documents).toBe(count);
        expect(sequenceAfter).toBe(sequenceBefore);
        expect((await database.get(documents[0]._id))._id).toBe(documents[0]._id);

        const afterDiagnostic = metadata("doc:/after-diagnostic.md", "/after-diagnostic.md");
        await database.put(afterDiagnostic);
        expect((await database.get(afterDiagnostic._id))._id).toBe(afterDiagnostic._id);
    });

    it("enumerates a conflicted Metadata document once and reads its current revisions explicitly", async () => {
        const id = "doc:/conflict.md";
        const firstRevision = await database.put(metadata(id, "/conflict.md"));
        const forcedConflict = metadata(id, "/conflict.md");
        forcedConflict._rev = `${firstRevision.rev.split("-")[0]}-diagnosticconflict`;
        await database.put(forcedConflict, { force: true } as PouchDB.Core.PutOptions & { force: true });

        const source = createLocalDiagnosticSource(database);
        const ids: string[] = [];
        for await (const enumeratedId of source.enumerateIds()) ids.push(enumeratedId);
        const current = (await source.get(id, { conflicts: true })) as EntryDoc & { _conflicts?: string[] };
        const conflictRevision = current._conflicts?.[0];
        const winnerRevision = current._rev;

        expect(ids).toEqual([id]);
        expect(current._conflicts).toHaveLength(1);
        expect(conflictRevision).toBeDefined();
        expect(winnerRevision).toBeDefined();
        if (!conflictRevision || !winnerRevision) throw new Error("PouchDB did not expose both current revisions");
        const conflict = await source.get(id, { rev: conflictRevision, conflicts: true });
        expect(conflict._id).toBe(id);
        expect(conflict._rev).toBe(conflictRevision);

        const result = await analyseDatabaseIntegrity(integrityOptions(database));
        expect(
            result.observations
                .filter((observation) => observation.id === id)
                .map((observation) => observation.revision)
                .sort()
        ).toEqual([winnerRevision, conflictRevision].sort());
        expect(result.coverage.local.conflictBranches).toBe(1);
    });
});
