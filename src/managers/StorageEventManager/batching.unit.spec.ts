import { describe, expect, it } from "vitest";
import { planBatchDeadline } from "./batching";

describe("batch deadline decisions", () => {
    // Event and deadline times are milliseconds; the first accepted event owns the maximum window.
    it.each([
        { label: "first event", now: 0, accepted: 0, since: 0, minimum: 10, maximum: 30, delay: 10, expired: false },
        {
            label: "later event resets quiet time",
            now: 8,
            accepted: 8,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 10,
            expired: false,
        },
        {
            label: "maximum caps the quiet delay",
            now: 25,
            accepted: 25,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 5,
            expired: false,
        },
        {
            label: "filtering consumes quiet time",
            now: 16,
            accepted: 10,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 4,
            expired: false,
        },
        {
            label: "quiet delay already consumed",
            now: 20,
            accepted: 10,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 0,
            expired: false,
        },
        {
            label: "exact maximum boundary",
            now: 30,
            accepted: 25,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 0,
            expired: true,
        },
        {
            label: "past maximum boundary",
            now: 35,
            accepted: 34,
            since: 0,
            minimum: 10,
            maximum: 30,
            delay: 0,
            expired: true,
        },
        {
            label: "quiet period disabled",
            now: 8,
            accepted: 8,
            since: 0,
            minimum: 0,
            maximum: 30,
            delay: 0,
            expired: false,
        },
        {
            label: "maximum delay disabled",
            now: 0,
            accepted: 0,
            since: 0,
            minimum: 10,
            maximum: 0,
            delay: 0,
            expired: true,
        },
    ])("$label", ({ now, accepted, since, minimum, maximum, delay, expired }) => {
        expect(planBatchDeadline(now, accepted, since, minimum, maximum)).toEqual({ delay, expired });
    });
});
