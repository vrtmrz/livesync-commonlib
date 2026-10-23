declare const commandTypes: unique symbol;

/** An immutable declaration which associates a stable name with request and result types. */
export interface UICommand<Request, Result> {
    readonly id: string;
    readonly [commandTypes]?: {
        readonly request: (value: Request) => Request;
        readonly result: (value: Result) => Result;
    };
}

/** Declare a command without registering it in any global state. */
export function declareUICommand<Request, Result>(id: string): UICommand<Request, Result> {
    return Object.freeze({ id }) as UICommand<Request, Result>;
}

type RegisteredCommand = {
    readonly command: object;
    readonly handler: (input: unknown) => unknown;
};

/** Instance-owned command handlers for one host or service composition. */
export class UICommandRegistry {
    private readonly definitions = new Map<string, object>();
    private readonly handlers = new Map<string, RegisteredCommand>();
    private disposed = false;

    register<Request, Result>(
        command: UICommand<Request, Result>,
        handler: (request: NoInfer<Request>) => NoInfer<Result> | Promise<NoInfer<Result>>
    ): () => void {
        if (this.disposed) {
            throw new Error("Cannot register a UI command on a disposed registry");
        }

        const knownDefinition = this.definitions.get(command.id);
        if (knownDefinition !== undefined && knownDefinition !== command) {
            throw new Error(`A conflicting command definition is already known for '${command.id}'`);
        }

        if (this.handlers.has(command.id)) {
            throw new Error(`A handler is already registered for '${command.id}'`);
        }

        this.definitions.set(command.id, command);
        const entry: RegisteredCommand = {
            command,
            handler: (input) => handler(input as Request),
        };
        this.handlers.set(command.id, entry);

        let active = true;
        return () => {
            if (!active) return;
            active = false;
            if (this.handlers.get(command.id) === entry) {
                this.handlers.delete(command.id);
            }
        };
    }

    async invoke<Request, Result>(
        command: UICommand<Request, Result>,
        input: NoInfer<Request>
    ): Promise<{ status: "handled"; value: Result } | { status: "unavailable" }> {
        if (this.disposed) {
            return { status: "unavailable" };
        }

        const entry = this.handlers.get(command.id);
        if (entry === undefined || entry.command !== command) {
            return { status: "unavailable" };
        }

        return {
            status: "handled",
            value: (await entry.handler(input)) as Result,
        };
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.handlers.clear();
        this.definitions.clear();
    }
}
