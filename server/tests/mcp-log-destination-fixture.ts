import type { WriteStream } from "node:fs";
import { refreshMcpLogStream } from "../src/utils/log-manager.js";

let ownershipTail = Promise.resolve();

/** Exclusively owns the process-global MCP file destination for one fixture lifetime. */
export async function acquireMcpLogDestination() {
    const previousOwner = ownershipTail;
    let unlock!: () => void;
    ownershipTail = new Promise<void>(resolve => unlock = resolve);
    await previousOwner;

    let destination: WriteStream;
    try {
        destination = refreshMcpLogStream();
    } catch (error) {
        unlock();
        throw error;
    }
    let released = false;
    return {
        destination,
        wait: () => new Promise<void>((resolve, reject) => {
            if (released) {
                reject(new Error("MCP audit destination lease has been released"));
                return;
            }
            destination.write("", error => error ? reject(error) : resolve());
        }),
        release() {
            if (released) return;
            released = true;
            unlock();
        },
    } satisfies { destination: WriteStream; wait: () => Promise<void>; release: () => void; };
}
