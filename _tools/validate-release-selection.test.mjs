import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateReleaseSelection } from "./validate-release-selection.mjs";

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
        sourceRef: "refs/heads/release/commonlib-0.1.0-rc.0",
        confirmation: `stage @vrtmrz/livesync-commonlib@${version} from ${sha}`,
        ...selectionOverrides,
    };
}

describe("release selection", () => {
    it("accepts an exact reviewed prerelease from a branch", () => {
        assert.doesNotThrow(() => validateReleaseSelection(validSelection()));
    });

    it("accepts a stable version from main while retaining the next publication gate", () => {
        assert.doesNotThrow(() =>
            validateReleaseSelection(validSelection({ version: "0.1.0", sourceRef: "refs/heads/main" }))
        );
    });

    it("rejects a stable version selected from a non-main branch", () => {
        assert.throws(
            () => validateReleaseSelection(validSelection({ version: "0.1.0" })),
            /Stable releases must be selected from refs\/heads\/main/u
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
