import type { P2PReplicationResult } from "./TrysteroReplicator";

/**
 * Stable de-duplication state for automatic baseline transfers.
 *
 * The service owner keeps this object across transport-only room replacement.
 * Completed baselines are reset only for a new application lifecycle or a
 * changed logical peer namespace/local database identity. In-flight work from
 * an older generation may still settle, but cannot publish completion into the
 * current generation.
 */
export class P2PAutomationCoordinator {
    private generation = 0;
    private identity: { readonly namespace: string; readonly database: object } | undefined;
    private readonly completedPeers = new Set<string>();
    private readonly inFlightPeers = new Map<string, Promise<P2PReplicationResult>>();

    beginLifecycle(): void {
        this.generation += 1;
        this.completedPeers.clear();
    }

    reconcileIdentity(namespace: string, database: object): void {
        if (this.identity?.namespace === namespace && this.identity.database === database) return;
        this.identity = { namespace, database };
        this.generation += 1;
        this.completedPeers.clear();
    }

    runBaseline(peerName: string, task: () => Promise<P2PReplicationResult>): Promise<P2PReplicationResult> {
        const key = this.normalisePeerName(peerName);
        if (this.completedPeers.has(key)) {
            return Promise.resolve({ status: "completed", ok: true });
        }
        const current = this.inFlightPeers.get(key);
        if (current) return current;

        const generation = this.generation;
        const operation = task()
            .then((result) => {
                if (result.status === "completed" && generation === this.generation) {
                    this.completedPeers.add(key);
                }
                return result;
            })
            .finally(() => {
                if (this.inFlightPeers.get(key) === operation) {
                    this.inFlightPeers.delete(key);
                }
            });
        this.inFlightPeers.set(key, operation);
        return operation;
    }

    private normalisePeerName(peerName: string): string {
        return peerName.trim().toLocaleLowerCase("en-US");
    }
}
