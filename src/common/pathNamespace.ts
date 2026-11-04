import { ICHeader, ICXHeader, PSCHeader } from "./models/fileaccess.const.ts";

export type PathNamespace = "" | typeof ICHeader | typeof ICXHeader | typeof PSCHeader;

/** Separate one recognised Metadata namespace while retaining the body's spelling. */
export function splitPathNamespace(path: string): readonly [PathNamespace, string] {
    for (const prefix of [ICHeader, ICXHeader, PSCHeader] as const) {
        if (path.startsWith(prefix)) return [prefix, path.slice(prefix.length)];
    }
    return ["", path];
}
