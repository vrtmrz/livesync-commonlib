import { APIBase, type IInitOptions } from "../base/APIBase";
export const EVENT_DENO_INFO_SUPPLIED = "server-deno-info-supplied";

declare global {
    interface LSEvents {
        [EVENT_DENO_INFO_SUPPLIED]: ServerInitOption;
    }
}

export type ServerInitOption = IInitOptions<{
    vaultName: string;
    manifestVersion?: string;
    packageVersion?: string;
}>;
export class ServerAPIBase extends APIBase<ServerInitOption> {}
