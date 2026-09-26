/** Messages between the UI thread and the package-engine Web Worker. */
import type { ApprovedPatch, ChangeRecord, CoverageRecord, DeckManifest, Finding } from '@ppt-remedy/contracts';

export type EngineRequest =
  | { id: number; type: 'scan'; name: string; bytes: ArrayBuffer }
  | { id: number; type: 'image'; objectKey: string }
  | { id: number; type: 'export'; patches: ApprovedPatch[]; findingIdsByPatch: Record<string, string[]> };

export interface ScanPayload {
  manifest: DeckManifest;
  findings: Finding[];
  coverage: CoverageRecord[];
  limitations: string[];
  partSha256: Record<string, string>;
}

export interface ImagePayload {
  bytes: ArrayBuffer;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  crop?: { left: number; top: number; right: number; bottom: number };
  aiEligible: boolean;
  blockers: string[];
}

export type ExportPayload =
  | { ok: true; bytes: ArrayBuffer; outputSha256: string; unchanged: boolean; changes: ChangeRecord[]; rescan: DeckManifest }
  | { ok: false; error: { code: string; message: string; part?: string }; changes: ChangeRecord[] };

export type EngineResponse =
  | { id: number; type: 'progress'; stage: string; done: number; total: number }
  | { id: number; type: 'scan'; payload: ScanPayload }
  | { id: number; type: 'image'; payload: ImagePayload | { unavailable: string } }
  | { id: number; type: 'export'; payload: ExportPayload }
  | { id: number; type: 'error'; code: string; message: string };
