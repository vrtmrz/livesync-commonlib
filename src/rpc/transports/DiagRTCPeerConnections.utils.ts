import { Logger, LOG_LEVEL_DEBUG, LOG_LEVEL_INFO } from "@lib/common/logger";
import {
    type DiagRTCPeerConnectionInternalStateHistory,
    type DiagRTCFailureDiagnosis,
    type DiagRTCPeerConnectionMetrics,
    type DiagRTCFailureStats,
    DiagRTCFailureReasonCodes,
} from "./DiagRTCPeerConnections.types";

// Utility functions for analysing RTCPeerConnection states and failures.
function asFiniteNumber(value: unknown): number | undefined {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function formatHistory<T extends string>(history: readonly T[]): string {
    return history.length > 0 ? history.join(">") : "none";
}

function getLastOrFallback<T>(items: readonly T[], fallback: T): T {
    if (items.length === 0) return fallback;
    return items[items.length - 1] ?? fallback;
}

function tryGetValue<T extends string | number>(record: Record<string, unknown>, key: string): T | "unknown" {
    const value = record[key];
    if (typeof value === "string" || typeof value === "number") {
        return value as T;
    }
    return "unknown";
}

function maskIdentifier(value: string): string {
    if (value === "unknown") return value;
    if (value.length <= 8) return "[id]";
    return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Diagnoses the failure reason of a failed RTCPeerConnection based on its internal state history and selected candidate pair information.
 * @param internalStateHistory The internal state history of the RTCPeerConnection.
 * @param selectedPair The selected candidate pair information.
 * @returns The diagnosis of the RTC failure.
 */
export function diagnoseRtcFailure(
    internalStateHistory: DiagRTCPeerConnectionInternalStateHistory,
    selectedPair: Record<string, unknown> | undefined
): DiagRTCFailureDiagnosis {
    const hasSelectedPair = !!selectedPair;
    const selectedPairState = (selectedPair?.state as string | undefined) ?? "unknown";
    const requestsSent = asFiniteNumber(selectedPair?.requestsSent);
    const responsesReceived = asFiniteNumber(selectedPair?.responsesReceived);

    // ICE: (Interactive Connectivity Establishment) is the process of gathering network candidates and checking connectivity. It has its own state machine (iceGatheringState and iceConnectionState).
    // The overall connection state (connectionState) is influenced by the ICE states but also includes other factors, such as signaling state and application-level issues.
    //
    // ICE gathering state (iceGatheringState)
    // iceGatheringState: new > gathering > complete
    //
    // meaning of states:
    // - new: connection is created, but no network gathering has started.
    // - gathering: connection is gathering network candidates.
    //     If the connection fails in this state, it often indicates network issues (e.g. VPN/proxy/firewall blocking).
    // - complete: ICE gathering is complete.
    //     If the connection fails after this state, it often indicates that the network path is established but the connectivity check failed (e.g. due to UDP being blocked).
    //
    // ICE connection state (iceConnectionState)
    // iceConnectionState: new > checking > connected/failed/disconnected can go back to checking > connected/failed/disconnected
    //
    // meaning of states:
    //
    // - new: connection is created, but no connectivity check has started.
    // - checking: connection is checking connectivity with the gathered candidates.
    //     If the connection fails in this state, it often indicates that a network path could not be established (e.g. due to strict firewall rules).
    // - connected: connection is established and working.
    // - failed: connection attempt failed. This can be due to various reasons, such as network issues, incompatibility between peers, or transient issues.
    //     Diagnosing the exact reason often requires looking at the state history and candidate pair information.
    // - disconnected: connection was established but then lost. This often indicates network interruptions after a successful connection.
    //
    // total connection state (connectionState)
    // connectionState: new > connecting > connected/failed/disconnected can go back to connecting > connected/failed/disconnected
    //
    // meaning of states:
    // - new: connection is created, but no connection attempt has started.
    // - connecting: connection is in the process of being established. It may go through multiple cycles of connecting > connected/failed/disconnected as it tries different candidates or recovers from failures.
    // - connected: connection is established and working.
    // - failed: connection attempt failed. Similar to iceConnectionState "failed", but at a higher level.
    //     It can be caused by various reasons, and diagnosing it often requires looking at the state history and candidate pair information.
    // - disconnected: connection was established but then lost. Similar to iceConnectionState "disconnected", but at a higher level. It often indicates network interruptions after a successful connection.
    //
    // Signaling state (signalingState)
    // signalingState: stable > have-local-offer / have-remote-offer / have-local-pranswer / have-remote-pranswer > stable
    // meaning of states:
    // - stable: no offer/answer exchange is in progress. This is the normal state when the connection is established and idle.
    // - have-local-offer: local peer has created an offer and is waiting for the remote peer to respond.
    // - have-remote-offer: remote peer has created an offer and is waiting for the local peer to respond.
    // - have-local-pranswer / have-remote-pranswer: provisional answer has been sent/received, but the final answer has not been sent/received yet.
    //     If the connection fails in a non-stable signaling state, it often indicates that the offer/answer exchange did not complete successfully (e.g. due to incompatibility between peers or issues in the signaling process).

    const hasIceGatheringStarted = internalStateHistory.iceGatheringHistory.includes("gathering");
    const hasIceGatheringComplete = internalStateHistory.iceGatheringHistory.includes("complete");
    const hasIceChecking = internalStateHistory.iceConnectionHistory.includes("checking");
    const hasIceConnected = internalStateHistory.iceConnectionHistory.includes("connected");
    const hasIceFailed = internalStateHistory.iceConnectionHistory.includes("failed");
    const hasIceDisconnected = internalStateHistory.iceConnectionHistory.includes("disconnected");
    const hasConnectionConnected = internalStateHistory.connectionHistory.includes("connected");
    const hasConnectionFailed = internalStateHistory.connectionHistory.includes("failed");
    const hasSignalingStable = internalStateHistory.signalingHistory.includes("stable");

    // Diagnose based on state history and candidate pair information.
    // Very heuristic, but should be helpful for common failure scenarios.
    if (!hasSelectedPair && hasIceGatheringStarted && !hasIceGatheringComplete) {
        // ICE gathering started but no candidate was successfully gathered. This often indicates network issues, such as VPN/proxy/firewall blocking.
        return {
            reasonCode: DiagRTCFailureReasonCodes.ICE_GATHERING_NOT_COMPLETED,
            userMessage:
                "Connection could not collect enough network candidates. Check VPN, proxy, or firewall settings.",
        };
    }

    if (hasIceChecking && hasIceFailed && !hasIceConnected) {
        return {
            reasonCode: DiagRTCFailureReasonCodes.ICE_CONNECTIVITY_FAILED,
            userMessage: "Connection attempt reached candidate checks but no route was established.",
        };
    }

    if (
        hasSelectedPair &&
        selectedPairState !== "succeeded" &&
        (requestsSent ?? 0) > 0 &&
        (responsesReceived ?? 0) === 0
    ) {
        return {
            reasonCode: DiagRTCFailureReasonCodes.STUN_REQUEST_TIMEOUT,
            userMessage: "Connection requests were sent but no response was returned. Network path may block UDP/STUN.",
        };
    }

    if (!hasSignalingStable) {
        return {
            reasonCode: DiagRTCFailureReasonCodes.SIGNALING_NOT_STABLE,
            userMessage: "Connection negotiation did not reach a stable signalling state.",
        };
    }

    if (hasConnectionConnected && hasConnectionFailed) {
        return {
            reasonCode: DiagRTCFailureReasonCodes.CONNECTION_DROPPED_AFTER_ESTABLISHED,
            userMessage: "Connection was established once, but dropped afterwards.",
        };
    }

    if (hasIceDisconnected && hasIceFailed) {
        return {
            reasonCode: DiagRTCFailureReasonCodes.NETWORK_INTERRUPTED,
            userMessage: "Connection was interrupted while exchanging data.",
        };
    }

    return {
        reasonCode: DiagRTCFailureReasonCodes.UNKNOWN,
        userMessage: "Connection failed for an unknown reason. Please retry and collect diagnostics.",
    };
}

/**
 * Describes the current progress of the RTCPeerConnection based on its internal state history and selected candidate pair information.
 *  This is useful for providing user-friendly status messages during the connection process.
 * @param internalStateHistory The internal state history of the RTCPeerConnection.
 * @param selectedPair The selected candidate pair information.
 * @returns A user-friendly description of the current connection progress.
 */
export function describeRTCProgress(
    internalStateHistory: DiagRTCPeerConnectionInternalStateHistory,
    selectedPair: Record<string, unknown> | undefined
): string {
    const lastConnectionState = getLastOrFallback(internalStateHistory.connectionHistory, "new");
    const lastIceConnectionState = getLastOrFallback(internalStateHistory.iceConnectionHistory, "new");
    const lastIceGatheringState = getLastOrFallback(internalStateHistory.iceGatheringHistory, "new");
    const lastSignalingState = getLastOrFallback(internalStateHistory.signalingHistory, "stable");
    const pairState = tryGetValue<string>(selectedPair ?? {}, "state");
    const requestsSent = tryGetValue<number>(selectedPair ?? {}, "requestsSent");
    const responsesReceived = tryGetValue<number>(selectedPair ?? {}, "responsesReceived");

    if (lastConnectionState === "connected" || lastIceConnectionState === "connected") {
        return `Connected (pair=${pairState})`;
    }

    if (lastConnectionState === "failed" || lastIceConnectionState === "failed") {
        const diagnosis = diagnoseRtcFailure(internalStateHistory, selectedPair);
        return `Failed (${diagnosis.reasonCode})`;
    }

    if (lastIceConnectionState === "checking") {
        if (requestsSent !== "unknown" && responsesReceived !== "unknown") {
            return `Checking connectivity (responses ${responsesReceived}/${requestsSent})`;
        }
        return "Checking connectivity";
    }

    if (lastIceGatheringState === "gathering") {
        return "Gathering network candidates";
    }

    if (lastSignalingState !== "stable") {
        return `Negotiating signalling (${lastSignalingState})`;
    }

    if (lastConnectionState === "connecting" || lastIceConnectionState === "new") {
        return "Starting peer connection";
    }

    return `Verbose state: State=${lastConnectionState}, ice=${lastIceConnectionState}, pair=${pairState}`;
}

/**
 * Fetches the RTCPeerConnection statistics and returns a structured metrics object.
 * This is useful for diagnosing connection issues and understanding the connection performance.
 * @param instanceId An identifier for the RTCPeerConnection instance, used for logging.
 * @param peer The RTCPeerConnection instance to fetch stats from.
 * @returns A structured object containing the connection metrics, or undefined if fetching stats failed.
 */
export async function getPeerConnectionStats(
    instanceId: string,
    peer: RTCPeerConnection
): Promise<DiagRTCPeerConnectionMetrics | undefined> {
    try {
        const stats = await peer.getStats();
        const reports: unknown[] = [];
        stats.forEach((value) => {
            reports.push(value);
        });
        const selectedPair = reports
            .map((r) => r as Record<string, unknown>)
            .find((r) => {
                return r.type === "candidate-pair" && (r.selected === true || r.nominated === true);
            });
        const selectedPairId = tryGetValue<string>(selectedPair ?? {}, "id") ?? "none";
        const state = tryGetValue<string>(selectedPair ?? {}, "state");
        const localCandidateId = tryGetValue<string>(selectedPair ?? {}, "localCandidateId");
        const remoteCandidateId = tryGetValue<string>(selectedPair ?? {}, "remoteCandidateId");
        const currentRoundTripTime = tryGetValue<number>(selectedPair ?? {}, "currentRoundTripTime");
        const totalRoundTripTime = tryGetValue<number>(selectedPair ?? {}, "totalRoundTripTime");
        const requestsSent = tryGetValue<number>(selectedPair ?? {}, "requestsSent");
        const responsesReceived = tryGetValue<number>(selectedPair ?? {}, "responsesReceived");
        const packetsDiscardedOnSend = tryGetValue<number>(selectedPair ?? {}, "packetsDiscardedOnSend");
        const bytesSent = tryGetValue<number>(selectedPair ?? {}, "bytesSent");
        const bytesReceived = tryGetValue<number>(selectedPair ?? {}, "bytesReceived");
        return {
            selectedPair,
            selectedPairId,
            state,
            localCandidateId,
            remoteCandidateId,
            currentRoundTripTime,
            totalRoundTripTime,
            requestsSent,
            responsesReceived,
            packetsDiscardedOnSend,
            bytesSent,
            bytesReceived,
            // raw
            reports,
        };
    } catch (ex) {
        Logger(
            `[DiagRTC:${instanceId}] progress/getStats threw: ${ex instanceof Error ? ex.message : String(ex)}`,
            LOG_LEVEL_DEBUG
        );
        return undefined;
    }
}

/**
 * Audits the RTCPeerConnection for failures and returns a structured failure report.
 * This is useful for diagnosing connection issues and understanding the reasons for failure.
 * @param instanceId An identifier for the RTCPeerConnection instance, used for logging.
 * @param internalStateHistory The internal state history of the RTCPeerConnection.
 * @param peer The RTCPeerConnection instance to audit.
 * @returns A structured object containing the failure diagnosis and metrics, or undefined if auditing failed.
 */
export async function auditRtcConnectionFailures(
    instanceId: string,
    internalStateHistory: DiagRTCPeerConnectionInternalStateHistory,
    peer: RTCPeerConnection
): Promise<DiagRTCFailureStats | undefined> {
    try {
        const stats = await getPeerConnectionStats(instanceId, peer);
        if (!stats) {
            Logger(
                `[DiagRTC:${instanceId}] failed/getStats: Unable to retrieve connection statistics.`,
                LOG_LEVEL_INFO
            );
            return undefined;
        }
        const reports = stats.reports;
        const diagnosis = diagnoseRtcFailure(internalStateHistory, stats.selectedPair);
        const connectionHistory = formatHistory(internalStateHistory.connectionHistory);
        const iceConnectionHistory = formatHistory(internalStateHistory.iceConnectionHistory);
        const iceGatheringHistory = formatHistory(internalStateHistory.iceGatheringHistory);
        const signalingHistory = formatHistory(internalStateHistory.signalingHistory);
        const maskedSelectedPairId = maskIdentifier(String(stats.selectedPairId));
        const maskedLocalCandidateId = maskIdentifier(String(stats.localCandidateId));
        const maskedRemoteCandidateId = maskIdentifier(String(stats.remoteCandidateId));

        Logger(
            `[DiagRTC:${instanceId}] failed/summary: reasonCode=${diagnosis.reasonCode}, userMessage="${diagnosis.userMessage}", history.connection=${connectionHistory}, history.iceConnection=${iceConnectionHistory}, history.iceGathering=${iceGatheringHistory}, history.signaling=${signalingHistory}`,
            LOG_LEVEL_INFO
        );

        Logger(
            `[DiagRTC:${instanceId}] failed/getStats/detail: reports=${reports.length}, reasonCode=${diagnosis.reasonCode}, userMessage="${diagnosis.userMessage}", history.connection=${connectionHistory}, history.iceConnection=${iceConnectionHistory}, history.iceGathering=${iceGatheringHistory}, history.signaling=${signalingHistory}, selectedPair=${maskedSelectedPairId}, pairState=${stats.state}, localCandidate=${maskedLocalCandidateId}, remoteCandidate=${maskedRemoteCandidateId}, rtt=${stats.currentRoundTripTime}, totalRtt=${stats.totalRoundTripTime}, requestsSent=${stats.requestsSent}, responsesReceived=${stats.responsesReceived}, packetsDiscardedOnSend=${stats.packetsDiscardedOnSend}, bytesSent=${stats.bytesSent}, bytesReceived=${stats.bytesReceived}`,
            LOG_LEVEL_DEBUG
        );
        return {
            diagnosis,
            stats: {
                reportsCount: reports.length,
                selectedPair: {
                    id: maskedSelectedPairId,
                    state: stats.state,
                    localCandidateId: maskedLocalCandidateId,
                    remoteCandidateId: maskedRemoteCandidateId,
                    currentRoundTripTime: stats.currentRoundTripTime,
                    totalRoundTripTime: stats.totalRoundTripTime,
                    requestsSent: stats.requestsSent,
                    responsesReceived: stats.responsesReceived,
                    packetsDiscardedOnSend: stats.packetsDiscardedOnSend,
                    bytesSent: stats.bytesSent,
                    bytesReceived: stats.bytesReceived,
                },
            },
        };
    } catch (ex) {
        Logger(
            `[DiagRTC:${instanceId}] failed/getStats threw: ${ex instanceof Error ? ex.message : String(ex)}`,
            LOG_LEVEL_DEBUG
        );
    }
}
