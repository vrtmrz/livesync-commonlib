// A wrapper around RTCPeerConnection to collect statistics for diagnostics.
import { compatGlobal } from "@lib/common/coreEnvFunctions";
import { LOG_LEVEL_VERBOSE, Logger } from "@lib/common/logger";
import { LOG_LEVEL_DEBUG, LOG_LEVEL_INFO } from "@lib/common/types";
import type {
    DiagRTCConnectionStatus,
    DiagRTCStats,
    DiagRTCPeerConnectionInternalStateHistory,
    DiagRTCFailureDiagnosis,
} from "./DiagRTCPeerConnections.types";
import {
    auditRtcConnectionFailures,
    describeRTCProgress,
    getPeerConnectionStats,
} from "./DiagRTCPeerConnections.utils";

// Total number of RTCPeerConnection instances created, used for generating instance IDs.
let rtcInstanceCounter = 0;
// Counters for connection statistics.
let totalNewConnections = 0;
let totalFailedConnections = 0;
let totalSuccessfulConnections = 0;
let totalClosedConnections = 0;

// Map to store the latest connection status of each RTCPeerConnection instance, keyed by instance ID.
const RTCConnectionStatuses = new Map<string, DiagRTCConnectionStatus>();

// Subscribers for connection status updates and failure diagnoses.
let connectionStatusSubscribers: ((status: DiagRTCStats) => void)[] = [];
let failureDiagnosisSubscribers: ((diagnosis: DiagRTCFailureDiagnosis) => void)[] = [];

// Debug-Level logging of RTCPeerConnection progress.
function logRtcProgress(instanceId: string, eventName: string, peer: RTCPeerConnection) {
    Logger(
        `[DiagRTC:${instanceId}] ${eventName}: connection=${peer.connectionState}, iceConnection=${peer.iceConnectionState}, iceGathering=${peer.iceGatheringState}, signaling=${peer.signalingState}`,
        LOG_LEVEL_DEBUG
    );
}

// -- Dispatchers

function dispatchStatus(status: DiagRTCConnectionStatus) {
    const details: Record<string, DiagRTCConnectionStatus> = Object.fromEntries(RTCConnectionStatuses);
    for (const subscriber of connectionStatusSubscribers) {
        try {
            subscriber({
                totalNewConnections,
                totalFailedConnections,
                totalSuccessfulConnections,
                totalClosedConnections,
                details,
            });
        } catch {
            // Ignore errors in subscribers to avoid breaking the main logic.
        }
    }
}

function dispatchFailureDiagnosis(diagnosis: DiagRTCFailureDiagnosis) {
    for (const subscriber of failureDiagnosisSubscribers) {
        try {
            subscriber(diagnosis);
        } catch {
            // Ignore errors in subscribers to avoid breaking the main logic.
        }
    }
}

// -- Public API

/**
 * Subscribes to connection status updates. The callback will be called with the latest connection statistics whenever there is a change in the connection status of any RTCPeerConnection instance.
 * Returns an unsubscribe function to stop receiving updates.
 *
 * @param callback - The function to call with the latest connection statistics.
 * @returns A function that can be called to unsubscribe from updates.
 */
export function subscribeConnectionStatus(callback: (status: DiagRTCStats) => void) {
    connectionStatusSubscribers.push(callback);
    return () => {
        connectionStatusSubscribers = connectionStatusSubscribers.filter((cb) => cb !== callback);
    };
}

/**
 * Subscribes to failure diagnosis updates. The callback will be called with the diagnosis information whenever a connection failure is detected in any RTCPeerConnection instance.
 * Returns an unsubscribe function to stop receiving updates.
 * @param callback - The function to call with the diagnosis information.
 * @returns A function that can be called to unsubscribe from updates.
 */
export function subscribeFailureDiagnosis(callback: (diagnosis: DiagRTCFailureDiagnosis) => void) {
    failureDiagnosisSubscribers.push(callback);
    return () => {
        failureDiagnosisSubscribers = failureDiagnosisSubscribers.filter((cb) => cb !== callback);
    };
}

export type DiagRTCPeerConnectionConstructor = typeof RTCPeerConnection;
/**
 * A wrapper around RTCPeerConnection to collect statistics for diagnostics.
 * It extends the native (or globally-polyfilled) RTCPeerConnection and overrides its constructor to add event listeners for connection state changes,
 * ice connection state changes, ice gathering state changes, and signaling state changes. It maintains a history of these states and logs the progress.
 * It also tracks the number of new connections, failed connections, successful connections, and closed connections, and dispatches this information to subscribers.
 */
export function createDiagRTCPeerConnectionConstructor(): DiagRTCPeerConnectionConstructor {
    if (typeof compatGlobal.RTCPeerConnection === "undefined") {
        throw new Error("RTCPeerConnection is not available in the current environment.");
    }
    return class DiagRTCPeerConnection extends compatGlobal.RTCPeerConnection {
        /**
         * Internal unique identifier for this RTCPeerConnection instance, used for tracking and logging purposes.
         */
        private readonly __instanceId: string;
        /**
         * A flag to ensure that failure statistics are logged only once per failure event, to avoid duplicate logs in case of multiple related state changes.
         */
        private __failureStatsLogged = false;
        /**
         * Histories of connection states
         */
        private _connectionStateHistory: RTCPeerConnection["connectionState"][] = [];
        /**
         * Histories of ice connection states
         */
        private _iceConnectionHistory: RTCPeerConnection["iceConnectionState"][] = [];
        /**
         * Histories of ice gathering states
         */
        private _iceGatheringHistory: RTCPeerConnection["iceGatheringState"][] = [];
        /**
         * Histories of signaling states
         */
        private _signalingHistory: RTCPeerConnection["signalingState"][] = [];

        /**
         * Last known connection state, used to detect changes and update statistics accordingly.
         */
        private _previousConnectionState: RTCPeerConnection["connectionState"] | undefined = undefined;

        /**
         * Returns the internal state history of this RTCPeerConnection instance, including connection state history, ice connection state history,
         * ice gathering state history, and signaling state history.
         * This is used for diagnostics and failure analysis.
         */
        get stateHistory() {
            return {
                connectionHistory: this._connectionStateHistory,
                iceConnectionHistory: this._iceConnectionHistory,
                iceGatheringHistory: this._iceGatheringHistory,
                signalingHistory: this._signalingHistory,
            } satisfies DiagRTCPeerConnectionInternalStateHistory;
        }

        private _logProgress(eventName: string) {
            logRtcProgress(this.__instanceId, eventName, this);
        }

        /**
         * Notifies subscribers about the current connection progress, including the latest connection state and ice connection state, as well as the overall progress of the connection based on the state history.
         * @param status The current connection status, including connection state and ice connection state.
         */
        private async notifyConnectionProgress(status: DiagRTCConnectionStatus) {
            const metrics = await getPeerConnectionStats(this.__instanceId, this);
            const progress = describeRTCProgress(this.stateHistory, metrics?.selectedPair);
            Logger(`[DiagRTC:${this.__instanceId}]: ${progress}`, LOG_LEVEL_INFO);
            Logger(
                `[DiagRTC:${this.__instanceId}] status: connection=${status.connectionState}, iceConnection=${status.iceConnectionState}`,
                LOG_LEVEL_VERBOSE
            );
        }
        /**
         * Tracks the connection progress of this RTCPeerConnection instance, updating statistics and notifying subscribers as needed.
         * @param instanceId The unique identifier of this RTCPeerConnection instance.
         * @param status The current connection status, including connection state and ice connection state.
         */
        private trackConnectionProgress() {
            const status = {
                connectionState: this.connectionState,
                iceConnectionState: this.iceConnectionState,
            };
            const instanceId = this.__instanceId;
            if (status.connectionState === "closed" || status.connectionState === "failed") {
                RTCConnectionStatuses.delete(instanceId);
            } else {
                RTCConnectionStatuses.set(instanceId, status);
            }
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
                void this.notifyConnectionProgress(status);
                dispatchStatus(status);
            }
        }
        /**
         * Analyses the failure of this RTCPeerConnection instance using the state history and selected pair information, and dispatches the diagnosis to subscribers.
         */
        private async analyseFailureAndDispatch() {
            const history = this.stateHistory;
            const diagnosis = await auditRtcConnectionFailures(this.__instanceId, history, this);
            if (diagnosis) {
                dispatchFailureDiagnosis(diagnosis.diagnosis);
            }
        }
        constructor(configuration?: RTCConfiguration) {
            super(configuration);
            rtcInstanceCounter += 1;
            this.__instanceId = `rtc-${rtcInstanceCounter}`;
            this._logProgress("created");
            this.addEventListener("connectionstatechange", () => {
                this._connectionStateHistory.push(this.connectionState);
                this._logProgress("connectionstatechange");
                this.trackConnectionProgress();
                if (this.connectionState !== "failed") {
                    this.__failureStatsLogged = false;
                }
                if (this.connectionState === "failed" && !this.__failureStatsLogged) {
                    this.__failureStatsLogged = true;
                    void this.analyseFailureAndDispatch();
                }
            });

            this.addEventListener("iceconnectionstatechange", () => {
                this._iceConnectionHistory.push(this.iceConnectionState);
                this._logProgress("iceconnectionstatechange");
                this.trackConnectionProgress();
                // reset the flag with iceConnectionState, not only connectionState.
                if (this.iceConnectionState !== "failed" && this.connectionState !== "failed") {
                    this.__failureStatsLogged = false;
                }
                if (
                    (this.connectionState === "failed" || this.iceConnectionState === "failed") &&
                    !this.__failureStatsLogged
                ) {
                    this.__failureStatsLogged = true;
                    void this.analyseFailureAndDispatch();
                }
            });
            this.addEventListener("icegatheringstatechange", () => {
                this._iceGatheringHistory.push(this.iceGatheringState);
                this._logProgress("icegatheringstatechange");
            });
            this.addEventListener("signalingstatechange", () => {
                this._signalingHistory.push(this.signalingState);
                this._logProgress("signalingstatechange");
            });
            // icecandidateerror produces so much logs, hence commenting out for now.
            // this.addEventListener("icecandidateerror", (ev) => {
            //     logIceCandidateError(this.__instanceId, ev);
            // });
        }
    };
}
