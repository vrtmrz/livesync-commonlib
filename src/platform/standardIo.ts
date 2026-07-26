/** A chunk written to standard output or standard error. */
export type StandardIoChunk = string | Uint8Array;

/**
 * Host-provided standard input and output for a command-line composition.
 *
 * The contract deliberately excludes process lifecycle, logging policy, and
 * terminal capability detection. Hosts own those concerns separately. None of
 * the write operations add a newline implicitly.
 */
export interface StandardIo {
    /** Read standard input to completion and decode it as UTF-8 text. */
    readStdin(): Promise<string>;

    /** Ask one line-oriented question and return the entered text. */
    prompt(question: string): Promise<string>;

    /** Write a text or binary chunk to standard output. */
    writeStdout(chunk: StandardIoChunk): void;

    /** Write a text or binary chunk to standard error. */
    writeStderr(chunk: StandardIoChunk): void;
}
