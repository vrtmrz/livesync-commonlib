import { APIBase, type IInitOptions } from "../base/APIBase";
export const EVENT_SERVER_INFO_SUPPLIED = "server-info-supplied";

declare global {
    interface LSEvents {
        [EVENT_SERVER_INFO_SUPPLIED]: ServerInitOption;
    }
}

export type ServerInitOption = IInitOptions<{
    vaultName: string;
    manifestVersion?: string;
    packageVersion?: string;
}>;
export class ServerAPIBase extends APIBase<ServerInitOption> {}
