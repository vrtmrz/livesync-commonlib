// Magic Special value for arguments or results.

export const CANCELLED = Symbol("cancelled");
export const AUTO_MERGED = Symbol("auto_merged");
export const NOT_CONFLICTED = Symbol("not_conflicted");
export const MISSING_OR_ERROR = Symbol("missing_or_error");
export const LEAVE_TO_SUBSEQUENT = Symbol("leave_to_subsequent_proc");
export const TIME_ARGUMENT_INFINITY = Symbol("infinity");

// File status comparison result
export const BASE_IS_NEW = Symbol("base");
export const TARGET_IS_NEW = Symbol("target");
export const EVEN = Symbol("even");
