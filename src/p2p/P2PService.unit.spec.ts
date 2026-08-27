import { describe, expect, it } from "vitest";
import type { DiagRTCPeerConnectionMetrics } from "@lib/rpc/transports/DiagRTCPeerConnections.types";
import { projectP2PPeerConnectionMetrics } from "./P2PService";

describe("P2P service diagnostics", () => {
    it("projects candidate details without exposing raw RTC reports", () => {
        const metrics: DiagRTCPeerConnectionMetrics = {
            selectedPair: { id: "pair-a" },
            selectedPairId: "pair-a",
            state: "succeeded",
            localCandidateId: "local-a",
            remoteCandidateId: "remote-a",
            currentRoundTripTime: 0.02,
            totalRoundTripTime: 0.5,
            requestsSent: 4,
            responsesReceived: 4,
            packetsDiscardedOnSend: 0,
            bytesSent: 120,
            bytesReceived: 240,
            reports: [
                {
                    id: "local-a",
                    candidateType: "host",
                    protocol: "udp",
                    relayProtocol: "unknown",
                },
                {
                    id: "remote-a",
                    candidateType: "relay",
                    protocol: "udp",
                    relayProtocol: "tls",
                },
            ],
        };

        expect(projectP2PPeerConnectionMetrics(metrics)).toEqual({
            selectedPairPresent: true,
            selectedPairId: "pair-a",
            state: "succeeded",
            currentRoundTripTime: 0.02,
            totalRoundTripTime: 0.5,
            requestsSent: 4,
            responsesReceived: 4,
            packetsDiscardedOnSend: 0,
            bytesSent: 120,
            bytesReceived: 240,
            localCandidate: {
                id: "local-a",
                candidateType: "host",
                protocol: "udp",
                relayProtocol: "unknown",
            },
            remoteCandidate: {
                id: "remote-a",
                candidateType: "relay",
                protocol: "udp",
                relayProtocol: "tls",
            },
        });
    });
});
