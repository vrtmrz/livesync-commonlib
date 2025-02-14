import type { Confirm } from "../interfaces/Confirm";
import { getConfirmInstance } from "./Confirm";
import { getEnvironmentInstance } from "./Environment";
import type { IEnvironment, ISimpleStoreAPI } from "./interfaces";
import { getSimpleStoreInstance } from "./base/SimpleStore.ts";

export type Synchronised = {
    confirm: Confirm;
    environment: IEnvironment;
    simpleStoreAPI: ISimpleStoreAPI<any>;
};

export async function Synchromesh(): Promise<Synchronised> {
    const instances = await Promise.all([getConfirmInstance(), getEnvironmentInstance(), getSimpleStoreInstance()]);
    const [confirm, environment, simpleStoreAPI] = instances;
    return { confirm, environment, simpleStoreAPI };
}
