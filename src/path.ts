import { webcrypto } from "./mods.ts";
import { uint8ArrayToHexString, writeString } from "./strbin.ts";
import { AnyEntry, DocumentID, EntryHasPath, FilePath, FilePathWithPrefix, FLAGMD_REDFLAG, FLAGMD_REDFLAG2, FLAGMD_REDFLAG3, PREFIX_OBFUSCATED, PREFIXMD_LOGFILE } from "./types.ts";
import { memorizeFuncWithLRUCache } from "./utils.ts";
// --- path utilities
export function isValidFilenameInWidows(filename: string): boolean {
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]|[\\":?<>|*#]/g;
    if (regex.test(filename)) return false;
    const win = /(\\|\/)(COM\d|LPT\d|CON|PRN|AUX|NUL|CLOCK$)($|\.)/gi;
    if (win.test(filename)) return false;
    return true;
}
export function isValidFilenameInDarwin(filename: string): boolean {
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]|[:]/g;
    return !regex.test(filename);
}
export function isValidFilenameInLinux(filename: string): boolean {
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]/g;
    return !regex.test(filename);
}
export function isValidFilenameInAndroid(filename: string): boolean {
    // In principle, Android can handle the path as like Linux, but most devices mount the storage in VFAT.
    // eslint-disable-next-line no-control-regex
    const regex = /[\u0000-\u001f]|[\\":?<>|*#]/g;
    return !regex.test(filename);
}


export function isFilePath(path: FilePath | FilePathWithPrefix): path is FilePath {
    if (path.indexOf(":") === -1) return true;
    return false;
}
export function stripAllPrefixes(prefixedPath: FilePathWithPrefix): FilePath {
    if (isFilePath(prefixedPath)) return prefixedPath;
    const [, body] = expandFilePathPrefix(prefixedPath);
    return stripAllPrefixes(body);
}
export function addPrefix(path: FilePath | FilePathWithPrefix, prefix: string): FilePathWithPrefix {
    if (prefix && path.startsWith(prefix)) return path;
    return `${prefix ?? ""}${path}` as FilePathWithPrefix;
}
export function expandFilePathPrefix(path: FilePathWithPrefix | FilePath): [string, FilePathWithPrefix] {
    let [prefix, body] = path.split(":", 2);
    if (!body) {
        body = prefix;
        prefix = "";
    } else {
        prefix = prefix + ":";
    }
    return [prefix, body as FilePathWithPrefix];
}
export function expandDocumentIDPrefix(id: DocumentID): [string, FilePathWithPrefix] {
    let [prefix, body] = id.split(":", 2);
    if (!body) {
        body = prefix;
        prefix = "";
    } else {
        prefix = prefix + ":";
    }
    return [prefix, body as FilePathWithPrefix];
}

const hashString = memorizeFuncWithLRUCache(async (key: string) => {
    const buff = writeString(key);
    let digest = await webcrypto.subtle.digest('SHA-256', buff);
    const len = key.length;
    for (let i = 0; i < len; i++) {
        // Stretching
        digest = await webcrypto.subtle.digest('SHA-256', buff);
    }
    return uint8ArrayToHexString(new Uint8Array(digest));
})

export async function path2id_base(
    filename: FilePathWithPrefix | FilePath,
    obfuscatePassphrase: string | false,
): Promise<DocumentID> {
    if (filename.startsWith(PREFIX_OBFUSCATED)) return filename as string as DocumentID;
    let x = filename;
    if (x.startsWith("_")) x = ("/" + x) as FilePathWithPrefix;
    if (!obfuscatePassphrase) return x as string as DocumentID;
    // obfuscating...
    const [prefix, body] = expandFilePathPrefix(x);
    // Already Hashed
    if (body.startsWith(PREFIX_OBFUSCATED)) return x as string as DocumentID;
    const hashedPassphrase = await hashString(obfuscatePassphrase);
    // Hash it!
    const out = await hashString(`${hashedPassphrase}:${filename}`);
    return (prefix + PREFIX_OBFUSCATED + out) as DocumentID;
}

export function id2path_base(id: DocumentID, entry?: EntryHasPath): FilePathWithPrefix {
    if (entry && entry?.path) {
        return id2path_base(entry.path as string as DocumentID);
    }
    if (id.startsWith(PREFIX_OBFUSCATED)) throw new Error("Entry has been obfuscated!");
    const [prefix, body] = expandDocumentIDPrefix(id);
    if (body.startsWith(PREFIX_OBFUSCATED)) throw new Error("Entry has been obfuscated!");
    if (body.startsWith("/")) {
        return body.substring(1) as FilePathWithPrefix;
    }
    return prefix + body as FilePathWithPrefix;
}

export function getPath(entry: AnyEntry) {
    return id2path_base(entry._id, entry);

}
export function getPathWithoutPrefix(entry: AnyEntry) {
    const f = getPath(entry);
    return stripAllPrefixes(f);
}
export function stripPrefix(prefixedPath: FilePathWithPrefix): FilePath {
    const [prefix, body] = prefixedPath.split(":", 2);
    if (!body) {
        return prefix as FilePath;
    }
    return body as FilePath;
}

export function shouldBeIgnored(filename: string): boolean {
    if (filename == FLAGMD_REDFLAG) {
        return true;
    }
    if (filename == FLAGMD_REDFLAG2) {
        return true;
    }
    if (filename == FLAGMD_REDFLAG3) {
        return true;
    }
    if (filename.startsWith(PREFIXMD_LOGFILE)) {
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
