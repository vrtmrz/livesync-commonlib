/**
 * Shared replication data contracts. Keep these independent of the facade,
 * operation factories, and transport implementations so adapters can use the
 * same types without importing the code they support.
 */
import type { ProgressInfo, ReplicationStatistics } from "@lib/pouchdb/ReplicatorShim";

/**
 * Local replication outcome. Error-compatible values remain available to callers;
 * the wire adapter converts them to JSON-safe data before transport.
 */
export type P2PReplicationResult =
    | { readonly status: "completed"; readonly ok: true; readonly error?: never }
    | { readonly status: "cancelled"; readonly ok?: false; readonly error?: never }
    | { readonly status: "failed"; readonly ok?: false; readonly error: unknown };

/** Sequence progress retained for compatibility, with independently observed work counts. */
export type P2PReplicationDirectionProgress = {
    max: number;
    current: number;
    isActive: boolean;
    statistics?: ReplicationStatistics;
};

export type P2PReplicationProgress = {
    peerId: string;
    peerName: string;
    fetching: P2PReplicationDirectionProgress;
    sending: P2PReplicationDirectionProgress;
};
export type P2PReplicationReport = {
    peerId: string;
    peerName: string;
} & ({ fetching: P2PReplicationDirectionProgress } | { sending: P2PReplicationDirectionProgress });

export type P2PConfiguredTargetResult = {
    readonly name: string;
    readonly peerId?: string;
} & (
    | { readonly status: "completed" }
    | { readonly status: "cancelled" }
    | { readonly status: "missing" }
    | { readonly status: "rejected" }
    | { readonly status: "undecided" }
    | { readonly status: "failed"; readonly error: unknown }
);

/** Explicit result of configured, unattended P2P target synchronisation. */
export type P2PConfiguredReplicationResult =
    | {
          readonly status: "completed";
          readonly targets: readonly P2PConfiguredTargetResult[];
      }
    | {
          readonly status: "cancelled";
          readonly targets: readonly P2PConfiguredTargetResult[];
      }
    | {
          readonly status: "blocked";
          readonly reason: "no-targets";
          readonly targets: readonly [];
      }
    | {
          readonly status: "partial";
          readonly targets: readonly P2PConfiguredTargetResult[];
      };

/** Transient attempt correlation; no replication checkpoint is stored here. */
export type ProgressAcknowledgement = { attempt: number; finalProgress?: ProgressInfo };
export type AcknowledgedProgressAttempt = { attempt: number; isActive: boolean; checkedChanges: number };

/** Non-interactive result of evaluating the persisted and automatic peer policy. */
export type P2PPeerAcceptance = "accepted" | "rejected" | "undecided" | "unknown";
