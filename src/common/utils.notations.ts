import { replaceAllPairs } from "octagonal-wheels/string";

const map = {
    "\n": "\\n",
    "\r": "\\r",
    "\\": "\\\\",
} as Record<string, string>;

const revMap = {
    "\\n": "\n",
    "\\r": "\r",
    "\\\\": "\\",
} as Record<string, string>;

export function escapeNewLineFromString(str: string) {
    if (str.indexOf("\n") === -1 && str.indexOf("\r") === -1) {
        return str;
    }
    const p = str.replace(/(\n|\r|\\)/g, (m) => `${map[m]}`);
    return "\\f" + p;
}

export function unescapeNewLineFromString(str: string) {
    if (!str.startsWith("\\f")) {
        return str;
    }
    const p = str.substring(2).replace(/(\\n|\\r|\\\\)/g, (m) => `${revMap[m]}`);
    return p;
}

export function escapeMarkdownValue<T>(value: T): T {
    if (typeof value === "string") {
        return replaceAllPairs(value, ["|", "\\|"], ["`", "\\`"]) as unknown as T;
    } else {
        return value;
    }
}

export function timeDeltaToHumanReadable(delta: number) {
    const sec = delta / 1000;
    if (sec < 60) {
        return `${sec.toFixed(2)}s`;
    }
    const min = sec / 60;
    if (min < 60) {
        return `${min.toFixed(2)}m`;
    }
    const hour = min / 60;
    if (hour < 24) {
        return `${hour.toFixed(2)}h`;
    }
    const day = hour / 24;
    if (day < 365) {
        return `${day.toFixed(2)}d`;
    }
    const year = day / 365;
    return `${year.toFixed(2)}y`;
}

export function toRanges(sorted: number[]) {
    if (sorted?.length == 0) return "";
    const ranges = [];
    let start = sorted[0];
    let end = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
        } else {
            ranges.push(start === end ? `${start.toString(32)}` : `${start.toString(32)}-${end.toString(32)}`);
            start = sorted[i];
            end = sorted[i];
        }
    }
    ranges.push(start === end ? `${start.toString(32)}` : `${start.toString(32)}-${end.toString(32)}`);

    return ranges.join(",");
}

export function displayRev(rev: string) {
    const [number, hash] = rev.split("-");
    return `${number}-${hash.substring(0, 6)}`;
}
