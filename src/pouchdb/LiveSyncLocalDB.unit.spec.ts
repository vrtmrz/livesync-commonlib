import { afterEach, beforeEach, describe, expect, it } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import replication from "pouchdb-replication";
import type { DocumentID, EntryDoc } from "@lib/common/types";
import { LiveSyncLocalDB } from "./LiveSyncLocalDB";

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
        await database.put(
            revision("second.md", "1-second", ["second"], ["h:shared"]),
            { new_edits: false } as PouchDB.Core.PutOptions
        );

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
