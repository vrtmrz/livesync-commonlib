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
