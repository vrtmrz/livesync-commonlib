import type { CustomRegExpSource, ParsedCustomRegExp, CustomRegExpSourceList } from "@lib/common/models/shared.type.util";
import type { ObsidianLiveSyncSettings, RemoteDBSettings } from "@lib/common/models/setting.type";

/***
 * Parse custom regular expression
 * @param regexp
 * @returns [negate: boolean, regexp: string]
 * @example `!!foo` => [true, "foo"]
 * @example `foo` => [false, "foo"]
 */
export function parseCustomRegExp(regexp: CustomRegExpSource): ParsedCustomRegExp {
    if (regexp.startsWith("!!")) {
        return [true, regexp.slice(2)];
    }
    return [false, regexp];
}
export function matchRegExp(regexp: CustomRegExpSource, target: string) {
    const [negate, regexpWithoutNegate] = parseCustomRegExp(regexp);
    if (regexpWithoutNegate.length == 0) return false;
    const re = new RegExp(regexpWithoutNegate);
    return negate ? !re.test(target) : re.test(target);
}
export function isValidRegExp(regexp: CustomRegExpSource) {
    try {
        const [, exp] = parseCustomRegExp(regexp);
        new RegExp(exp);
        return true;
    } catch {
        return false;
    }
}
export function isInvertedRegExp(regexp: CustomRegExpSource) {
    const [negate] = parseCustomRegExp(regexp);
    return negate;
}

function parseCustomRegExpList<D extends string>(list: CustomRegExpSourceList<D>, flags?: string, delimiter?: D) {
    const d = delimiter ?? ",";
    const source = `${list ?? ""}`;
    const items = source
        .replace(/\n| /g, "")
        .split(d)
        .filter((e) => e);
    return items.map((e) => new CustomRegExp(e as unknown as CustomRegExpSource, flags));
}

export function constructCustomRegExpList<D extends string>(
    items: CustomRegExpSource[],
    delimiter: D
): CustomRegExpSourceList<D> {
    return items.map((e) => `${e}`).join(`${delimiter}`) as CustomRegExpSourceList<D>;
}
export function splitCustomRegExpList<D extends string>(list: CustomRegExpSourceList<D>, delimiter: D) {
    const d = delimiter;
    const source = `${list ?? ""}`;
    return source.split(d).filter((e) => e as CustomRegExpSource) as CustomRegExpSource[];
}

export class CustomRegExp {
    regexp: RegExp;
    negate: boolean;
    pattern: string;
    constructor(regexp: CustomRegExpSource, flags?: string) {
        const [negate, exp] = parseCustomRegExp(regexp);
        this.pattern = exp;
        this.regexp = new RegExp(exp, flags);
        this.negate = negate;
    }
    test(str: string) {
        return this.negate ? !this.regexp.test(str) : this.regexp.test(str);
    }
}

type RegExpSettingKey =
    | "syncOnlyRegEx"
    | "syncIgnoreRegEx"
    | "syncInternalFilesIgnorePatterns"
    | "syncInternalFilesTargetPatterns"
    | "syncInternalFileOverwritePatterns";
export function getFileRegExp(settings: ObsidianLiveSyncSettings | RemoteDBSettings, key: RegExpSettingKey) {
    const flagCase = settings.handleFilenameCaseSensitive ? "" : "i";
    if (
        key === "syncInternalFilesIgnorePatterns" ||
        key === "syncInternalFilesTargetPatterns" ||
        key === "syncInternalFileOverwritePatterns"
    ) {
        const regExp = (settings as ObsidianLiveSyncSettings)[key];
        return parseCustomRegExpList(regExp, flagCase, ",");
    }
    const regExp = settings[key];
    return parseCustomRegExpList(regExp, flagCase, "|[]|");
}
