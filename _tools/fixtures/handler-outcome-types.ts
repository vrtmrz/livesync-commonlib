import {
    firstHandledFunction,
    handlers,
    type HandlerOutcome,
} from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";
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
// @ts-expect-error Completion carries its own payload type.
const wrongValue: HandlerOutcome<number, string> = { kind: "completed", value: "unavailable" };

interface SavedValue {
    path: string;
}
interface VetoReason {
    code: "unavailable";
}
type StructuredOutcome = HandlerOutcome<SavedValue, VetoReason>;
const structured =
    firstHandledFunction<(path: string, force?: boolean) => StructuredOutcome | Promise<StructuredOutcome>>();
structured.addHandler((path) => ({ kind: "completed", value: { path } }));
structured.addHandler(async () => ({ kind: "veto", value: { code: "unavailable" } }));
const structuredResult: Promise<StructuredOutcome> = structured("note.md", true);
// @ts-expect-error Arguments retain the selected callback signature.
structured(42);
// @ts-expect-error Registration must accept the selected callback arguments.
structured.addHandler((path: number) => ({ kind: "completed", value: { path: String(path) } }));
// @ts-expect-error A completion payload is not a veto reason.
structured.addHandler(() => ({ kind: "veto", value: { path: "note.md" } }));
// @ts-expect-error A boolean notification is not a handled outcome.
structured.addHandler(() => true);

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
    synchronous(input: number): HandlerOutcome<number, string>;
    label: string;
    empty: null;
    absent?: undefined;
    notification(): Promise<void>;
}
const optional = handlers<OptionalHost>().firstHandled("save");
optional.addHandler(async () => ({ kind: "veto", value: "unavailable" }));
// @ts-expect-error Boolean callbacks do not establish an explicit outcome.
handlers<OptionalHost>().firstHandled("legacy");
// @ts-expect-error A non-callable property cannot be selected.
handlers<OptionalHost>().firstHandled("label");
// @ts-expect-error A null property is not a callback.
handlers<OptionalHost>().firstHandled("empty");
// @ts-expect-error An undefined-only property is not an optional callback.
handlers<OptionalHost>().firstHandled("absent");
// @ts-expect-error A notification without an outcome cannot be selected.
handlers<OptionalHost>().firstHandled("notification");
// @ts-expect-error The selected method must exist on the host.
handlers<OptionalHost>().firstHandled("missing");
const selectedSynchronous = handlers<OptionalHost>().firstHandled("synchronous");
selectedSynchronous.addHandler((input) => ({ kind: "completed", value: input }));
const selectedSynchronousResult: Promise<HandlerOutcome<number, string>> = selectedSynchronous(7);

declare const legacyInterface: Omit<IFileProcessingService, "processOptionalFileEventWithResult">;
declare const legacyService: Omit<FileProcessingService, "processOptionalFileEventWithResult">;
const compatibleInterface: IFileProcessingService = legacyInterface;
const compatibleService: FileProcessingService = legacyService;
void [
    completed,
    veto,
    value,
    reason,
    missingValue,
    missingReason,
    wrongReason,
    wrongValue,
    structuredResult,
    selectedSynchronousResult,
    result,
    synchronousResult,
    alwaysCompleted,
    compatibleInterface,
    compatibleService,
];
