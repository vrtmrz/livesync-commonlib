import { EventHub } from "octagonal-wheels/events";

declare global {
    interface LSEvents {
        hello: string;
        world: undefined;
    }
}

/** An event hub owned by one Commonlib service context. */
export type LiveSyncEventHub = EventHub<LSEvents>;

/** Creates an isolated event hub for one Commonlib client or host composition. */
export function createLiveSyncEventHub(): LiveSyncEventHub {
    return new EventHub<LSEvents>();
}

/**
 * Process-global compatibility hub used while existing services migrate to `ServiceContext.events`.
 *
 * @deprecated Receive an instance-owned hub from a service context.
 */
export const eventHub = createLiveSyncEventHub();
