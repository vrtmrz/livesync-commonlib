import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseReleaseSelectionArguments, validateReleaseSelection } from "./validate-release-selection.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";

function validSelection(overrides = {}) {
    const {
        sourceManifest: sourceManifestOverrides = {},
        builtManifest: builtManifestOverrides = {},
        ...selectionOverrides
    } = overrides;
    const version = selectionOverrides.version ?? "0.1.0-rc.0";
    return {
        sourceManifest: {
            name: "@vrtmrz/livesync-commonlib",
            version,
            private: true,
            ...sourceManifestOverrides,
        },
        builtManifest: {
            name: "@vrtmrz/livesync-commonlib",
            version,
            publishConfig: { access: "public", tag: "next" },
            ...builtManifestOverrides,
        },
        version,
        expectedSha: sha,
        actualSha: sha,
        workflowSha: sha,
        sourceRef: "refs/heads/main",
        confirmation: `stage @vrtmrz/livesync-commonlib@${version} from ${sha}`,
        ...selectionOverrides,
    };
}

describe("release selection", () => {
    it("accepts an exact reviewed prerelease from main", () => {
        assert.doesNotThrow(() => validateReleaseSelection(validSelection()));
    });

    it("accepts a stable version from main while retaining the next publication gate", () => {
        assert.doesNotThrow(() => validateReleaseSelection(validSelection({ version: "0.1.0" })));
    });

    it("accepts an exact reviewed prerelease from a branch when the trusted workflow commit differs", () => {
        assert.doesNotThrow(() =>
            validateReleaseSelection(
                validSelection({
                    workflowSha: "f".repeat(40),
                    sourceRef: "refs/heads/release/commonlib-0.1.0-rc.0",
                })
            )
        );
    });

    it("accepts an exact reviewed prerelease from the legacy trusted workflow invocation", () => {
        assert.doesNotThrow(() =>
            validateReleaseSelection(
                validSelection({
                    workflowSha: undefined,
                    sourceRef: "refs/heads/release/commonlib-0.1.0-rc.0",
                })
            )
        );
    });

    it("rejects a stable release selected from a non-main branch", () => {
        assert.throws(
            () =>
                validateReleaseSelection(
                    validSelection({
                        version: "0.1.0",
                        sourceRef: "refs/heads/release/commonlib-0.1.0",
                    })
                ),
            /Stable releases must be selected from refs\/heads\/main/u
        );
    });

    it("rejects a stable release without the trusted workflow commit", () => {
        assert.throws(
            () => validateReleaseSelection(validSelection({ version: "0.1.0", workflowSha: undefined })),
            /Stable releases require the trusted workflow commit/u
        );
    });

    it("rejects a stable release from a different workflow commit", () => {
        assert.throws(
            () => validateReleaseSelection(validSelection({ version: "0.1.0", workflowSha: "f".repeat(40) })),
            /workflow was triggered/u
        );
    });

    it("rejects a prerelease selected by tag", () => {
        assert.throws(
            () => validateReleaseSelection(validSelection({ sourceRef: "refs/tags/0.1.0-rc.0" })),
            /release source must be selected from a branch ref/u
        );
    });

    for (const [name, overrides, message] of [
        ["package proof", { version: "0.1.0-package-proof.8" }, /Package-proof versions/u],
        ["short commit", { expectedSha: "0123456" }, /full lowercase SHA/u],
        ["different commit", { actualSha: "f".repeat(40) }, /workflow is running/u],
        ["short workflow commit", { workflowSha: "0123456" }, /workflow commit must be a full lowercase SHA/u],
        ["source version mismatch", { sourceManifest: { version: "0.1.1", private: true } }, /Source manifest/u],
        ["public source root", { sourceManifest: { private: false } }, /source repository manifest/u],
        ["private output", { builtManifest: { private: true } }, /built package is marked private/u],
        ["latest default", { builtManifest: { publishConfig: { access: "public", tag: "latest" } } }, /next dist-tag/u],
        ["incorrect confirmation", { confirmation: "stage something else" }, /Confirmation must be/u],
    ]) {
        it(`rejects ${name}`, () => {
            assert.throws(() => validateReleaseSelection(validSelection(overrides)), message);
        });
    }
});

describe("release selection arguments", () => {
    it("parses the current six-argument workflow invocation", () => {
        assert.deepEqual(
            parseReleaseSelectionArguments([
                "0.1.0-rc.14",
                sha,
                sha,
                "f".repeat(40),
                "refs/heads/separate-setting-lifecycle",
                `stage @vrtmrz/livesync-commonlib@0.1.0-rc.14 from ${sha}`,
            ]),
            {
                version: "0.1.0-rc.14",
                expectedSha: sha,
                actualSha: sha,
                workflowSha: "f".repeat(40),
                sourceRef: "refs/heads/separate-setting-lifecycle",
                confirmation: `stage @vrtmrz/livesync-commonlib@0.1.0-rc.14 from ${sha}`,
            }
        );
    });

    it("parses the legacy five-argument prerelease invocation", () => {
        assert.deepEqual(
            parseReleaseSelectionArguments([
                "0.1.0-rc.14",
                sha,
                sha,
                "refs/heads/separate-setting-lifecycle",
                `stage @vrtmrz/livesync-commonlib@0.1.0-rc.14 from ${sha}`,
            ]),
            {
                version: "0.1.0-rc.14",
                expectedSha: sha,
                actualSha: sha,
                workflowSha: undefined,
                sourceRef: "refs/heads/separate-setting-lifecycle",
                confirmation: `stage @vrtmrz/livesync-commonlib@0.1.0-rc.14 from ${sha}`,
            }
        );
    });

    it("rejects an unsupported argument count", () => {
        assert.throws(() => parseReleaseSelectionArguments(["0.1.0-rc.14"]), /five legacy arguments or six current/u);
    });
});
