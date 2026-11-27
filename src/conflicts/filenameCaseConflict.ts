import type { FilePathWithPrefix } from "@lib/common/types.ts";

/** Compare the stored paths of two revisions of the same document for a case difference. */
export function hasFilenameCaseConflict(leftPath?: FilePathWithPrefix, rightPath?: FilePathWithPrefix): boolean {
    if (!leftPath || !rightPath) {
        return false;
    }
    const left = leftPath.normalize("NFC");
    const right = rightPath.normalize("NFC");
    return left !== right && left.toLowerCase() === right.toLowerCase();
}
