/**
 * Setup URI sharing for maintained hosts.
 *
 * @packageDocumentation
 */

export {
    encodeSettingsToSetupURI,
    encodeTimeBoundSetupURI,
    getTimeBoundSetupURIUsableUntil,
    isTimeBoundSetupURIUsableNow,
    decodeSettingsFromSetupURI,
    type TimeBoundSetupURIOptions,
    type TimeBoundSetupURIResult,
    type TimeBoundSetupURIMode,
} from "./API/processSetting.ts";
