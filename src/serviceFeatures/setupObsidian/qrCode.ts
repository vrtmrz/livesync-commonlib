import type { NecessaryServices } from "@lib/interfaces/ServiceModule";
import { $msg } from "@lib/common/i18n";
import { encodeQR, encodeSettingsToQRCodeData, OutputFormat } from "@lib/API/processSetting";
import { EVENT_REQUEST_SHOW_SETUP_QR } from "@lib/events/coreEvents";
import { eventHub } from "@lib/hub/hub";
import { fireAndForget } from "@lib/common/utils";
import type { SetupFeatureHost } from "./types";

export async function encodeSetupSettingsAsQR(host: SetupFeatureHost) {
    const settingString = encodeSettingsToQRCodeData(host.services.setting.currentSettings());
    const codeSVG = encodeQR(settingString, OutputFormat.SVG);
    if (codeSVG === "") {
        return "";
    }
    const msg = $msg("Setup.QRCode", { qr_image: codeSVG });
    await host.services.UI.confirm.confirmWithMessage("Settings QR Code", msg, ["OK"], "OK");
    return codeSVG;
}

export function useSetupQRCodeFeature(host: NecessaryServices<"API" | "UI" | "setting" | "appLifecycle", never>) {
    host.services.appLifecycle.onLoaded.addHandler(() => {
        host.services.API.addCommand({
            id: "livesync-setting-qr",
            name: "Show settings as a QR code",
            callback: () => fireAndForget(encodeSetupSettingsAsQR(host)),
        });
        eventHub.onEvent(EVENT_REQUEST_SHOW_SETUP_QR, () => fireAndForget(() => encodeSetupSettingsAsQR(host)));
        return Promise.resolve(true);
    });
}
