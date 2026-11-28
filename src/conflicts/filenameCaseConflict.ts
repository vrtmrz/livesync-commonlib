import { normalisePathForIdentity } from "@lib/common/pathNormalization.ts";

/** Check whether both revisions record the same case-preserving path under the configured normalisation. */
export function haveMatchingRevisionPaths(
    leftPath: string | undefined,
    rightPath: string | undefined,
    version?: number
): boolean {
    return (
        !!leftPath &&
        !!rightPath &&
        normalisePathForIdentity(leftPath, version) === normalisePathForIdentity(rightPath, version)
    );
}

/** Check whether two recorded paths differ only in case under the configured normalisation. */
export function hasFilenameCaseConflict(
    leftPath: string | undefined,
    rightPath: string | undefined,
    version?: number
): boolean {
    if (!leftPath || !rightPath) {
        return false;
    }
    const left = normalisePathForIdentity(leftPath, version);
    const right = normalisePathForIdentity(rightPath, version);
    return left !== right && left.toLowerCase() === right.toLowerCase();
}

/** Return the parent directory of a Vault path, or the empty string for the Vault root. */
export function getParentPath(path: string): string {
    const lastSeparator = path.lastIndexOf("/");
    return lastSeparator < 0 ? "" : path.slice(0, lastSeparator);
}

/** Check for a filename casing difference within the same normalised parent directory. */
export function hasSameParentFilenameCaseConflict(
    left: string | undefined,
    right: string | undefined,
    version?: number
): boolean {
    if (!left || !right || !hasFilenameCaseConflict(left, right, version)) return false;
    return (
        normalisePathForIdentity(getParentPath(left), version) ===
        normalisePathForIdentity(getParentPath(right), version)
    );
}
