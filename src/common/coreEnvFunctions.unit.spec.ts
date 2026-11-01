import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function createHost() {
    const response = new Response("host response");
    const fetch = vi.fn(function (this: unknown, _input: RequestInfo | URL, _init?: RequestInit) {
        return Promise.resolve(response);
    });
    return {
        host: {
            fetch,
            document: { name: "default document" },
            activeDocument: { name: "active document" } as { name: string } | null | undefined,
        },
        response,
        fetch,
    };
}

beforeEach(() => {
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("legacy environment snapshots", () => {
    it("selects the window and binds its fetch receiver", async () => {
        const { host, response, fetch } = createHost();
        const otherFetch = vi.fn();
        vi.stubGlobal("window", host);
        vi.stubGlobal("fetch", otherFetch);

        const { compatGlobal, _activeDocument, _fetch } = await import("./coreEnvFunctions");
        expect(compatGlobal).toBe(host);
        expect(_activeDocument).toBe(host.activeDocument);
        expect(fetch).not.toHaveBeenCalled();

        const init = { method: "HEAD" };
        await expect(_fetch("https://example.invalid/resource", init)).resolves.toBe(response);
        expect(fetch).toHaveBeenCalledExactlyOnceWith("https://example.invalid/resource", init);
        expect(fetch.mock.contexts[0]).toBe(host);
        expect(otherFetch).not.toHaveBeenCalled();
    });

    it.each([undefined, null])("falls back to document when activeDocument is %s", async (activeDocument) => {
        const { host } = createHost();
        host.activeDocument = activeDocument;
        vi.stubGlobal("window", host);

        const { _activeDocument } = await import("./coreEnvFunctions");
        expect(_activeDocument).toBe(host.document);
    });

    it("uses globalThis without requiring a document when window is absent", async () => {
        const { fetch, response } = createHost();
        vi.stubGlobal("window", undefined);
        vi.stubGlobal("fetch", fetch);
        vi.stubGlobal("activeDocument", undefined);
        vi.stubGlobal("document", undefined);

        const { compatGlobal, _activeDocument, _fetch } = await import("./coreEnvFunctions");
        expect(compatGlobal).toBe(globalThis);
        expect(_activeDocument).toBeUndefined();
        await expect(_fetch("https://example.invalid/resource")).resolves.toBe(response);
        expect(fetch.mock.contexts[0]).toBe(globalThis);
    });

    it("retains the selected object, bound fetch, and document after initialisation", async () => {
        const first = createHost();
        const second = createHost();
        const selectedDocument = first.host.activeDocument;
        vi.stubGlobal("window", first.host);

        const { compatGlobal, _activeDocument, _fetch } = await import("./coreEnvFunctions");
        vi.stubGlobal("window", second.host);
        first.host.fetch = second.fetch;
        first.host.activeDocument = second.host.activeDocument;
        first.host.document = second.host.document;

        expect(compatGlobal).toBe(first.host);
        expect(_activeDocument).toBe(selectedDocument);
        await expect(_fetch("https://example.invalid/resource")).resolves.toBe(first.response);
        expect(first.fetch).toHaveBeenCalledExactlyOnceWith("https://example.invalid/resource");
        expect(first.fetch.mock.contexts[0]).toBe(first.host);
        expect(second.fetch).not.toHaveBeenCalled();
    });

    it("retains the legacy import failure when the selected object has no fetch", async () => {
        vi.stubGlobal("window", { document: { name: "document" } });

        await expect(import("./coreEnvFunctions")).rejects.toBeInstanceOf(TypeError);
    });
});
