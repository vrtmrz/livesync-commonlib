import { vi } from "vitest";
import { serveBackgroundWorker } from "../serveBackgroundWorker.ts";

export class LoopbackWorker extends EventTarget {
    private readonly channel = new MessageChannel();
    private server?: ReturnType<typeof serveBackgroundWorker>;
    deliverRequests = true;
    readonly ready = new Promise<void>((resolve) => {
        this.channel.port1.addEventListener("message", () => resolve(), { once: true });
    });
    readonly postMessage = vi.fn((data: unknown, transfer: Transferable[] = []) => {
        if (this.deliverRequests) {
            this.channel.port1.postMessage(data, transfer);
        }
    });
    readonly terminate = vi.fn(() => {
        this.server?.close();
        this.channel.port1.close();
        this.channel.port2.close();
    });

    constructor(start: boolean) {
        super();
        this.channel.port1.addEventListener("message", ({ data }) => {
            this.dispatchEvent(new MessageEvent("message", { data }));
        });
        this.channel.port1.start();
        if (start) {
            this.start();
        }
    }

    start(): void {
        this.server = serveBackgroundWorker(this.channel.port2);
    }

    crash(message: string): void {
        this.dispatchEvent(Object.assign(new Event("error"), { message }));
    }
}
