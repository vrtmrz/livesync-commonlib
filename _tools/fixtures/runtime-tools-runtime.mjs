import assert from "node:assert/strict";
import { timeDeltaToHumanReadable, splitCustomRegExpList, constructCustomRegExpList } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import { bindableFunction, lazyBindableFunction } from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";

for (const [value, expected] of [[0,"0.00s"],[60000,"1.00m"],[86400000,"1.00d"],[31536000000,"1.00y"],[-1000,"-1.00s"],[NaN,"NaNy"],[Infinity,"Infinityy"]]) {
    assert.equal(timeDeltaToHumanReadable(value), expected);
}
assert.deepEqual(splitCustomRegExpList("|a||b|", "|"), ["a", "b"]);
assert.deepEqual(splitCustomRegExpList(null, "|"), []);
assert.deepEqual(splitCustomRegExpList(121, "2"), ["1", "1"]);
assert.equal(constructCustomRegExpList(["", "a", ""], "|"), "|a|");
assert.equal(constructCustomRegExpList([null, undefined, 2], "|"), "null|undefined|2");

const immediate = bindableFunction("packed-immediate");
const immediateCallback = () => "current";
const removeImmediate = immediate.setHandler(immediateCallback);
immediate.setHandler(immediateCallback, true);
removeImmediate();
removeImmediate();
assert.equal(immediate(), "current");

const lazy = lazyBindableFunction("packed-lazy");
const lazyCallback = () => "current";
const removeLazy = lazy.setHandler(lazyCallback);
lazy.setHandler(lazyCallback, true);
removeLazy();
removeLazy();
assert.equal(await lazy(), "current");

const waitingLazy = lazyBindableFunction("packed-lazy-waiting");
const removeWaiting = waitingLazy.setHandler(() => "first");
removeWaiting();
const waiting = waitingLazy();
removeWaiting();
let invoked = false;
waitingLazy.setHandler(() => {
    invoked = true;
    return "current";
});
await Promise.resolve();
assert.equal(invoked, true);
assert.equal(await waiting, "current");
