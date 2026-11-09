import { describe, expect, it, vi } from "vitest";

import { FLAGMD_REDFLAG, type FilePathWithPrefix } from "@lib/common/types";
import { LOG_LEVEL_INFO, LOG_LEVEL_NOTICE, LOG_LEVEL_VERBOSE } from "octagonal-wheels/common/logger";

import { createFileHandlerFixture, makeFile } from "../../../_tools/fixtures/file-handler-context";
import { createAllChunks } from "./chunks";

describe("createAllChunks", () => {
    // The decision table exercises each admission filter, the progress-level switch, and the ten-permit bound.
    it("stores only selected, size-eligible, non-ignored files", async () => {
        const fixture = createFileHandlerFixture();
        const storeFileToDB = vi.mocked(fixture.host.storeFileToDB);
        const excluded = "excluded.md" as FilePathWithPrefix;
        const tooLarge = "large.md" as FilePathWithPrefix;
        const ignored = FLAGMD_REDFLAG as FilePathWithPrefix;
        const selected = "selected.md" as FilePathWithPrefix;
        fixture.files.set(excluded, makeFile(excluded, "ok"));
        fixture.files.set(tooLarge, makeFile(tooLarge, "content above the fixture size limit"));
        fixture.files.set(ignored, makeFile(ignored, "ok"));
        fixture.files.set(selected, makeFile(selected, "ok"));
        fixture.vault.isTargetFile.mockImplementation(
            async (file) => (typeof file === "string" ? file : file.path) !== excluded
        );
        fixture.vault.isFileSizeTooLarge.mockImplementation((size) => size > 10);

        await createAllChunks(fixture.ctx);

        expect(storeFileToDB.mock.calls.map(([file]) => (typeof file === "string" ? file : file.path))).toEqual([
            selected,
        ]);
        expect(storeFileToDB).toHaveBeenCalledWith(expect.objectContaining({ path: selected }), false, true);
        expect(storeFileToDB).not.toHaveBeenCalledWith(expect.objectContaining({ path: excluded }), false, true);
        expect(storeFileToDB).not.toHaveBeenCalledWith(expect.objectContaining({ path: tooLarge }), false, true);
        expect(storeFileToDB).not.toHaveBeenCalledWith(expect.objectContaining({ path: ignored }), false, true);
    });

    it.each([
        { showingNotice: false, progressLevel: LOG_LEVEL_INFO },
        { showingNotice: true, progressLevel: LOG_LEVEL_NOTICE },
    ])(
        "reports progress and stays within ten permits (notice=$showingNotice)",
        async ({ showingNotice, progressLevel }) => {
            const fixture = createFileHandlerFixture();
            const storeFileToDB = vi.mocked(fixture.host.storeFileToDB);
            for (let index = 0; index < 25; index++) {
                const path = `chunks/${index}.md` as FilePathWithPrefix;
                fixture.files.set(path, makeFile(path, "chunk body"));
            }
            let active = 0;
            let maximumActive = 0;
            storeFileToDB.mockImplementation(async () => {
                active++;
                maximumActive = Math.max(maximumActive, active);
                await new Promise<void>((resolve) => setTimeout(resolve, 0));
                active--;
                return true;
            });

            await createAllChunks(fixture.ctx, showingNotice);

            expect(storeFileToDB).toHaveBeenCalledTimes(25);
            expect(maximumActive).toBe(10);
            expect(fixture.log).toHaveBeenCalledWith(
                "Creating missing chunks: 25 of 25 files",
                progressLevel,
                "chunkCreation"
            );
            expect(fixture.log).toHaveBeenCalledWith(
                "Creating chunks Done: 25 of 25 files",
                progressLevel,
                "chunkCreation"
            );
        }
    );

    it("logs per-file save errors and continues with the other files", async () => {
        const fixture = createFileHandlerFixture();
        const storeFileToDB = vi.mocked(fixture.host.storeFileToDB);
        const first = "first.md" as FilePathWithPrefix;
        const second = "second.md" as FilePathWithPrefix;
        const saveError = new Error("chunk write failed");
        fixture.files.set(first, makeFile(first, "first"));
        fixture.files.set(second, makeFile(second, "second"));
        storeFileToDB.mockRejectedValueOnce(saveError);

        await expect(createAllChunks(fixture.ctx)).resolves.toBeUndefined();

        expect(storeFileToDB).toHaveBeenCalledTimes(2);
        expect(fixture.log).toHaveBeenCalledWith(saveError, LOG_LEVEL_VERBOSE);
    });

    it("propagates a storage-listing error before attempting any file writes", async () => {
        const fixture = createFileHandlerFixture();
        const storeFileToDB = vi.mocked(fixture.host.storeFileToDB);
        const listingError = new Error("storage listing failed");
        fixture.storage.getFiles.mockRejectedValueOnce(listingError);

        await expect(createAllChunks(fixture.ctx)).rejects.toBe(listingError);

        expect(storeFileToDB).not.toHaveBeenCalled();
    });
});
