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
export type DiagRTCPeerConnectionInternalStateHistory = {
    connectionHistory: RTCPeerConnection["connectionState"][];
    iceConnectionHistory: RTCPeerConnection["iceConnectionState"][];
    iceGatheringHistory: RTCPeerConnection["iceGatheringState"][];
    signalingHistory: RTCPeerConnection["signalingState"][];
};
export const DiagRTCFailureReasonCodes = {
    ICE_GATHERING_NOT_COMPLETED: "ICE_GATHERING_NOT_COMPLETED",
    ICE_CONNECTIVITY_FAILED: "ICE_CONNECTIVITY_FAILED",
    STUN_REQUEST_TIMEOUT: "STUN_REQUEST_TIMEOUT",
    SIGNALING_NOT_STABLE: "SIGNALING_NOT_STABLE",
    CONNECTION_DROPPED_AFTER_ESTABLISHED: "CONNECTION_DROPPED_AFTER_ESTABLISHED",
    NETWORK_INTERRUPTED: "NETWORK_INTERRUPTED",
    UNKNOWN: "UNKNOWN",
} as const;
export type DiagRTCFailureDiagnosis = {
    reasonCode: keyof typeof DiagRTCFailureReasonCodes;
    userMessage: string;
};

export type DiagRTCFailureStats = {
    diagnosis: DiagRTCFailureDiagnosis;
    stats: {
        reportsCount: number;
        selectedPair: {
            id: string;
            state: string;
            localCandidateId: string;
            remoteCandidateId: string;
            currentRoundTripTime: number | "unknown";
            totalRoundTripTime: number | "unknown";
            requestsSent: number | "unknown";
            responsesReceived: number | "unknown";
            packetsDiscardedOnSend: number | "unknown";
            bytesSent: number | "unknown";
            bytesReceived: number | "unknown";
        };
    };
};

export type DiagRTCPeerConnectionMetrics = {
    selectedPair: Record<string, unknown> | undefined;
    selectedPairId: string;
    state: string;
    localCandidateId: string;
    remoteCandidateId: string;
    currentRoundTripTime: number | "unknown";
    totalRoundTripTime: number | "unknown";
    requestsSent: number | "unknown";
    responsesReceived: number | "unknown";
    packetsDiscardedOnSend: number | "unknown";
    bytesSent: number | "unknown";
    bytesReceived: number | "unknown";
    // raw
    reports: unknown[];
};
