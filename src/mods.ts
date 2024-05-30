//@ts-ignore
import { webcrypto as crypto_ } from "crypto";
let webcrypto: Crypto;

if (globalThis.crypto) {
    webcrypto = globalThis.crypto;
} else {
    const crypto = crypto_;
    //@ts-ignore
    webcrypto = crypto;
}

export { webcrypto };