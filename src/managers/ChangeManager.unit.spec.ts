import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PouchDB from "pouchdb-core";
import MemoryAdapter from "pouchdb-adapter-memory";
import { ChangeManager, type ChangeManagerCallback } from "./ChangeManager.ts";

// Set up PouchDB with memory adapter
PouchDB.plugin(MemoryAdapter);
const PROMISE_SLEEP = 10;
interface TestDocument {
    _id: string;
    _rev?: string;
    data: string;
}

describe("ChangeManager", () => {
    let db: PouchDB.Database<TestDocument>;
    let changeManager: ChangeManager<TestDocument>;

    beforeEach(() => {
        // Create a new in-memory database for each test
        db = new PouchDB<TestDocument>("test-db", { adapter: "memory" });
        changeManager = new ChangeManager<TestDocument>({ database: db });
    });

    afterEach(async () => {
        // Clean up after each test
        changeManager.teardown();
        await db.destroy();
    });

    it("should initialise with a database", () => {
        expect(changeManager._database).toBe(db);
        expect(changeManager._callbacks).toEqual([]);
        expect(changeManager._changes).toBeDefined();
    });

    it("should add a callback and return an unsubscribe function", () => {
        const callback = vi.fn();
        const unsubscribe = changeManager.addCallback(callback);

        expect(changeManager._callbacks.length).toBe(1);
        expect(typeof unsubscribe).toBe("function");

        // Unsubscribe
        unsubscribe();
        expect(changeManager._callbacks.length).toBe(0);
    });

    it("should add multiple callbacks", () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();

        changeManager.addCallback(callback1);
        changeManager.addCallback(callback2);

        expect(changeManager._callbacks.length).toBe(2);
    });

    it("should remove a specific callback using removeCallback", () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();

        changeManager.addCallback(callback1);
        changeManager.addCallback(callback2);

        expect(changeManager._callbacks.length).toBe(2);

        changeManager.removeCallback(callback1);
        expect(changeManager._callbacks.length).toBe(1);
        expect(changeManager._callbacks[0].deref()).toBe(callback2);
    });

    it("should invoke callbacks when a document is added", async () => {
        const callback = vi.fn();
        changeManager.addCallback(callback);

        // Add a document to trigger a change
        await db.put({ _id: "doc1", data: "test data" });

        // Wait for the change event to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "doc1",
                doc: expect.objectContaining({
                    _id: "doc1",
                    data: "test data",
                }),
            })
        );
    });

    it("should invoke callbacks when a document is updated", async () => {
        const callback = vi.fn();

        // Add a document first
        const result = await db.put({ _id: "doc1", data: "initial data" });

        // Wait for initial change
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Now add the callback
        changeManager.addCallback(callback);

        // Update the document
        await db.put({ _id: "doc1", _rev: result.rev, data: "updated data" });

        // Wait for the change event to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "doc1",
                doc: expect.objectContaining({
                    _id: "doc1",
                    data: "updated data",
                }),
            })
        );
    });

    it("should invoke callbacks when a document is deleted", async () => {
        const callback = vi.fn();

        // Add a document first
        const result = await db.put({ _id: "doc1", data: "test data" });

        // Wait for initial change
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Now add the callback
        changeManager.addCallback(callback);

        // Delete the document
        await db.remove("doc1", result.rev);

        // Wait for the change event to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(1);
        expect(callback).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "doc1",
                deleted: true,
            })
        );
    });

    it("should invoke multiple callbacks when a change occurs", async () => {
        const callback1 = vi.fn();
        const callback2 = vi.fn();

        changeManager.addCallback(callback1);
        changeManager.addCallback(callback2);

        // Add a document to trigger a change
        await db.put({ _id: "doc1", data: "test data" });

        // Wait for the change event to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback1).toHaveBeenCalledTimes(1);
        expect(callback2).toHaveBeenCalledTimes(1);
    });

    it("should not invoke callbacks after unsubscribe", async () => {
        const callback = vi.fn();
        const unsubscribe = changeManager.addCallback(callback);

        // Unsubscribe before making changes
        unsubscribe();

        // Add a document to trigger a change
        await db.put({ _id: "doc1", data: "test data" });

        // Wait for potential change event
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).not.toHaveBeenCalled();
    });

    it("should support async callbacks", async () => {
        let callbackExecuted = false;
        const asyncCallback: ChangeManagerCallback = async (change) => {
            await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));
            callbackExecuted = true;
        };

        changeManager.addCallback(asyncCallback);

        // Add a document to trigger a change
        await db.put({ _id: "doc1", data: "test data" });

        // Wait for the async callback to complete
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP * 2));

        expect(callbackExecuted).toBe(true);
    });

    it("should clean up dead WeakRefs when processing changes", async () => {
        // Create a callback and let it be garbage collected
        let callback: ChangeManagerCallback | null = vi.fn();
        const weakRef = new WeakRef(callback);
        changeManager.addCallback(weakRef.deref()!);
        // Simulate the callback being garbage collected
        callback = null;

        try {
            globalThis.gc?.();
            globalThis.gc?.();
            await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));
        } catch (e) {
            // If gc is not available, we can't reliably test this behavior
            console.warn("Garbage collection is not available. Skipping this part of the test.");
            console.warn(e);
            return;
        }

        // Force the callback list to have the dead WeakRef
        // (In real scenario, this would happen naturally with GC)

        // Add a live callback
        const liveCallback = vi.fn();
        changeManager.addCallback(liveCallback);

        // Trigger a change
        await db.put({ _id: "doc1", data: "test data" });

        // Wait for the change event to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // The live callback should be invoked
        expect(liveCallback).toHaveBeenCalledTimes(1);
    });

    it("should teardown the changes listener", async () => {
        expect(changeManager._changes).toBeDefined();

        changeManager.teardown();

        expect(changeManager._changes).toBeUndefined();

        // Callback should not be invoked after teardown
        const callback = vi.fn();
        changeManager.addCallback(callback);

        await db.put({ _id: "doc1", data: "test data" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).not.toHaveBeenCalled();
    });

    it("should restart the watch", async () => {
        const callback = vi.fn();
        changeManager.addCallback(callback);

        // Add a document before restart
        await db.put({ _id: "doc1", data: "before restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(1);

        // Restart the watch
        changeManager.restartWatch();

        // Add another document after restart
        await db.put({ _id: "doc2", data: "after restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Callback should be invoked again (total of 2 times)
        expect(callback).toHaveBeenCalledTimes(2);

        // Restart the watch again
        changeManager.restartWatch();
        await db.put({ _id: "doc3", data: "after second restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Callback should be invoked again (total of 3 times)
        expect(callback).toHaveBeenCalledTimes(3);
    });

    it("should accept unexpected setupListener", async () => {
        const callback = vi.fn();
        changeManager.addCallback(callback);

        // Add a document before restart
        await db.put({ _id: "doc1", data: "before restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(1);

        // Restart the watch
        changeManager.restartWatch();

        // Add another document after restart
        await db.put({ _id: "doc2", data: "after restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Callback should be invoked again (total of 2 times)
        expect(callback).toHaveBeenCalledTimes(2);

        // Force setupListener to be called again (simulate unexpected call)
        changeManager.setupListener();
        await db.put({ _id: "doc3", data: "after second restart" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Callback should be invoked again (total of 3 times)
        expect(callback).toHaveBeenCalledTimes(3);
    });

    it("should only listen to changes since 'now' (not historical)", async () => {
        // Add a document before creating the change manager
        await db.put({ _id: "doc1", data: "before manager" });

        // Create a new change manager
        const newDb = new PouchDB<TestDocument>("test-db-2", { adapter: "memory" });
        await newDb.put({ _id: "doc1", data: "before manager" });

        const newManager = new ChangeManager<TestDocument>({ database: newDb });
        const callback = vi.fn();
        newManager.addCallback(callback);

        // Wait a bit
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Should not receive the historical change
        expect(callback).not.toHaveBeenCalled();

        // Add a new document
        await newDb.put({ _id: "doc2", data: "after manager" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Should receive the new change
        expect(callback).toHaveBeenCalledTimes(1);

        // Clean up
        newManager.teardown();
        await newDb.destroy();
    });

    it("should handle multiple sequential changes", async () => {
        const callback = vi.fn();
        changeManager.addCallback(callback);

        // Add multiple documents
        await db.put({ _id: "doc1", data: "data1" });
        await db.put({ _id: "doc2", data: "data2" });
        await db.put({ _id: "doc3", data: "data3" });

        // Wait for all changes to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(3);
    });

    it("should handle rapid bulk changes", async () => {
        const callback = vi.fn();
        changeManager.addCallback(callback);

        // Add multiple documents in bulk
        const docs = Array.from({ length: 10 }, (_, i) => ({
            _id: `doc${i}`,
            data: `data${i}`,
        }));

        await db.bulkDocs(docs);

        // Wait for all changes to be processed
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        expect(callback).toHaveBeenCalledTimes(10);
    });

    it("should not invoke callbacks if there are no registered callbacks", async () => {
        // No callbacks registered
        expect(changeManager._callbacks.length).toBe(0);

        // Add a document (should not cause any errors)
        await db.put({ _id: "doc1", data: "test data" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // No assertions needed, just ensuring no errors occur
    });

    it("should handle callback exceptions gracefully", async () => {
        const errorCallback: ChangeManagerCallback = () => {
            throw new Error("Test error");
        };
        const normalCallback = vi.fn();

        changeManager.addCallback(errorCallback);
        changeManager.addCallback(normalCallback);
        // Add a document to trigger the callbacks
        await db.put({ _id: "doc1", data: "test data" });
        await new Promise((resolve) => setTimeout(resolve, PROMISE_SLEEP));

        // Normal callback should still be called even if one callback throws an error
        expect(normalCallback).toHaveBeenCalledTimes(1);
    });
});
