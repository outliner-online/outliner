/** Controls only runtime scheduling; real sockets, PGlite, and writer workers keep their own clocks. */
export class RuntimeClock {
    private time = Date.parse("2026-11-21T12:00:00Z");
    private sequence = 0;
    private readonly timers = new Map<number, { at: number; callback: () => void; }>();
    now = () => this.time;
    setTimeout = (callback: () => void, milliseconds: number): unknown => {
        const id = ++this.sequence;
        this.timers.set(id, { at: this.time + Math.max(0, milliseconds), callback });
        return id;
    };
    clearTimeout = (token: unknown): void => {
        this.timers.delete(token as number);
    };
    get pendingTimers() {
        return this.timers.size;
    }
    async advance(milliseconds: number): Promise<void> {
        const target = this.time + milliseconds;
        for (let count = 0; count < 10_000; count++) {
            const next = [...this.timers].filter(([, timer]) => timer.at <= target)
                .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
            if (!next) {
                this.time = target;
                await new Promise<void>(resolve => setImmediate(resolve));
                return;
            }
            this.time = next[1].at;
            this.timers.delete(next[0]);
            next[1].callback();
            await new Promise<void>(resolve => setImmediate(resolve));
        }
        throw new Error("Runtime scheduled an unbounded immediate timer loop");
    }
    async until(predicate: () => boolean, step = 5): Promise<void> {
        const deadline = Date.now() + 15_000;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error("Runtime clock progress timed out");
            await this.advance(step);
            await new Promise(resolve => setTimeout(resolve, 1));
        }
    }
}
