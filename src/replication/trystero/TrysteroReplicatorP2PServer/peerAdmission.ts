import { AutoAccepting, type P2PSyncSetting } from "@lib/common/types";
import type { StoredMapLike } from "@lib/dataobject/StoredMap";
import type { Confirm } from "@lib/interfaces/Confirm";
import { shareRunningResult } from "octagonal-wheels/concurrency/lock_v2";
import { bindContext } from "octagonal-wheels/context";
import type { Computed } from "octagonal-wheels/dataobject/Computed";
import { ResponsePreventedError, type Advertisement } from "../types";
import type { P2PPeerAcceptance } from "../replicationTypes";

export type AcceptanceDecision = {
    peerId: string;
    name: string;
    decision: boolean;
    isTemporary: boolean;
};

export type RevokeAcceptanceDecision = {
    peerId: string;
    name: string;
};

/** Host capabilities and dynamic method overrides used for peer admission. */
export interface PeerAdmissionDependencies {
    isEnabled(): boolean;
    advertisement(peerId: string): Advertisement | undefined;
    currentSettings(): P2PSyncSetting;
    acceptedPeers(): Pick<StoredMapLike<boolean>, "get" | "set" | "delete">;
    temporaryAcceptedPeers(): Map<string, boolean>;
    confirm(): Pick<Confirm, "askSelectStringDialogue">;
    dispatchConnectionStatus(): Promise<void>;
    acceptablePatterns(): Pick<Computed<[P2PSyncSetting], RegExp[]>, "update">;
    deniedPatterns(): Pick<Computed<[P2PSyncSetting], RegExp[]>, "update">;
    /** Forward to the host's overridable `_confirmUserToAccept` method. */
    promptPeerAcceptance(peerId: string): Promise<boolean>;
    /** Forward to the host's overridable `evaluatePeerAcceptance` method. */
    evaluatePeerAcceptance(peerId: string): Promise<P2PPeerAcceptance>;
    /** Forward to the host's overridable `confirmUserToAccept` method. */
    confirmUserToAccept(peerId: string): Promise<boolean>;
}

type PeerAdmissionContext<Keys extends keyof PeerAdmissionDependencies> = {
    deps: Pick<PeerAdmissionDependencies, Keys>;
};

type MakeDecisionContext = PeerAdmissionContext<
    "acceptedPeers" | "temporaryAcceptedPeers" | "dispatchConnectionStatus"
>;
type RevokeDecisionContext = MakeDecisionContext;
type PromptPeerAcceptanceContext = PeerAdmissionContext<
    "advertisement" | "confirm" | "temporaryAcceptedPeers" | "acceptedPeers" | "dispatchConnectionStatus"
>;
type ConfirmUserToAcceptContext = PeerAdmissionContext<"promptPeerAcceptance">;
type EvaluatePeerAcceptanceContext = PeerAdmissionContext<
    | "isEnabled"
    | "advertisement"
    | "temporaryAcceptedPeers"
    | "acceptedPeers"
    | "currentSettings"
    | "acceptablePatterns"
    | "deniedPatterns"
>;
type IsAcceptablePeerContext = PeerAdmissionContext<
    | "advertisement"
    | "temporaryAcceptedPeers"
    | "acceptedPeers"
    | "currentSettings"
    | "dispatchConnectionStatus"
    | "evaluatePeerAcceptance"
    | "confirmUserToAccept"
>;

export interface PeerAdmission {
    makeDecision(decision: AcceptanceDecision): Promise<void>;
    revokeDecision(decision: RevokeAcceptanceDecision): Promise<void>;
    confirmUserToAccept(peerId: string): Promise<boolean>;
    promptPeerAcceptance(peerId: string): Promise<boolean>;
    evaluatePeerAcceptance(peerId: string): Promise<P2PPeerAcceptance>;
    isAcceptablePeer(peerId: string): Promise<boolean>;
}

/** Persist a manual peer decision, then publish its updated connection status. */
export async function makeDecision({ deps }: MakeDecisionContext, decision: AcceptanceDecision): Promise<void> {
    if (decision.decision) {
        if (decision.isTemporary) {
            deps.temporaryAcceptedPeers().set(decision.peerId, true);
        } else {
            await deps.acceptedPeers().set(decision.name, true);
        }
    } else if (decision.isTemporary) {
        deps.temporaryAcceptedPeers().set(decision.peerId, false);
    } else {
        await deps.acceptedPeers().set(decision.name, false);
    }
    await deps.dispatchConnectionStatus();
}

/** Remove the temporary and persisted decisions, then publish the updated status. */
export async function revokeDecision(
    { deps }: RevokeDecisionContext,
    decision: RevokeAcceptanceDecision
): Promise<void> {
    deps.temporaryAcceptedPeers().delete(decision.peerId);
    await deps.acceptedPeers().delete(decision.name);
    await deps.dispatchConnectionStatus();
}

/** Ask the user for a peer decision and apply the selected scope immediately. */
export function promptPeerAcceptance({ deps }: PromptPeerAcceptanceContext, peerId: string): Promise<boolean> {
    const peerInfo = deps.advertisement(peerId);
    if (!peerInfo) {
        throw new Error("Unknown Peer");
    }
    const peerName = peerInfo.name;
    const message = `Are you sure to establish connection to ${peerName} (${peerId})?
You can chose as follows:
- Accept: Accept all connections from this peer.
- Ignore: Reject all connections from this peer.
- Accept Temporarily: Accept the connection for this session only.
- Ignore Temporarily: Reject the connection for this session only.

>[!INFO] You can revoke your decision from the Peer-to-Peer Replicator Pane.`;

    const OPTION_ACCEPT = "Accept";
    const OPTION_IGNORE = "Ignore";
    const OPTION_ACCEPT_TEMPORARILY = "Accept Temporarily";
    const OPTION_IGNORE_TEMPORARILY = "Ignore Temporarily";
    const OPTIONS = [OPTION_ACCEPT, OPTION_IGNORE, OPTION_ACCEPT_TEMPORARILY, OPTION_IGNORE_TEMPORARILY] as const;
    return deps
        .confirm()
        .askSelectStringDialogue(message, OPTIONS, {
            title: "P2P Connection Request",
            defaultAction: "Ignore Temporarily",
            timeout: 30,
        })
        .then((decision) => {
            if (decision === OPTION_ACCEPT_TEMPORARILY) {
                deps.temporaryAcceptedPeers().set(peerId, true);
                void deps.dispatchConnectionStatus();
                return true;
            } else if (decision === OPTION_IGNORE_TEMPORARILY) {
                deps.temporaryAcceptedPeers().set(peerId, false);
                void deps.dispatchConnectionStatus();
                return false;
            } else if (decision === OPTION_ACCEPT) {
                deps.temporaryAcceptedPeers().delete(peerId);
                void deps.acceptedPeers().set(peerName, true);
                void deps.dispatchConnectionStatus();
                return true;
            } else if (decision === OPTION_IGNORE) {
                deps.temporaryAcceptedPeers().delete(peerId);
                void deps.acceptedPeers().set(peerName, false);
                void deps.dispatchConnectionStatus();
                return false;
            } else {
                throw new ResponsePreventedError("User Accepting failed");
            }
        });
}

/** Deduplicate simultaneous prompts for the same peer while preserving host overrides. */
export function confirmUserToAccept({ deps }: ConfirmUserToAcceptContext, peerId: string): Promise<boolean> {
    return shareRunningResult(`confirmUserToAccept-${peerId}`, () => deps.promptPeerAcceptance(peerId));
}

/** Evaluate stored and automatic policy without prompting or changing decisions. */
export async function evaluatePeerAcceptance(
    { deps }: EvaluatePeerAcceptanceContext,
    peerId: string
): Promise<P2PPeerAcceptance> {
    if (!deps.isEnabled()) {
        return "unknown";
    }
    const peerInfo = deps.advertisement(peerId);
    if (!peerInfo) {
        return "unknown";
    }
    const peerName = peerInfo.name;
    if (deps.temporaryAcceptedPeers().has(peerId)) {
        return deps.temporaryAcceptedPeers().get(peerId) ? "accepted" : "rejected";
    }
    const accepted = await deps.acceptedPeers().get(peerName);
    if (accepted !== undefined && accepted !== null) {
        return accepted ? "accepted" : "rejected";
    }
    const currentSettings = { ...deps.currentSettings() };
    const isAcceptable = (await deps.acceptablePatterns().update(currentSettings)).value.some((pattern) =>
        pattern.test(peerName)
    );
    const isDeny = (await deps.deniedPatterns().update(currentSettings)).value.some((pattern) =>
        pattern.test(peerName)
    );
    if (isDeny) {
        return "rejected";
    }
    if (isAcceptable || currentSettings.P2P_AutoAccepting === AutoAccepting.ALL) {
        return "accepted";
    }
    return "undecided";
}

/** Enforce automatic admission first, then headless policy and the host prompt override. */
export async function isAcceptablePeer({ deps }: IsAcceptablePeerContext, peerId: string): Promise<boolean> {
    const acceptance = await deps.evaluatePeerAcceptance(peerId);
    if (acceptance === "accepted") {
        const peerName = deps.advertisement(peerId)?.name;
        const persisted = peerName ? await deps.acceptedPeers().get(peerName) : undefined;
        if (!deps.temporaryAcceptedPeers().has(peerId) && persisted == null) {
            deps.temporaryAcceptedPeers().set(peerId, true);
            void deps.dispatchConnectionStatus();
        }
        return true;
    }
    if (acceptance === "rejected" || acceptance === "unknown") {
        return false;
    }
    if (deps.currentSettings().P2P_IsHeadless) {
        return false;
    }
    return await deps.confirmUserToAccept(peerId);
}

/** Compose peer-admission operations from live host capabilities without owning state. */
export function createPeerAdmission(deps: PeerAdmissionDependencies): PeerAdmission {
    return {
        makeDecision: bindContext({ deps }, makeDecision),
        revokeDecision: bindContext({ deps }, revokeDecision),
        confirmUserToAccept: bindContext({ deps }, confirmUserToAccept),
        promptPeerAcceptance: bindContext({ deps }, promptPeerAcceptance),
        evaluatePeerAcceptance: bindContext({ deps }, evaluatePeerAcceptance),
        isAcceptablePeer: bindContext({ deps }, isAcceptablePeer),
    };
}
