import { middlewares } from "./MiddlewareUtils";
import { describe, it, expect } from "vitest";
describe("MiddlewareManager", () => {
    it("should execute middlewares in order and return final result", async () => {
        const example = middlewares<{
            isTargetFile: (file: string) => Promise<boolean>;
        }>();
        const x = example.useMiddleware("isTargetFile");
        x.use(10, async (ctx, file) => {
            console.log("Middleware 1: Checking if file is target by duplication: " + file);
            const result = await ctx.next();
            console.log("Middleware 1: Result from next middleware: " + result);
            return result;
        });
        x.use(20, async (ctx, file) => {
            console.log("Middleware 2: Checking if file is target by local database: " + file);
            const result = await ctx.next();
            console.log("Middleware 2: Result from next middleware: " + result);
            return result;
        });
        x.setFinal(async (file) => {
            console.log("Final function: Checking if file is target by default logic: " + file);
            await Promise.resolve(); // Simulate async operation
            return false; // Default logic, for example, we can return false to indicate it's not a target.
        });

        const result = await x.invoke("test.txt");
        expect(result).toBe(false); // Since the final function returns false, we expect the result to be false.
    });
    describe("should allow middlewares to short-circuit the chain, respects priority", async () => {
        const example = middlewares<{
            isTargetFile: (file: string) => Promise<boolean>;
        }>();
        const x = example.useMiddleware("isTargetFile");
        x.use(20, async (ctx, file) => {
            console.log("Middleware 2: Checking if file is target by local database: " + file);
            // const result = await ctx.next();
            console.log(
                "Middleware 2: Short-circuiting the chain and returning true, indicating it's a target file: " + file
            );
            return true; // Short-circuit the chain and return true, indicating it's a target file.
        });
        let calledUnused20 = false;
        // This middleware should not be executed because the previous middleware short-circuits the chain.
        // Priority is the same as the previous middleware, but since this middleware is added later, it should be executed after the previous middleware if the previous middleware calls next(), but in this case, the previous middleware does not call next(), so this middleware should not be executed.
        x.use(20, async (ctx, file) => {
            console.log("Middleware 2: Checking if file is target by local database: " + file);
            const result = await ctx.next();
            calledUnused20 = true;
            console.log(
                "Middleware 2: Short-circuiting the chain and returning true, indicating it's a target file: " + file
            );
            return false; // Short-circuit the chain and return true, indicating it's a target file.
        });
        let called30 = false;
        x.use(30, async (ctx, file) => {
            called30 = true;
            console.log(
                "Middleware 3: This middleware should not be executed because the previous middleware short-circuits the chain: " +
                    file
            );
            const result = await ctx.next();

            console.log("Middleware 3: Result from next middleware: " + result);
            return result;
        });
        x.use(10, async (ctx, file) => {
            console.log("Middleware 1: Checking if file is target by duplication: " + file);
            const result = await ctx.next();
            console.log("Middleware 1: Result from next middleware: " + result);
            return result;
        });

        let finalCalled = false;
        x.setFinal(async (file) => {
            console.log("Final function: Checking if file is target by default logic: " + file);
            finalCalled = true;
            await Promise.resolve(); // Simulate async operation
            return false; // Default logic, for example, we can return false to indicate it's not a target.
        });
        it("should execute middlewares in order and return final result", async () => {
            const result = await x.invoke("test.txt");
            expect(result).toBe(true); // Since the second middleware short-circuits and returns true, we expect the result to be true
            expect(finalCalled).toBe(false); // Since the second middleware short-circuits, the final function should not be called.
            expect(called30).toBe(false); // Since the second middleware short-circuits, the third middleware should not be called.
            expect(calledUnused20).toBe(false); // Since the second middleware short-circuits, the unused middleware should not be called.
        });
    });
});
describe("MiddlewareManager error handling", () => {
    const example = middlewares<{
        isTargetFile: (file: string) => Promise<boolean>;
    }>();

    const x = example.useMiddleware("isTargetFile");
    x.use(10, async (ctx, file) => {
        console.log("Middleware 1: Checking if file is target by duplication: " + file);
        const result = await ctx.next();
        console.log("Middleware 1: Result from next middleware: " + result);
        return result;
    });
    x.use(20, async (ctx, file) => {
        console.log("Middleware 2: Checking if file is target by local database: " + file);
        throw new Error("Database error"); // Simulate an error in the middleware
    });
    x.setFinal(async (file) => {
        console.log("Final function: Checking if file is target by default logic: " + file);
        await Promise.resolve(); // Simulate async operation
        return false; // Default logic, for example, we can return false to indicate it's not a target.
    });
    it("should propagate errors from middlewares", async () => {
        try {
            await x.invoke("test.txt");
            throw new Error("Expected error was not thrown");
        } catch (error) {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toBe("Database error");
        }
    });
});
