import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { CredentialEnvelope } from "./credential-envelope.js";

export class EventsError extends Error {
    constructor(readonly category: "unavailable" | "conflict" | "expired" | "verification_failed") {
        super(`Notification Events ${category}`);
    }
}
export interface Lease {
    uid: string;
    identity: string;
    clientId: string;
    subscriptionId: string;
    generation: number;
    expiresAtMs: number;
    callbackUrl: string;
    signingSecret: string;
}
interface Row {
    uid: string;
    generation: number;
    active: string | null;
    pending: string | null;
    state: string;
}
interface SealedLease {
    identity: string;
    id: string;
    expires: number;
    sealed: string;
}
export interface LeaseCandidate {
    lease: Lease;
    candidateId: string;
    deadline: number;
}

/** Only route control state is durable; never store event bodies or delivery evidence. */
export class McpLeaseStore {
    private initialized?: Database.Database;
    constructor(
        private readonly database: () => Database.Database | undefined,
        private readonly envelope: CredentialEnvelope,
    ) {}
    private run<T>(operation: (db: Database.Database) => T): T {
        try {
            const db = this.database();
            if (!db?.open) throw new Error();
            if (this.initialized !== db) {
                db.exec(`CREATE TABLE IF NOT EXISTS notification_mcp_leases (
                    uid TEXT PRIMARY KEY, generation INTEGER NOT NULL, active TEXT, pending TEXT, state TEXT NOT NULL)`);
                // Verification is process-local work. A restart invalidates every unfinished challenge.
                db.exec(
                    "UPDATE notification_mcp_leases SET pending=NULL, generation=generation+1 WHERE pending IS NOT NULL",
                );
                this.initialized = db;
            }
            return db.transaction(() => operation(db))();
        } catch (error) {
            if (error instanceof EventsError) throw error;
            throw new EventsError("unavailable");
        }
    }
    ready(): boolean {
        try {
            this.run(() => undefined);
            return true;
        } catch {
            return false;
        }
    }
    private row(db: Database.Database, uid: string): Row {
        db.prepare("INSERT OR IGNORE INTO notification_mcp_leases VALUES (?,0,NULL,NULL,'configured')").run(uid);
        let row = db.prepare("SELECT * FROM notification_mcp_leases WHERE uid=?").get(uid) as Row;
        const active = row.active ? JSON.parse(row.active) as SealedLease : undefined;
        const pending = row.pending ? JSON.parse(row.pending) as SealedLease : undefined;
        if ((active && active.expires <= Date.now()) || (pending && pending.expires <= Date.now())) {
            db.prepare(
                `UPDATE notification_mcp_leases SET generation=generation+1, active=?,pending=?,state=? WHERE uid=?`,
            )
                .run(active && active.expires > Date.now() ? row.active : null,
                    pending && pending.expires > Date.now() ? row.pending : null,
                    active && active.expires <= Date.now() ? "expired" : row.state, uid);
            row = db.prepare("SELECT * FROM notification_mcp_leases WHERE uid=?").get(uid) as Row;
        }
        return row;
    }
    private decode(row: Row): Lease | undefined {
        if (!row.active) return undefined;
        const box = JSON.parse(row.active) as SealedLease;
        const lease = this.envelope.open<Lease>(box.sealed, JSON.stringify([row.uid, box.identity, box.id, 1]));
        if (lease.uid !== row.uid || lease.identity !== box.identity || lease.expiresAtMs !== box.expires) {
            throw new Error();
        }
        return { ...lease, generation: row.generation };
    }
    capture(uid: string): Lease | undefined {
        return this.run(db => this.decode(this.row(db, uid)));
    }
    reserve(input: Omit<Lease, "generation" | "subscriptionId">): LeaseCandidate {
        return this.run(db => {
            const row = this.row(db, input.uid);
            const active = this.decode(row);
            const pending = row.pending ? JSON.parse(row.pending) as SealedLease : undefined;
            if ((active && active.identity !== input.identity) || (pending && pending.identity !== input.identity)) {
                throw new EventsError("conflict");
            }
            if (input.expiresAtMs <= Date.now()) throw new EventsError("expired");
            const candidateId = randomUUID();
            // Reservation does not invalidate the old active lease during refresh verification.
            const lease: Lease = {
                ...input,
                generation: row.generation,
                subscriptionId: active?.subscriptionId ?? randomUUID(),
            };
            const deadline = Math.min(input.expiresAtMs, Date.now() + 60_000);
            const sealed = this.envelope.seal(lease, JSON.stringify([input.uid, input.identity, candidateId, 1]));
            db.prepare("UPDATE notification_mcp_leases SET pending=? WHERE uid=?")
                .run(JSON.stringify({ identity: input.identity, id: candidateId, expires: deadline, sealed }),
                    input.uid);
            return { lease, candidateId, deadline };
        });
    }
    candidateCurrent(candidate: LeaseCandidate): boolean {
        try {
            return this.run(db => {
                const row = this.row(db, candidate.lease.uid);
                if (row.generation !== candidate.lease.generation || !row.pending || Date.now() >= candidate.deadline) {
                    return false;
                }
                const pending = JSON.parse(row.pending) as SealedLease;
                if (
                    pending.id !== candidate.candidateId || pending.identity !== candidate.lease.identity
                    || pending.expires !== candidate.deadline
                ) return false;
                const lease = this.envelope.open<Lease>(pending.sealed,
                    JSON.stringify([row.uid, pending.identity, pending.id, 1]));
                return JSON.stringify(lease) === JSON.stringify(candidate.lease);
            });
        } catch {
            return false;
        }
    }
    commit(candidate: LeaseCandidate): Lease {
        const committed = this.run(db => {
            if (!this.candidateCurrent(candidate)) return undefined;
            const row = this.row(db, candidate.lease.uid);
            const lease = { ...candidate.lease, generation: row.generation + 1 };
            const id = randomUUID();
            const sealed = this.envelope.seal(lease, JSON.stringify([lease.uid, lease.identity, id, 1]));
            db.prepare(
                "UPDATE notification_mcp_leases SET generation=?,active=?,pending=NULL,state='active' WHERE uid=?",
            )
                .run(lease.generation,
                    JSON.stringify({ identity: lease.identity, id, expires: lease.expiresAtMs, sealed }), lease.uid);
            return lease;
        });
        if (!committed) throw new EventsError("expired");
        return committed;
    }
    fail(candidate: LeaseCandidate): void {
        this.run(db => {
            const row = this.row(db, candidate.lease.uid);
            if (row.pending && JSON.parse(row.pending).id === candidate.candidateId) {
                db.prepare("UPDATE notification_mcp_leases SET pending=NULL WHERE uid=?").run(row.uid);
            }
        });
    }
    remove(uid: string, identity: string): void {
        this.run(db => {
            const row = this.row(db, uid);
            const active = this.decode(row);
            const pending = row.pending ? JSON.parse(row.pending) as SealedLease : undefined;
            if ((active && active.identity !== identity) || (pending && pending.identity !== identity)) return;
            db.prepare(
                "UPDATE notification_mcp_leases SET generation=generation+1,active=NULL,pending=NULL,state='disabled' WHERE uid=?",
            ).run(uid);
        });
    }
    isCurrent(lease: Lease): boolean {
        try {
            return this.run(db => {
                const row = this.row(db, lease.uid);
                const current = this.decode(row);
                return Date.now() < lease.expiresAtMs && current !== undefined
                    && JSON.stringify(current) === JSON.stringify(lease);
            });
        } catch {
            return false;
        }
    }
    gone(lease: Lease): void {
        this.run(db => {
            if (this.isCurrent(lease)) {
                db.prepare(
                    "UPDATE notification_mcp_leases SET generation=generation+1,active=NULL,pending=NULL,state='disabled' WHERE uid=?",
                ).run(lease.uid);
            }
        });
    }
    status(uid: string): { state: string; expiresAtMs?: number; } {
        return this.run(db => {
            const row = this.row(db, uid);
            const lease = this.decode(row);
            if (row.pending) {
                const pending = JSON.parse(row.pending) as SealedLease;
                this.envelope.open<Lease>(pending.sealed, JSON.stringify([row.uid, pending.identity, pending.id, 1]));
            }
            return { state: row.pending ? "pending" : lease ? "active" : row.state, expiresAtMs: lease?.expiresAtMs };
        });
    }
    /** Called at the next control deadline, including when no events arrive. */
    sweep(): number | undefined {
        return this.run(db => {
            const rows = db.prepare(
                "SELECT uid FROM notification_mcp_leases WHERE active IS NOT NULL OR pending IS NOT NULL",
            ).all() as { uid: string; }[];
            let next: number | undefined;
            for (const { uid } of rows) {
                const row = this.row(db, uid);
                for (const value of [row.active, row.pending]) {
                    if (value) {
                        const deadline = (JSON.parse(value) as SealedLease).expires;
                        next = Math.min(next ?? deadline, deadline);
                    }
                }
            }
            return next;
        });
    }
}
