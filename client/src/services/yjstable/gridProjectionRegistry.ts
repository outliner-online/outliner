import type { GridProjectionResult } from "../../../../shared/src/notifications/gridProjection";

export type GridProjectionSource = () => GridProjectionResult;

const sources = new Map<string, GridProjectionSource>();

/** Registers the live, committed projection producer for later notification observers. */
export function registerGridProjectionSource(gridId: string, source: GridProjectionSource): () => void {
    sources.set(gridId, source);
    return () => {
        if (sources.get(gridId) === source) sources.delete(gridId);
    };
}

export function getGridProjection(gridId: string): GridProjectionResult {
    return sources.get(gridId)?.() ?? { status: "unavailable", reason: "Grid is not currently observed" };
}
