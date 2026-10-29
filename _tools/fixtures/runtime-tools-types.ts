import { timeDeltaToHumanReadable, splitCustomRegExpList, constructCustomRegExpList } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { CustomRegExpSource, CustomRegExpSourceList } from "@vrtmrz/livesync-commonlib/compat/common/types";
import {
    bindableFunction,
    lazyBindableFunction,
    type UnregisterFunction,
} from "@vrtmrz/livesync-commonlib/compat/services/lib/HandlerUtils";

const duration: string = timeDeltaToHumanReadable(1000);
const source = "a|b" as CustomRegExpSourceList<"|">;
const parts: CustomRegExpSource[] = splitCustomRegExpList(source, "|");
const joined: CustomRegExpSourceList<"|"> = constructCustomRegExpList(parts, "|");
const immediateUnregister: UnregisterFunction = bindableFunction<() => string>("immediate").setHandler(() => "value");
const lazyUnregister: UnregisterFunction = lazyBindableFunction<() => string>("lazy").setHandler(() => "value");
void [duration, joined, immediateUnregister, lazyUnregister];
