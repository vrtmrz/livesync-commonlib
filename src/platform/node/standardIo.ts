import * as nodeReadlinePromises from "node:readline/promises";

import type { StandardIo, StandardIoChunk } from "../standardIo.ts";

/** Minimal readable stream shape accepted by the Node standard-I/O adapter. */
export type NodeStandardInput = AsyncIterable<unknown> & NodeJS.ReadableStream;

/** Minimal writable stream shape accepted by the Node standard-I/O adapter. */
export interface NodeStandardOutput extends NodeJS.WritableStream {
    write(chunk: StandardIoChunk): boolean;
}

/** Streams used by {@link createNodeStandardIo}. */
export interface CreateNodeStandardIoOptions {
    /** Defaults to `process.stdin`. */
    stdin?: NodeStandardInput;
    /** Defaults to `process.stdout`. */
    stdout?: NodeStandardOutput;
    /** Defaults to `process.stderr`. */
    stderr?: NodeStandardOutput;
}

/**
 * Bind the host-neutral standard-I/O contract to Node streams.
 *
 * Supplying streams is useful for embedded command-line hosts and tests. The
 * caller owns stream lifecycle; this adapter only closes the temporary
 * readline interface created by {@link StandardIo.prompt}.
 */
export function createNodeStandardIo(options: CreateNodeStandardIoOptions = {}): StandardIo {
    const stdin = options.stdin ?? (process.stdin as NodeStandardInput);
    const stdout = options.stdout ?? (process.stdout as NodeStandardOutput);
    const stderr = options.stderr ?? (process.stderr as NodeStandardOutput);

    return {
        async readStdin(): Promise<string> {
            const decoder = new TextDecoder();
            let content = "";
            for await (const chunk of stdin) {
                if (typeof chunk === "string") {
                    content += chunk;
                } else if (chunk instanceof Uint8Array) {
                    content += decoder.decode(chunk, { stream: true });
                } else {
                    throw new TypeError("Standard input yielded a value which is neither text nor binary data.");
                }
            }
            return content + decoder.decode();
        },

        async prompt(question: string): Promise<string> {
            const readline = nodeReadlinePromises.createInterface({ input: stdin, output: stdout });
            try {
                return await readline.question(question);
            } finally {
                readline.close();
            }
        },

        writeStdout(chunk: StandardIoChunk): void {
            stdout.write(chunk);
        },

        writeStderr(chunk: StandardIoChunk): void {
            stderr.write(chunk);
        },
    };
}
