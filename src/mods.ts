import { compatGlobal } from "./common/coreEnvFunctions";

let webcrypto: Crypto;
export async function getWebCrypto() {
    if (webcrypto) {
        return webcrypto;
    }
    if (compatGlobal.crypto) {
        webcrypto = compatGlobal.crypto;
        return webcrypto;
    } else {
        // This is for Node.js.
        // eslint-disable-next-line import/no-nodejs-modules
        const module = await import("crypto");
        webcrypto = module.webcrypto as Crypto;
        return webcrypto;
    }
}
