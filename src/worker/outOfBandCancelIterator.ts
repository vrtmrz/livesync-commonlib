export const OUT_OF_BAND_CANCEL_ITERATOR = Symbol.for("livesync-commonlib.outOfBandCancelIterator");

export function isOutOfBandCancellableIterator(iterator: unknown): boolean {
    return (
        typeof iterator === "object" &&
        iterator !== null &&
        OUT_OF_BAND_CANCEL_ITERATOR in iterator &&
        iterator[OUT_OF_BAND_CANCEL_ITERATOR] === true
    );
}
