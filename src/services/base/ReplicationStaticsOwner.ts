import { reactive, reactiveSource, type ReactiveValue } from "octagonal-wheels/dataobject/reactive";
import {
    DEFAULT_REPLICATION_STATICS,
    type PublishedReplicationStatics,
    type ReplicationStatics,
} from "@lib/common/models/shared.definition.ts";

/** A reactive source which accepts raw statistics and returns published values. */
export interface ReplicationStaticsSource {
    get value(): PublishedReplicationStatics;
    set value(value: ReplicationStatics);
    onChanged: ReactiveValue<PublishedReplicationStatics>["onChanged"];
    offChanged: ReactiveValue<PublishedReplicationStatics>["offChanged"];
}

/** Own the publication timestamp and initial state for replication statistics. */
export class ReplicationStaticsOwner {
    private readonly state = reactiveSource<PublishedReplicationStatics>(
        Object.freeze({ ...DEFAULT_REPLICATION_STATICS })
    );
    private readonly view = reactive(() => this.state.value);
    readonly source: ReplicationStaticsSource;

    constructor() {
        const owner = this;
        this.source = {
            get value() {
                return owner.state.value;
            },
            set value(value) {
                owner.publish(value);
            },
            onChanged: (handler) => owner.view.onChanged(handler),
            offChanged: (handler) => owner.view.offChanged(handler),
        };
    }

    reset(): void {
        this.state.value = Object.freeze({ ...DEFAULT_REPLICATION_STATICS });
    }

    private publish(value: ReplicationStatics): void {
        this.state.value = Object.freeze({ ...value, statsUpdatedAt: Date.now() });
    }
}
