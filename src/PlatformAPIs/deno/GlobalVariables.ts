import { setGlobalVariablesInstance, GlobalVariablesBase } from "../base/GlobalVariables.ts";
import type { ServerInitOption } from "./base.ts";

export class GlobalVariables extends GlobalVariablesBase<ServerInitOption, Globals> {
    constructor() {
        super();
    }
}

const instance = new GlobalVariables();
setGlobalVariablesInstance(instance);
export { getGlobalVariablesInstance } from "../base/GlobalVariables.ts";
