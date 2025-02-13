import { promiseWithResolver } from "octagonal-wheels/promises";
import type { Confirm } from "../../interfaces/Confirm";
import { eventHub } from "../../hub/hub";
import { EVENT_PLATFORM_UNLOADED } from "../APIBase";

const p = promiseWithResolver<Confirm>();
let instance: Confirm | undefined = undefined;

eventHub.onceEvent(EVENT_PLATFORM_UNLOADED, () => {
    instance = undefined;
    p.resolve(undefined!);
});
export function setConfirmInstance(api: Confirm) {
    instance = api;
    if (instance) {
        instance = api;
    } else {
        p.resolve(api);
    }
}

export function getConfirmInstance() {
    if (!instance) {
        return p.promise;
    } else {
        return Promise.resolve(instance);
    }
}
