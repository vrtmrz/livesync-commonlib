import { AutoAccepting, DEFAULT_SETTINGS, type P2PSyncSetting } from "@lib/common/types";
import type { StoredMapLike } from "@lib/dataobject/StoredMap";
import type { Confirm } from "@lib/interfaces/Confirm";
import { Computed } from "octagonal-wheels/dataobject/Computed";
import { describe, expect, it, vi } from "vitest";

import { parsePeerPatterns } from "../peerPatterns";
import { ResponsePreventedError, type Advertisement } from "../types";
import { createPeerAdmission, type PeerAdmission, type PeerAdmissionDependencies } from "./peerAdmission";

type AcceptedPeers = Pick<StoredMapLike<boolean>, "get" | "set" | "delete">;
type DecisionChoice = "Accept" | "Ignore" | "Accept Temporarily" | "Ignore Temporarily";
type DialogueChoice = DecisionChoice | false;
type PeerOverrides = Partial<
    Pick<PeerAdmissionDependencies, "promptPeerAcceptance" | "evaluatePeerAcceptance" | "confirmUserToAccept">
>;

const settingsWith = (patch: Partial<P2PSyncSetting> = {}): P2PSyncSetting => ({
    ...DEFAULT_SETTINGS,
    P2P_Enabled: true,
    P2P_AutoAccepting: AutoAccepting.NONE,
    P2P_AutoAcceptingPeers: "",
    P2P_AutoDenyingPeers: "",
    P2P_IsHeadless: false,
    ...patch,
});

const createAcceptedPeers = (initial: ReadonlyMap<string, boolean> = new Map()) => {
    const values = new Map(initial);
    const acceptedPeers: AcceptedPeers = {
        get: vi.fn(async (name: string) => values.get(name)),
        set: vi.fn(async (name: string, accepted: boolean) => {
            values.set(name, accepted);
        }),
        delete: vi.fn(async (name: string) => {
            values.delete(name);
        }),
    };
    return { acceptedPeers, values };
};

const createAdmissionHarness = (
    dialogueChoice: DialogueChoice = false,
    overrides: PeerOverrides = {},
    initialSettings: P2PSyncSetting = settingsWith(),
    currentSettings?: () => P2PSyncSetting
) => {
    const { acceptedPeers } = createAcceptedPeers();
    const resources: {
        enabled: boolean;
        settings: P2PSyncSetting;
        advertisements: Map<string, Advertisement>;
        acceptedPeers: AcceptedPeers;
        temporaryAcceptedPeers: Map<string, boolean>;
    } = {
        enabled: true,
        settings: initialSettings,
        advertisements: new Map(),
        acceptedPeers,
        temporaryAcceptedPeers: new Map(),
    };
    const askSelectStringDialogue = vi.fn(async () => dialogueChoice) as Confirm["askSelectStringDialogue"];
    const confirm: Pick<Confirm, "askSelectStringDialogue"> = { askSelectStringDialogue };
    const dispatchConnectionStatus = vi.fn(async () => undefined);
    const acceptablePatterns = new Computed<[P2PSyncSetting], RegExp[]>({
        evaluation: (settings) => parsePeerPatterns(`${settings.P2P_AutoAcceptingPeers ?? ""}`),
    });
    const deniedPatterns = new Computed<[P2PSyncSetting], RegExp[]>({
        evaluation: (settings) => parsePeerPatterns(`${settings.P2P_AutoDenyingPeers ?? ""}`),
    });

    let admission: PeerAdmission;
    const deps: PeerAdmissionDependencies = {
        isEnabled: () => resources.enabled,
        advertisement: (peerId) => resources.advertisements.get(peerId),
        currentSettings: currentSettings ?? (() => resources.settings),
        acceptedPeers: () => resources.acceptedPeers,
        temporaryAcceptedPeers: () => resources.temporaryAcceptedPeers,
        confirm: () => confirm,
        dispatchConnectionStatus,
        acceptablePatterns: () => acceptablePatterns,
        deniedPatterns: () => deniedPatterns,
        promptPeerAcceptance: overrides.promptPeerAcceptance ?? ((peerId) => admission.promptPeerAcceptance(peerId)),
        evaluatePeerAcceptance:
            overrides.evaluatePeerAcceptance ?? ((peerId) => admission.evaluatePeerAcceptance(peerId)),
        confirmUserToAccept: overrides.confirmUserToAccept ?? ((peerId) => admission.confirmUserToAccept(peerId)),
    };
    admission = createPeerAdmission(deps);
    return {
        admission,
        resources,
        acceptedPeers,
        askSelectStringDialogue,
        dispatchConnectionStatus,
        acceptablePatterns,
        deniedPatterns,
    };
};

const advertise = (harness: ReturnType<typeof createAdmissionHarness>, peerId = "peer-a", name = "Device A") => {
    const advertisement = { peerId, name, platform: "test" };
    harness.resources.advertisements.set(peerId, advertisement);
    return advertisement;
};

describe("peer admission decision operations", () => {
    it.each([
        { decision: true, isTemporary: false },
        { decision: false, isTemporary: false },
        { decision: true, isTemporary: true },
        { decision: false, isTemporary: true },
    ])("stores the $isTemporary $decision decision before dispatching status", async ({ decision, isTemporary }) => {
        const h = createAdmissionHarness();
        const peer = { peerId: "peer-a", name: "Device A", decision, isTemporary };
        let finishWrite: (() => void) | undefined;
        const set = vi.fn(async (_name: string, _value: boolean) => {
            await new Promise<void>((resolve) => {
                finishWrite = resolve;
            });
        });
        const replacementAcceptedPeers: AcceptedPeers = {
            get: vi.fn(async () => undefined),
            set,
            delete: vi.fn(async () => undefined),
        };
        h.resources.acceptedPeers = replacementAcceptedPeers;

        const pending = h.admission.makeDecision(peer);
        if (isTemporary) {
            await pending;
            expect(h.resources.temporaryAcceptedPeers.get(peer.peerId)).toBe(decision);
            expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
            expect(set).not.toHaveBeenCalled();
            return;
        }

        await Promise.resolve();
        expect(set).toHaveBeenCalledExactlyOnceWith(peer.name, decision);
        expect(h.dispatchConnectionStatus).not.toHaveBeenCalled();
        finishWrite?.();
        await pending;
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
    });

    it.each([true, false] as const)("revokes the persisted %s peer decision", async (decision) => {
        const h = createAdmissionHarness();
        const peerId = "peer-a";
        const name = "Device A";
        const { acceptedPeers, values } = createAcceptedPeers(new Map([[name, decision]]));
        h.resources.acceptedPeers = acceptedPeers;
        h.resources.temporaryAcceptedPeers.set(peerId, decision);

        await h.admission.revokeDecision({ peerId, name });

        expect(h.resources.temporaryAcceptedPeers.has(peerId)).toBe(false);
        expect(acceptedPeers.delete).toHaveBeenCalledExactlyOnceWith(name);
        expect(values.has(name)).toBe(false);
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
    });

    it("waits for persisted revocation before dispatching status", async () => {
        const h = createAdmissionHarness();
        let finishDelete: (() => void) | undefined;
        const acceptedPeers: AcceptedPeers = {
            get: vi.fn(async () => true),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => {
                await new Promise<void>((resolve) => {
                    finishDelete = resolve;
                });
            }),
        };
        h.resources.acceptedPeers = acceptedPeers;

        const pending = h.admission.revokeDecision({ peerId: "peer-a", name: "Device A" });
        await Promise.resolve();
        expect(acceptedPeers.delete).toHaveBeenCalledExactlyOnceWith("Device A");
        expect(h.dispatchConnectionStatus).not.toHaveBeenCalled();
        finishDelete?.();
        await pending;
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
    });

    it.each([
        ["Accept", true, false],
        ["Ignore", false, false],
        ["Accept Temporarily", true, true],
        ["Ignore Temporarily", false, true],
    ] as const)("applies the %s prompt choice to the expected peer scope", async (choice, accepted, temporary) => {
        const h = createAdmissionHarness(choice);
        advertise(h);

        await expect(h.admission.promptPeerAcceptance("peer-a")).resolves.toBe(accepted);

        expect(h.askSelectStringDialogue).toHaveBeenCalledExactlyOnceWith(
            `Are you sure to establish connection to Device A (peer-a)?\nYou can chose as follows:\n- Accept: Accept all connections from this peer.\n- Ignore: Reject all connections from this peer.\n- Accept Temporarily: Accept the connection for this session only.\n- Ignore Temporarily: Reject the connection for this session only.\n\n>[!INFO] You can revoke your decision from the Peer-to-Peer Replicator Pane.`,
            ["Accept", "Ignore", "Accept Temporarily", "Ignore Temporarily"],
            { title: "P2P Connection Request", defaultAction: "Ignore Temporarily", timeout: 30 }
        );
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
        if (temporary) {
            expect(h.resources.temporaryAcceptedPeers.get("peer-a")).toBe(accepted);
            expect(h.resources.acceptedPeers.set).not.toHaveBeenCalled();
        } else {
            expect(h.resources.temporaryAcceptedPeers.has("peer-a")).toBe(false);
            expect(h.resources.acceptedPeers.set).toHaveBeenCalledExactlyOnceWith("Device A", accepted);
        }
    });

    it("rejects a cancelled prompt and synchronously throws for an unknown peer", async () => {
        const cancelled = createAdmissionHarness(false);
        advertise(cancelled);
        await expect(cancelled.admission.promptPeerAcceptance("peer-a")).rejects.toBeInstanceOf(ResponsePreventedError);
        expect(cancelled.resources.acceptedPeers.set).not.toHaveBeenCalled();
        expect(cancelled.resources.temporaryAcceptedPeers.has("peer-a")).toBe(false);

        const unknown = createAdmissionHarness("Accept");
        expect(() => unknown.admission.promptPeerAcceptance("unknown-peer")).toThrow("Unknown Peer");
        expect(unknown.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("does not wait for prompt persistence or status dispatch", async () => {
        const h = createAdmissionHarness("Accept");
        advertise(h);
        let finishWrite: (() => void) | undefined;
        const acceptedPeers: AcceptedPeers = {
            get: vi.fn(async () => undefined),
            set: vi.fn(async () => {
                await new Promise<void>((resolve) => {
                    finishWrite = resolve;
                });
            }),
            delete: vi.fn(async () => undefined),
        };
        h.resources.acceptedPeers = acceptedPeers;
        h.dispatchConnectionStatus.mockImplementation(async () => await new Promise<void>(() => undefined));

        await expect(h.admission.promptPeerAcceptance("peer-a")).resolves.toBe(true);
        expect(acceptedPeers.set).toHaveBeenCalledOnce();
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
        finishWrite?.();
    });

    it("deduplicates simultaneous confirmation through the host prompt override", async () => {
        let resolvePrompt: ((accepted: boolean) => void) | undefined;
        const promptPeerAcceptance = vi.fn(
            () =>
                new Promise<boolean>((resolve) => {
                    resolvePrompt = resolve;
                })
        );
        const h = createAdmissionHarness(false, { promptPeerAcceptance });

        const first = h.admission.confirmUserToAccept("shared-peer");
        const second = h.admission.confirmUserToAccept("shared-peer");
        expect(promptPeerAcceptance).toHaveBeenCalledExactlyOnceWith("shared-peer");
        resolvePrompt?.(true);
        await expect(first).resolves.toBe(true);
        await expect(second).resolves.toBe(true);
    });
});

describe("peer admission policy", () => {
    it("applies temporary, persisted, deny, and automatic decisions in order", async () => {
        const h = createAdmissionHarness(
            false,
            {},
            settingsWith({
                P2P_AutoAccepting: AutoAccepting.ALL,
                P2P_AutoAcceptingPeers: "Persisted rejection, Automatic device, Denied device",
                P2P_AutoDenyingPeers: "Denied device",
            })
        );
        advertise(h, "temporary", "Temporary device");
        advertise(h, "persisted", "Persisted device");
        advertise(h, "persisted-rejected", "Persisted rejection");
        advertise(h, "automatic", "Automatic device");
        advertise(h, "denied", "Denied device");
        advertise(h, "all", "Other device");
        h.resources.temporaryAcceptedPeers.set("temporary", false);
        const stored: AcceptedPeers = {
            get: vi.fn(async (name) => {
                if (name === "Persisted device") {
                    return true;
                }
                if (name === "Temporary device") {
                    return true;
                }
                if (name === "Persisted rejection") {
                    return false;
                }
                return undefined;
            }),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        h.resources.acceptedPeers = stored;

        await expect(h.admission.evaluatePeerAcceptance("temporary")).resolves.toBe("rejected");
        await expect(h.admission.evaluatePeerAcceptance("persisted")).resolves.toBe("accepted");
        await expect(h.admission.evaluatePeerAcceptance("persisted-rejected")).resolves.toBe("rejected");
        await expect(h.admission.evaluatePeerAcceptance("automatic")).resolves.toBe("accepted");
        await expect(h.admission.evaluatePeerAcceptance("denied")).resolves.toBe("rejected");
        await expect(h.admission.evaluatePeerAcceptance("all")).resolves.toBe("accepted");
        h.resources.enabled = false;
        await expect(h.admission.evaluatePeerAcceptance("automatic")).resolves.toBe("unknown");
        await expect(h.admission.evaluatePeerAcceptance("missing")).resolves.toBe("unknown");
    });

    it("reads automatic settings only after the persisted lookup completes", async () => {
        let selectedSettings = settingsWith();
        const currentSettings = vi.fn(() => selectedSettings);
        const h = createAdmissionHarness(false, {}, selectedSettings, currentSettings);
        advertise(h);
        let finishLookup: ((value: boolean | undefined) => void) | undefined;
        const get = vi.fn(
            () =>
                new Promise<boolean | undefined>((resolve) => {
                    finishLookup = resolve;
                })
        );
        const acceptedPeers: AcceptedPeers = {
            get,
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        h.resources.acceptedPeers = acceptedPeers;

        const pending = h.admission.evaluatePeerAcceptance("peer-a");
        await Promise.resolve();
        expect(currentSettings).not.toHaveBeenCalled();
        selectedSettings = settingsWith({ P2P_AutoAcceptingPeers: "Device A" });
        finishLookup?.(undefined);
        await expect(pending).resolves.toBe("accepted");
        expect(currentSettings).toHaveBeenCalledOnce();
    });

    it("uses the current headless setting after reporting an undecided result", async () => {
        let settingsReads = 0;
        const currentSettings = vi.fn(() => {
            settingsReads++;
            return settingsReads === 1 ? settingsWith() : settingsWith({ P2P_IsHeadless: true });
        });
        const h = createAdmissionHarness(false, {}, settingsWith(), currentSettings);
        advertise(h);

        await expect(h.admission.isAcceptablePeer("peer-a")).resolves.toBe(false);

        expect(settingsReads).toBe(2);
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("materialises automatic acceptance temporarily and does not prompt", async () => {
        const h = createAdmissionHarness(false, {}, settingsWith({ P2P_AutoAcceptingPeers: "Device A" }));
        advertise(h);

        await expect(h.admission.isAcceptablePeer("peer-a")).resolves.toBe(true);

        expect(h.resources.temporaryAcceptedPeers.get("peer-a")).toBe(true);
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
        expect(h.resources.acceptedPeers.get).toHaveBeenCalledTimes(2);
    });

    it("keeps evaluated acceptance when the advertisement disappears before caching", async () => {
        const evaluatePeerAcceptance = vi.fn(async () => "accepted" as const);
        const h = createAdmissionHarness(false, { evaluatePeerAcceptance });
        advertise(h);

        const pending = h.admission.isAcceptablePeer("peer-a");
        h.resources.advertisements.delete("peer-a");

        await expect(pending).resolves.toBe(true);
        expect(h.acceptedPeers.get).not.toHaveBeenCalled();
        expect(h.resources.temporaryAcceptedPeers.get("peer-a")).toBe(true);
        expect(h.dispatchConnectionStatus).toHaveBeenCalledOnce();
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("does not materialise a persisted acceptance as a temporary decision", async () => {
        const h = createAdmissionHarness();
        advertise(h);
        h.resources.acceptedPeers = {
            get: vi.fn(async () => true),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };

        await expect(h.admission.isAcceptablePeer("peer-a")).resolves.toBe(true);

        expect(h.resources.temporaryAcceptedPeers.has("peer-a")).toBe(false);
        expect(h.dispatchConnectionStatus).not.toHaveBeenCalled();
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("does not prompt for undecided headless or rejected peers", async () => {
        const headless = createAdmissionHarness(false, {}, settingsWith({ P2P_IsHeadless: true }));
        advertise(headless);
        await expect(headless.admission.isAcceptablePeer("peer-a")).resolves.toBe(false);
        expect(headless.askSelectStringDialogue).not.toHaveBeenCalled();

        const rejected = createAdmissionHarness("Accept");
        advertise(rejected);
        rejected.resources.temporaryAcceptedPeers.set("peer-a", false);
        await expect(rejected.admission.isAcceptablePeer("peer-a")).resolves.toBe(false);
        expect(rejected.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("uses dynamic host overrides when deciding whether to prompt", async () => {
        const evaluatePeerAcceptance = vi.fn(async () => "undecided" as const);
        const confirmUserToAccept = vi.fn(async () => true);
        const h = createAdmissionHarness(false, { evaluatePeerAcceptance, confirmUserToAccept });
        advertise(h);

        await expect(h.admission.isAcceptablePeer("peer-a")).resolves.toBe(true);

        expect(evaluatePeerAcceptance).toHaveBeenCalledExactlyOnceWith("peer-a");
        expect(confirmUserToAccept).toHaveBeenCalledExactlyOnceWith("peer-a");
        expect(h.askSelectStringDialogue).not.toHaveBeenCalled();
    });

    it("uses replacement host resources after factory creation", async () => {
        const h = createAdmissionHarness();
        advertise(h, "peer-a", "Old name");
        const replacementAdvertisement = { peerId: "peer-a", name: "New name", platform: "test" };
        h.resources.advertisements.set("peer-a", replacementAdvertisement);
        const replacementAcceptedPeers: AcceptedPeers = {
            get: vi.fn(async (name) => (name === "New name" ? true : undefined)),
            set: vi.fn(async () => undefined),
            delete: vi.fn(async () => undefined),
        };
        const replacementTemporary = new Map<string, boolean>([["peer-a", false]]);
        h.resources.acceptedPeers = replacementAcceptedPeers;
        h.resources.temporaryAcceptedPeers = replacementTemporary;

        await expect(h.admission.evaluatePeerAcceptance("peer-a")).resolves.toBe("rejected");
        replacementTemporary.delete("peer-a");
        await expect(h.admission.evaluatePeerAcceptance("peer-a")).resolves.toBe("accepted");
        expect(replacementAcceptedPeers.get).toHaveBeenCalledWith("New name");
    });
});
