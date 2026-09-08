import type {
    ObsidianLiveSyncSettings,
    RemoteDBSettings,
    RemotePreferredTweakResult,
    TweakAssessment,
    TweakValues,
} from "@lib/common/types";
import type { ITweakValueService } from "./IService";
import { ServiceBase, type ServiceContext } from "./ServiceBase";

/**
 * The TweakValueService provides methods for managing tweak values and resolving mismatches.
 */
export abstract class TweakValueService<T extends ServiceContext = ServiceContext>
    extends ServiceBase<T>
    implements ITweakValueService
{
    /**
     * Fetch and trial the remote database settings to determine if they are preferred.
     * @param trialSetting The remote database settings to connect.
     */
    abstract fetchRemotePreferred(trialSetting: RemoteDBSettings): Promise<RemotePreferredTweakResult>;

    /**
     * Check and ask the user to resolve any mismatched tweak values.
     * @param preferred The preferred tweak values to check against.
     * @param assessment The exact compatibility assessment from the calling operation, when available.
     */
    abstract checkAndAskResolvingMismatched(
        preferred: Partial<TweakValues>,
        assessment?: TweakAssessment
    ): Promise<[TweakValues | boolean, boolean]>;

    /**
     * Ask the user to resolve any mismatched tweak values.
     * @param preferredSource The preferred tweak values to resolve against.
     * @param updatePreferredRemote Optional exact-context writer supplied by the failed operation.
     * @param assessment The exact compatibility assessment from the failed operation, when available.
     */
    abstract askResolvingMismatched(
        preferredSource: TweakValues,
        updatePreferredRemote?: (setting: ObsidianLiveSyncSettings) => Promise<boolean>,
        assessment?: TweakAssessment
    ): Promise<"OK" | "CHECKAGAIN" | "IGNORE">;

    /**
     * Check and ask the user to use the remote configuration.
     * @param settings The remote database settings to connect.
     */
    abstract checkAndAskUseRemoteConfiguration(
        settings: RemoteDBSettings
    ): Promise<{ result: false | TweakValues; requireFetch: boolean }>;

    /**
     * Ask the user to use the remote configuration.
     * @param trialSetting The remote database settings to connect.
     * @param preferred The preferred tweak values to use.
     */
    abstract askUseRemoteConfiguration(
        trialSetting: RemoteDBSettings,
        preferred: TweakValues
    ): Promise<{ result: false | TweakValues; requireFetch: boolean }>;
}
