import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import { SuperCallCapture } from "./SuperCallCapture.ts";

function createFallbackCapture() {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("require", undefined);
    try {
        return new SuperCallCapture<string>();
    } finally {
        vi.unstubAllGlobals();
    }
}

describe("SuperCallCapture", () => {
    it("serialises a receiver's captures without host async context and advances after rejection", async () => {
        const capture = createFallbackCapture();

        const gate = promiseWithResolvers<void>();
        const entered = promiseWithResolvers<void>();
        const failure = new Error("override failed");
        const nextOverride = vi.fn();
        const owner = {
            async legacy(value: string) {
                if (value === "first") {
                    entered.resolve();
                    await gate.promise;
                    capture.takeRecorder(this)?.(value);
                    throw failure;
                }
                nextOverride();
                await Promise.resolve();
                capture.takeRecorder(this)?.(value);
                return false;
            },
        };
        const first = capture.invoke(owner, owner.legacy, "first");
        const rejection = expect(first).rejects.toBe(failure);
        const second = capture.invoke(owner, owner.legacy, "second");

        await entered.promise;
        expect(nextOverride).not.toHaveBeenCalled();
        gate.resolve();
        await rejection;
        await expect(second).resolves.toEqual({ result: false, delegated: { value: "second" } });
        expect(capture.takeRecorder(owner)).toBeUndefined();
    });

    it.each([false, true])(
        "keeps a direct async call separate from capture (direct first: %s)",
        async (directFirst) => {
            const capture = createFallbackCapture();
            const typedEntered = promiseWithResolvers<void>();
            const directEntered = promiseWithResolvers<void>();
            const typedGate = promiseWithResolvers<void>();
            const directGate = promiseWithResolvers<void>();

            class Base {
                constructor() {
                    capture.instrumentReceiver(this, "legacy", Base.prototype.legacy);
                }

                async legacy(value: string) {
                    capture.takeRecorder(this)?.(value);
                    return false;
                }
            }

            class Override extends Base {
                #receiver = this;

                override async legacy(value: string) {
                    expect(this.#receiver).toBe(owner);
                    const typed = value === "typed";
                    (typed ? typedEntered : directEntered).resolve();
                    await (typed ? typedGate : directGate).promise;
                    expect(this.#receiver).toBe(owner);
                    return super.legacy(value);
                }
            }

            const owner = new Override();
            const startDirect = () => owner.legacy("direct");
            const startTyped = () => capture.invoke(owner, owner.legacy, "typed");
            const first = directFirst ? startDirect() : startTyped();
            await (directFirst ? directEntered : typedEntered).promise;
            const second = directFirst ? startTyped() : startDirect();
            const secondEntered = vi.fn();
            void (directFirst ? typedEntered : directEntered).promise.then(secondEntered);
            await Promise.resolve();
            expect(secondEntered).not.toHaveBeenCalled();

            // Make the second gate ready first. The queued invocation must still enter second.
            (directFirst ? typedGate : directGate).resolve();
            (directFirst ? directGate : typedGate).resolve();

            const [firstResult, secondResult] = await Promise.all([first, second]);
            expect(directFirst ? firstResult : secondResult).toBe(false);
            expect(directFirst ? secondResult : firstResult).toEqual({
                result: false,
                delegated: { value: "typed" },
            });
        }
    );

    it("shields a re-entrant call and an instrumented ancestor from the outer recorder", async () => {
        const capture = createFallbackCapture();
        class Base {
            constructor() {
                capture.instrumentReceiver(this, "legacy", Base.prototype.legacy);
            }

            async legacy(value: string) {
                capture.takeRecorder(this)?.(value);
                return value;
            }
        }
        class Parent extends Base {
            override async legacy(value: string) {
                await Promise.resolve();
                return super.legacy(value);
            }
        }
        const parent = new Parent();
        const owner = new (class extends Parent {
            override async legacy(value: string) {
                if (value === "outer") {
                    await expect(this.legacy("inner")).resolves.toBe("inner");
                }
                return super.legacy(value);
            }
        })();

        await expect(parent.legacy("direct")).resolves.toBe("direct");
        await expect(capture.invoke(owner, owner.legacy, "outer")).resolves.toEqual({
            result: "outer",
            delegated: { value: "outer" },
        });
    });
});
