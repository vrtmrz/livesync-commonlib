import { createLiveSyncEventHub, type LiveSyncEventHub } from "@lib/hub/hub";
import {
    passthroughMessageTranslator,
    type MessageTranslator,
} from "@lib/services/base/MessageTranslator";

/** Capabilities shared by services which belong to one Commonlib client. */
export interface ServiceContextOptions {
    /** An isolated event channel. A new channel is created when omitted. */
    events?: LiveSyncEventHub;
    /** Host-provided message translation. Keys pass through unchanged when omitted. */
    translate?: MessageTranslator;
}

/** Instance-owned capabilities shared by a composed set of Commonlib services. */
export class ServiceContext {
    readonly events: LiveSyncEventHub;
    readonly translate: MessageTranslator;

    constructor(options: ServiceContextOptions = {}) {
        this.events = options.events ?? createLiveSyncEventHub();
        this.translate = options.translate ?? passthroughMessageTranslator;
    }
}

/** Creates a service context without requiring a subclass. */
export function createServiceContext(options: ServiceContextOptions = {}): ServiceContext {
    return new ServiceContext(options);
}

export abstract class ServiceBase<T extends ServiceContext> {
    protected context: T;
    constructor(context: T) {
        this.context = context;
    }
}
