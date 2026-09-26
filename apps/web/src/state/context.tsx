import { createContext, useContext, type Dispatch } from 'react';
import type { Capabilities } from '@ppt-remedy/contracts';
import type { EngineClient } from '../engine/client.ts';
import type { ImagePayload } from '../engine/protocol.ts';
import type { QueueSnapshot } from '../ai/queue.ts';
import type { Action, AppState } from './session.ts';

export interface PreviewEntry {
  status: 'loading' | 'ready' | 'unavailable';
  url?: string;
  image?: ImagePayload;
  reason?: string;
}

export interface AiContextInput {
  slideTitle: string;
  contextText: string;
}

export interface AppApi {
  state: AppState;
  dispatch: Dispatch<Action>;
  engine: EngineClient;
  capabilities: Capabilities | undefined;
  aiAvailable: boolean;
  queue: QueueSnapshot;
  aiErrors: Record<string, string>;
  openFile: (file: File) => void;
  loadSample: () => void;
  cancelScan: () => void;
  preview: (objectKey: string) => PreviewEntry | undefined;
  requestPreview: (objectKey: string) => void;
  generate: (targetKey: string, input?: AiContextInput, opts?: { consented?: boolean }) => void;
  cancelGenerate: (objectKey: string) => void;
  resumeAi: () => void;
  exportDeck: (patchIds: string[]) => void;
  cancelExport: () => void;
  /** Automatically describe every eligible picture, export, and verify (ADR 0003). */
  remediateAll: () => void;
  cancelRemediation: () => void;
  download: (kind: 'pptx' | 'html' | 'json') => void;
  clearSession: () => void;
}

export const AppContext = createContext<AppApi | null>(null);

export function useApp(): AppApi {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('AppContext missing');
  return ctx;
}
