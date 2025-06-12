import { EventHub } from "octagonal-wheels/events.js";

declare global {
    interface LSEvents {
        hello: string;
        world: undefined;
    }
}

export const eventHub = new EventHub<LSEvents>();
