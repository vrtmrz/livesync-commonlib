import { describe, expect, it } from "vitest";
import { EVENT_PLUGIN_UNLOADED } from "@lib/events/coreEvents";
import { declareUICommand } from "@lib/uiCommands";
import { createServiceContext, type ServiceContext } from "@lib/services/base/ServiceBase";
import type { IAPIService } from "@lib/services/base/IService";
import { UIService } from "./UIService";
import type { ComponentHasResult, SvelteDialogManager } from "./SvelteDialog";

class TestUIService extends UIService {
    override get dialogToCopy(): ComponentHasResult<"ok" | "cancel", { title: string; dataToCopy: string }> {
        return {} as ComponentHasResult<"ok" | "cancel", { title: string; dataToCopy: string }>;
    }
}

describe("UIService command ownership", () => {
    it("disposes its command registry when the plug-in unloads", async () => {
        const context = createServiceContext();
        const service = new TestUIService(context, {
            dialogManager: {} as SvelteDialogManager<ServiceContext>,
            APIService: {} as IAPIService,
        });
        const command = declareUICommand<{ deviceId: string }, boolean>("joinedDevices/service-lifecycle");
        service.commands.register(command, () => true);

        context.events.emitEvent(EVENT_PLUGIN_UNLOADED);

        await expect(service.commands.invoke(command, { deviceId: "device-1" })).resolves.toEqual({
            status: "unavailable",
        });
    });
});
