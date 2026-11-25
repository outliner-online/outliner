import type { Hocuspocus } from "@hocuspocus/server";
import crypto from "node:crypto";
import * as Y from "yjs";
import type { CalendarObservationContextV1 } from "../../../shared/src/notifications/calendarProjection.js";
import { deriveCalendarVisibleModel } from "../../../shared/src/notifications/calendarVisibleModel.js";
import {
    type GridObservationContextV1,
    type GridProjectionField,
    projectGridTable,
} from "../../../shared/src/notifications/gridProjection.js";
import {
    getGridColumnOrder,
    getGridDefinitionTarget,
    getGridQuery,
    readGridComponents,
} from "../../../shared/src/services/gridDefinition.js";
import {
    analyzeProjectQueryProvenance,
    unambiguousRowSource,
} from "../../../shared/src/services/projectQueryProvenance.js";
import {
    embeddableReadOnlySelect,
    parseSqlIdentifiers,
    validateReadOnlySelect,
} from "../../../shared/src/services/readOnlySql.js";
import type { SelectRelationEvidence } from "../../../shared/src/services/viewSourceEvidence.js";
import { boundGridRelations } from "../mcp/grid-query-evidence.js";
import { closeLiveRoom, type DirectConnection, isLiveRoom, type LiveRoomHost, openLiveRoom } from "../mcp/live-room.js";
import { McpReadError } from "../mcp/mcp-error.js";
import {
    acquireDb,
    materializeProjectCatalog,
    outlineItemRows,
    resultColumnMetadata,
    SYSTEM_SCHEMA,
} from "../mcp/relation-service.js";
import { Project } from "../schema/app-schema.js";
import type { CapturedViewProducer, ObservationContext, TargetRef, ViewProducerOpener } from "./view-observation.js";

const LIMITS = { queryBytes: 16 * 1024, rows: 10_000, columns: 100, jsonBytes: 8 * 1024 * 1024 } as const;
type Kind = "grid" | "calendar";
type Host = Pick<Hocuspocus, "openDirectConnection"> & Partial<Pick<Hocuspocus, "documents">>;

interface Capture {
    readonly project: DirectConnection;
    readonly sources: ReadonlyMap<string, DirectConnection>;
    readonly documents: readonly Y.Doc[];
    readonly definition: Y.Map<unknown>;
    readonly revision: string;
    readonly projection: Awaited<ReturnType<CapturedViewProducer["read"]>>;
    /** Whether every authority required by the captured registry was opened. */
    readonly authoritiesComplete: boolean;
    authoritiesCurrent(): boolean;
    current(): boolean;
    definitionCurrent(): boolean;
    definitionExists(): boolean;
    release(): Promise<void>;
}

export function savedViewOpener(
    host: Host,
    canAccess: (uid: string, projectId: string) => Promise<boolean>,
    kind: Kind,
    options: {
        beforeFinalCertification?: () => Promise<void>;
        beforeSourceOpen?: (tableId: string, index: number) => Promise<void>;
    } = {},
): ViewProducerOpener {
    return async input => {
        let capture = await openCapture(host, canAccess, kind, input, options);
        let closed = false;
        let terminal: "incarnation_lost" | "not_found" | undefined;
        return {
            get documents() {
                return capture.documents;
            },
            async read() {
                if (closed) return { status: "stale", reason: "closed" };
                if (terminal) return { status: terminal === "not_found" ? "not_found" : "stale", reason: terminal };
                if (!capture.current()) {
                    const retained = capture;
                    let candidate: Capture;
                    try {
                        candidate = await openCapture(host, canAccess, kind, input, options);
                    } catch (error) {
                        if (error instanceof McpReadError && error.code === "forbidden") {
                            return { status: "forbidden", reason: "access_revoked" };
                        }
                        if (error instanceof McpReadError && error.code === "not_found") {
                            terminal = "not_found";
                            await retained.release();
                            return { status: "not_found", reason: terminal };
                        }
                        throw error;
                    }
                    if (!candidate.definitionExists()) {
                        terminal = "not_found";
                        await candidate.release();
                        await retained.release();
                        return { status: "not_found", reason: terminal };
                    }
                    // A project edit observed while the candidate is still
                    // opening sources leaves that candidate intentionally
                    // incomplete. It cannot prove that an unopened retained
                    // source changed incarnation, so discard it and preserve
                    // the retained authority for the next refresh attempt.
                    if (
                        candidate.projection.status === "stale" && candidate.projection.reason === "inputs_changed"
                        && candidate.definitionCurrent() && retained.definition === candidate.definition
                    ) {
                        await candidate.release();
                        return candidate.projection;
                    }
                    // Validation and query-size failures happen before Table
                    // rooms are opened. Such a candidate can report the
                    // configuration error, but its partial document set is
                    // not evidence that a retained Table room lost its
                    // incarnation. Keep the retained authorities so a later
                    // configuration correction can recover on this handle.
                    if (
                        !closed && !candidate.authoritiesComplete && retained.authoritiesCurrent()
                        && candidate.definitionCurrent()
                        && retained.definition === candidate.definition
                    ) {
                        const projection = candidate.projection;
                        await candidate.release();
                        return projection;
                    }
                    if (
                        closed || !candidate.definitionCurrent() || retained.definition !== candidate.definition
                        || !sameAuthorities(retained, candidate)
                    ) {
                        terminal = closed ? undefined : "incarnation_lost";
                        await candidate.release();
                        await retained.release();
                        return { status: "stale", reason: closed ? "closed" : "incarnation_lost" };
                    }
                    capture = candidate;
                    await retained.release();
                }
                return capture.projection;
            },
            isCurrent(revision) {
                return !closed && capture.current() && capture.revision === revision;
            },
            async close() {
                if (closed) return;
                closed = true;
                await capture.release();
            },
        };
    };
}

async function openCapture(
    hostValue: Host,
    canAccess: (uid: string, projectId: string) => Promise<boolean>,
    kind: Kind,
    { uid, target, context }: { uid: string; target: TargetRef; context: ObservationContext; },
    options: {
        beforeFinalCertification?: () => Promise<void>;
        beforeSourceOpen?: (tableId: string, index: number) => Promise<void>;
    },
): Promise<Capture> {
    if (!hostValue.documents) throw new McpReadError("internal_failure", "Live room authority is unavailable");
    const host = hostValue as LiveRoomHost;
    if (!await canAccess(uid, target.projectId)) throw new McpReadError("forbidden", "Project is inaccessible");
    let project: DirectConnection | undefined;
    const sources = new Map<string, DirectConnection>();
    let transferred = false;
    try {
        project = await openLiveRoom(host, `projects/${target.projectId}`, uid, { effect: "none" });
        if (!await canAccess(uid, target.projectId)) throw new McpReadError("forbidden", "Project is inaccessible");
        const doc = project.document as unknown as Y.Doc;
        const definition = definitionFor(doc, kind, target.objectId);
        if (!definition) throw new McpReadError("not_found", `${kind} not found`);
        const query = kind === "grid"
            ? getGridQuery(getGridDefinitionTarget(doc as never, target.objectId)!)
            : String(definition.get("query") ?? "");
        // Capture the complete project/definition input before the first
        // source-opening await. A later revision must never certify the query
        // and settings selected above as if they came from that later state.
        const projectInputRevision = documentRevision(doc);
        if (Buffer.byteLength(query, "utf8") > LIMITS.queryBytes) {
            transferred = true;
            return complete(project, sources, definition, {
                status: "unavailable",
                reason: "resource_limit",
            }, host, target, undefined, false);
        }
        let normalized: string;
        try {
            normalized = embeddableReadOnlySelect(validateReadOnlySelect(query, false), false);
        } catch {
            transferred = true;
            return complete(project, sources, definition, { status: "unavailable", reason: "invalid_query" }, host,
                target, undefined, false);
        }
        const identifiers = parseSqlIdentifiers(normalized);
        const tables = [...doc.getMap<Y.Map<unknown>>("yjsTables").entries()].map(([id, entry]) => ({
            id,
            sqlName: String(entry.get("sqlName") ?? ""),
        })).filter(value => /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.sqlName));
        for (const [index, table] of tables.entries()) {
            await options.beforeSourceOpen?.(table.id, index);
            const connection = await openLiveRoom(host, `projects/${target.projectId}/tables/${table.id}`, uid, {
                effect: "none",
            });
            sources.set(table.id, connection);
            if (
                definitionFor(doc, kind, target.objectId) !== definition
                || documentRevision(doc) !== projectInputRevision
            ) {
                transferred = true;
                return complete(project, sources, definition, { status: "stale", reason: "inputs_changed" }, host,
                    target, `stale:${projectInputRevision}`, false);
            }
        }
        const docs = [doc, ...[...sources.values()].map(value => value.document as unknown as Y.Doc)];
        const capturedRevision = revision(docs);
        const lease = await acquireDb();
        let projection: Capture["projection"];
        try {
            const catalog = await materializeProjectCatalog(lease.db, target.projectId, doc);
            await lease.db.exec(SYSTEM_SCHEMA);
            for (const row of outlineItemRows(Project.fromDoc(doc as never))) {
                await lease.db.query(
                    `INSERT INTO outline_items VALUES (${row.map((_, index) => `$${index + 1}`).join(",")})`,
                    row,
                );
            }
            const evidenceSources: SelectRelationEvidence[] = [{
                kind: "system",
                id: "outline_items",
                sqlName: "outline_items",
                schemaRevision: digest(SYSTEM_SCHEMA),
                columns: await columnsFor(lease.db, "outline_items"),
            }];
            for (const table of tables) {
                const source = sources.get(table.id)!;
                const sourceDoc = source.document as unknown as Y.Doc;
                const schema = sourceDoc.getText("schema").toString();
                if (
                    !schema.trim()
                    || (!identifiers.has(table.sqlName) && !identifiers.has(table.sqlName.toLowerCase()))
                ) {
                    continue;
                }
                await lease.db.exec(schema);
                await loadRecords(lease.db, table.sqlName, [...sourceDoc.getMap<Y.Map<unknown>>("data").entries()]);
                evidenceSources.push({
                    kind: "table",
                    id: table.id,
                    sqlName: table.sqlName,
                    schemaRevision: digest(schema),
                    columns: await columnsFor(lease.db, table.sqlName),
                });
            }
            await lease.db.exec("BEGIN");
            try {
                if (kind === "calendar") {
                    const calendarContext = context as CalendarObservationContextV1;
                    await lease.db.query("SELECT set_config('timezone', $1, true)", [calendarContext.timeZone]);
                    await lease.db.query("SELECT set_config('view.range_start', $1, true)", [
                        new Date(calendarContext.rangeStartUtcMs).toISOString(),
                    ]);
                    await lease.db.query("SELECT set_config('view.range_end', $1, true)", [
                        new Date(calendarContext.rangeEndUtcMs).toISOString(),
                    ]);
                }
                const result = await lease.db.query<Record<string, unknown>>(
                    `SELECT * FROM (${normalized}\n) AS saved_view_observation LIMIT ${LIMITS.rows + 1}`,
                );
                result.rows = formatQueryDateFields(result.fields, result.rows);
                if (
                    result.rows.length > LIMITS.rows || result.fields.length > LIMITS.columns
                    || Buffer.byteLength(JSON.stringify(result.rows, jsonReplacer), "utf8") > LIMITS.jsonBytes
                ) {
                    projection = { status: "unavailable", reason: "resource_limit" };
                } else if (kind === "grid") {
                    projection = await gridProjection(lease.db, target, context as GridObservationContextV1, definition,
                        normalized, result, evidenceSources, catalog.snapshot.revision);
                } else {
                    projection = calendarProjection(doc, definition, context as CalendarObservationContextV1, result);
                }
                await lease.db.exec("COMMIT");
            } catch (error) {
                await lease.db.exec("ROLLBACK").catch(() => undefined);
                throw error;
            }
        } catch (error) {
            if (error instanceof McpReadError && error.code === "forbidden") throw error;
            projection = { status: "unavailable", reason: "execution_error" };
        } finally {
            lease.release();
        }
        await options.beforeFinalCertification?.();
        if (!await canAccess(uid, target.projectId)) throw new McpReadError("forbidden", "Project is inaccessible");
        if (!isCaptureCurrent(host, target, docs, definition, capturedRevision)) {
            projection = { status: "stale", reason: "inputs_changed" };
        }
        transferred = true;
        return complete(project, sources, definition, projection, host, target, capturedRevision);
    } finally {
        if (!transferred) await release(project, sources, host);
    }
}

async function gridProjection(
    db: import("@electric-sql/pglite").PGlite,
    target: TargetRef,
    context: GridObservationContextV1,
    definition: Y.Map<unknown>,
    query: string,
    result: { rows: Record<string, unknown>[]; fields: { name: string; dataTypeID: number; }[]; },
    sources: SelectRelationEvidence[],
    catalogRevision: string,
): Promise<Capture["projection"]> {
    const binding = await boundGridRelations(db, query, result.fields.length, sources.map(value => value.sqlName));
    const analysis = analyzeProjectQueryProvenance({
        queryId: crypto.randomUUID(),
        queryRevision: 1,
        query,
        executionGeneration: 1,
        catalogGeneration: 1,
        catalogRevision,
        dependencyStatus: binding.status,
        sources: sources.filter(source => binding.relations.includes(source.sqlName)),
        columns: result.fields.map(field => ({ name: field.name, typeId: field.dataTypeID })),
    });
    const grid = getGridDefinitionTarget(definition.doc as never, target.objectId)!;
    const components = readGridComponents(grid);
    const physicalColumns = await Promise.all(analysis.branches.flatMap(branch => branch.columns).map(async column => ({
        outputColumn: column.outputColumn,
        physicalColumn: column.physicalColumn,
        source: column.source,
        field: await fieldFor(db, column.source.sqlName, column.physicalColumn),
    })));
    // A proven empty dependency set is authoritative relation-free evidence:
    // no physical field can exist, so the UI's result-OID renderer fallback is
    // the complete production derivation rather than incomplete provenance.
    const metadataStatus = binding.status === "proven" && binding.relations.length === 0
        ? "relation-free" as const
        : analysis.status === "proven"
        ? "resolved" as const
        : "unavailable" as const;
    const projected = projectGridTable({
        title: String(definition.get("name") ?? ""),
        context,
        columns: result.fields.map(field => field.name),
        rows: result.rows,
        rowTargets: result.rows.map((row, index) => {
            const accepted = unambiguousRowSource(analysis, row);
            return {
                logicalRowId: `${String(row.source_kind ?? "result")}:${
                    String(row.source_id ?? row.id ?? index)
                }:${index}`,
                ...(accepted?.kind === "source"
                    ? { source: { sourceKind: accepted.source.sqlName, sourceId: accepted.rowId } }
                    : {}),
            };
        }),
        columnOrder: getGridColumnOrder(grid),
        hiddenColumns: components.hidden,
        columnLabels: components.labels,
        componentTypes: components.types,
        resultColumns: result.fields.map(field => ({ name: field.name, typeId: field.dataTypeID })),
        physicalColumns,
        metadataStatus,
    });
    return projected.status === "ready"
        ? { status: "ready", projection: projected.projection, revision: "pending" }
        : { status: "unavailable", reason: projected.reason };
}

function calendarProjection(
    doc: Y.Doc,
    definition: Y.Map<unknown>,
    context: CalendarObservationContextV1,
    result: { rows: Record<string, unknown>[]; fields: { name: string; }[]; },
): Capture["projection"] {
    const array = (value: unknown): string[] =>
        Array.isArray(value)
            ? [...new Set(value.map(String))]
            : value instanceof Y.Array
            ? [...new Set(value.toArray().map(String))]
            : [];
    const derived = deriveCalendarVisibleModel({
        authority: {
            current: true,
            result: { columns: result.fields.map(field => field.name), rows: result.rows },
            project: Project.fromDoc(doc as never),
        },
        settings: {
            name: String(definition.get("name") ?? ""),
            query: String(definition.get("query") ?? ""),
            roleTitle: stringValue(definition.get("roleTitle")),
            roleStart: stringValue(definition.get("roleStart")),
            roleAllDay: stringValue(definition.get("roleAllDay")),
            roleDuration: stringValue(definition.get("roleDuration")),
            roleDue: stringValue(definition.get("roleDue")),
            groupAxes: array(definition.get("groupAxes")),
            laneOrder: array(definition.get("laneOrder")),
            showEmptyLanes: definition.get("showEmptyLanes") === true,
            workingHoursStartMinutes: numberValue(definition.get("workingHoursStartMinutes")),
            workingHoursEndMinutes: numberValue(definition.get("workingHoursEndMinutes")),
        },
        context,
    });
    return derived.ready
        ? { status: "ready", projection: derived.model.projection, revision: "pending" }
        : { status: "unavailable", reason: derived.reason };
}

function complete(
    project: DirectConnection,
    sources: ReadonlyMap<string, DirectConnection>,
    definition: Y.Map<unknown>,
    projection: Capture["projection"],
    host: LiveRoomHost,
    target: TargetRef,
    capturedRevision?: string,
    authoritiesComplete = true,
): Capture {
    const documents = [project.document as unknown as Y.Doc,
        ...[...sources.values()].map(value => value.document as unknown as Y.Doc)];
    const value = capturedRevision ?? revision(documents);
    const ready = projection.status === "ready" ? { ...projection, revision: value } : projection;
    let released = false;
    return {
        project,
        sources,
        documents,
        definition,
        revision: value,
        projection: ready,
        authoritiesComplete,
        authoritiesCurrent: () =>
            !released
            && documents.every(doc => isLiveRoom(host, (doc as Y.Doc & { name?: string; }).name ?? doc.guid, doc)),
        current: () => !released && isCaptureCurrent(host, target, documents, definition, value),
        definitionCurrent: () => definitionFor(documents[0]!, target.kind as Kind, target.objectId) === definition,
        definitionExists: () => definitionFor(documents[0]!, target.kind as Kind, target.objectId) !== undefined,
        async release() {
            if (released) return;
            released = true;
            await release(project, sources, host);
        },
    };
}

function definitionFor(doc: Y.Doc, kind: Kind, id: string): Y.Map<unknown> | undefined {
    return kind === "grid"
        ? doc.getMap<Y.Map<unknown>>("yjsGrids").get(id)
        : doc.getMap<Y.Map<unknown>>("calendars").get(id);
}
function isCaptureCurrent(
    host: LiveRoomHost,
    target: TargetRef,
    docs: readonly Y.Doc[],
    definition: Y.Map<unknown>,
    value: string,
) {
    return definitionFor(docs[0]!, target.kind as Kind, target.objectId) === definition
        && docs.every(doc => isLiveRoom(host, (doc as Y.Doc & { name?: string; }).name ?? doc.guid, doc))
        && revision(docs) === value;
}
function sameAuthorities(left: Capture, right: Capture) {
    const byName = new Map(right.documents.map(doc => [(doc as Y.Doc & { name?: string; }).name ?? doc.guid, doc]));
    return left.documents.every(doc => byName.get((doc as Y.Doc & { name?: string; }).name ?? doc.guid) === doc);
}
async function release(
    project: DirectConnection | undefined,
    sources: ReadonlyMap<string, DirectConnection>,
    host: LiveRoomHost,
) {
    let failure: unknown;
    for (const connection of [...sources.values(), ...(project ? [project] : [])]) {
        try {
            await closeLiveRoom(host, connection);
        } catch (error) {
            failure ??= error;
        }
    }
    if (failure) throw failure;
}
function revision(documents: readonly Y.Doc[]) {
    const hash = crypto.createHash("sha256");
    for (const doc of documents) hash.update(Buffer.from(Y.encodeStateAsUpdate(doc)));
    return hash.digest("base64url");
}
function documentRevision(document: Y.Doc) {
    return Buffer.from(Y.encodeStateAsUpdate(document)).toString("base64url");
}
function digest(value: string) {
    return crypto.createHash("sha256").update(value).digest("base64url");
}
const jsonReplacer = (_key: string, value: unknown) => typeof value === "bigint" ? value.toString() : value;
async function columnsFor(db: import("@electric-sql/pglite").PGlite, relation: string) {
    return (await db.query<{ column_name: string; }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [relation],
    )).rows.map(row => row.column_name);
}
async function fieldFor(
    db: import("@electric-sql/pglite").PGlite,
    relation: string,
    column: string,
): Promise<GridProjectionField | undefined> {
    const row = (await db.query<{ data_type: string; is_nullable: string; }>(
        "SELECT data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
        [relation, column],
    )).rows[0];
    if (!row) return undefined;
    const kind = row.data_type === "boolean" ? "boolean" : /int/.test(row.data_type)
        ? "integer"
        : /numeric|real|double/.test(row.data_type)
        ? "number"
        : row.data_type === "date"
        ? "date"
        : "text";
    return { name: column, kind, dataType: row.data_type, isNullable: row.is_nullable === "YES", isPrimaryKey: false };
}
async function loadRecords(
    db: import("@electric-sql/pglite").PGlite,
    table: string,
    records: [string, Y.Map<unknown>][],
) {
    for (const [id, record] of records) {
        const values = { ...Object.fromEntries(record.entries()), id } as Record<string, unknown>;
        const keys = Object.keys(values);
        await db.query(
            `INSERT INTO "${table.replace(/"/g, '""')}" (${
                keys.map(key => `"${key.replace(/"/g, '""')}"`).join(",")
            }) VALUES (${keys.map((_, index) => `$${index + 1}`).join(",")})`,
            keys.map(key => values[key]),
        );
    }
}
function stringValue(value: unknown) {
    return typeof value === "string" ? value : undefined;
}
function numberValue(value: unknown) {
    return typeof value === "number" ? value : undefined;
}

function formatQueryDateFields(
    fields: readonly { name: string; dataTypeID: number; }[],
    rows: Record<string, unknown>[],
): Record<string, unknown>[] {
    const types = new Map(fields.map(field => [field.name, field.dataTypeID]));
    const pad = (value: number) => String(value).padStart(2, "0");
    return rows.map(row =>
        Object.fromEntries(Object.entries(row).map(([name, value]) => {
            if (!(value instanceof Date)) return [name, value];
            const type = types.get(name);
            if (type === 1082) {
                return [name, `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`];
            }
            if (type === 1114) {
                return [name,
                    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${
                        pad(value.getHours())
                    }:${pad(value.getMinutes())}:${pad(value.getSeconds())}.${
                        String(value.getMilliseconds()).padStart(3, "0")
                    }Z`];
            }
            return [name, type === 1184 ? value.toISOString() : value];
        }))
    );
}
