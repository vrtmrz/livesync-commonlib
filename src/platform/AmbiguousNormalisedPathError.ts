/** More than one listed entry has the requested logical identity. */
export class AmbiguousNormalisedPathError extends Error {
    /** Physical candidate paths copied from the listing which exposed the ambiguity. */
    readonly candidates: readonly string[];

    /**
     * Describe an ambiguous request without choosing a physical candidate.
     *
     * @param path - Path whose logical identity matched multiple entries.
     * @param candidates - Matching physical paths, copied into a frozen array.
     */
    constructor(
        /** Path whose logical identity was ambiguous. */
        readonly path: string,
        candidates: readonly string[] = []
    ) {
        const detail = candidates.length ? ` (${candidates.map((name) => JSON.stringify(name)).join(", ")})` : "";
        super(`Ambiguous path after Unicode normalisation: ${path}${detail}`);
        this.name = "AmbiguousNormalisedPathError";
        this.candidates = Object.freeze([...candidates]);
    }
}
