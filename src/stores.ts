import { getGlobalStore } from "./store";

export type LockStats = {
    pending: string[],
    running: string[],
    count: number;
}
export const lockStore = getGlobalStore<LockStats>("locks", { pending: [], running: [], count: 0 });