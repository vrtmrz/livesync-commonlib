import { describe, expect, it, vi } from "vitest";
import {
    DOCID_SYNC_PARAMETERS,
    EntryTypes,
    MILESTONE_DOCID,
    NODEINFO_DOCID,
    SYNCINFO_ID,
    VERSIONING_DOCID,
    type DocumentID,
    type EntryDoc,
} from "../common/types.ts";
import { analyseDatabaseIntegrity } from "./integrity.ts";
import {
    DiagnosticReadError,
    type DatabaseIntegrityOptions,
    type DiagnosticDatabaseSource,
    type DiagnosticReadOptions,
} from "./types.ts";

interface TestSourceOptions {
    ids?: string[];
    documents?: Record<string, EntryDoc>;
    revisions?: Record<string, Record<string, EntryDoc>>;
    info?: () => Promise<{ update_seq?: string | number }>;
    onBeforeYield?(id: string): void | Promise<void>;
    getError?(id: string, options?: DiagnosticReadOptions): unknown;
}

function createSource({
    ids = [],
    documents = {},
    revisions = {},
    info = async () => ({ update_seq: 1 }),
    onBeforeYield,
    getError,
}: TestSourceOptions = {}) {
    const infoMock = vi.fn(info);
    const get = vi.fn(async (id: string, options?: DiagnosticReadOptions): Promise<EntryDoc> => {
        const error = getError?.(id, options);
        if (error) throw error;
        if (options?.rev) {
            const branch = revisions[id]?.[options.rev];
            if (branch) return branch;
        } else if (documents[id]) {
            return documents[id];
        }
        throw Object.assign(new Error("private read failure"), { status: 404, name: "not_found" });
    });
    const enumerateIds = vi.fn(async function* (): AsyncGenerator<string> {
        for (const id of ids) {
            await onBeforeYield?.(id);
            yield id;
        }
    });
    const source: DiagnosticDatabaseSource = { info: infoMock, enumerateIds, get };
    return { source, info: infoMock, enumerateIds, get };
}

function metadata(
    id: string,
    path: string,
    options: {
        rev?: string;
        children?: string[];
        type?: string;
        deleted?: boolean;
        conflicts?: string[];
    } = {}
): EntryDoc {
    return {
        _id: id as DocumentID,
        _rev: options.rev ?? "1-rev",
        type: options.type ?? EntryTypes.NOTE_PLAIN,
        path,
        children: options.children ?? [],
        ctime: 1,
        mtime: 1,
        size: 1,
        eden: {},
        ...(options.deleted ? { deleted: true } : {}),
        ...(options.conflicts ? { _conflicts: options.conflicts } : {}),
    } as EntryDoc;
}

function chunk(id: string, data: string): EntryDoc {
    return { _id: id as DocumentID, _rev: "1-chunk", type: EntryTypes.CHUNK, data } as EntryDoc;
}

const settings = {
    encrypt: false,
    usePathObfuscation: false,
    handleFilenameCaseSensitive: true,
    idDerivationVersion: 1,
    pathNormalizationVersion: 1,
};

function makeOptions(
    local: DiagnosticDatabaseSource,
    overrides: Partial<DatabaseIntegrityOptions> = {}
): DatabaseIntegrityOptions {
    const normalise = (path: string) => path.normalize("NFC").toLowerCase();
    return {
        local,
        remote: async () => ({ ...createSource().source, close: async () => {} }),
        path: {
            getPath: (entry) => (entry as { path: string }).path,
            path2id: async (path) => `expected:${normalise(path)}` as DocumentID,
        },
        settings,
        readStorage: async () => ({ status: "not-checked" }),
        isConfigurationCurrent: () => true,
        ...overrides,
    } as DatabaseIntegrityOptions;
}

function bytes(value: string): Uint8Array<ArrayBuffer> {
    return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

describe("analyseDatabaseIntegrity", () => {
    it("retains deleted and live Metadata counterparts and flags their shared identity mismatch", async () => {
        const path = "/note.md";
        const expectedId = `expected:${path}`;
        const local = createSource({
            ids: ["stale-id"],
            documents: { "stale-id": metadata("stale-id", path, { rev: "2-local", deleted: true }) },
        });
        const remote = createSource({
            ids: [expectedId],
            documents: { [expectedId]: metadata(expectedId, path, { rev: "3-remote" }) },
        });
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, { remote: async () => ({ ...remote.source, close: async () => {} }) })
        );

        expect(result.status).toBe("complete");
        expect(result.observations).toHaveLength(2);
        expect(result.observations.map((observation) => observation.path)).toEqual([path, path]);
        expect(result.observations.map((observation) => observation.identity)).toEqual([
            "document-id-mismatch",
            "consistent",
        ]);
        expect(result.observations.map((observation) => observation.logicallyDeleted)).toEqual([true, false]);
        expect(result.observations.every((observation) => observation.content.status === "available")).toBe(true);
        expect(local.get).toHaveBeenCalledWith("stale-id", { conflicts: true });
        expect(remote.get).toHaveBeenCalledWith(expectedId, { conflicts: true });
    });

    it("reads each current conflict by its actual document ID and exact revision", async () => {
        const id = "expected:/conflict.md";
        const winner = metadata(id, "/conflict.md", {
            rev: "2-winner",
            children: ["h:winner"],
            conflicts: ["1-conflict"],
        });
        const branch = metadata(id, "/conflict.md", { rev: "1-conflict", children: ["h:branch"] });
        const local = createSource({
            ids: [id],
            documents: {
                [id]: winner,
                "h:winner": chunk("h:winner", "winner"),
                "h:branch": chunk("h:branch", "branch"),
            },
            revisions: { [id]: { "1-conflict": branch } },
        });
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, { remote: undefined, remoteUnavailableReason: "unsupported-remote" })
        );

        expect(local.get).toHaveBeenCalledWith(id, { conflicts: true });
        expect(local.get).toHaveBeenCalledWith(id, { rev: "1-conflict", conflicts: true });
        expect(result.observations.map((observation) => observation.branch)).toEqual(["winner", "conflict"]);
        expect(result.observations.map((observation) => observation.reference)).toEqual(["local:1", "local:2"]);
        expect(result.coverage.local.conflictBranches).toBe(1);
        expect(result.observations.every((observation) => observation.content.status === "available")).toBe(true);
    });

    it("prefers in-memory Eden chunks and reuses them for repeated children", async () => {
        const id = "wrong-eden-id";
        const document = {
            ...metadata(id, "/eden.md", { children: ["h:shared", "h:shared"] }),
            eden: { "h:shared": { data: "eden-content" } },
        } as EntryDoc;
        const local = createSource({
            ids: [id],
            documents: {
                [id]: document,
                "h:shared": chunk("h:shared", "database-content"),
            },
        });
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                remote: undefined,
                readStorage: async () => ({ status: "available", bytes: bytes("eden-contenteden-content") }),
            })
        );

        expect(result.observations[0].content.status).toBe("available");
        expect(result.observations[0].content.chunksRead).toBe(2);
        expect(result.observations[0].comparisons).toContainEqual({
            against: "vault:local:1",
            relation: "equal",
        });
        expect(local.get).not.toHaveBeenCalledWith("h:shared");
    });

    it("checks content for conflict branches even when all branches are logically deleted", async () => {
        const id = "expected:/deleted-conflict.md";
        const winner = metadata(id, "/deleted-conflict.md", {
            rev: "2-winner",
            deleted: true,
            conflicts: ["1-conflict"],
        });
        const branch = metadata(id, "/deleted-conflict.md", { rev: "1-conflict", deleted: true });
        const local = createSource({
            ids: [id],
            documents: { [id]: winner },
            revisions: { [id]: { "1-conflict": branch } },
        });
        const result = await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));

        expect(result.observations).toHaveLength(2);
        expect(result.observations.every((observation) => observation.content.status === "available")).toBe(true);
        expect(result.coverage.local.contentReads).toBe(2);
    });

    it("compares complete bytes against other Metadata and the Vault", async () => {
        const id = "expected:/same.md";
        const local = createSource({
            ids: [id],
            documents: {
                [id]: metadata(id, "/same.md", { rev: "3-local", children: ["h:local"] }),
                "h:local": chunk("h:local", "AB"),
            },
        });
        const remote = createSource({
            ids: [id],
            documents: {
                [id]: metadata(id, "/same.md", { rev: "4-remote", children: ["h:remote"] }),
                "h:remote": chunk("h:remote", "CD"),
            },
        });
        const readStorage = vi.fn(async (path: string) => {
            expect(path).toBe("/same.md");
            return { status: "available" as const, bytes: bytes("AB") };
        });
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                remote: async () => ({ ...remote.source, close: async () => {} }),
                readStorage,
            })
        );
        const [localObservation, remoteObservation] = result.observations;

        expect(localObservation.reference).toBe("local:1");
        expect(remoteObservation.reference).toBe("remote:1");
        expect(localObservation.otherSourceGroup).toBe("present");
        expect(remoteObservation.otherSourceGroup).toBe("present");
        expect(localObservation.vault).toEqual({ reference: "vault:local:1", status: "available" });
        expect(remoteObservation.vault).toEqual({ reference: "vault:local:1", status: "available" });
        expect(localObservation.content.status).toBe("available");
        expect(localObservation.comparisons).toContainEqual({
            against: remoteObservation.reference,
            relation: "different",
        });
        expect(localObservation.comparisons).toContainEqual({
            against: `vault:${localObservation.reference}`,
            relation: "equal",
        });
        expect(remoteObservation.comparisons).toContainEqual({
            against: `vault:${localObservation.reference}`,
            relation: "different",
        });
        expect(readStorage).toHaveBeenCalledTimes(1);
        expect(result.observations.some((observation) => JSON.stringify(observation).includes("AB"))).toBe(false);
    });

    it("reports missing and unreadable Vault content separately", async () => {
        const docs = {
            first: metadata("first", "/missing-vault.md"),
            second: metadata("second", "/unreadable-vault.md"),
        };
        const local = createSource({ ids: Object.keys(docs), documents: docs });
        const remote = createSource();
        const readStorage = vi.fn(async (path: string) =>
            path === "/missing-vault.md"
                ? { status: "missing" as const }
                : { status: "unreadable" as const, reason: "storage-changed" as const }
        );
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                remote: async () => ({ ...remote.source, close: async () => {} }),
                readStorage,
            })
        );
        const missing = result.observations.find((observation) => observation.path === "/missing-vault.md");
        const unreadable = result.observations.find((observation) => observation.path === "/unreadable-vault.md");

        expect(missing?.otherSourceGroup).toBe("missing");
        expect(missing?.vault).toMatchObject({ reference: "vault:local:1", status: "missing" });
        expect(unreadable?.otherSourceGroup).toBe("missing");
        expect(unreadable?.vault).toMatchObject({
            reference: "vault:local:2",
            status: "unreadable",
            reason: "storage-changed",
        });
        expect(result.errors).toContainEqual({
            source: "storage",
            reason: "storage-changed",
            path: "/unreadable-vault.md",
        });
    });

    it("marks case and NFC equivalents while preserving each exact stored path", async () => {
        const paths = ["/Title.md", "/title.md", "/Cafe\u0301.md", "/Café.md"];
        const docs = Object.fromEntries(
            paths.map((path, index) => [`actual-${index}`, metadata(`actual-${index}`, path)])
        );
        const local = createSource({ ids: Object.keys(docs), documents: docs });
        const result = await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));
        const observationsByPath = new Map(result.observations.map((observation) => [observation.path, observation]));

        expect([...observationsByPath.keys()]).toEqual(paths);
        expect(observationsByPath.get(paths[0])?.caseEquivalentPaths).toBe(true);
        expect(observationsByPath.get(paths[1])?.caseEquivalentPaths).toBe(true);
        expect(observationsByPath.get(paths[2])?.nfcEquivalentPaths).toBe(true);
        expect(observationsByPath.get(paths[3])?.nfcEquivalentPaths).toBe(true);
        expect(observationsByPath.get(paths[2])?.pathIsNFC).toBe(false);
    });

    it("distinguishes missing chunks from unreadable chunks without retaining raw errors", async () => {
        const id = "wrong-id";
        const local = createSource({
            ids: [id],
            documents: {
                [id]: metadata(id, "/broken.md", { children: ["h:diagnostic-missing", "h:pouch-404", "h:unreadable"] }),
            },
            getError: (readId) => {
                if (readId === "h:diagnostic-missing") return new DiagnosticReadError("document-unreadable", true);
                if (readId === "h:pouch-404")
                    return Object.assign(new Error("private 404 payload"), { status: 404, name: "not_found" });
                if (readId === "h:unreadable") return new Error("secret chunk payload");
                return undefined;
            },
        });
        const result = await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));
        const observation = result.observations[0];

        expect(observation.content.status).toBe("unreadable");
        expect(observation.content.reason).toBe("chunk-unreadable");
        expect(observation.content.unavailableChunks).toEqual([
            { id: "h:diagnostic-missing", status: "missing" },
            { id: "h:pouch-404", status: "missing" },
            { id: "h:unreadable", status: "unreadable" },
        ]);
        expect(result.errors).toContainEqual({
            source: "local",
            reason: "document-unreadable",
            id,
            revision: "1-rev",
            path: "/broken.md",
            chunkId: "h:diagnostic-missing",
        });
        expect(JSON.stringify(result)).not.toContain("private 404 payload");
        expect(JSON.stringify(result)).not.toContain("secret chunk payload");
    });

    it("retains local findings after remote initialisation fails without treating ordinary local files as suspect", async () => {
        const id = "expected:/ordinary.md";
        const local = createSource({ ids: [id], documents: { [id]: metadata(id, "/ordinary.md") } });
        const readStorage = vi.fn(async () => ({ status: "available" as const, bytes: bytes("unused") }));
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                remote: async () => {
                    throw new Error("https://private.example/user:password");
                },
                readStorage,
            })
        );

        expect(result.status).toBe("partial");
        expect(result.observations).toHaveLength(1);
        expect(result.observations[0].content.status).toBe("not-checked");
        expect(result.coverage.local.metadata).toBe(1);
        expect(result.coverage.remote.status).toBe("failed");
        expect(result.observations[0].otherSourceGroup).toBe("not-checked");
        expect(result.observations[0].vault.status).toBe("not-checked");
        expect(readStorage).not.toHaveBeenCalled();
        expect(JSON.stringify(result)).not.toContain("private.example");
    });

    it("stops reads after cancellation and closes an owned remote source", async () => {
        const controller = new AbortController();
        const remote = createSource({
            ids: ["expected:/cancel.md"],
            documents: { "expected:/cancel.md": metadata("expected:/cancel.md", "/cancel.md") },
            onBeforeYield: () => controller.abort(),
        });
        const close = vi.fn(async () => {});
        const local = createSource();
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                signal: controller.signal,
                remote: async () => ({ ...remote.source, close }),
            })
        );

        expect(result.status).toBe("cancelled");
        expect(remote.get).not.toHaveBeenCalled();
        expect(remote.info).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
        expect(local.info).toHaveBeenCalledTimes(1);
    });

    it("marks sequence and configuration changes as partial", async () => {
        const id = "expected:/stable.md";
        const localSeqs = [1, 2];
        const local = createSource({
            ids: [id],
            documents: { [id]: metadata(id, "/stable.md") },
            info: async () => ({ update_seq: localSeqs.shift() }),
        });
        const remote = createSource({ ids: [id], documents: { [id]: metadata(id, "/stable.md") } });
        const changedConfiguration = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, {
                remote: async () => ({ ...remote.source, close: async () => {} }),
                isConfigurationCurrent: changedConfiguration,
            })
        );

        expect(result.status).toBe("partial");
        expect(result.coverage.local.changedDuringRun).toBe(true);
        expect(result.errors).toContainEqual({ source: "local", reason: "source-changed" });
        expect(result.errors).toContainEqual({ source: "configuration", reason: "configuration-changed" });
    });

    it("marks unavailable update sequences as partial", async () => {
        const local = createSource({ info: async () => ({}) });
        const remote = createSource({ info: async () => ({}) });
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, { remote: async () => ({ ...remote.source, close: async () => {} }) })
        );

        expect(result.status).toBe("partial");
        expect(result.coverage.local.status).toBe("partial");
        expect(result.coverage.remote.status).toBe("partial");
        expect(result.errors.filter((error) => error.reason === "source-unavailable")).toHaveLength(4);
    });

    it("reports supported Metadata types with missing fields as invalid instead of excluded", async () => {
        const malformed = {
            _id: "malformed-children",
            _rev: "1-rev",
            type: EntryTypes.NOTE_PLAIN,
            path: "/no-children.md",
        } as unknown as EntryDoc;
        const missingRevision = {
            _id: "malformed-revision",
            type: EntryTypes.NOTE_BINARY,
            path: "/no-revision.md",
            children: [],
        } as unknown as EntryDoc;
        const local = createSource({
            ids: ["malformed-children", "malformed-revision"],
            documents: { "malformed-children": malformed, "malformed-revision": missingRevision },
        });
        const result = await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));

        expect(result.coverage.local.excluded).toBe(0);
        expect(result.errors).toContainEqual({
            source: "local",
            reason: "invalid-metadata",
            id: "malformed-children",
            revision: "1-rev",
        });
        expect(result.errors).toContainEqual({ source: "local", reason: "invalid-metadata", id: "malformed-revision" });
    });

    it("preserves fixed DiagnosticReadError reasons for Metadata and Chunk reads", async () => {
        const unreadableMetadata = createSource({
            ids: ["metadata-error"],
            getError: () => new DiagnosticReadError("security-seed-unavailable"),
        });
        const metadataResult = await analyseDatabaseIntegrity(
            makeOptions(unreadableMetadata.source, { remote: undefined })
        );
        const id = "wrong-content-id";
        const unreadableChunk = createSource({
            ids: [id],
            documents: { [id]: metadata(id, "/chunk-error.md", { children: ["h:seed-error"] }) },
            getError: (readId) =>
                readId === "h:seed-error" ? new DiagnosticReadError("security-seed-unavailable") : undefined,
        });
        const chunkResult = await analyseDatabaseIntegrity(makeOptions(unreadableChunk.source, { remote: undefined }));

        expect(metadataResult.errors).toContainEqual({
            source: "local",
            reason: "security-seed-unavailable",
            id: "metadata-error",
        });
        expect(chunkResult.errors).toContainEqual({
            source: "local",
            reason: "security-seed-unavailable",
            id,
            revision: "1-rev",
            path: "/chunk-error.md",
            chunkId: "h:seed-error",
        });
    });

    it("marks unsupported content as a partial inspection with a typed error", async () => {
        const id = "expected:/unsupported.bin";
        const local = createSource({
            ids: [id],
            documents: { [id]: metadata(id, "/unsupported.bin", { type: EntryTypes.NOTE_BINARY }) },
        });
        const remote = createSource();
        const readArrayBuffer = vi
            .spyOn(Blob.prototype, "arrayBuffer")
            .mockRejectedValue(new Error("secret conversion error"));
        try {
            const result = await analyseDatabaseIntegrity(
                makeOptions(local.source, { remote: async () => ({ ...remote.source, close: async () => {} }) })
            );

            expect(result.status).toBe("partial");
            expect(result.errors).toContainEqual({
                source: "local",
                reason: "unsupported-content",
                id,
                revision: "1-rev",
                path: "/unsupported.bin",
            });
            expect(JSON.stringify(result)).not.toContain("secret conversion error");
        } finally {
            readArrayBuffer.mockRestore();
        }
    });

    it("uses linear path-equivalence passes for many distinct observations", async () => {
        const count = 80;
        const paths = Array.from({ length: count }, (_, index) => `/unique-${index}.md`);
        const documents = Object.fromEntries(
            paths.map((path) => {
                const id = `expected:${path}`;
                return [id, metadata(id, path)];
            })
        );
        const local = createSource({ ids: Object.keys(documents), documents });
        const lowerSpy = vi.spyOn(String.prototype, "toLowerCase");
        const normalizeSpy = vi.spyOn(String.prototype, "normalize");
        let lowerCalls = 0;
        let normalizeCalls = 0;
        try {
            await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));
        } finally {
            lowerCalls = lowerSpy.mock.calls.length;
            normalizeCalls = normalizeSpy.mock.calls.length;
            lowerSpy.mockRestore();
            normalizeSpy.mockRestore();
        }

        expect(lowerCalls).toBeLessThan(count * 10);
        expect(normalizeCalls).toBeLessThan(count * 10);
    });

    it("resolves group comparison references without repeated linear searches", async () => {
        const id = "expected:/large-conflict.md";
        const revisions = Object.fromEntries(
            Array.from({ length: 24 }, (_, index) => {
                const revision = `${index + 1}-conflict${index}`;
                return [revision, metadata(id, "/large-conflict.md", { rev: revision })];
            })
        );
        const conflictRevisions = Object.keys(revisions);
        const local = createSource({
            ids: [id],
            documents: { [id]: metadata(id, "/large-conflict.md", { rev: "25-winner", conflicts: conflictRevisions }) },
            revisions: { [id]: revisions },
        });
        const originalFind = Array.prototype.find;
        const findSpy = vi.spyOn(Array.prototype, "find");
        let findPredicateVisits = 0;
        findSpy.mockImplementation(function (predicate, thisArg) {
            return originalFind.call(
                this,
                (value, index, array) => {
                    findPredicateVisits++;
                    return predicate.call(thisArg, value, index, array);
                },
                thisArg
            );
        });
        try {
            await analyseDatabaseIntegrity(makeOptions(local.source, { remote: undefined }));
        } finally {
            findSpy.mockRestore();
        }

        expect(findPredicateVisits).toBeLessThan(24 * 24 * 2);
    });

    it("excludes Chunk, system, legacy, and nonnormal namespace documents", async () => {
        const ids = [
            "h:chunk",
            VERSIONING_DOCID,
            MILESTONE_DOCID,
            NODEINFO_DOCID,
            SYNCINFO_ID,
            DOCID_SYNC_PARAMETERS,
            "_local/other-system",
            "_design/chunks",
            "legacy",
            "missing-type",
            "i:internal.md",
        ];
        const local = createSource({
            ids,
            documents: {
                legacy: metadata("legacy", "/legacy.md", { type: EntryTypes.NOTE_LEGACY }),
                "missing-type": { ...metadata("missing-type", "/missing.md"), type: undefined } as unknown as EntryDoc,
                "i:internal.md": metadata("i:internal.md", "i:internal.md"),
            },
        });
        const remote = createSource();
        const result = await analyseDatabaseIntegrity(
            makeOptions(local.source, { remote: async () => ({ ...remote.source, close: async () => {} }) })
        );

        expect(local.get).toHaveBeenCalledTimes(3);
        expect(local.get).not.toHaveBeenCalledWith("h:chunk", expect.anything());
        expect(local.get).not.toHaveBeenCalledWith(VERSIONING_DOCID, expect.anything());
        expect(local.get).not.toHaveBeenCalledWith("_design/chunks", expect.anything());
        expect(result.observations).toEqual([]);
        expect(result.coverage.local.excluded).toBe(ids.length);
        expect(result.status).toBe("complete");
    });
});
