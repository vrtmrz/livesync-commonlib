import { describe, expect, it, vi } from "vitest";
import { evaluateReadiness, type ReadinessCondition } from "./ReadinessEvaluator.ts";

interface TestContext {
    readonly includeConditional: boolean;
}

describe("evaluateReadiness", () => {
    it("evaluates applicable conditions in declaration order", async () => {
        const calls: string[] = [];
        const context: TestContext = { includeConditional: true };
        const conditions: ReadinessCondition<TestContext>[] = [
            {
                name: "first",
                evaluate: async () => {
                    calls.push("first");
                    return true;
                },
            },
            {
                name: "conditional",
                appliesTo: (current) => current.includeConditional,
                evaluate: () => {
                    calls.push("conditional");
                    return true;
                },
            },
        ];

        await expect(evaluateReadiness({ purpose: "test-operation", context, conditions })).resolves.toEqual({
            ready: true,
            purpose: "test-operation",
        });
        expect(calls).toEqual(["first", "conditional"]);
    });

    it("skips inapplicable conditions without evaluating them", async () => {
        const evaluateConditional = vi.fn(() => true);
        const context: TestContext = { includeConditional: false };

        await expect(
            evaluateReadiness({
                purpose: "test-operation",
                context,
                conditions: [
                    {
                        name: "conditional",
                        appliesTo: (current) => current.includeConditional,
                        evaluate: evaluateConditional,
                    },
                ],
            })
        ).resolves.toEqual({ ready: true, purpose: "test-operation" });
        expect(evaluateConditional).not.toHaveBeenCalled();
    });

    it("reports the first rejected condition and short-circuits later work", async () => {
        const rejected = vi.fn();
        const later = vi.fn(() => true);
        const context: TestContext = { includeConditional: true };

        await expect(
            evaluateReadiness({
                purpose: "test-operation",
                context,
                conditions: [
                    { name: "blocked", evaluate: () => false, onRejected: rejected },
                    { name: "later", evaluate: later },
                ],
            })
        ).resolves.toEqual({
            ready: false,
            purpose: "test-operation",
            rejectedCondition: "blocked",
        });
        expect(rejected).toHaveBeenCalledWith(context);
        expect(later).not.toHaveBeenCalled();
    });

    it("propagates evaluation errors without reporting a policy rejection", async () => {
        const error = new Error("condition failed unexpectedly");
        const rejected = vi.fn();

        await expect(
            evaluateReadiness({
                purpose: "test-operation",
                context: { includeConditional: true },
                conditions: [
                    {
                        name: "throws",
                        evaluate: async () => {
                            throw error;
                        },
                        onRejected: rejected,
                    },
                ],
            })
        ).rejects.toBe(error);
        expect(rejected).not.toHaveBeenCalled();
    });
});
