import { describe, expect, it, vi } from "vitest";

import type { DocumentID, FilePathWithPrefix, MetaEntry } from "@lib/common/types";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { inspectMetadataDocumentIdentities, repairMetadataDocumentIdentity } from "./offlineScanner";

function metadata(
    id: string,
    revision: string,
    path: string,
    children: string[] = ["h:content"],
    extra: Partial<MetaEntry> = {}
): MetaEntry {
    return {
        _id: id as DocumentID,
        _rev: revision,
        path: path as FilePathWithPrefix,
        ctime: 10,
        mtime: 20,
        size: 7,
        type: "plain",
        children,
        eden: {},
        ...extra,
    } as MetaEntry;
}

function createHarness({
    documents,
    expectedIds,
    tombstones = {},
    failTargetPut = false,
    failSourceRemove = false,
    caseSensitive = false,
}: {
    documents: MetaEntry[];
    expectedIds: Record<string, string>;
    tombstones?: Record<string, string>;
    failTargetPut?: boolean;
    failSourceRemove?: boolean;
    caseSensitive?: boolean;
}) {
    const liveDocuments = new Map<DocumentID, MetaEntry>(documents.map((doc) => [doc._id, { ...doc }]));
    const deletedDocuments = new Map<DocumentID, string>(
        Object.entries(tombstones).map(([id, revision]) => [id as DocumentID, revision])
    );
    const lastSeen: Record<string, number> = { "renamed.md": 1234, "other.md": 5678 };
    const events: string[] = [];

    const findAllNormalDocs = vi.fn(async function* () {
        yield* [...liveDocuments.values()];
    });
    const allDocsRaw = vi.fn(async ({ keys }: { keys: DocumentID[] }) => ({
        rows: keys.map((key) => {
            const live = liveDocuments.get(key);
            if (live) {
                return { key, id: key, value: { rev: live._rev }, doc: { ...live } };
            }
            const deletedRevision = deletedDocuments.get(key);
            if (deletedRevision) {
                return { key, id: key, value: { rev: deletedRevision, deleted: true } };
            }
            return { key, error: "not_found" };
        }),
    }));
    const getRaw = vi.fn(async (id: DocumentID) => {
        const doc = liveDocuments.get(id);
        if (!doc) throw new Error(`Missing ${id}`);
        return { ...doc };
    });
    const putRaw = vi.fn(async (doc: MetaEntry) => {
        events.push("put-target");
        if (failTargetPut) throw new Error("Target put failed");
        if (liveDocuments.has(doc._id) || deletedDocuments.has(doc._id)) throw new Error("Target occupied");
        liveDocuments.set(doc._id, { ...doc, _rev: "1-target" });
        return { ok: true, id: doc._id, rev: "1-target" };
    });
    const removeRaw = vi.fn(async (id: DocumentID, revision: string) => {
        events.push("remove-source");
        if (failSourceRemove) throw new Error("Source tombstone failed");
        const doc = liveDocuments.get(id);
        if (!doc || doc._rev !== revision) throw new Error("Source changed");
        liveDocuments.delete(id);
        deletedDocuments.set(id, "5-source-tombstone");
        return { ok: true, id, rev: "5-source-tombstone" };
    });
    const kvGet = vi.fn(async () => {
        events.push("last-seen:get");
        return { ...lastSeen };
    });
    const kvSet = vi.fn(async (_key: string, value: Record<string, number>) => {
        events.push("last-seen:set");
        for (const key of Object.keys(lastSeen)) delete lastSeen[key];
        Object.assign(lastSeen, value);
    });

    const host = {
        services: {
            context: createServiceContext(),
            path: {
                getPath: vi.fn((doc: MetaEntry) => doc.path),
                path2id: vi.fn(async (path: FilePathWithPrefix) => expectedIds[path]),
            },
            setting: {
                currentSettings: vi.fn(() => ({ handleFilenameCaseSensitive: caseSensitive })),
            },
            vault: {
                isValidPath: vi.fn(() => true),
                isTargetFile: vi.fn(async () => true),
            },
            database: {
                localDatabase: {
                    findAllNormalDocs,
                    allDocsRaw,
                    getRaw,
                    putRaw,
                    removeRaw,
                },
            },
            keyValueDB: {
                kvDB: { get: kvGet, set: kvSet },
            },
        },
        serviceModules: {},
    } as any;
    return {
        host,
        liveDocuments,
        deletedDocuments,
        lastSeen,
        events,
        putRaw,
        removeRaw,
        kvSet,
    };
}

describe("Metadata document identity repair", () => {
    it("publishes and verifies the target before tombstoning the exact source revision", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const harness = createHarness({
            documents: [source],
            expectedIds: { "renamed.md": "f:renamed" },
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: "f:renamed" as DocumentID,
            sourceRevision: "4-source",
        });

        expect(result).toMatchObject({ status: "completed", targetCreated: true });
        expect(harness.liveDocuments.has(source._id)).toBe(false);
        expect(harness.deletedDocuments.has(source._id)).toBe(true);
        expect(harness.liveDocuments.get("f:renamed" as DocumentID)).toMatchObject({
            _id: "f:renamed",
            path: "renamed.md",
            children: ["h:content"],
        });
        expect(harness.lastSeen).toEqual({ "other.md": 5678 });
        expect(harness.events.indexOf("last-seen:set")).toBeLessThan(harness.events.indexOf("put-target"));
        expect(harness.events.indexOf("put-target")).toBeLessThan(harness.events.indexOf("remove-source"));
    });

    it("repeats safely from an exact target without writing it again", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const target = metadata("f:renamed", "1-target", "renamed.md");
        const harness = createHarness({
            documents: [source, target],
            expectedIds: { "renamed.md": "f:renamed" },
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);
        expect(report.find(({ sourceRevision }) => sourceRevision === "4-source")).toMatchObject({
            repairAvailable: true,
            targetAlreadyPresent: true,
            ordinaryPathAvailable: true,
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: target._id,
            sourceRevision: "4-source",
        });

        expect(result).toMatchObject({ status: "completed", targetCreated: false });
        expect(harness.putRaw).not.toHaveBeenCalled();
        expect(harness.removeRaw).toHaveBeenCalledWith(source._id, "4-source");
    });

    it("rejects a stale approval without clearing last-seen state or mutating documents", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const harness = createHarness({
            documents: [source],
            expectedIds: { "renamed.md": "f:renamed" },
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: "f:renamed" as DocumentID,
            sourceRevision: "3-obsolete",
        });

        expect(result.status).toBe("stale");
        expect(harness.kvSet).not.toHaveBeenCalled();
        expect(harness.putRaw).not.toHaveBeenCalled();
        expect(harness.removeRaw).not.toHaveBeenCalled();
    });

    it("blocks a tombstoned target and retains the source", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const harness = createHarness({
            documents: [source],
            expectedIds: { "renamed.md": "f:renamed" },
            tombstones: { "f:renamed": "2-deleted" },
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);
        expect(report[0]).toMatchObject({
            repairAvailable: false,
            targetAlreadyPresent: false,
            ordinaryPathAvailable: false,
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: "f:renamed" as DocumentID,
            sourceRevision: "4-source",
        });
        expect(result.status).toBe("blocked");
        expect(harness.putRaw).not.toHaveBeenCalled();
        expect(harness.removeRaw).not.toHaveBeenCalled();
    });

    it("retains the source and leaves a retry-safe last-seen state when target creation fails", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const harness = createHarness({
            documents: [source],
            expectedIds: { "renamed.md": "f:renamed" },
            failTargetPut: true,
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: "f:renamed" as DocumentID,
            sourceRevision: "4-source",
        });

        expect(result).toMatchObject({ status: "failed", targetCreated: false });
        expect(harness.liveDocuments.has(source._id)).toBe(true);
        expect(harness.lastSeen).toEqual({ "other.md": 5678 });
        expect(harness.removeRaw).not.toHaveBeenCalled();
    });

    it("leaves an exact target which the same action can complete when source tombstoning fails", async () => {
        const source = metadata("f:stale", "4-source", "renamed.md");
        const harness = createHarness({
            documents: [source],
            expectedIds: { "renamed.md": "f:renamed" },
            failSourceRemove: true,
        });

        const result = await repairMetadataDocumentIdentity(harness.host, {
            actualDocumentId: source._id,
            expectedDocumentId: "f:renamed" as DocumentID,
            sourceRevision: "4-source",
        });

        expect(result).toMatchObject({ status: "failed", targetCreated: true });
        expect(harness.liveDocuments.has(source._id)).toBe(true);
        const report = await inspectMetadataDocumentIdentities(harness.host);
        expect(report.find(({ sourceRevision }) => sourceRevision === "4-source")).toMatchObject({
            repairAvailable: true,
            targetAlreadyPresent: true,
        });
    });

    it("blocks conflicted and logically deleted sources", async () => {
        const sources = [
            metadata("f:conflict", "3-conflict", "conflict.md", ["h:content"], {
                _conflicts: ["2-other"],
            }),
            metadata("f:deleted", "3-deleted", "deleted.md", ["h:content"], { deleted: true }),
        ];
        const harness = createHarness({
            documents: sources,
            expectedIds: {
                "conflict.md": "f:expected-conflict",
                "deleted.md": "f:expected-deleted",
            },
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);
        const repairAvailability = new Map(
            report.map((entry) => [
                entry.inspection.diagnostic.declaredPath,
                entry.repairAvailable,
            ])
        );
        expect(repairAvailability.get("conflict.md" as FilePathWithPrefix)).toBe(false);
        expect(repairAvailability.get("deleted.md" as FilePathWithPrefix)).toBe(false);
    });

    it("blocks case-variant path claims under case-insensitive handling", async () => {
        const sources = [
            metadata("f:stale-a", "2-a", "Folder/shared.md"),
            metadata("f:stale-b", "2-b", "folder/shared.md"),
        ];
        const harness = createHarness({
            documents: sources,
            expectedIds: {
                "Folder/shared.md": "f:shared-a",
                "folder/shared.md": "f:shared-b",
            },
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);

        expect(report.filter(({ repairAvailable }) => repairAvailable)).toHaveLength(0);
        for (const entry of report) {
            expect(entry.repairAvailable).toBe(false);
        }
    });

    it("keeps case-variant path claims distinct under case-sensitive handling", async () => {
        const harness = createHarness({
            documents: [
                metadata("f:stale-a", "2-a", "Folder/shared.md"),
                metadata("f:stale-b", "2-b", "folder/shared.md"),
            ],
            expectedIds: {
                "Folder/shared.md": "f:shared-a",
                "folder/shared.md": "f:shared-b",
            },
            caseSensitive: true,
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);

        expect(report.every(({ repairAvailable }) => repairAvailable)).toBe(true);
    });

    it("blocks a target ID which is also claimed by a different recorded path", async () => {
        const source = metadata("f:stale", "2-source", "renamed.md");
        const other = metadata("f:renamed", "2-other", "other.md");
        const harness = createHarness({
            documents: [source, other],
            expectedIds: {
                "renamed.md": "f:renamed",
                "other.md": "f:other",
            },
        });

        const report = await inspectMetadataDocumentIdentities(harness.host);
        const sourceEntry = report.find(({ sourceRevision }) => sourceRevision === "2-source");

        expect(sourceEntry?.repairAvailable).toBe(false);
    });
});
