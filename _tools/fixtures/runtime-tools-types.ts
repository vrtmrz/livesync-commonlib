import { timeDeltaToHumanReadable, splitCustomRegExpList, constructCustomRegExpList } from "@vrtmrz/livesync-commonlib/compat/common/utils";
import type { CustomRegExpSource, CustomRegExpSourceList } from "@vrtmrz/livesync-commonlib/compat/common/types";

const duration: string = timeDeltaToHumanReadable(1000);
const source = "a|b" as CustomRegExpSourceList<"|">;
const parts: CustomRegExpSource[] = splitCustomRegExpList(source, "|");
const joined: CustomRegExpSourceList<"|"> = constructCustomRegExpList(parts, "|");
void [duration, joined];
