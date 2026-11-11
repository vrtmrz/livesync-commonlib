const rejectionConsequences = {
    replication: "Synchronisation stopped",
    "on-demand": "File content could not be retrieved",
    "fast-fetch": "Fast Fetch stopped without completing",
} as const;

/** Explain a refused operation and its recovery action without including document content. */
export function getUnencryptedContentRejectionMessage(operation: keyof typeof rejectionConsequences): string {
    const nextAction = operation === "on-demand" ? ", then retry the file retrieval." : ".";
    return (
        `${rejectionConsequences[operation]} because unencrypted content was rejected. Review the remote data and ` +
        `'Accept unencrypted content' in the E2EE Advanced settings${nextAction}`
    );
}
