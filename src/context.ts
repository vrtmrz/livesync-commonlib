/**
 * Instance-owned event and translation capabilities for Commonlib service composition.
 *
 * @packageDocumentation
 */

export {
    ServiceContext,
    createServiceContext,
    type ServiceContextContract,
    type ServiceContextOptions,
} from "@lib/services/base/ServiceBase";
export { createLiveSyncEventHub, type LiveSyncEventHub } from "@lib/hub/hub";
export {
    englishMessageTranslator,
    passthroughMessageTranslator,
    type MessageTranslator,
    type TranslationParameters,
} from "@lib/services/base/MessageTranslator";
export { commonlibEnglishMessages, type CommonlibMessageKey } from "@lib/services/base/CommonlibMessages";
export type { StandardIo, StandardIoChunk } from "@lib/platform/standardIo";
