//@ts-ignore
import { webcrypto as crypto_ } from "node:crypto";
let webcrypto: Crypto;

if (typeof window !== "undefined" && window.crypto) {
    webcrypto = window.crypto;
} else {
    const crypto = crypto_;
    //@ts-ignore
    webcrypto = crypto;
}

export { webcrypto };