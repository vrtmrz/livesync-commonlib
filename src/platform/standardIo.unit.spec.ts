import { PassThrough, Readable } from "node:stream";

import { describe, expect, it } from "vitest";

import { createNodeStandardIo, type NodeStandardOutput } from "./node/index.ts";
import type { StandardIo } from "./standardIo.ts";

function collectStream(stream: PassThrough): { chunks: Uint8Array[]; content(): Uint8Array } {
    const chunks: Uint8Array[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(Uint8Array.from(chunk)));
    return {
        chunks,
        content() {
            const length = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
            const result = new Uint8Array(length);
            let offset = 0;
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.byteLength;
            }
            return result;
        },
    };
}

function asOutput(stream: NodeJS.WritableStream): NodeStandardOutput {
    return stream as NodeStandardOutput;
}

describe("standard I/O contract", () => {
    it("accepts a host implementation without requiring Node streams", async () => {
        const stdout: (string | Uint8Array)[] = [];
        const stderr: (string | Uint8Array)[] = [];
        const memoryIo: StandardIo = {
            readStdin: async () => "input",
            prompt: async (question) => `${question}:answer`,
            writeStdout: (chunk) => stdout.push(chunk),
            writeStderr: (chunk) => stderr.push(chunk),
        };

        await expect(memoryIo.readStdin()).resolves.toBe("input");
        await expect(memoryIo.prompt("question")).resolves.toBe("question:answer");
        memoryIo.writeStdout("out");
        memoryIo.writeStderr("err");
        expect(stdout).toEqual(["out"]);
        expect(stderr).toEqual(["err"]);
    });

    it("decodes split UTF-8 input through the Node implementation", async () => {
        const encoded = new TextEncoder().encode("aあb");
        const stdin = Readable.from([encoded.slice(0, 2), encoded.slice(2)]);
        const io = createNodeStandardIo({ stdin });

        await expect(io.readStdin()).resolves.toBe("aあb");
    });

    it("writes text and binary chunks without adding delimiters", () => {
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        const capturedStdout = collectStream(stdout);
        const capturedStderr = collectStream(stderr);
        const io = createNodeStandardIo({
            stdout: asOutput(stdout),
            stderr: asOutput(stderr),
        });

        io.writeStdout("out");
        io.writeStdout(Uint8Array.from([0x00, 0xff]));
        io.writeStderr("err");

        expect([...capturedStdout.content()]).toEqual([...new TextEncoder().encode("out"), 0x00, 0xff]);
        expect(new TextDecoder().decode(capturedStderr.content())).toBe("err");
    });

    it("rejects object-mode standard input explicitly", async () => {
        const stdin = Readable.from([{ value: "not a stream chunk" }], { objectMode: true });
        const io = createNodeStandardIo({ stdin });

        await expect(io.readStdin()).rejects.toThrow("neither text nor binary data");
    });

    it("uses the injected streams for a line-oriented prompt", async () => {
        const stdin = new PassThrough();
        const stdout = new PassThrough();
        const capturedStdout = collectStream(stdout);
        const io = createNodeStandardIo({
            stdin,
            stdout: asOutput(stdout),
        });

        const answer = io.prompt("Passphrase: ");
        stdin.end("secret\n");

        await expect(answer).resolves.toBe("secret");
        expect(new TextDecoder().decode(capturedStdout.content())).toContain("Passphrase: ");
    });
});
