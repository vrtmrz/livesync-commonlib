import { ContentReadError } from "@lib/common/LSError.ts";
import { describe, expect, it } from "vitest";

import {
    DEFAULT_SETTINGS,
    EntryTypes,
    type DocumentID,
    type FileEventItem,
    type FilePathWithPrefix,
    type LoadedEntry,
    type MetaEntry,
} from "@lib/common/types";

import {
    createFileHandlerFixture,
    makeFile,
    makeFileStub,
    makeMetaEntry,
} from "../../../_tools/fixtures/file-handler-context";
import { processFileEvent } from "./events";
import { storeFileToDBFromRevision, storeFileToDBWithBaseRevision } from "./saving";

const filePath = "notes/saving.md" as FilePathWithPrefix;

/** Build a decoded Metadata revision for database-boundary responses. */
function makeLoadedEntry(path: FilePathWithPrefix, revision: string, data: string): LoadedEntry & MetaEntry {
    return {
        ...makeMetaEntry(path, revision),
        data,
        datatype: EntryTypes.NOTE_PLAIN,
    };
}

describe("ServiceFileHandlerBase saving operations", () => {
    it("creates a root revision when storage has no current Metadata entry", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new local file\n");
        fixture.files.set(filePath, file);

        await expect(storeFileToDBFromRevision(fixture.ctx, file)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, undefined, true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-stored");
    });

    it("refuses missing and internal observations before any database write", async () => {
        const fixture = createFileHandlerFixture();
        const missingResult = await storeFileToDBFromRevision(fixture.ctx, filePath);
        const internal = { ...makeFileStub(filePath), isInternal: true };
        const internalResult = await storeFileToDBFromRevision(fixture.ctx, internal);
        const missingBaseResult = await storeFileToDBWithBaseRevision(fixture.ctx, filePath, "2-base");
        const internalBaseResult = await storeFileToDBWithBaseRevision(fixture.ctx, internal, "2-base");

        expect(missingResult).toBe(false);
        expect(internalResult).toBe(false);
        expect(missingBaseResult).toBe(false);
        expect(internalBaseResult).toBe(false);
        expect(fixture.storage.getFileStub).toHaveBeenCalledTimes(2);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
    });

    it("refuses an explicit base which is no longer a live leaf", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "local edit\n");
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-obsolete") return makeMetaEntry(filePath, "2-obsolete");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-obsolete")).resolves.toBe(false);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledWith(file, "2-obsolete", true);
        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledWith(file, undefined, true);
        expect(fixture.db.getConflictedRevs).toHaveBeenCalledExactlyOnceWith(file);
        expect(fixture.storage.readStubContent).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("stores an edit below the selected live conflict revision, not the winner", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "edit on displayed branch\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "previous displayed bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed")).resolves.toBe(true);

        expect(fixture.db.fetchEntry).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true, true);
        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalledWith(file, "3-winner", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("certifies matching bytes without creating a child when edits are disabled", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "same bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "same bytes\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed", false)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-displayed");
    });

    it("refuses differing bytes when the selected-base operation cannot create a child", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "old bytes\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed", false)).resolves.toBe(false);

        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("returns false when the selected live branch refuses a changed body", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "new branch content\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockResolvedValue(makeLoadedEntry(filePath, "2-displayed", "old branch content\n"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);
        fixture.db.storeWithBaseRevision.mockResolvedValue(false);

        await expect(storeFileToDBWithBaseRevision(fixture.ctx, file, "2-displayed")).resolves.toBe(false);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("recognises unchanged bytes on a uniquely reconstructed displayed conflict branch", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "displayed branch bytes\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "displayed branch bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-deleted-winner", { deleted: true });
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.findContentRevisions.mockResolvedValue(["2-displayed"]);
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file)).resolves.toBe(true);

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.db.fetchEntry).toHaveBeenCalledWith(file, "2-displayed", true, true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-displayed");
        expect(fixture.log).toHaveBeenCalledWith(
            expect.stringContaining("is not changed on its displayed conflict branch"),
            expect.any(Number)
        );
    });

    it("preserves unknown conflicted bytes as a sibling and clears stale rename-source provenance", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unknown branch bytes\n");
        const sourcePath = "notes/source.md" as FilePathWithPrefix;
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(sourcePath, {
            revision: "1-pruned-source",
            contentHash: `sha256:${"a".repeat(64)}`,
            contentSize: 0,
        });
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "1-pruned-source") return false;
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true, false, sourcePath)).resolves.toBe(true);

        expect(fixture.db.findContentRevisions).toHaveBeenCalledExactlyOnceWith(file, file.body);
        expect(fixture.db.storeAsConflictedRevisionWithResult).toHaveBeenCalledExactlyOnceWith(file, "3-winner", true);
        expect(fixture.provenance.delete).toHaveBeenCalledExactlyOnceWith(sourcePath);
        expect(fixture.provenanceRecords.has(sourcePath)).toBe(false);
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-conflicted");
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("queues conflict review when a sibling-preservation write is refused", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unknown branch bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockResolvedValue(makeMetaEntry(filePath, "3-winner"));
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);
        fixture.db.storeAsConflictedRevisionWithResult.mockResolvedValue(false);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(false);

        expect(fixture.db.storeAsConflictedRevisionWithResult).toHaveBeenCalledExactlyOnceWith(file, "3-winner", true);
        expect(fixture.provenance.set).not.toHaveBeenCalled();
        expect(fixture.provenance.delete).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("saves a forced displayed-branch child even when provenance publication fails", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "current storage bytes\n");
        const displayed = makeLoadedEntry(filePath, "2-displayed", "current storage bytes\n");
        fixture.files.set(filePath, file);
        fixture.provenanceRecords.set(filePath, { revision: "2-displayed", observedStorageMtime: file.stat.mtime });
        fixture.provenance.set.mockRejectedValue(new Error("provenance store unavailable"));
        fixture.db.fetchEntryMeta.mockImplementation(async (_file, revision) => {
            if (revision === "2-displayed") return makeMetaEntry(filePath, "2-displayed");
            if (revision === undefined) return makeMetaEntry(filePath, "3-winner");
            return false;
        });
        fixture.db.fetchEntry.mockImplementation(async (_file, revision) =>
            revision === "2-displayed" ? displayed : false
        );
        fixture.db.getConflictedRevs.mockResolvedValue(["2-displayed"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(file, "2-displayed", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.log).toHaveBeenCalledWith(
            expect.stringContaining("Could not record file reflection provenance"),
            expect.any(Number)
        );
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("refuses unknown branch preservation if the current revision disappears before the save", async () => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "untracked conflict bytes\n");
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta
            .mockResolvedValueOnce(makeMetaEntry(filePath, "3-winner"))
            .mockResolvedValueOnce(false);
        fixture.db.getConflictedRevs.mockResolvedValue(["2-other"]);

        await expect(storeFileToDBFromRevision(fixture.ctx, file, true)).resolves.toBe(false);

        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledTimes(2);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(1, file, undefined, true);
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(2, file, undefined, true);
        expect(fixture.db.storeAsConflictedRevisionWithResult).not.toHaveBeenCalled();
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });
});

describe("ordinary save content fallback", () => {
    it.each([true, false])("preserves independently after failed content classification (stored=%s)", async (stored) => {
        const fixture = createFileHandlerFixture();
        const file = makeFile(filePath, "unique local edits");
        const entry = makeMetaEntry(filePath, "3-current");
        const error = new ContentReadError({ documentId: entry._id, revision: entry._rev, resources: ["local-database"], cause: new Error("classification read failed") });
        fixture.files.set(filePath, file);
        fixture.db.fetchEntryMeta.mockResolvedValue(entry);
        fixture.db.findLiveContentRevisions.mockRejectedValue(error);
        fixture.db.storeIndependentRevision.mockResolvedValue(stored ? "1-preserved" : false);
        const result = storeFileToDBFromRevision(fixture.ctx, file);
        if (stored) {
            await expect(result).resolves.toBe(true);
        } else {
            await expect(result).rejects.toBe(error);
        }
        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledOnce();
        expect(fixture.storage.writeFileAuto).not.toHaveBeenCalled();
    });
});

describe("ordinary filename-case saves", () => {
    const alternateSpelling = "notes/Saving.md" as FilePathWithPrefix;

    function makeStoredEntry(path: FilePathWithPrefix, revision: string, body: string) {
        return { ...makeLoadedEntry(path, revision, body), storedPath: path };
    }

    function setup(localBytes: string, databasePath: FilePathWithPrefix | null = alternateSpelling) {
        const fixture = createFileHandlerFixture();
        fixture.setting.currentSettings.mockImplementation(() => ({
            ...DEFAULT_SETTINGS,
            handleFilenameCaseSensitive: false,
        }));
        fixture.path.path2id.mockImplementation(async (path) => String(path).toLowerCase() as DocumentID);
        const file = makeFile(filePath, localBytes);
        const current = databasePath
            ? makeStoredEntry(databasePath, "2-current", "same bytes")
            : makeLoadedEntry(filePath, "2-current", "");
        current._id = String(filePath) as DocumentID;
        const leaves = new Map<string | undefined, LoadedEntry & MetaEntry>([[undefined, current], ["2-current", current]]);
        fixture.files.set(filePath, file);
        const readEntry = (
            input: Parameters<typeof fixture.db.fetchEntryMeta>[0],
            revision: string | undefined,
            pathSource: "stored" | undefined
        ): (LoadedEntry & MetaEntry) | false => {
            const leaf = leaves.get(revision);
            if (!leaf) {
                return false;
            }
            if (pathSource === "stored" && leaf.storedPath) {
                return leaf;
            }
            const { storedPath: _storedPath, ...entry } = leaf;
            return { ...entry, path: typeof input === "string" ? input : input.path };
        };
        fixture.db.fetchEntry.mockImplementation(async (input, revision, _wait, _skip, _local, pathSource) =>
            readEntry(input, revision, pathSource)
        );
        fixture.db.fetchEntryMeta.mockImplementation(async (input, revision, _skip, pathSource) =>
            readEntry(input, revision, pathSource)
        );
        fixture.db.findLiveContentRevisions.mockResolvedValue(localBytes === "same bytes" ? ["2-current"] : []);
        const process = (type: FileEventItem["type"] = "CHANGED") =>
            processFileEvent(fixture.ctx, { type, key: filePath, args: { file } });
        return { ...fixture, file, leaves, process };
    }

    it.each([
        ["CREATE", "same bytes"],
        ["CHANGED", "local bytes"],
    ] as const)("preserves the filename and body on an untracked %s", async (type, localBytes) => {
        const fixture = setup(localBytes);

        await expect(fixture.process(type)).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-independent");
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
        expect(fixture.storage.renameFile).not.toHaveBeenCalled();
        expect(fixture.storage.writeFileAuto).not.toHaveBeenCalled();
    });

    it("disregards legacy provenance contradicted by the stored filename", async () => {
        const fixture = setup("same bytes");
        fixture.provenanceRecords.set(filePath, { revision: "2-current" });

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, true);
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-independent");
    });

    it("does not infer the local spelling from a legacy revision without a stored path", async () => {
        const fixture = setup("legacy bytes");
        const legacyRevision = "1-legacy";
        const readMetadata = fixture.db.fetchEntryMeta.getMockImplementation();
        fixture.db.fetchEntryMeta.mockImplementation(async (input, revision, skip, pathSource) => {
            if (revision !== legacyRevision) {
                return (await readMetadata?.(input, revision, skip, pathSource)) ?? false;
            }
            // The metadata boundary projects the lookup spelling for an old record without a path.
            return makeMetaEntry(typeof input === "string" ? input : input.path, legacyRevision);
        });
        fixture.leaves.set(legacyRevision, makeLoadedEntry(filePath, legacyRevision, "legacy bytes"));
        fixture.provenanceRecords.set(filePath, { revision: legacyRevision });
        fixture.db.getConflictedRevs.mockResolvedValue(["3-other"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue([legacyRevision]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, true);
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-independent");
    });

    it("deduplicates a previously preserved same-spelling leaf when other matches have a different spelling", async () => {
        const fixture = setup("same bytes");
        fixture.leaves.set("1-preserved", makeStoredEntry(filePath, "1-preserved", "same bytes"));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-preserved"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(["2-current", "1-preserved"]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-preserved");
    });

    it("stores a known edit below its recorded same-spelling base", async () => {
        const fixture = setup("edited bytes");
        fixture.leaves.set("1-displayed", makeStoredEntry(filePath, "1-displayed", "old local bytes"));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-displayed"]);
        fixture.provenanceRecords.set(filePath, { revision: "1-displayed" });

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, "1-displayed", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
    });

    it("retries a filename save after the body changes before preservation", async () => {
        const fixture = setup("same bytes");
        const changed = makeFile(filePath, "edited before preservation");
        fixture.db.getConflictedRevs.mockImplementationOnce(async () => {
            fixture.files.set(filePath, changed);
            return [];
        });

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(changed, true);
        expect(fixture.provenanceRecords.get(filePath)?.contentSize).toBe(changed.body.size);
    });

    it("preserves a durable branch and retries when the file changes during the write", async () => {
        const fixture = setup("same bytes");
        const changed = makeFile(filePath, "edited during preservation");
        fixture.db.storeIndependentRevision.mockImplementationOnce(async () => {
            fixture.files.set(filePath, changed);
            fixture.db.getConflictedRevs.mockResolvedValue(["1-first"]);
            fixture.db.findLiveContentRevisions.mockResolvedValue([]);
            return "1-first";
        });

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenNthCalledWith(1, fixture.file, true);
        expect(fixture.db.storeIndependentRevision).toHaveBeenNthCalledWith(2, changed, true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).toHaveBeenCalledExactlyOnceWith(filePath, expect.objectContaining({
            revision: "1-independent",
            contentSize: changed.body.size,
        }));
    });

    it.each([
        ["one differently spelled leaf", ["1-first"]],
        ["several differently spelled leaves", ["1-first", "1-second"]],
    ] as const)("preserves the local spelling when only %s match the bytes", async (_scenario, matchingRevisions) => {
        const localContent = "losing leaf bytes";
        const fixture = setup(localContent, filePath);
        for (const revision of matchingRevisions) {
            fixture.leaves.set(revision, makeStoredEntry(alternateSpelling, revision, localContent));
        }
        fixture.db.getConflictedRevs.mockResolvedValue([...matchingRevisions]);
        fixture.db.findLiveContentRevisions.mockResolvedValue([...matchingRevisions]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, true);
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-independent");
        expect(fixture.db.findLiveContentRevisions).toHaveBeenCalledExactlyOnceWith(fixture.file, fixture.file.body);
    });

    it("reuses the current Metadata when conflicting byte matches already include the local spelling", async () => {
        const localContent = "same bytes";
        const fixture = setup(localContent, filePath);
        fixture.leaves.set("1-other", makeStoredEntry(alternateSpelling, "1-other", localContent));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(["2-current", "1-other"]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("2-current");
        expect(fixture.db.findLiveContentRevisions).toHaveBeenCalledExactlyOnceWith(fixture.file, fixture.file.body);
        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledExactlyOnceWith(filePath, "1-other", true, "stored");
    });

    it.each([
        { localBytes: "", matchingRevisions: ["2-current", "1-other"] },
        { localBytes: "only the named revision matches", matchingRevisions: ["1-other"] },
    ])("preserves a local spelling with a pathless winner and a differently named byte match ($matchingRevisions)", async ({
        localBytes,
        matchingRevisions,
    }) => {
        const fixture = setup(localBytes, null);
        fixture.leaves.set("1-other", makeStoredEntry(alternateSpelling, "1-other", localBytes));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(matchingRevisions);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, true);
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe("1-independent");
    });

    it.each([
        { matchingRevisions: ["2-current"], expectedRevision: "2-current" },
        { matchingRevisions: ["2-current", "1-other"], expectedRevision: undefined },
    ])("keeps byte-only deduplication when matching live revisions are pathless ($matchingRevisions)", async ({
        matchingRevisions,
        expectedRevision,
    }) => {
        const fixture = setup("", null);
        fixture.leaves.set("1-other", makeLoadedEntry(filePath, "1-other", matchingRevisions.length === 1 ? "different bytes" : ""));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(matchingRevisions);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe(expectedRevision);
        expect(fixture.conflict.queueCheckFor).toHaveBeenCalledExactlyOnceWith(filePath);
    });

    it("keeps the displayed base when an edit matches a differently named revision", async () => {
        const fixture = setup("edited bytes", filePath);
        fixture.leaves.set("1-other", makeStoredEntry(alternateSpelling, "1-other", "edited bytes"));
        fixture.db.getConflictedRevs.mockResolvedValue(["1-other"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(["1-other"]);
        fixture.provenanceRecords.set(filePath, { revision: "2-current" });

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeWithBaseRevision).toHaveBeenCalledExactlyOnceWith(fixture.file, "2-current", true);
        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.findLiveContentRevisions).not.toHaveBeenCalled();
    });

    it.each([false, true])("counts only verified spellings when an equal-byte revision is pathless (second spelling %s)", async (
        hasSecondStoredMatch
    ) => {
        const fixture = setup("same bytes", filePath);
        fixture.leaves.set("1-legacy", makeLoadedEntry(filePath, "1-legacy", "same bytes"));
        const conflicts = ["1-legacy"];
        if (hasSecondStoredMatch) {
            fixture.leaves.set("1-modern", makeStoredEntry(filePath, "1-modern", "same bytes"));
            conflicts.push("1-modern");
        }
        fixture.db.getConflictedRevs.mockResolvedValue(conflicts);
        fixture.db.findLiveContentRevisions.mockResolvedValue(["2-current", ...conflicts]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.get(filePath)?.revision).toBe(hasSecondStoredMatch ? undefined : "2-current");
        expect(fixture.db.fetchEntryMeta).toHaveBeenNthCalledWith(1, filePath, "1-legacy", true, "stored");
        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledTimes(conflicts.length);
    });

    it("does not infer provenance when another matching revision's spelling cannot be read", async () => {
        const fixture = setup("", null);
        fixture.db.getConflictedRevs.mockResolvedValue(["1-unavailable"]);
        fixture.db.findLiveContentRevisions.mockResolvedValue(["2-current", "1-unavailable"]);

        await expect(fixture.process()).resolves.toBe(true);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenanceRecords.has(filePath)).toBe(false);
        expect(fixture.db.fetchEntryMeta).toHaveBeenCalledExactlyOnceWith(filePath, "1-unavailable", true, "stored");
    });

    it("refuses a filename alias when the two spellings resolve to different document IDs", async () => {
        const fixture = setup("same bytes");
        fixture.path.path2id.mockImplementation(async (path) => String(path) as DocumentID);

        await expect(fixture.process()).resolves.toBe(false);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
    });

    it("refuses a retry when the current storage file now exceeds the size limit", async () => {
        const fixture = setup("same bytes");
        const largerFile = makeFile(filePath, "now too large to store");
        fixture.vault.isFileSizeTooLarge.mockImplementation((size) => size > fixture.file.body.size);
        fixture.db.getConflictedRevs.mockImplementationOnce(async () => {
            fixture.files.set(filePath, largerFile);
            return [];
        });

        await expect(fixture.process()).resolves.toBe(false);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
    });

    it("refuses a filename alias across differently cased parent directories", async () => {
        const fixture = setup("same bytes", "Notes/Saving.md" as FilePathWithPrefix);

        await expect(fixture.process()).resolves.toBe(false);

        expect(fixture.db.storeIndependentRevision).not.toHaveBeenCalled();
        expect(fixture.db.storeWithBaseRevision).not.toHaveBeenCalled();
        expect(fixture.provenance.set).not.toHaveBeenCalled();
    });
});
