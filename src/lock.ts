export class Lock {
    waiters: (() => void)[];
    locked: boolean;

    constructor() {
        this.locked = false;
        this.waiters = [];
    }

    lock(): Promise<void> {
        return new Promise((resolve, reject) => {
            if (this.locked) {
                this.waiters.push(resolve);
            } else {
                this.locked = true;
                resolve();
            }
        });
    }

    unlock() {
        if (this.waiters.length > 0) {
            const cb = this.waiters.shift();
            setTimeout(cb, 0);
        } else {
            this.locked = false;
        }
    }
}

export class Debouncer {
    waiting: boolean;
    bounceTime: number;

    constructor(time: number) {
        this.waiting = false;
        this.bounceTime = time;
    }

    queue_or_bust(): Promise<void> | null {
        if (this.waiting) {
            return null;
        }
        return new Promise((resolve) => {
            this.waiting = true;
            setTimeout(() => {
                this.waiting = false;
                resolve();
            }, this.bounceTime);
        });
    }
}
