import { expect } from "chai";
import { normalizeNotificationRule } from "../../shared/src/notifications/notification-settings.js";

describe("notification settings validation", () => {
    const base = {
        ruleId: "r",
        target: { projectId: "p", kind: "grid", objectId: "g" },
        enabled: true,
        channels: { mcp: true, mobile: false },
        context: { version: 1, locale: "en-US", timeZone: "UTC", surface: "table" },
    };
    it("accepts independent channels and rejects unknown fields and wrong surfaces", () => {
        expect(normalizeNotificationRule(base).channels).to.deep.equal({ mcp: true, mobile: false });
        expect(() => normalizeNotificationRule({ ...base, owner: "someone-else" })).to.throw("unknown");
        expect(() => normalizeNotificationRule({ ...base, context: { ...base.context, surface: "board" } })).to.throw();
    });
});
