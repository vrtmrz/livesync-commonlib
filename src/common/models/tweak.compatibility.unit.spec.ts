import { describe, expect, it } from "vitest";
import {
    CompatibleButLossyChanges,
    IncompatibleChanges,
    IncompatibleChangesInSpecificPattern,
    TweakValuesDefault,
    TweakValuesShouldMatchedTemplate,
    TweakValuesTemplate,
    type TweakValues,
} from "./tweak.definition.ts";
import { assessTweakCompatibility } from "./tweak.compatibility.ts";
import { path2id_base } from "@lib/string_and_binary/path.ts";
import type { FilePath } from "./db.type.ts";

describe("assessTweakCompatibility", () => {
    it.each([
        {
            current: { handleFilenameCaseSensitive: false },
            preferred: {},
            alignment: "matched",
            relation: "equal",
            currentChanges: {},
            preferredChanges: { handleFilenameCaseSensitive: false },
        },
        {
            current: { handleFilenameCaseSensitive: true },
            preferred: {},
            alignment: "mismatched",
            relation: "different",
            currentChanges: { handleFilenameCaseSensitive: false },
            preferredChanges: { handleFilenameCaseSensitive: true },
        },
        {
            current: { handleFilenameCaseSensitive: true },
            preferred: { handleFilenameCaseSensitive: false },
            alignment: "mismatched",
            relation: "different",
            currentChanges: { handleFilenameCaseSensitive: false },
            preferredChanges: { handleFilenameCaseSensitive: true },
        },
    ] as const)(
        "uses the established false default for filename-case compatibility ($alignment)",
        ({ current, preferred, alignment, relation, currentChanges, preferredChanges }) => {
            const assessment = assessTweakCompatibility(current, preferred);
            const entry = assessment.entries.find(({ key }) => key === "handleFilenameCaseSensitive");

            expect(assessment.alignment).toBe(alignment);
            expect(assessment.representationDiffers).toBe(true);
            expect(entry).toMatchObject({ relation });
            expect(assessment.adoptPreferred.changes).toEqual(currentChanges);
            expect(assessment.adoptCurrent.changes).toEqual(preferredChanges);
        }
    );

    it("keeps a missing value without a proven default unadvertised", () => {
        const assessment = assessTweakCompatibility({ customChunkSize: 0 }, {});
        const entry = assessment.entries.find(({ key }) => key === "customChunkSize");

        expect(assessment.alignment).toBe("matched");
        expect(entry).toMatchObject({
            relation: "unadvertised",
            current: { present: true, rawValue: 0, effectiveValue: 0 },
            preferred: { present: false, rawValue: undefined, effectiveValue: undefined },
        });
        expect(assessment.adoptPreferred.changes).toEqual({});
        expect(assessment.adoptCurrent).toEqual({
            changes: { customChunkSize: 0 },
            reconstruction: "recommended",
            reasons: [{ key: "customChunkSize", reconstruction: "recommended" }],
        });
        expect(assessment.onlyCompatibleLossyDifferences).toBe(false);
    });

    it("preserves explicit false, zero, and empty-string values", () => {
        const assessment = assessTweakCompatibility(
            { enableCompression: false, customChunkSize: 0, hashAlg: "" },
            { enableCompression: true, customChunkSize: 10, hashAlg: "xxhash64" }
        );

        expect(
            assessment.entries
                .filter(({ key }) => ["enableCompression", "customChunkSize", "hashAlg"].includes(key))
                .map(({ key, current, relation }) => [key, current.rawValue, current.effectiveValue, relation])
        ).toEqual([
            ["enableCompression", false, false, "different"],
            ["customChunkSize", 0, 0, "different"],
            ["hashAlg", "", "", "different"],
        ]);
    });

    it("preserves the established enum and boolean defaults", () => {
        const assessment = assessTweakCompatibility({}, {
            usePluginSyncV2: TweakValuesDefault.usePluginSyncV2,
            E2EEAlgorithm: TweakValuesDefault.E2EEAlgorithm,
            chunkSplitterVersion: TweakValuesDefault.chunkSplitterVersion,
        });

        for (const key of ["usePluginSyncV2", "E2EEAlgorithm", "chunkSplitterVersion"] as const) {
            expect(assessment.entries.find((entry) => entry.key === key)).toMatchObject({
                current: { present: false, rawValue: undefined, effectiveValue: TweakValuesDefault[key] },
                preferred: {
                    present: true,
                    rawValue: TweakValuesDefault[key],
                    effectiveValue: TweakValuesDefault[key],
                },
                relation: "equal",
            });
        }
    });

    it("agrees with document-ID case handling for an uppercase path", async () => {
        const path = "Folder/Calculus.md" as FilePath;
        const lowerPath = "folder/calculus.md" as FilePath;
        const assessment = assessTweakCompatibility({ handleFilenameCaseSensitive: true }, {});
        const caseEntry = assessment.entries.find(({ key }) => key === "handleFilenameCaseSensitive");
        const currentCaseSensitive = caseEntry?.current.effectiveValue === true;
        const preferredCaseSensitive = caseEntry?.preferred.effectiveValue === true;

        const currentId = await path2id_base(path, false, !currentCaseSensitive);
        const currentLowerId = await path2id_base(lowerPath, false, !currentCaseSensitive);
        const preferredId = await path2id_base(path, false, !preferredCaseSensitive);
        const preferredLowerId = await path2id_base(lowerPath, false, !preferredCaseSensitive);

        expect(caseEntry?.relation).toBe("different");
        expect(currentId).not.toBe(currentLowerId);
        expect(preferredId).toBe(preferredLowerId);
    });

    it("qualifies only fully assessed differences from the legacy compatible-lossy set", () => {
        const current = { ...TweakValuesShouldMatchedTemplate, customChunkSize: 0 };
        const preferred = { ...TweakValuesShouldMatchedTemplate, customChunkSize: 60 };
        const assessment = assessTweakCompatibility(current, preferred);

        expect(assessment.onlyCompatibleLossyDifferences).toBe(true);
        expect(assessment.adoptPreferred).toMatchObject({
            changes: { customChunkSize: 60 },
            reconstruction: "recommended",
        });

        const mixed = assessTweakCompatibility(current, { ...preferred, usePluginSyncV2: true });
        expect(mixed.onlyCompatibleLossyDifferences).toBe(false);
    });

    it("returns immutable, whitelisted snapshots without mutating the inputs", () => {
        const current = {
            handleFilenameCaseSensitive: undefined,
            customChunkSize: 0,
            passphrase: "secret",
            unknown: "value",
        } as TweakValues & Record<string, unknown>;
        const preferred = { handleFilenameCaseSensitive: false } satisfies TweakValues;
        const currentBefore = { ...current };
        const assessment = assessTweakCompatibility(current, preferred);
        const caseEntry = assessment.entries.find(({ key }) => key === "handleFilenameCaseSensitive");

        expect(current).toEqual(currentBefore);
        expect(assessment.currentValues).toEqual({
            customChunkSize: 0,
            handleFilenameCaseSensitive: undefined,
        });
        expect(assessment.currentValues).not.toHaveProperty("passphrase");
        expect(assessment.currentValues).not.toHaveProperty("unknown");
        expect(caseEntry).toMatchObject({
            current: { present: true, rawValue: undefined, effectiveValue: false },
            preferred: { present: true, rawValue: false, effectiveValue: false },
            relation: "equal",
        });
        expect(Object.isFrozen(assessment)).toBe(true);
        expect(Object.isFrozen(assessment.entries)).toBe(true);
        expect(Object.isFrozen(caseEntry)).toBe(true);
        expect(Object.isFrozen(caseEntry?.current)).toBe(true);
        expect(Object.isFrozen(assessment.currentValues)).toBe(true);
        expect(Object.isFrozen(assessment.adoptPreferred)).toBe(true);
        expect(Object.isFrozen(assessment.adoptPreferred.changes)).toBe(true);
        expect(Object.isFrozen(assessment.adoptPreferred.reasons)).toBe(true);
    });
});

describe("legacy tweak compatibility projections", () => {
    it("preserves the public compatibility values, key order, and classifications", () => {
        expect(TweakValuesShouldMatchedTemplate).toEqual({
            minimumChunkSize: 20,
            longLineThreshold: 250,
            encrypt: false,
            usePathObfuscation: false,
            enableCompression: false,
            useEden: false,
            customChunkSize: 0,
            useDynamicIterationCount: false,
            hashAlg: "xxhash64",
            enableChunkSplitterV2: false,
            maxChunksInEden: 10,
            maxTotalLengthInEden: 1024,
            maxAgeInEden: 10,
            usePluginSyncV2: false,
            handleFilenameCaseSensitive: false,
            useSegmenter: false,
            E2EEAlgorithm: "v2",
            chunkSplitterVersion: "v3-rabin-karp",
        });
        expect(IncompatibleChanges).toEqual([
            "encrypt",
            "usePathObfuscation",
            "useDynamicIterationCount",
            "handleFilenameCaseSensitive",
        ]);
        expect(CompatibleButLossyChanges).toEqual(["hashAlg", "customChunkSize", "chunkSplitterVersion"]);
        expect(IncompatibleChangesInSpecificPattern).toEqual([]);
        expect(TweakValuesDefault).toEqual({
            usePluginSyncV2: false,
            E2EEAlgorithm: "v2",
            chunkSplitterVersion: "v3-rabin-karp",
            tweakModified: undefined,
        });
        expect(Object.keys(TweakValuesTemplate)).toContain("handleFilenameCaseSensitive");
    });
});
