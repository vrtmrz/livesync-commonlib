import { firstHandledFunction, handlers, type HandlerOutcome } from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";
import type { IFileProcessingService } from "@vrtmrz/livesync-commonlib/compat/services/base/IService";
import type { FileProcessingService } from "@vrtmrz/livesync-commonlib/compat/services/base/FileProcessingService";

const completed: HandlerOutcome = { kind: "completed" };
const veto: HandlerOutcome = { kind: "veto" };
const value: HandlerOutcome<number, string> = { kind: "completed", value: 0 };
const reason: HandlerOutcome<number, string> = { kind: "veto", value: "unavailable" };
// @ts-expect-error Non-void success values are required.
const missingValue: HandlerOutcome<number> = { kind: "completed" };
// @ts-expect-error Non-void veto reasons are required.
const missingReason: HandlerOutcome<void, string> = { kind: "veto" };
// @ts-expect-error A veto carries its own payload type.
const wrongReason: HandlerOutcome<number, string> = { kind: "veto", value: 12 };

const synchronous = firstHandledFunction<() => { kind: "completed"; value: false }>();
synchronous.addHandler(() => ({ kind: "completed", value: false }));
const result: Promise<{ kind: "completed"; value: false } | { kind: "not-applicable" }> = synchronous();
// @ts-expect-error Even synchronous handlers produce an asynchronous aggregate result.
const synchronousResult: { kind: "completed"; value: false } = synchronous();
// @ts-expect-error An empty chain must remain representable for a completed-only callback.
const alwaysCompleted: Promise<{ kind: "completed"; value: false }> = synchronous();
// @ts-expect-error Registration state is read-only.
synchronous.hasHandlers = true;

interface OptionalHost {
    save?(): Promise<HandlerOutcome<void, string>>;
    legacy(): Promise<boolean>;
}
const optional = handlers<OptionalHost>().firstHandled("save");
optional.addHandler(async () => ({ kind: "veto", value: "unavailable" }));
// @ts-expect-error Boolean callbacks do not establish an explicit outcome.
handlers<OptionalHost>().firstHandled("legacy");

declare const legacyInterface: Omit<IFileProcessingService, "processOptionalFileEventWithResult">;
declare const legacyService: Omit<FileProcessingService, "processOptionalFileEventWithResult">;
const compatibleInterface: IFileProcessingService = legacyInterface;
const compatibleService: FileProcessingService = legacyService;
void [completed, veto, value, reason, missingValue, missingReason, wrongReason, result, synchronousResult, alwaysCompleted, compatibleInterface, compatibleService];
