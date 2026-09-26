/**
 * Browser AI scheduler (spec §15 "Concurrency, cancellation and retries"): one request in
 * flight, at most 20 queued objects, one automatic retry only for a clearly transient
 * AI_UNAVAILABLE (with 2–5 s jitter and a fresh challenge), and the queue halts on quota
 * exhaustion or when AI is disabled. These are usability safeguards, not abuse controls.
 */
import { LIMITS } from '@ppt-remedy/contracts';
/** Any attempt result: the queue only inspects success and error codes. */
export type QueueResult = { ok: true } | { ok: false; code: string; message: string };

export interface AiJob {
  targetKey: string;
  sessionId: number;
  kind: 'picture' | 'link';
  /** Performs one attempt; receives a signal for cancellation. */
  run: (signal: AbortSignal) => Promise<QueueResult>;
}

export interface QueueSnapshot {
  queued: string[];
  inFlight?: string;
  halted?: { code: string; message: string };
}

export type JobListener = (job: AiJob, result: QueueResult) => void;

const HALT_CODES = new Set(['AI_QUOTA_EXHAUSTED', 'AI_DISABLED']);

export class AiQueue {
  private queue: AiJob[] = [];
  private current: { job: AiJob; controller: AbortController } | undefined;
  private halted: QueueSnapshot['halted'];
  private listeners = new Set<() => void>();
  private readonly onResult: JobListener;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(onResult: JobListener, opts: { sleep?: (ms: number) => Promise<void>; random?: () => number } = {}) {
    this.onResult = onResult;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  snapshot(): QueueSnapshot {
    const snap: QueueSnapshot = { queued: this.queue.map((j) => j.targetKey) };
    if (this.current) snap.inFlight = this.current.job.targetKey;
    if (this.halted) snap.halted = this.halted;
    return snap;
  }

  /** Returns false (and does nothing) if halted, full, or already pending for the object. */
  enqueue(job: AiJob): { ok: true } | { ok: false; reason: 'halted' | 'full' | 'duplicate' } {
    if (this.halted) return { ok: false, reason: 'halted' };
    if (this.current?.job.targetKey === job.targetKey || this.queue.some((j) => j.targetKey === job.targetKey)) return { ok: false, reason: 'duplicate' };
    if (this.queue.length + (this.current ? 1 : 0) >= LIMITS.clientQueueObjects) return { ok: false, reason: 'full' };
    this.queue.push(job);
    this.emit();
    void this.pump();
    return { ok: true };
  }

  /** Stop local work. Already-submitted inference may still complete and be billed. */
  cancelAll(): void {
    this.queue = [];
    this.current?.controller.abort();
    this.emit();
  }

  cancel(targetKey: string): void {
    this.queue = this.queue.filter((j) => j.targetKey !== targetKey);
    if (this.current?.job.targetKey === targetKey) this.current.controller.abort();
    this.emit();
  }

  resume(): void {
    this.halted = undefined;
    this.emit();
    void this.pump();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  private async pump(): Promise<void> {
    if (this.current || this.halted) return;
    const job = this.queue.shift();
    if (!job) return;
    const controller = new AbortController();
    this.current = { job, controller };
    this.emit();
    let result = await job.run(controller.signal);
    if (!result.ok && result.code === 'AI_UNAVAILABLE' && !controller.signal.aborted) {
      await this.sleep(2000 + Math.floor(this.random() * 3000));
      if (!controller.signal.aborted) result = await job.run(controller.signal);
    }
    this.current = undefined;
    if (!result.ok && HALT_CODES.has(result.code)) {
      this.halted = { code: result.code, message: result.message };
      this.queue = [];
    }
    if (!controller.signal.aborted) this.onResult(job, result);
    this.emit();
    void this.pump();
  }
}
