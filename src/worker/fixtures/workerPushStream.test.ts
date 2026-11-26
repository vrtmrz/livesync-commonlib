import { promiseWithResolvers } from "octagonal-wheels/promises";
import { vi } from "vitest";
import { isStringItem, measureStringItem } from "../workerPushStreamProtocol.ts";

export const limits = { isItem: isStringItem, chargeItem: measureStringItem, maxItemBytes: 128 * 1024 };
export const batch = (items: readonly string[]) => ({
    version: 1,
    type: "batch",
    items,
    chargeBytes: items.reduce((charge, item) => charge + measureStringItem(item), 0),
});

export async function* items(values: readonly string[]): AsyncGenerator<string> {
    yield* values;
}

export async function collect(stream: AsyncIterable<readonly string[]>): Promise<(readonly string[])[]> {
    const batches: (readonly string[])[] = [];
    for await (const items of stream) {
        batches.push(items);
    }
    return batches;
}

export function receive(port: MessagePort) {
    const messages: unknown[] = [];
    port.addEventListener("message", ({ data }) => messages.push(data));
    port.start();
    return messages;
}

export function captureChannel(): MessageChannel {
    const NativeMessageChannel = globalThis.MessageChannel;
    const channel = new NativeMessageChannel();
    let captured = false;
    vi.stubGlobal(
        "MessageChannel",
        class {
            port1: MessagePort;
            port2: MessagePort;
            constructor() {
                if (!captured) {
                    captured = true;
                    this.port1 = channel.port1;
                    this.port2 = channel.port2;
                } else {
                    const extra = new NativeMessageChannel();
                    this.port1 = extra.port1;
                    this.port2 = extra.port2;
                }
            }
        }
    );
    return channel;
}

export function nextMessage(port: MessagePort): Promise<unknown> {
    const message = promiseWithResolvers<unknown>();
    port.addEventListener("message", ({ data }) => message.resolve(data), { once: true });
    port.start();
    return message.promise;
}
