import { describe, expect, it } from "vitest";
import { LOG_LEVEL_INFO } from "octagonal-wheels/common/logger";
import { ServiceContext } from "../../base/ServiceBase";
import { HeadlessAPIService } from "./HeadlessAPIService";

describe("HeadlessAPIService", () => {
    it("accepts service log messages without a host-provided handler", () => {
        const service = new HeadlessAPIService(new ServiceContext());

        expect(() => service.addLog("Headless service initialised", LOG_LEVEL_INFO, "test")).not.toThrow();
    });
});
