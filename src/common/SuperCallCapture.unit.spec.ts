import { promiseWithResolvers } from "octagonal-wheels/promises";
import { describe, expect, it, vi } from "vitest";
import { SuperCallCapture } from "./SuperCallCapture.ts";

function createFallbackCapture() {
    vi.stubGlobal("process", undefined);
    vi.stubGlobal("require", undefined);
    try {
        return new SuperCallCapture<string>("legacy");
    } finally {
        vi.unstubAllGlobals();
    }
}

describe("SuperCallCapture", () => {
    it.each([false, true])("isolates overlapping captures across rejection (reverse: %s)", async (reverse) => {
        const capture = createFallbackCapture();

        const gate = promiseWithResolvers<void>();
        const entered = promiseWithResolvers<void>();
        const failure = new Error("override failed");
        const nextEntered = promiseWithResolvers<void>();
        const nextGate = promiseWithResolvers<void>();
        const owner = {
            async legacy(value: string) {
                if (value === "first") {
                    entered.resolve();
                    await gate.promise;
                    capture.takeRecorder(this)?.(value);
                    throw failure;
                }
                nextEntered.resolve();
                await nextGate.promise;
                capture.takeRecorder(this)?.(value);
                return false;
            },
        };
        const first = capture.invoke(owner, owner.legacy, "first");
        const rejection = expect(first).rejects.toBe(failure);
        const second = capture.invoke(owner, owner.legacy, "second");

        await entered.promise;
        await nextEntered.promise;
        const secondResult = expect(second).resolves.toEqual({ result: false, delegated: { value: "second" } });
        const completions = [
            [gate, rejection],
            [nextGate, secondResult],
        ] as const;
        for (const index of reverse ? [1, 0] : [0, 1]) {
            const [pending, completion] = completions[index];
            pending.resolve();
            await completion;
        }
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
                async legacy(value: string) {
                    capture.takeRecorder(this)?.(value);
                    return false;
                }
            }

            class Override extends Base {
                #receiver = this;

                override legacy = async (value: string) => {
                    expect(this.#receiver).toBe(owner);
                    const typed = value === "typed";
                    (typed ? typedEntered : directEntered).resolve();
                    await (typed ? typedGate : directGate).promise;
                    expect(this.#receiver).toBe(owner);
                    return super.legacy(value);
                };
            }

            const owner = new Override();
            const startDirect = () => owner.legacy("direct");
            const startTyped = () => capture.invoke(owner, owner.legacy, "typed");
            const first = directFirst ? startDirect() : startTyped();
            await (directFirst ? directEntered : typedEntered).promise;
            const second = directFirst ? startTyped() : startDirect();
            await (directFirst ? typedEntered : directEntered).promise;
            directGate.resolve();
            await (directFirst ? first : second);
            typedGate.resolve();

            const [firstResult, secondResult] = await Promise.all([first, second]);
            expect(directFirst ? firstResult : secondResult).toBe(false);
            expect(directFirst ? secondResult : firstResult).toEqual({
                result: false,
                delegated: { value: "typed" },
            });
        }
    );

    it("keeps legacy completion when async stacks are unavailable", async () => {
        const capture = createFallbackCapture();
        const owner = {
            async legacy(wait: boolean) {
                if (wait) {
                    await Promise.resolve();
                }
                capture.takeRecorder(this)?.("base");
                return false;
            },
        };
        const stackTraceLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 0;
        try {
            await expect(capture.invoke(owner, owner.legacy, false)).resolves.toEqual({
                result: false,
                delegated: { value: "base" },
            });
            await expect(capture.invoke(owner, owner.legacy, true)).resolves.toEqual({
                result: false,
                delegated: {},
            });
        } finally {
            Error.stackTraceLimit = stackTraceLimit;
        }
    });

    it("shields a re-entrant call and an instrumented ancestor from the outer recorder", async () => {
        const capture = createFallbackCapture();
        class Base {
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
                    await Promise.resolve();
                    expect(await this.legacy("inner")).toBe("inner");
                }
                return super.legacy(value);
            }
        })();

        await expect(capture.invoke(parent, parent.legacy, "parent")).resolves.toEqual({
            result: "parent",
            delegated: { value: "parent" },
        });
        await expect(capture.invoke(owner, owner.legacy, "outer")).resolves.toEqual({
            result: "outer",
            delegated: { value: "outer" },
        });
    });
});
