import { isIP } from "node:net";

export const MAX_NOTIFICATION_URL_LENGTH = 2048;
export const MAX_DNS_ANSWERS = 16;

export type HttpsDestination = Readonly<{
    url: URL;
    hostname: string;
    path: string;
    port: 443;
}>;

/** Pure admission validation. Network-dependent checks deliberately live elsewhere. */
export function validateHttpsDestination(value: string): HttpsDestination | undefined {
    if (value.length === 0 || value.length > MAX_NOTIFICATION_URL_LENGTH || /[\0-\x20\x7f]/u.test(value)) {
        return undefined;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return undefined;
    }
    if (
        url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.hash !== ""
        || (url.port !== "" && url.port !== "443") || !url.hostname || isIP(url.hostname) !== 0
        || url.hostname.endsWith(".") || url.hostname.length > 253
    ) return undefined;
    const labels = url.hostname.split(".");
    if (labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return undefined;
    return Object.freeze({ url, hostname: url.hostname, path: `${url.pathname}${url.search}`, port: 443 as const });
}

function ipv4Number(address: string): number | undefined {
    if (isIP(address) !== 4) return undefined;
    const octets = address.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
        return undefined;
    }
    return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0;
}

function inCidr(value: number, base: number, bits: number): boolean {
    const divisor = 2 ** (32 - bits);
    return Math.floor(value / divisor) === Math.floor(base / divisor);
}

// IANA special-purpose/non-global IPv4 blocks, including documentation and benchmarking space.
const NON_PUBLIC = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
] as const;

export function isPublicIpv4(address: string): boolean {
    const value = ipv4Number(address);
    return value !== undefined && !NON_PUBLIC.some(([base, bits]) => inCidr(value, ipv4Number(base)!, bits));
}

export function validateResolvedIpv4(addresses: readonly string[]): readonly string[] | undefined {
    if (addresses.length === 0 || addresses.length > MAX_DNS_ANSWERS) return undefined;
    const unique = [...new Set(addresses)];
    return unique.length === addresses.length && unique.every(isPublicIpv4) ? Object.freeze(unique) : undefined;
}
