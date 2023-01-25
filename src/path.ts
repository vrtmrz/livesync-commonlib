import { FLAGMD_REDFLAG, FLAGMD_REDFLAG2 } from "./types";

// --- path utilities
export function isValidPath(filename: string): boolean {
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]|[\\":?<>|*#]/g;
    let x = filename.replace(regex, "_");
    const win = /(\\|\/)(COM\d|LPT\d|CON|PRN|AUX|NUL|CLOCK$)($|\.)/gi;
    const sx = (x = x.replace(win, "/_"));
    return sx == filename;
}

// For backward compatibility, using the path for determining id.
// Only CouchDB unacceptable ID (that starts with an underscore) has been prefixed with "/".
// The first slash will be deleted when the path is normalized.
export function path2id_base(filename: string): string {
    let x = filename;
    if (x.startsWith("_")) x = "/" + x;
    return x;
}
export function id2path_base(filename: string): string {
    //TODO:FIXING PREFIX
    return filename;
}

export function shouldBeIgnored(filename: string): boolean {
    if (filename == FLAGMD_REDFLAG) {
        return true;
    }
    if (filename == FLAGMD_REDFLAG2) {
        return true;
    }
    return false;
}
export function isPlainText(filename: string): boolean {
    if (filename.endsWith(".md")) return true;
    if (filename.endsWith(".txt")) return true;
    if (filename.endsWith(".svg")) return true;
    if (filename.endsWith(".html")) return true;
    if (filename.endsWith(".csv")) return true;
    if (filename.endsWith(".css")) return true;
    if (filename.endsWith(".js")) return true;
    if (filename.endsWith(".xml")) return true;
    if (filename.endsWith(".canvas")) return true;
    return false;
}
export function shouldSplitAsPlainText(filename: string): boolean {
    if (filename.endsWith(".md")) return true;
    if (filename.endsWith(".txt")) return true;
    if (filename.endsWith(".canvas")) return true;
    return false;
}
