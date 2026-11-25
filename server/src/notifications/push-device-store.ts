import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

export const MAX_ACTIVE_PUSH_DEVICES = 16;
export const MAX_RETAINED_PUSH_DEVICES = 32;

export interface ValidatedRegistration {
    endpoint: string;
    p256dh: string;
    auth: string;
    vapidKeyId: string;
    expectedRevision: number;
    admissionFence: number;
    enrollmentGeneration: string;
}
export interface PushDeviceStatus {
    deviceId: string;
    revision: number;
    state: "registered" | "disabled";
    vapidKeyId?: string;
    endpointHash?: string;
    enrollmentGeneration?: string;
}
export class PushDeviceError extends Error {
    constructor(public code: "conflict" | "capacity" | "unavailable", message: string) {
        super(message);
    }
}

export class PushDeviceStore {
    constructor(private readonly database: Database.Database | undefined) {}
    initialize(): void {
        const db = this.database;
        if (!db?.open) throw new PushDeviceError("unavailable", "Push enrollment persistence is unavailable");
        db.exec(`
          CREATE TABLE IF NOT EXISTS web_push_owners (uid TEXT PRIMARY KEY, admission_fence INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS web_push_devices (
            uid TEXT NOT NULL, device_id TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL,
            endpoint_hash TEXT UNIQUE, endpoint TEXT, p256dh TEXT, auth_secret TEXT, vapid_key_id TEXT,
            enrollment_generation TEXT, updated_at INTEGER NOT NULL,
            PRIMARY KEY(uid, device_id), CHECK(state IN ('registered','disabled'))
          );
          CREATE TABLE IF NOT EXISTS web_push_admissions (
            uid TEXT NOT NULL, device_id TEXT NOT NULL, admission_fence INTEGER NOT NULL,
            updated_at INTEGER NOT NULL, PRIMARY KEY(uid, device_id), UNIQUE(uid, admission_fence)
          );
          CREATE INDEX IF NOT EXISTS web_push_devices_owner ON web_push_devices(uid, state);
        `);
    }
    private db(): Database.Database {
        if (!this.database?.open) {
            throw new PushDeviceError("unavailable", "Push enrollment persistence is unavailable");
        }
        return this.database;
    }
    issueAdmission(uid: string, deviceId: string): number {
        const db = this.db();
        return db.transaction(() => {
            db.prepare("INSERT INTO web_push_owners(uid, admission_fence) VALUES (?, 0) ON CONFLICT(uid) DO NOTHING")
                .run(uid);
            const existing = db.prepare("SELECT 1 FROM web_push_admissions WHERE uid=? AND device_id=?")
                .get(uid, deviceId);
            const admitted = (db.prepare("SELECT COUNT(*) count FROM web_push_admissions WHERE uid=?").get(uid) as {
                count: number;
            }).count;
            if (!existing && admitted >= MAX_RETAINED_PUSH_DEVICES) {
                throw new PushDeviceError("capacity", "Device capacity reached");
            }
            db.prepare("UPDATE web_push_owners SET admission_fence=admission_fence+1 WHERE uid=?").run(uid);
            const fence = (db.prepare("SELECT admission_fence FROM web_push_owners WHERE uid=?").get(uid) as {
                admission_fence: number;
            }).admission_fence;
            db.prepare(
                `INSERT INTO web_push_admissions(uid,device_id,admission_fence,updated_at) VALUES (?,?,?,?)
                 ON CONFLICT(uid,device_id) DO UPDATE SET admission_fence=excluded.admission_fence,updated_at=excluded.updated_at`,
            ).run(uid, deviceId, fence, Date.now());
            return fence;
        }).immediate();
    }
    list(uid: string): PushDeviceStatus[] {
        return (this.db().prepare(
            "SELECT device_id deviceId, revision, state, vapid_key_id vapidKeyId, endpoint_hash endpointHash, enrollment_generation enrollmentGeneration FROM web_push_devices WHERE uid=? ORDER BY device_id",
        ).all(uid) as PushDeviceStatus[]);
    }
    get(uid: string, deviceId: string): PushDeviceStatus | undefined {
        return this.db().prepare(
            "SELECT device_id deviceId, revision, state, vapid_key_id vapidKeyId, endpoint_hash endpointHash, enrollment_generation enrollmentGeneration FROM web_push_devices WHERE uid=? AND device_id=?",
        ).get(uid, deviceId) as PushDeviceStatus | undefined;
    }
    register(uid: string, deviceId: string, input: ValidatedRegistration): PushDeviceStatus {
        const db = this.db();
        return db.transaction(() => {
            const row = db.prepare("SELECT * FROM web_push_devices WHERE uid=? AND device_id=?").get(uid, deviceId) as
                | Record<string, unknown>
                | undefined;
            const endpointHash = createHash("sha256").update(input.endpoint).digest("hex");
            if (
                row?.state === "registered" && row.endpoint === input.endpoint && row.p256dh === input.p256dh
                && row.auth_secret === input.auth && row.vapid_key_id === input.vapidKeyId
                && row.enrollment_generation === input.enrollmentGeneration
            ) return this.get(uid, deviceId)!;
            const admission = db.prepare(
                "SELECT 1 FROM web_push_admissions WHERE uid=? AND device_id=? AND admission_fence=?",
            ).get(uid, deviceId, input.admissionFence);
            if (!admission) throw new PushDeviceError("conflict", "Registration authority is stale");
            if ((row ? Number(row.revision) : 0) !== input.expectedRevision) {
                throw new PushDeviceError("conflict", "Registration authority is stale");
            }
            if (row?.state !== "registered") {
                const counts = db.prepare(
                    "SELECT COUNT(*) total, SUM(state='registered') active FROM web_push_devices WHERE uid=?",
                ).get(uid) as { total: number; active: number; };
                if (counts.active >= MAX_ACTIVE_PUSH_DEVICES) {
                    throw new PushDeviceError("capacity", "Device capacity reached");
                }
                if (!row && counts.total >= MAX_RETAINED_PUSH_DEVICES) {
                    db.prepare(
                        "DELETE FROM web_push_devices WHERE uid=? AND device_id=(SELECT device_id FROM web_push_devices WHERE uid=? AND state='disabled' ORDER BY updated_at LIMIT 1)",
                    ).run(uid, uid);
                    const retained =
                        (db.prepare("SELECT COUNT(*) count FROM web_push_devices WHERE uid=?").get(uid) as {
                            count: number;
                        }).count;
                    if (retained >= MAX_RETAINED_PUSH_DEVICES) {
                        throw new PushDeviceError("capacity", "Device capacity reached");
                    }
                }
            }
            const conflict = db.prepare(
                "SELECT 1 FROM web_push_devices WHERE endpoint_hash=? AND NOT(uid=? AND device_id=?)",
            ).get(endpointHash, uid, deviceId);
            if (conflict) throw new PushDeviceError("conflict", "Registration conflicts with an existing destination");
            const revision = (row ? Number(row.revision) : 0) + 1;
            db.prepare(
                `INSERT INTO web_push_devices(uid,device_id,revision,state,endpoint_hash,endpoint,p256dh,auth_secret,vapid_key_id,enrollment_generation,updated_at)
              VALUES (?,?,?,'registered',?,?,?,?,?,?,?) ON CONFLICT(uid,device_id) DO UPDATE SET revision=excluded.revision,state='registered',endpoint_hash=excluded.endpoint_hash,endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth_secret=excluded.auth_secret,vapid_key_id=excluded.vapid_key_id,enrollment_generation=excluded.enrollment_generation,updated_at=excluded.updated_at`,
            )
                .run(uid, deviceId, revision, endpointHash, input.endpoint, input.p256dh, input.auth, input.vapidKeyId,
                    input.enrollmentGeneration, Date.now());
            db.prepare("DELETE FROM web_push_admissions WHERE uid=? AND device_id=? AND admission_fence=?")
                .run(uid, deviceId, input.admissionFence);
            return this.get(uid, deviceId)!;
        }).immediate();
    }
    disable(uid: string, deviceId: string): PushDeviceStatus | undefined {
        const db = this.db();
        return db.transaction(() => {
            const row = this.get(uid, deviceId);
            // Invalidate authority admitted for this exact device only. An
            // absent unrelated ID remains an allocation-free no-op.
            db.prepare("DELETE FROM web_push_admissions WHERE uid=? AND device_id=?").run(uid, deviceId);
            if (!row) return undefined;
            db.prepare(
                `UPDATE web_push_devices SET revision=revision+1,state='disabled',endpoint_hash=NULL,endpoint=NULL,p256dh=NULL,auth_secret=NULL,enrollment_generation=NULL,updated_at=? WHERE uid=? AND device_id=?`,
            ).run(Date.now(), uid, deviceId);
            return this.get(uid, deviceId);
        }).immediate();
    }
}
