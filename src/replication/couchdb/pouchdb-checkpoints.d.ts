declare module "pouchdb-utils" {
    export function uuid(): string;
}

declare module "pouchdb-generate-replication-id" {
    export default function generateReplicationId(
        source: { id(): Promise<string> },
        target: { id(): Promise<string> },
        options: PouchDB.Replication.ReplicateOptions
    ): Promise<string>;
}

declare module "pouchdb-checkpointer" {
    interface CheckpointEndpoint {
        adapter?: string;
        get(id: string): Promise<unknown>;
        put(document: any): Promise<unknown>;
    }
    export default class Checkpointer {
        constructor(
            source: CheckpointEndpoint,
            target: CheckpointEndpoint,
            id: string,
            state: { cancelled: boolean }
        );
        writeCheckpoint(sequence: number | string, session: string): Promise<void>;
        getCheckpoint(): Promise<number | string>;
    }
}
