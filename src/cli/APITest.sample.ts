import { DirectFileManipulator } from "../API/DirectFileManipulator.ts";
import type { DirectFileManipulatorOptions } from "../API/DirectFileManipulator.ts";
import { createTextBlob } from "../common/utils.ts";
import type { FilePathWithPrefix } from "../common/types.ts";

// Sample configuration
const opt: DirectFileManipulatorOptions = {
    url: "http://localhost:5984/",
    username: "adminuser",
    password: "adminpassword",
    passphrase: "vaultpassphrase",
    database: "yourdatabase",
    obfuscatePassphrase: "vaultpassphrase", // It should be the same as passphrase
    customChunkSize: 100,
    useEden: false,
    maxChunksInEden: 10,
    maxTotalLengthInEden: 1024,
    maxAgeInEden: 10,
    enableChunkSplitterV2: true,
    enableCompression: false,
    handleFilenameCaseSensitive: false,
    doNotUseFixedRevisionForChunks: false,
};

const directFileManipulator = new DirectFileManipulator(opt);
const f = await directFileManipulator.get("test.md" as FilePathWithPrefix);
console.dir(f);
const testData = createTextBlob(`Hello world a`);
const r = await directFileManipulator.put("test.md", testData, {
    mtime: Date.now(),
    ctime: Date.now(),
    size: testData.size,
});
console.dir(r);
await directFileManipulator.close();
