import { describe, expect, it, vi } from "vitest";
import { createServiceContext } from "@lib/services/base/ServiceBase";
import { createServiceFeature, serviceFeature } from "./ServiceModule";

describe("service feature composition helpers", () => {
    it("retains the feature and its borrowed collaborators without invoking them during definition", async () => {
        const log = vi.fn();
        const open = vi.fn(async () => "opened");
        const result = Promise.resolve({ open });
        const feature = vi.fn((dependencies: { readonly log: (message: string) => void }, label = "ready") => {
            dependencies.log(label);
            return result;
        });

        const useFeature = createServiceFeature(feature);

        expect(feature).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        expect(open).not.toHaveBeenCalled();
        expect(useFeature).toBe(feature);
        expect(useFeature({ log }, "selected")).toBe(result);
        expect(log).toHaveBeenCalledExactlyOnceWith("selected");
        expect((await result).open).toBe(open);
    });

    it("propagates a synchronous composition failure unchanged", () => {
        const failure = new Error("composition failed");
        const useFeature = createServiceFeature(() => {
            throw failure;
        });

        expect(() => useFeature()).toThrow(failure);
    });

    it("creates a fresh context from the selected host for each invocation", () => {
        const firstHost = { services: { context: createServiceContext() }, serviceModules: {} };
        const secondHost = { services: { context: createServiceContext() }, serviceModules: {} };
        const log = vi.fn();
        const suppliedContext = { _log: vi.fn(), sequence: -1, selectedContext: firstHost.services.context };
        let sequence = 0;
        const factory = vi.fn((host: typeof firstHost) => ({
            _log: log,
            sequence: ++sequence,
            selectedContext: host.services.context,
        }));
        const feature = vi.fn((_host: typeof firstHost, context: ReturnType<typeof factory>) => context);
        const useFeature = serviceFeature<never, never>()
            .withContext(factory)
            .create<ReturnType<typeof factory>>(feature);

        expect(factory).not.toHaveBeenCalled();
        expect(feature).not.toHaveBeenCalled();

        const first = useFeature(firstHost, suppliedContext);
        const second = useFeature(secondHost, suppliedContext);

        expect(factory).toHaveBeenNthCalledWith(1, firstHost);
        expect(factory).toHaveBeenNthCalledWith(2, secondHost);
        expect(feature).toHaveBeenNthCalledWith(1, firstHost, first);
        expect(feature).toHaveBeenNthCalledWith(2, secondHost, second);
        expect(first).toBe(factory.mock.results[0].value);
        expect(second).toBe(factory.mock.results[1].value);
        expect(first).toEqual({ _log: log, sequence: 1, selectedContext: firstHost.services.context });
        expect(second).toEqual({ _log: log, sequence: 2, selectedContext: secondHost.services.context });
        expect(first).not.toBe(second);
        expect(first).not.toBe(suppliedContext);
        expect(suppliedContext.sequence).toBe(-1);
    });

    it.each(["factory", "feature"] as const)("preserves a contextual %s failure", (source) => {
        const failure = new Error(`${source} failed`);
        const host = { services: { context: createServiceContext() }, serviceModules: {} };
        const factory = vi.fn(() => {
            if (source === "factory") throw failure;
            return { _log: vi.fn() };
        });
        const feature = vi.fn(() => {
            throw failure;
        });
        const useFeature = serviceFeature<never, never>().withContext(factory).create(feature);

        expect(() => useFeature(host, { _log: vi.fn() })).toThrow(failure);
        expect(factory).toHaveBeenCalledExactlyOnceWith(host);
        expect(feature).toHaveBeenCalledTimes(source === "factory" ? 0 : 1);
    });

    it("keeps explicit service selection and additional arguments in the builder", () => {
        const context = createServiceContext();
        const useFeature = serviceFeature<never, never>().create((host, suffix = "default") => ({
            selectedContext: host.services.context,
            suffix,
        }));

        expect(useFeature({ services: { context }, serviceModules: {} }, "selected")).toEqual({
            selectedContext: context,
            suffix: "selected",
        });
    });
});
