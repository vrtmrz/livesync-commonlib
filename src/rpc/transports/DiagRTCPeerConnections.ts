// A wrapper around RTCPeerConnection to collect statistics for diagnostics.
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { Logger } from "@lib/common/logger";
import { LOG_LEVEL_DEBUG } from "@lib/common/types";

export type DiagRTCConnectionStatus = {
    connectionState: RTCPeerConnection["connectionState"];
    iceConnectionState: RTCPeerConnection["iceConnectionState"];
};

export type DiagRTCStats = {
    totalNewConnections: number;
    totalFailedConnections: number;
    totalSuccessfulConnections: number;
    totalClosedConnections: number;
    details: Record<string, DiagRTCConnectionStatus>;
};

let rtcInstanceCounter = 0;
let totalNewConnections = 0;
let totalFailedConnections = 0;
let totalSuccessfulConnections = 0;
let totalClosedConnections = 0;

const RTCConnectionStatuses = new Map<string, DiagRTCConnectionStatus>();

let connectionStatusSubscribers: ((status: DiagRTCStats) => void)[] = [];

function logRtcProgress(instanceId: string, eventName: string, peer: RTCPeerConnection) {
    Logger(
        `[DiagRTC:${instanceId}] ${eventName}: connection=${peer.connectionState}, iceConnection=${peer.iceConnectionState}, iceGathering=${peer.iceGatheringState}, signaling=${peer.signalingState}`,
        LOG_LEVEL_DEBUG
    );
}

function logIceCandidateError(instanceId: string, ev: Event) {
    const eventLike = ev as Event & {
        errorCode?: number;
        errorText?: string;
        url?: string;
        address?: string;
        port?: number;
    };
    Logger(
        `[DiagRTC:${instanceId}] icecandidateerror: code=${eventLike.errorCode ?? "unknown"}, text=${eventLike.errorText ?? ""}, url=${eventLike.url ?? ""}, address=${eventLike.address ?? ""}, port=${eventLike.port ?? ""}`,
        LOG_LEVEL_DEBUG
    );
}

async function logRtcFailureStats(instanceId: string, peer: RTCPeerConnection) {
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
        const selectedPairId = (selectedPair?.id as string | undefined) ?? "none";
        const state = (selectedPair?.state as string | undefined) ?? "unknown";
        const localCandidateId = (selectedPair?.localCandidateId as string | undefined) ?? "unknown";
        const remoteCandidateId = (selectedPair?.remoteCandidateId as string | undefined) ?? "unknown";
        const currentRoundTripTime = (selectedPair?.currentRoundTripTime as number | undefined) ?? "unknown";
        const totalRoundTripTime = (selectedPair?.totalRoundTripTime as number | undefined) ?? "unknown";
        const requestsSent = (selectedPair?.requestsSent as number | undefined) ?? "unknown";
        const responsesReceived = (selectedPair?.responsesReceived as number | undefined) ?? "unknown";
        const packetsDiscardedOnSend = (selectedPair?.packetsDiscardedOnSend as number | undefined) ?? "unknown";
        const bytesSent = (selectedPair?.bytesSent as number | undefined) ?? "unknown";
        const bytesReceived = (selectedPair?.bytesReceived as number | undefined) ?? "unknown";

        Logger(
            `[DiagRTC:${instanceId}] failed/getStats: reports=${reports.length}, selectedPair=${selectedPairId}, pairState=${state}, localCandidate=${localCandidateId}, remoteCandidate=${remoteCandidateId}, rtt=${currentRoundTripTime}, totalRtt=${totalRoundTripTime}, requestsSent=${requestsSent}, responsesReceived=${responsesReceived}, packetsDiscardedOnSend=${packetsDiscardedOnSend}, bytesSent=${bytesSent}, bytesReceived=${bytesReceived}`,
            LOG_LEVEL_DEBUG
        );
    } catch (ex) {
        Logger(
            `[DiagRTC:${instanceId}] failed/getStats threw: ${ex instanceof Error ? ex.message : String(ex)}`,
            LOG_LEVEL_DEBUG
        );
    }
}

export function subscribeConnectionStatus(callback: (status: DiagRTCStats) => void) {
    connectionStatusSubscribers.push(callback);
    return () => {
        connectionStatusSubscribers = connectionStatusSubscribers.filter((cb) => cb !== callback);
    };
}

export type DiagRTCPeerConnectionConstructor = typeof RTCPeerConnection;

/**
 * A wrapper around RTCPeerConnection to collect statistics for diagnostics.
 * It has the same API as RTCPeerConnection, but it notifies the connection status changes to the subscribers.
 */

export function createDiagRTCPeerConnectionConstructor(): DiagRTCPeerConnectionConstructor {
    if (typeof compatGlobal.RTCPeerConnection === "undefined") {
        throw new Error("RTCPeerConnection is not available in the current environment.");
    }
    return class DiagRTCPeerConnection extends compatGlobal.RTCPeerConnection {
        private readonly __instanceId: string;
        private __failureStatsLogged = false;

        private _previousConnectionState: RTCPeerConnection["connectionState"] | undefined = undefined;
        notifyConnectionStatus(instanceId: string, status: DiagRTCConnectionStatus) {
            if (this._previousConnectionState != status.connectionState) {
                if (status.connectionState === "connected") {
                    totalSuccessfulConnections += 1;
                }
                if (status.connectionState === "failed") {
                    totalFailedConnections += 1;
                }
                if (status.connectionState === "new") {
                    totalNewConnections += 1;
                }
                if (status.connectionState === "closed") {
                    totalClosedConnections += 1;
                }
                this._previousConnectionState = status.connectionState;
                for (const subscriber of connectionStatusSubscribers) {
                    try {
                        subscriber({
                            totalNewConnections: totalNewConnections,
                            totalFailedConnections,
                            totalSuccessfulConnections,
                            totalClosedConnections,
                            details: Object.fromEntries(RTCConnectionStatuses),
                        });
                    } catch {
                        // Ignore errors in subscribers to avoid breaking the main logic.
                    }
                }
            }
            if (status.connectionState === "closed" || status.connectionState === "failed") {
                RTCConnectionStatuses.delete(instanceId);
            } else {
                RTCConnectionStatuses.set(instanceId, status);
            }
        }
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            rtcInstanceCounter += 1;
            this.__instanceId = `rtc-${rtcInstanceCounter}`;
            logRtcProgress(this.__instanceId, "created", this);
            // this.notifyConnectionStatus(this.__instanceId, {
            //     connectionState: this.connectionState,
            //     iceConnectionState: this.iceConnectionState,
            // });
            this.addEventListener("connectionstatechange", () => {
                logRtcProgress(this.__instanceId, "connectionstatechange", this);
                this.notifyConnectionStatus(this.__instanceId, {
                    connectionState: this.connectionState,
                    iceConnectionState: this.iceConnectionState,
                });
                if (this.connectionState !== "failed") {
                    this.__failureStatsLogged = false;
                }
                if (this.connectionState === "failed" && !this.__failureStatsLogged) {
                    this.__failureStatsLogged = true;
                    void logRtcFailureStats(this.__instanceId, this);
                }
            });
            this.addEventListener("iceconnectionstatechange", () => {
                logRtcProgress(this.__instanceId, "iceconnectionstatechange", this);
                this.notifyConnectionStatus(this.__instanceId, {
                    connectionState: this.connectionState,
                    iceConnectionState: this.iceConnectionState,
                });
                if (this.iceConnectionState !== "failed" && this.connectionState !== "failed") {
                    this.__failureStatsLogged = false;
                }
                if (
                    (this.connectionState === "failed" || this.iceConnectionState === "failed") &&
                    !this.__failureStatsLogged
                ) {
                    this.__failureStatsLogged = true;
                    void logRtcFailureStats(this.__instanceId, this);
                }
            });
            this.addEventListener("icegatheringstatechange", () => {
                logRtcProgress(this.__instanceId, "icegatheringstatechange", this);
            });
            this.addEventListener("signalingstatechange", () => {
                logRtcProgress(this.__instanceId, "signalingstatechange", this);
            });
            this.addEventListener("icecandidateerror", (ev) => {
                logIceCandidateError(this.__instanceId, ev);
            });
        }
    };
}
