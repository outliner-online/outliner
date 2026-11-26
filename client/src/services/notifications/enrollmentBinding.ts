const DB = "outliner-web-push";
const STORE = "enrollment";

export interface EnrollmentBinding {
    fence: number;
    generation?: string;
    vapidKeyId?: string;
}

function parseBinding(value: unknown): EnrollmentBinding {
    if (value === undefined) return { fence: 0 };
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid enrollment binding");
    const binding = value as EnrollmentBinding;
    if (
        !Number.isSafeInteger(binding.fence) || binding.fence < 0
        || (binding.generation !== undefined
            && (typeof binding.generation !== "string" || !/^[A-Za-z0-9_-]{16,128}$/u.test(binding.generation)))
        || (binding.vapidKeyId !== undefined && (typeof binding.vapidKeyId !== "string" || !binding.vapidKeyId))
        || (!!binding.generation !== !!binding.vapidKeyId)
    ) throw new Error("Invalid enrollment binding");
    return binding;
}

function openBinding(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open(DB, 1);
        open.onupgradeneeded = () => open.result.createObjectStore(STORE);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => resolve(open.result);
    });
}

/** Arm and durable disarm share one store with worker effect initiation. */
export async function updateEnrollmentBinding(
    operation: "read" | "disarm" | "arm",
    value?: EnrollmentBinding,
): Promise<EnrollmentBinding> {
    const database = await openBinding();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, operation === "read" ? "readonly" : "readwrite");
        const store = tx.objectStore(STORE);
        const request = store.get("current");
        let result: EnrollmentBinding = { fence: 0 };
        request.onsuccess = () => {
            try {
                const current = parseBinding(request.result);
                if (operation === "read") result = current;
                else if (operation === "disarm") {
                    result = parseBinding({ fence: current.fence + 1 });
                    store.put(result, "current");
                } else {
                    if (!value || current.fence !== value.fence || current.generation) {
                        throw new Error("Enrollment binding changed");
                    }
                    result = parseBinding(value);
                    if (!result.generation) throw new Error("Enrollment generation is required");
                    store.put(result, "current");
                }
            } catch {
                tx.abort();
            }
        };
        tx.oncomplete = () => {
            database.close();
            resolve(result);
        };
        tx.onabort = tx.onerror = () => {
            database.close();
            reject(tx.error ?? new Error("Enrollment binding changed"));
        };
    });
}

export type EnrollmentInitiation<T> = { initiated: false; } | { initiated: true; value: T; };

/**
 * Initiate synchronously while holding the same readwrite transaction as disarm.
 * Awaiting a read and then initiating would allow another tab's disarm to commit
 * in the gap. Each distinct browser operation must acquire this gate separately.
 */
export async function initiateForEnrollment<T>(
    generation: string,
    initiate: () => Promise<T>,
): Promise<EnrollmentInitiation<T>> {
    const database = await openBinding();
    return new Promise((resolve, reject) => {
        const tx = database.transaction(STORE, "readwrite");
        const request = tx.objectStore(STORE).get("current");
        let effect: Promise<T> | undefined;
        request.onsuccess = () => {
            try {
                const binding = parseBinding(request.result);
                if (!binding.generation || binding.generation !== generation || !binding.vapidKeyId) return;
                // No await, promise continuation or callback between match and initiation.
                effect = initiate();
                // A failed operation may settle before IndexedDB commits the read.
                void effect.catch(() => {});
            } catch {
                tx.abort();
            }
        };
        tx.oncomplete = () => {
            database.close();
            if (effect) void effect.then(value => resolve({ initiated: true, value }), reject);
            else resolve({ initiated: false });
        };
        tx.onabort = tx.onerror = () => {
            database.close();
            reject(tx.error ?? new Error("Enrollment binding unavailable"));
        };
    });
}
