/** Default budget for one retained semantic projection, excluding the host's canonical Y.Docs. */
export const DEFAULT_OBSERVATION_PROJECTION_BYTES = 512 * 1024;

/**
 * Conservative accounting for plain JSON DTOs: include object/array/string
 * headers, property storage, array slots, and UTF-16 strings. This is a budget
 * model, not a measurement of V8 process RSS or shared source-document heaps.
 */
export function retainedJsonBytes(value: unknown): number {
    if (typeof value === "string") return 32 + value.length * 2;
    if (value === null || typeof value !== "object") return 8;
    if (Array.isArray(value)) {
        return 32 + value.length * 8 + value.reduce((total, entry) => total + retainedJsonBytes(entry), 0);
    }
    let bytes = 64;
    for (const [key, entry] of Object.entries(value)) bytes += 16 + key.length * 2 + retainedJsonBytes(entry);
    return bytes;
}

export function observationProjectionLimit(configured?: number, requested?: number): number {
    const ceiling = configured ?? DEFAULT_OBSERVATION_PROJECTION_BYTES;
    for (const value of [ceiling, requested ?? ceiling]) {
        if (!Number.isSafeInteger(value) || value <= 0) {
            throw new RangeError("observation projection budget must be a finite positive integer");
        }
    }
    return Math.min(ceiling, requested ?? ceiling);
}
