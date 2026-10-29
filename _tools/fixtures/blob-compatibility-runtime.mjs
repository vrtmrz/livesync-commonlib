import assert from "node:assert/strict";
import {
    createBinaryBlob,
    createBlob,
    createTextBlob,
    isDocContentSame,
    isTextBlob,
    readAsBlob,
} from "@vrtmrz/livesync-commonlib/compat/common/utils";

const original = new Blob(["payload"], { type: "application/custom" });
assert.equal(createBlob(original), original);
assert.equal(createBlob(original).type, "application/custom");
assert.equal(createBlob.name, "createBlob");
const text = createTextBlob(["first\r", "\n日本語"]);
assert.equal(await text.text(), "first\r\n日本語");
assert.equal(isTextBlob(text), true);
const bytes = new Uint8Array([255, 0, 128, 254, 255]);
const binary = createBinaryBlob(bytes.subarray(1, 4));
bytes.fill(17);
assert.deepEqual(new Uint8Array(await binary.arrayBuffer()), new Uint8Array([0, 128, 254]));
assert.equal(binary.type, "application/octet-stream");
const document = readAsBlob({
    _id: "attachment.bin",
    path: "attachment.bin",
    type: "newnote",
    datatype: "newnote",
    children: [],
    eden: {},
    ctime: 0,
    mtime: 0,
    size: 3,
    data: "AP8B",
});
assert.deepEqual(new Uint8Array(await document.arrayBuffer()), new Uint8Array([0, 255, 1]));
assert.equal(await isDocContentSame(new Blob(["same"], { type: "text/custom" }), "same"), true);
assert.equal(await isDocContentSame("one", "two"), false);
const multiPartBytes = new Uint8Array(20_003).fill(31);
const multiPartSame = new Blob([multiPartBytes], { type: "application/custom" });
const multiPartCopy = new Blob([multiPartBytes.slice()], { type: "application/octet-stream" });
assert.equal(await isDocContentSame(multiPartSame, multiPartCopy), true);
const multiPartDifferentBytes = multiPartBytes.slice();
multiPartDifferentBytes[20_002] ^= 1;
assert.equal(await isDocContentSame(multiPartSame, new Blob([multiPartDifferentBytes])), false);
