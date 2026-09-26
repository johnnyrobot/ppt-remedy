/**
 * Promise-based client for the engine worker. Cancellation terminates the worker (the
 * only reliable way to stop synchronous inflation/parsing) and starts a fresh one.
 */
import type { ApprovedPatch } from '@ppt-remedy/contracts';
import type { EngineRequest, EngineResponse, ExportPayload, ImagePayload, ScanPayload } from './protocol.ts';

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (stage: string, done: number, total: number) => void;
};

/** Omit that distributes over union members. */
type RequestBody = EngineRequest extends infer R ? (R extends EngineRequest ? Omit<R, 'id'> : never) : never;

export type ProgressFn = (stage: string, done: number, total: number) => void;

export class EngineClient {
  /** Spawned lazily so a disposed client (e.g. React StrictMode remount) recovers. */
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensure(): Worker {
    this.worker ??= this.spawn();
    return this.worker;
  }

  private spawn(): Worker {
    const w = new Worker(new URL('./engine.worker.ts', import.meta.url), { type: 'module', name: 'pptx-engine' });
    w.onmessage = (e: MessageEvent<EngineResponse>) => this.handle(e.data);
    w.onerror = () => {
      for (const p of this.pending.values()) p.reject(new EngineError('WORKER_CRASHED', 'The browser stopped processing (it may have run out of memory). Try a smaller file or a desktop browser.'));
      this.pending.clear();
    };
    return w;
  }

  private handle(msg: EngineResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return; // stale response from a cancelled task
    if (msg.type === 'progress') {
      p.onProgress?.(msg.stage, msg.done, msg.total);
      return;
    }
    this.pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new EngineError(msg.code, msg.message));
    else p.resolve(msg.payload);
  }

  private call<T>(req: RequestBody, transfer: Transferable[] = [], onProgress?: ProgressFn): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(onProgress ? { onProgress } : {}) });
      this.ensure().postMessage({ ...req, id } as EngineRequest, transfer);
    });
  }

  scan(name: string, bytes: ArrayBuffer, onProgress?: ProgressFn): Promise<ScanPayload> {
    return this.call<ScanPayload>({ type: 'scan', name, bytes }, [bytes], onProgress);
  }

  image(objectKey: string): Promise<ImagePayload | { unavailable: string }> {
    return this.call({ type: 'image', objectKey });
  }

  export(patches: ApprovedPatch[], findingIdsByPatch: Record<string, string[]>, onProgress?: ProgressFn): Promise<ExportPayload> {
    return this.call<ExportPayload>({ type: 'export', patches, findingIdsByPatch }, [], onProgress);
  }

  /** Abort all work: terminate and replace the worker. In-memory source is discarded. */
  cancel(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const p of this.pending.values()) p.reject(new EngineError('CANCELLED', 'Cancelled.'));
    this.pending.clear();
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    this.pending.clear();
  }
}
