/// <reference lib="webworker" />
/**
 * Package engine worker: holds the source package in memory, scans it, serves picture
 * previews and performs transactional exports. The UI can terminate it at any time.
 */
import { exportPackage, isEngineError, readPictureImage, scanPackage, type ScanSession } from '@ppt-remedy/ooxml';
import { evaluate } from '@ppt-remedy/rules';
import type { EngineRequest, EngineResponse } from './protocol.ts';

declare const self: DedicatedWorkerGlobalScope;

let session: ScanSession | undefined;

function post(msg: EngineResponse, transfer: Transferable[] = []): void {
  self.postMessage(msg, transfer);
}

function fail(id: number, e: unknown): void {
  if (isEngineError(e)) post({ id, type: 'error', code: e.code, message: e.message });
  else post({ id, type: 'error', code: 'INTERNAL', message: 'The presentation could not be processed. It may be damaged or use features this tool does not support.' });
}

self.onmessage = async (event: MessageEvent<EngineRequest>) => {
  const req = event.data;
  try {
    switch (req.type) {
      case 'scan': {
        session = undefined;
        const s = await scanPackage(new Uint8Array(req.bytes), {
          sourceName: req.name,
          onProgress: (p) => post({ id: req.id, type: 'progress', stage: p.stage, done: p.done, total: p.total }),
        });
        session = s;
        const rules = evaluate(s.manifest);
        post({
          id: req.id,
          type: 'scan',
          payload: {
            manifest: s.manifest,
            findings: rules.findings,
            coverage: rules.coverage,
            limitations: rules.limitations,
            partSha256: Object.fromEntries(s.partSha256),
          },
        });
        break;
      }
      case 'image': {
        if (!session) throw new Error('no session');
        const res = readPictureImage(session, req.objectKey);
        if (!res.ok) {
          post({ id: req.id, type: 'image', payload: { unavailable: res.reason } });
          break;
        }
        const copy = res.image.bytes.slice().buffer;
        const payload = {
          bytes: copy,
          mime: res.image.mime,
          width: res.image.width,
          height: res.image.height,
          aiEligible: res.image.aiEligible,
          blockers: res.image.blockers,
          ...(res.image.crop ? { crop: res.image.crop } : {}),
        };
        post({ id: req.id, type: 'image', payload }, [copy]);
        break;
      }
      case 'export': {
        if (!session) throw new Error('no session');
        const result = await exportPackage(session, req.patches, {
          findingIdsByPatch: req.findingIdsByPatch,
          onProgress: (p) => post({ id: req.id, type: 'progress', stage: p.stage, done: p.done, total: p.total }),
        });
        if (result.ok) {
          // Copy so the in-memory source (returned as-is when unchanged) is never transferred away.
          const bytes = result.bytes.slice().buffer;
          post({ id: req.id, type: 'export', payload: { ...result, bytes } }, [bytes]);
        } else {
          post({ id: req.id, type: 'export', payload: result });
        }
        break;
      }
    }
  } catch (e) {
    fail(req.id, e);
  }
};
