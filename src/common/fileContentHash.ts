import { Semaphore } from "octagonal-wheels/concurrency/semaphore";
import { getWebCrypto } from "@lib/mods.ts";
import { uint8ArrayToHexString } from "@lib/string_and_binary/convert.ts";

// Bound simultaneous whole-file buffers, including Web Crypto's input copy.
const hashing = Semaphore(1);

/** Hash the exact bytes of one immutable file snapshot. */
export async function computeFileContentHash(content: Blob): Promise<`sha256:${string}`> {
    const release = await hashing.acquire();
    try {
        const crypto = await getWebCrypto();
        const bytes = await content.arrayBuffer();
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return `sha256:${uint8ArrayToHexString(new Uint8Array(digest))}`;
    } finally {
        release();
    }
}
