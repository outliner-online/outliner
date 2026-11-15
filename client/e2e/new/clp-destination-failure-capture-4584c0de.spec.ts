/** @feature CLP-4584c0de */
import fs from "node:fs/promises";
import { collectGridRenderTraces, expect, test, withGridFailureCapture } from "../fixtures/grid-render-trace";
import { createBlankGrid } from "../utils/crossProjectGridHelpers";
import { registerCoverageHooks } from "../utils/registerCoverageHooks";
import { TestHelpers } from "../utils/testHelpers";

registerCoverageHooks();

test("retains the failing destination's real state before close and rethrows the original assertion",
    async ({ page }, info) => {
        await page.goto("/");
        await expect(page.getByTestId("home-page")).toBeVisible();
        const sourceUrl = page.url();
        const destination = await page.context().newPage();
        let original: unknown;
        let observed: unknown;
        let destinationUrl = "";
        let gridId: string | null = null;
        try {
            await TestHelpers.seedProjectAndNavigate(destination, info, ["Destination anchor"]);
            await createBlankGrid(destination, "Diagnostic destination", "diagnostic_destination");
            destinationUrl = destination.url();
            gridId = await destination.getByTestId("yjs-table-view").getAttribute("data-grid-id");
            await expect.poll(async () =>
                (await collectGridRenderTraces(destination)).some(trace => trace.gridId === gridId)
            )
                .toBe(true);
            const before = info.attachments.length;
            expect(await withGridFailureCapture(destination, info, "success", async () => 42)).toBe(42);
            expect(info.attachments).toHaveLength(before);

            await withGridFailureCapture(destination, info, "destination", async () => {
                try {
                    // Deliberately fail against a real one-Grid page. This tests the
                    // diagnostic boundary, without weakening the actual paste test.
                    await expect(destination.getByTestId("yjs-table-view")).toHaveCount(2, { timeout: 100 });
                } catch (error) {
                    original = error;
                    throw error;
                }
            });
        } catch (error) {
            observed = error;
        } finally {
            await destination.close();
        }
        expect(original).toBeInstanceOf(Error);
        expect(observed).toBe(original);
        expect(destination.isClosed()).toBe(true);
        expect(destinationUrl).not.toBe(sourceUrl);

        const attachment = (name: string) => info.attachments.find(value => value.name === name)!;
        const state = JSON.parse(await fs.readFile(attachment("destination-page-state.json").path!, "utf8"));
        expect(state.url).toBe(destinationUrl);
        expect(state.domGridIds).toEqual([gridId]);
        expect(state.gridIds).toContain(gridId);
        expect(state.tableIds).toHaveLength(1);
        expect(state.registryAvailable).toEqual({ grids: true, tables: true });
        const index = JSON.parse(
            await fs.readFile(attachment("destination-grid-render-trace-index.json").path!, "utf8"),
        );
        expect(index.url).toBe(destinationUrl);
        expect(index.label).toBe("destination");
        expect(index.gridIds).toContain(gridId);
        expect(await fs.readFile(attachment("destination-page-snapshot.yaml").path!, "utf8"))
            .toContain("Diagnostic destination");
        expect(info.attachments.some(value => value.name === "destination-capture-errors.json")).toBe(false);
    });

test("a closed destination records diagnostic unavailability without replacing the original failure",
    async ({ page }, info) => {
        const destination = await page.context().newPage();
        await destination.close();
        const original = new Error("Original destination failure");
        let observed: unknown;
        try {
            await withGridFailureCapture(destination, info, "closed-destination", async () => {
                throw original;
            });
        } catch (error) {
            observed = error;
        }
        expect(observed).toBe(original);
        const attachment = info.attachments.find(value => value.name === "closed-destination-capture-errors.json")!;
        const diagnostic = JSON.parse(await fs.readFile(attachment.path!, "utf8"));
        expect(diagnostic.errors.map((value: { stage: string; }) => value.stage))
            .toEqual(["page-state", "page-snapshot", "grid-traces"]);
    });
