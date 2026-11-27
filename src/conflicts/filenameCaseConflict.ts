import type { FilePathWithPrefix } from "@lib/common/types.ts";
import type { PathNormalizationVersion } from "@lib/common/models/setting.type.ts";
import { normalisePathForIdentity } from "@lib/common/pathNormalization.ts";

/** Compare the stored paths of two revisions of the same document for a case difference. */
export function hasFilenameCaseConflict(
    leftPath: FilePathWithPrefix | undefined,
    rightPath: FilePathWithPrefix | undefined,
    version: PathNormalizationVersion
): boolean {
    if (!leftPath || !rightPath) {
        return false;
    }
    const left = normalisePathForIdentity(leftPath, version);
    const right = normalisePathForIdentity(rightPath, version);
    return left !== right && left.toLowerCase() === right.toLowerCase();
}
