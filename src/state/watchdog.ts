export class Watchdog {
  private lastEventAt: Date;
  private timeoutMs: number;
  private checkIntervalMs: number;
  private timer: NodeJS.Timeout | null;
  private callback: (() => void) | null;

  constructor(options: { timeoutMs?: number; checkIntervalMs?: number } = {}) {
    this.lastEventAt = new Date();
    this.timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
    this.checkIntervalMs = options.checkIntervalMs ?? 30 * 1000;
    this.timer = null;
    this.callback = null;
  }

  start(): void {
    if (this.timer) {
      return;
    }

    this.timer = setInterval(() => {
      const elapsed = Date.now() - this.lastEventAt.getTime();
      if (elapsed >= this.timeoutMs) {
        this.callback?.();
      }
    }, this.checkIntervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  touch(): void {
    this.lastEventAt = new Date();
  }

  onStuck(callback: () => void): void {
    this.callback = callback;
  }
}
