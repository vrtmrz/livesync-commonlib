import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, DEVICE_ID_PREFERRED, type EntryMilestoneInfo } from "@lib/common/types.ts";
import {
    hasJournalNodeDeclarations,
    inspectJournalPathIdentity,
    journalVersionRange,
    matchesJournalPathIdentity,
    pathIdentityFromJournalRange,
} from "./journalCompatibility.ts";

function milestone(values: Partial<EntryMilestoneInfo>): EntryMilestoneInfo {
    return { _id: "_00000000-milestone.json", type: "milestoneinfo", ...values } as EntryMilestoneInfo;
}
const legacy = { min: 0, max: 2, current: 2 };
const nfc = { min: 4, max: 4, current: 4 };

describe("Journal version range", () => {
    it.each([
        { settings: {}, range: legacy },
        { settings: { pathNormalizationVersion: 1 }, range: nfc },
        {
            settings: {
                idDerivationVersion: 1,
                idDerivationKey: "ab".repeat(32),
                encrypt: true,
                usePathObfuscation: true,
            },
            range: { min: 3, max: 3, current: 3 },
        },
        {
            settings: {
                idDerivationVersion: 1,
                idDerivationKey: "ab".repeat(32),
                encrypt: false,
                usePathObfuscation: true,
            },
            range: legacy,
        },
    ])("uses $range for the configured identity", ({ settings, range }) => {
        expect(journalVersionRange({ ...DEFAULT_SETTINGS, ...settings })).toEqual(range);
    });

    it.each([
        { range: undefined, version: 0 },
        { range: legacy, version: 0 },
        { range: { min: 3, max: 3, current: 3 }, version: 0 },
        { range: nfc, version: 1 },
    ])("interprets the declared range $range", ({ range, version }) => {
        expect(pathIdentityFromJournalRange(range)).toBe(version);
    });

    it.each([
        [-1, 2],
        [0, 2.5],
        [3, 2],
        [0, 4],
        [5, 5],
        [0, Number.MAX_SAFE_INTEGER + 1],
    ])("rejects the unsupported range %s to %s", (min, max) => {
        expect(() => pathIdentityFromJournalRange({ min, max, current: max })).toThrow(
            "unsupported path identity range"
        );
    });
});

describe("Journal path identity declarations", () => {
    it.each([
        { name: "missing milestone", value: undefined, identity: { status: "empty" }, nodes: false },
        {
            name: "accepted Legacy node",
            value: milestone({ accepted_nodes: ["old"] }),
            identity: { status: "configured", pathNormalizationVersion: 0 },
            nodes: true,
        },
        {
            name: "retired NFC node",
            value: milestone({ accepted_nodes: [], node_chunk_info: { retired: nfc } }),
            identity: { status: "configured", pathNormalizationVersion: 1 },
            nodes: true,
        },
        {
            name: "preferred setting without nodes",
            value: milestone({ tweak_values: { [DEVICE_ID_PREFERRED]: { pathNormalizationVersion: 1 } } }),
            identity: { status: "configured", pathNormalizationVersion: 1 },
            nodes: false,
        },
    ])("projects $name without mutating it", ({ value, identity, nodes }) => {
        const before = structuredClone(value);
        expect(inspectJournalPathIdentity(value)).toEqual(identity);
        expect(hasJournalNodeDeclarations(value)).toBe(nodes);
        expect(value).toEqual(before);
    });

    it.each([
        milestone({ accepted_nodes: ["old"], node_chunk_info: { retired: nfc } }),
        milestone({
            node_chunk_info: { old: legacy },
            tweak_values: { [DEVICE_ID_PREFERRED]: { pathNormalizationVersion: 1 } },
        }),
    ])("rejects conflicting declarations", (value) => {
        expect(() => inspectJournalPathIdentity(value)).toThrow("conflicting path identity declarations");
    });

    it.each([
        { version: 0, value: undefined, matches: true },
        { version: 1, value: undefined, matches: true },
        { version: 0, value: milestone({ accepted_nodes: ["old"] }), matches: true },
        { version: 1, value: milestone({ accepted_nodes: ["old"] }), matches: false },
        { version: 0, value: milestone({ accepted_nodes: [], node_chunk_info: { retired: nfc } }), matches: false },
        { version: 1, value: milestone({ node_chunk_info: { current: nfc } }), matches: true },
        {
            version: 1,
            value: milestone({
                node_chunk_info: { current: nfc },
                tweak_values: { [DEVICE_ID_PREFERRED]: { pathNormalizationVersion: 0 } },
            }),
            matches: false,
        },
    ])("compares local identity $version with every declaration", ({ version, value, matches }) => {
        const before = structuredClone(value);
        expect(matchesJournalPathIdentity({ ...DEFAULT_SETTINGS, pathNormalizationVersion: version }, value)).toBe(
            matches
        );
        expect(value).toEqual(before);
    });
});
