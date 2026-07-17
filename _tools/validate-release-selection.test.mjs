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
        confirmation: `stage @vrtmrz/livesync-commonlib@${version} from ${sha}`,
        ...selectionOverrides,
    };
}

describe("release selection", () => {
    it("accepts an exact reviewed prerelease", () => {
        assert.doesNotThrow(() => validateReleaseSelection(validSelection()));
    });

    it("accepts a stable version while retaining the next publication gate", () => {
        assert.doesNotThrow(() => validateReleaseSelection(validSelection({ version: "0.1.0" })));
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
