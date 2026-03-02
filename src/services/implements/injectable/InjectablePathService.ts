import type { UXFileInfo, AnyEntry, UXFileInfoStub, FilePathWithPrefix } from "@lib/common/types";
import { PathService } from "../../base/PathService";
import type { ServiceContext } from "../../base/ServiceBase";
import { BASE_IS_NEW, EVEN, TARGET_IS_NEW } from "@lib/common/models/shared.const.symbols";
import { compareMTime } from "@lib/common/utils";
export function compareFileFreshnessGeneric(
    baseFile: UXFileInfoStub | AnyEntry | undefined,
    checkTarget: UXFileInfo | AnyEntry | undefined
): typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN {
    if (baseFile === undefined && checkTarget == undefined) return EVEN;
    if (baseFile == undefined) return TARGET_IS_NEW;
    if (checkTarget == undefined) return BASE_IS_NEW;

    const modifiedBase = "stat" in baseFile ? (baseFile?.stat?.mtime ?? 0) : (baseFile?.mtime ?? 0);
    const modifiedTarget = "stat" in checkTarget ? (checkTarget?.stat?.mtime ?? 0) : (checkTarget?.mtime ?? 0);

    if (modifiedBase && modifiedTarget) {
        return EVEN;
    }
    return compareMTime(modifiedBase, modifiedTarget);
}
export class PathServiceCompat<T extends ServiceContext> extends PathService<T> {
    override markChangesAreSame(
        old: UXFileInfo | AnyEntry | FilePathWithPrefix,
        newMtime: number,
        oldMtime: number
    ): boolean | undefined {
        return undefined;
    }
    override unmarkChanges(file: AnyEntry | FilePathWithPrefix | UXFileInfoStub): void {
        return;
    }
    override compareFileFreshness(
        baseFile: UXFileInfoStub | AnyEntry | undefined,
        checkTarget: UXFileInfo | AnyEntry | undefined
    ): typeof BASE_IS_NEW | typeof TARGET_IS_NEW | typeof EVEN {
        return compareFileFreshnessGeneric(baseFile, checkTarget);
    }
    override isMarkedAsSameChanges(
        file: UXFileInfoStub | AnyEntry | FilePathWithPrefix,
        mtimes: number[]
    ): undefined | typeof EVEN {
        return undefined;
    }
    override normalizePath(path: string): string {
        // Turns the path with forward slashes, strip double slashes
        const fPath = path.replace(/\\/g, "/").replace(/\/+/g, "/");
        return fPath;
    }
}
