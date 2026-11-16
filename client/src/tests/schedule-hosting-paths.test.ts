import { afterEach, expect, it, vi } from "vitest";
import { getFirebaseFunctionUrl } from "../lib/firebaseFunctionsUrl";

afterEach(() => vi.unstubAllEnvs());
it("selects all five configured Schedule paths at the canonical production origin", () => {
    vi.stubEnv("MODE", "production");
    vi.stubEnv("DEV", false);
    vi.stubEnv("VITE_FIREBASE_FUNCTIONS_URL", "https://outliner-online.com");
    for (
        const [operation, path] of [
            ["createSchedule", "create-schedule"],
            ["listSchedules", "list-schedules"],
            ["updateSchedule", "update-schedule"],
            ["cancelSchedule", "cancel-schedule"],
            ["exportSchedulesIcal", "export-schedules-ical"],
        ]
    ) expect(getFirebaseFunctionUrl(operation)).toBe(`https://outliner-online.com/api/${path}`);
    expect(getFirebaseFunctionUrl("saveProject")).toBe("https://outliner-online.com/api/saveProject");
});
it("preserves existing direct emulator function names", () => {
    vi.stubEnv("MODE", "test");
    expect(getFirebaseFunctionUrl("createSchedule")).toBe(
        "http://127.0.0.1:57070/outliner-d57b0/us-central1/createSchedule",
    );
});
