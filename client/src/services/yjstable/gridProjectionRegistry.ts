import type { GridProjectionResult } from "../../../../shared/src/notifications/gridProjection";

export type GridProjectionSource = () => GridProjectionResult;

const sources = new Map<string, GridProjectionSource[]>();

/** Registers the live, committed projection producer for later notification observers. */
export function registerGridProjectionSource(gridId: string, source: GridProjectionSource): () => void {
    const registered = sources.get(gridId) ?? [];
    registered.push(source);
    sources.set(gridId, registered);
    return () => {
        const current = sources.get(gridId);
        if (!current) return;
        const index = current.lastIndexOf(source);
        if (index !== -1) current.splice(index, 1);
        if (current.length === 0) sources.delete(gridId);
    };
}

export function getGridProjection(gridId: string): GridProjectionResult {
    const registered = sources.get(gridId);
    return registered?.[registered.length - 1]?.()
        ?? { status: "unavailable", reason: "Grid is not currently observed" };
}
