export function parsePeerPatterns(value: string): RegExp[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => (entry.startsWith("~") ? new RegExp(entry.substring(1), "i") : new RegExp(`^${entry}$`, "i")));
}
