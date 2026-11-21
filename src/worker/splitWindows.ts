const LENGTH_BASE = 0x10000;
const HEADER_UNITS = 2;
const HEADER_BYTES = HEADER_UNITS * 2;

/**
 * Calculates the frame limit for a window budget that permits an oversized chunk on its own.
 *
 * @param maxChunkBytes - An upper bound on the charge for one unframed chunk in bytes.
 * @param windowBytes - The target budget for an encoded window, including its length headers.
 * @returns The greater of the window budget and the charge for the largest single-chunk frame.
 * @throws `RangeError` if the window budget is less than four bytes or is not a safe integer.
 */
export function splitWindowFrameCapacity(maxChunkBytes: number, windowBytes: number): number {
    if (!Number.isSafeInteger(windowBytes) || windowBytes < HEADER_BYTES) {
        throw new RangeError("The split window size must be a safe integer of at least four bytes.");
    }
    return Math.max(windowBytes, maxChunkBytes + HEADER_BYTES);
}

/**
 * Groups whole string chunks into consecutive windows according to their encoded charge.
 *
 * @remarks
 * Each chunk costs two bytes per UTF-16 code unit plus four bytes for its length header.
 * A chunk that exceeds the budget forms a window on its own. The iterator may hold
 * one chunk for the next window while the caller processes the current window.
 *
 * @param source - The ordered chunks to group.
 * @param windowBytes - The target byte budget per encoded window.
 * @returns A lazy iterator of non-empty windows preserving every chunk's content, boundary, and order.
 * @throws `RangeError` on iteration if the budget is less than four bytes or is not a safe integer.
 */
export async function* groupSplitChunks(
    source: AsyncIterable<string>,
    windowBytes: number
): AsyncGenerator<readonly string[], void, unknown> {
    splitWindowFrameCapacity(0, windowBytes);
    let window: string[] = [];
    let bytes = 0;
    for await (const chunk of source) {
        const chunkBytes = 2 * chunk.length + HEADER_BYTES;
        if (window.length > 0 && bytes + chunkBytes > windowBytes) {
            yield window;
            window = [];
            bytes = 0;
        }
        window.push(chunk);
        bytes += chunkBytes;
        // An oversized chunk keeps its original boundary and occupies a window on its own.
        if (bytes >= windowBytes) {
            yield window;
            window = [];
            bytes = 0;
        }
    }
    if (window.length > 0) {
        yield window;
    }
}

/**
 * Encodes a window from {@link groupSplitChunks} as one string for transport.
 *
 * @remarks
 * Each chunk is preceded by its length in two UTF-16 code units, most significant first.
 * The original code units are preserved.
 *
 * @param chunks - A non-empty ordered window of string chunks.
 * @returns The encoded frame to pass to {@link decodeSplitWindow}.
 */
export function encodeSplitWindow(chunks: readonly string[]): string {
    const parts: string[] = [];
    for (const chunk of chunks) {
        // Two UTF-16 code units encode a length without escaping the chunk contents.
        parts.push(String.fromCharCode(Math.floor(chunk.length / LENGTH_BASE), chunk.length % LENGTH_BASE), chunk);
    }
    return parts.join("");
}

/**
 * Restores the original chunks and their boundaries from one encoded window.
 *
 * @param frame - A complete frame produced by {@link encodeSplitWindow}.
 * @returns The ordered string chunks, including any empty chunks.
 * @throws `Error` if the frame has no chunk header, a truncated header, or an incomplete chunk.
 */
export function decodeSplitWindow(frame: string): readonly string[] {
    const chunks: string[] = [];
    let offset = 0;
    while (offset + HEADER_UNITS <= frame.length) {
        const length = frame.charCodeAt(offset) * LENGTH_BASE + frame.charCodeAt(offset + 1);
        const start = offset + HEADER_UNITS;
        const end = start + length;
        if (end > frame.length) {
            throw new Error("A split window contains an incomplete chunk.");
        }
        chunks.push(frame.slice(start, end));
        offset = end;
    }
    if (chunks.length === 0 || offset !== frame.length) {
        throw new Error("A split window contains an invalid chunk header.");
    }
    return chunks;
}
