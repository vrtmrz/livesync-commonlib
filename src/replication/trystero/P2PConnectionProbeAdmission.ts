import type { ObsidianLiveSyncSettings } from "@lib/common/types";
import { splitP2PRelayUrls } from "@lib/common/models/setting.p2p";

/** Stable decision code for a trial which would extend an active relay binding. */
export const ACTIVE_P2P_RELAY_BINDING_CONFLICT = "active-p2p-relay-binding-conflict" as const;

/** Settings needed to arbitrate a signalling-only P2P connection probe. */
export type P2PConnectionProbeSettings = Pick<ObsidianLiveSyncSettings, "P2P_relays">;

/** Owner settlement for one P2P connection-probe request. */
export type P2PConnectionProbeAdmissionResult<T> =
    | { readonly status: "observed-active" }
    | { readonly status: "trial"; readonly result: T }
    | { readonly status: "blocked"; readonly reason: typeof ACTIVE_P2P_RELAY_BINDING_CONFLICT };

/**
 * Arbitrates a complete short-lived probe against the stable P2P room owner.
 *
 * The continuation owns construction and disposal of its trial resources. It
 * must not await another lifecycle operation on the same P2P service because
 * the owner holds that lifecycle serialisation boundary until it settles.
 */
export interface P2PConnectionProbeAdmission {
    run<T>(
        trialSettings: P2PConnectionProbeSettings,
        runOwnedTrial: () => Promise<T>
    ): Promise<P2PConnectionProbeAdmissionResult<T>>;
}

/**
 * Return whether an active relay set already covers every requested relay.
 *
 * Relay strings are split, trimmed, and de-duplicated. Broader URI
 * canonicalisation would diverge from the key used by the Trystero transport.
 */
export function activeP2PRelayBindingCovers(
    activeSettings: P2PConnectionProbeSettings,
    trialSettings: P2PConnectionProbeSettings
): boolean {
    const activeRelays = new Set(splitP2PRelayUrls(activeSettings.P2P_relays));
    return splitP2PRelayUrls(trialSettings.P2P_relays).every((relay) => activeRelays.has(relay));
}
