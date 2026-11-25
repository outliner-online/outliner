export interface GridObservationContextV1 {
    readonly version: 1;
    readonly surface: "table";
    readonly locale: string;
    readonly timeZone: string;
}

export type ParsedGridObservationContext =
    | { readonly status: "none"; }
    | { readonly status: "supported"; readonly context: GridObservationContextV1; }
    | { readonly status: "unsupported"; readonly reason: string; };

/** Parses the standalone route context without accepting SQL or arbitrary data parameters. */
export function parseGridObservationContext(value: string | undefined): ParsedGridObservationContext {
    if (value === undefined) return { status: "none" };
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return { status: "unsupported", reason: "The Grid observation context is invalid" };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { status: "unsupported", reason: "The Grid observation context is invalid" };
    }
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["version", "surface", "locale", "timeZone"].includes(key))) {
        return { status: "unsupported", reason: "The Grid observation context contains unsupported parameters" };
    }
    if (
        record.version !== 1 || record.surface !== "table" || typeof record.locale !== "string"
        || typeof record.timeZone !== "string" || !record.locale || !record.timeZone
    ) return { status: "unsupported", reason: "Only the version-1 Grid table surface is supported" };
    try {
        new Intl.DateTimeFormat(record.locale, { timeZone: record.timeZone });
    } catch {
        return { status: "unsupported", reason: "The Grid observation locale or time zone is invalid" };
    }
    return { status: "supported", context: record as unknown as GridObservationContextV1 };
}
