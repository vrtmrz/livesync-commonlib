/** More than one listed entry has the requested logical identity. */
export class AmbiguousNormalisedPathError extends Error {
    readonly candidates: readonly string[];

    constructor(
        readonly path: string,
        candidates: readonly string[] = []
    ) {
        const detail = candidates.length ? ` (${candidates.map((name) => JSON.stringify(name)).join(", ")})` : "";
        super(`Ambiguous path after Unicode normalisation: ${path}${detail}`);
        this.name = "AmbiguousNormalisedPathError";
        this.candidates = Object.freeze([...candidates]);
    }
}
