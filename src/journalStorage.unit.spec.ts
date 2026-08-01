import { describe, expect, it } from "vitest";

import { isJournalStorageConnectionInspector } from "./journalStorage.ts";

describe("journal-storage host inspection boundary", () => {
    it("recognises only structural Journal connection inspectors", () => {
        expect(
            isJournalStorageConnectionInspector({
                inspectJournalStorageConnection: async () => ({ available: true }),
            })
        ).toBe(true);
        expect(isJournalStorageConnectionInspector({ inspectJournalStorageConnection: true })).toBe(false);
        expect(isJournalStorageConnectionInspector(undefined)).toBe(false);
    });
});
