import { describe, expect, it } from "vitest";
import { JournalReceiveFailure, isJournalReceiveFailure } from "./JournalReceiveFailure.ts";

describe("isJournalReceiveFailure", () => {
    it("narrows a failure with its original Journal key and stage", () => {
        const error: unknown = new JournalReceiveFailure("metadata-write", "001.jsonl.gz");
        expect(isJournalReceiveFailure(error)).toBe(true);
        if (!isJournalReceiveFailure(error)) throw new Error("Expected a Journal receive failure");
        expect(error.stage).toBe("metadata-write");
        expect(error.key).toBe("001.jsonl.gz");
    });

    it("recognises derived failures without requiring callers to know the subclass", () => {
        class DerivedFailure extends JournalReceiveFailure {}
        expect(isJournalReceiveFailure(new DerivedFailure("parse"))).toBe(true);
    });

    it.each([
        undefined,
        null,
        "Journal receive failed at parse",
        new Error("Journal receive failed at parse"),
        { stage: "parse", key: "001.jsonl.gz" },
        new Error("wrapped", { cause: new JournalReceiveFailure("parse") }),
    ])("does not treat another value as a failure snapshot: %s", (error) => {
        expect(isJournalReceiveFailure(error)).toBe(false);
    });
});
