import assert from "node:assert/strict";
import { timeDeltaToHumanReadable, splitCustomRegExpList, constructCustomRegExpList } from "@vrtmrz/livesync-commonlib/compat/common/utils";

for (const [value, expected] of [[0,"0.00s"],[60000,"1.00m"],[86400000,"1.00d"],[31536000000,"1.00y"],[-1000,"-1.00s"],[NaN,"NaNy"],[Infinity,"Infinityy"]]) {
    assert.equal(timeDeltaToHumanReadable(value), expected);
}
assert.deepEqual(splitCustomRegExpList("|a||b|", "|"), ["a", "b"]);
assert.deepEqual(splitCustomRegExpList(null, "|"), []);
assert.deepEqual(splitCustomRegExpList(121, "2"), ["1", "1"]);
assert.equal(constructCustomRegExpList(["", "a", ""], "|"), "|a|");
assert.equal(constructCustomRegExpList([null, undefined, 2], "|"), "null|undefined|2");
