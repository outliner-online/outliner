import { userManager } from "../../auth/UserManager";
import { resolveApiBaseUrl } from "../../lib/yjsApiUrl";

export interface PushStatus {
    deviceId: string;
    revision: number;
    state: "registered" | "disabled";
    vapidKeyId?: string;
    endpointHash?: string;
    enrollmentGeneration?: string;
}
export interface PublicPushConfig {
    available: true;
    publicKey: string;
    vapidKeyId: string;
}
export class PushRequestError extends Error {
    constructor(public status: number, public code: string) {
        super(code);
    }
}

async function request(path: string, init?: Parameters<typeof fetch>[1]): Promise<Response> {
    const token = await userManager.auth.currentUser?.getIdToken();
    if (!token) throw new PushRequestError(401, "unauthorized");
    const response = await fetch(`${resolveApiBaseUrl().replace(/\/$/u, "")}/api/notifications/push${path}`, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init?.headers },
    });
    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string; reason?: string; };
        throw new PushRequestError(response.status, body.error ?? body.reason ?? "request_failed");
    }
    return response;
}
export async function getPushConfig(): Promise<PublicPushConfig> {
    return (await request("/config")).json();
}
export async function getPushStatus(deviceId: string): Promise<PushStatus> {
    return (await request(`/devices/${encodeURIComponent(deviceId)}`)).json();
}
export async function createAdmission(): Promise<number> {
    return ((await (await request("/admissions", { method: "POST" })).json()) as { admissionFence: number; })
        .admissionFence;
}
export async function registerPushDevice(deviceId: string, body: object): Promise<PushStatus> {
    return (await request(`/devices/${encodeURIComponent(deviceId)}`, { method: "PUT", body: JSON.stringify(body) }))
        .json();
}
export async function disablePushDevice(deviceId: string): Promise<PushStatus> {
    return (await request(`/devices/${encodeURIComponent(deviceId)}/disable`, { method: "POST" })).json();
}
