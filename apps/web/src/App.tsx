import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { LIMITS, sanitizeLinkDestination, truncateCodePoints, type Capabilities } from '@ppt-remedy/contracts';
import { recheck } from '@ppt-remedy/rules';
import { buildReport, renderReportHtml } from '@ppt-remedy/report';
import { EngineClient, EngineError } from './engine/client.ts';
import type { ImagePayload } from './engine/protocol.ts';
import { describeImage, describeLink, fetchCapabilities } from './ai/api.ts';
import { prepareImageForAi } from './ai/prepare.ts';
import { AiQueue, type QueueSnapshot } from './ai/queue.ts';
import { runRemediation, type Attempt, type RemediationTarget } from './ai/remediate.ts';
import { defaultContext, linkContext } from './util/context-text.ts';
import { ChallengeClient } from './ai/turnstile.ts';
import { AppContext, type AiContextInput, type AppApi, type PreviewEntry } from './state/context.tsx';
import {
  findLink,
  findObject,
  findingIdsByPatch,
  findingTarget,
  hasUnsavedWork,
  initialState,
  isLinkTarget,
  patchTarget,
  reducer,
  targetObjectKey,
} from './state/session.ts';
import { LiveRegion } from './components/LiveRegion.tsx';
import { StartScreen } from './components/StartScreen.tsx';
import { Rejection } from './components/Rejection.tsx';
import { Scanning } from './components/Scanning.tsx';
import { Review } from './components/Review.tsx';
import { Exporting } from './components/Exporting.tsx';
import { Remediating } from './components/Remediating.tsx';
import { Complete } from './components/Complete.tsx';

const REJECTED_EXTENSIONS: Record<string, string> = {
  ppt: 'Legacy .ppt files are not supported. Open the file in PowerPoint and save it as a PowerPoint Presentation (.pptx).',
  pptm: 'Macro-enabled presentations (.pptm) are not supported. Save a copy as .pptx without macros.',
  ppsx: 'PowerPoint Show files (.ppsx) are not supported. Save the file as a PowerPoint Presentation (.pptx).',
  pps: 'PowerPoint Show files are not supported. Save the file as a PowerPoint Presentation (.pptx).',
  potx: 'Templates (.potx) are not supported. Save the file as a PowerPoint Presentation (.pptx).',
  key: 'Keynote files are not supported. Export to PowerPoint (.pptx) from Keynote first.',
  odp: 'OpenDocument presentations are not supported. Save as PowerPoint (.pptx) first; check the result in PowerPoint.',
  pdf: 'PDF files are not supported. This tool edits PowerPoint (.pptx) presentations.',
};

export function stemOf(name: string): string {
  return name.replace(/\.pptx$/i, '').replace(/[\\/:*?"<>|]+/g, '_') || 'presentation';
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  const engine = useMemo(() => new EngineClient(), []);
  const sourceFile = useRef<File | undefined>(undefined);
  const previews = useRef(new Map<string, PreviewEntry>());
  const previewLoads = useRef(new Map<string, Promise<PreviewEntry>>());
  const [, bumpPreviews] = useState(0);
  const [capabilities, setCapabilities] = useState<Capabilities | undefined>();
  const [aiErrors, setAiErrors] = useState<Record<string, string>>({});
  const challengeHost = useRef<HTMLDivElement>(null);
  const challenge = useRef<ChallengeClient | undefined>(undefined);

  useEffect(() => () => engine.dispose(), [engine]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCapabilities(controller.signal).then(setCapabilities);
    return () => controller.abort();
  }, []);

  // Best-effort unload warning once there is unsaved work (no durable recovery in R1).
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      const s = stateRef.current;
      if ((s.stage === 'reviewing' || s.stage === 'exporting' || s.stage === 'remediating') && hasUnsavedWork(s)) {
        e.preventDefault();
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  const aiAvailable = !!capabilities?.aiEnabled && !!capabilities.turnstileSiteKey && !state.manualOnly;

  // ---- AI queue ------------------------------------------------------------------
  /** Draft text at the moment each suggestion was requested (stale-result detection). */
  const pendingDrafts = useRef(new Map<string, string | undefined>());
  const queue = useMemo(
    () =>
      new AiQueue((job, raw) => {
        const result = raw as Attempt;
        const s = stateRef.current;
        if (job.sessionId !== s.sessionId) return; // stale: a new file was loaded
        const key = job.targetKey;
        const draftAtStart = pendingDrafts.current.get(key);
        pendingDrafts.current.delete(key);
        if (!result.ok) {
          setAiErrors((e) => ({ ...e, [key]: result.message }));
          dispatch({ type: 'ANNOUNCE', text: result.message });
          return;
        }
        if (s.drafts[key]?.text !== draftAtStart) {
          dispatch({ type: 'ANNOUNCE', text: 'A suggestion arrived after you edited the text, so it was discarded.' });
          return;
        }
        setAiErrors((e) => {
          const next = { ...e };
          delete next[key];
          return next;
        });
        if (result.kind === 'link') {
          dispatch({ type: 'AI_SUGGESTION', targetKey: key, text: result.suggestion.linkText, ai: { status: result.status, model: result.model, warnings: result.suggestion.warnings } });
        } else {
          const sg = result.suggestion;
          dispatch({
            type: 'AI_SUGGESTION',
            targetKey: key,
            text: sg.altText,
            ai: { status: result.status, model: result.model, warnings: sg.warnings, needsLongDescription: sg.needsLongDescription, decorativeSuggestion: sg.decorativeSuggestion },
          });
        }
      }),
    [],
  );
  const [queueSnap, setQueueSnap] = useState<QueueSnapshot>(queue.snapshot());
  useEffect(() => queue.subscribe(() => setQueueSnap(queue.snapshot())), [queue]);

  // ---- Previews ------------------------------------------------------------------
  const releasePreviews = useCallback(() => {
    for (const p of previews.current.values()) if (p.url) URL.revokeObjectURL(p.url);
    previews.current.clear();
    previewLoads.current.clear();
    bumpPreviews((n) => n + 1);
  }, []);

  /** Load (once) and cache a picture preview; resolves when ready or unavailable. */
  const loadPreview = useCallback(
    (objectKey: string): Promise<PreviewEntry> => {
      const existing = previewLoads.current.get(objectKey);
      if (existing) return existing;
      previews.current.set(objectKey, { status: 'loading' });
      const sessionId = stateRef.current.sessionId;
      const promise = engine
        .image(objectKey)
        .then(async (res): Promise<PreviewEntry> => {
          if ('unavailable' in res) return { status: 'unavailable', reason: res.unavailable };
          return { status: 'ready', url: await croppedPreviewUrl(res), image: res };
        })
        .catch((): PreviewEntry => ({ status: 'unavailable', reason: 'UNREADABLE' }))
        .then((entry) => {
          if (stateRef.current.sessionId === sessionId) {
            previews.current.set(objectKey, entry);
            bumpPreviews((n) => n + 1);
          } else if (entry.url) {
            URL.revokeObjectURL(entry.url);
          }
          return entry;
        });
      previewLoads.current.set(objectKey, promise);
      return promise;
    },
    [engine],
  );
  const requestPreview = useCallback((objectKey: string) => void loadPreview(objectKey), [loadPreview]);

  // ---- Intake --------------------------------------------------------------------
  const openFile = useCallback(
    (file: File) => {
      queue.cancelAll();
      releasePreviews();
      setAiErrors({});
      dispatch({ type: 'START_FILE', name: file.name });
      const ext = /\.([^.]+)$/.exec(file.name)?.[1]?.toLowerCase() ?? '';
      if (ext !== 'pptx') {
        dispatch({ type: 'SCAN_FAILED', code: 'UNSUPPORTED_FORMAT', message: REJECTED_EXTENSIONS[ext] ?? 'Only PowerPoint Presentation (.pptx) files are supported.' });
        return;
      }
      if (file.size > LIMITS.inputArchiveBytes) {
        dispatch({ type: 'SCAN_FAILED', code: 'FILE_TOO_LARGE', message: `This file is ${(file.size / 1048576).toFixed(1)} MiB; the limit is ${LIMITS.inputArchiveBytes / 1048576} MiB. Try compressing pictures in PowerPoint (File › Compress Pictures).` });
        return;
      }
      sourceFile.current = file;
      const sessionId = stateRef.current.sessionId + 1;
      void file
        .arrayBuffer()
        .then((buf) =>
          engine.scan(file.name, buf, (stage, done, total) => {
            if (stateRef.current.sessionId === sessionId) dispatch({ type: 'PROGRESS', stage, done, total });
          }),
        )
        .then((payload) => {
          if (stateRef.current.sessionId === sessionId) dispatch({ type: 'SCAN_OK', payload });
        })
        .catch((e: unknown) => {
          if (stateRef.current.sessionId !== sessionId) return;
          if (e instanceof EngineError && e.code === 'CANCELLED') return;
          const err = e instanceof EngineError ? e : new EngineError('INTERNAL', 'The file could not be read.');
          dispatch({ type: 'SCAN_FAILED', code: err.code, message: err.message });
        });
    },
    [engine, queue, releasePreviews],
  );

  const loadSample = useCallback(() => {
    void fetch('/sample-deck.pptx')
      .then((r) => {
        if (!r.ok) throw new Error('missing');
        return r.blob();
      })
      .then((b) => openFile(new File([b], 'sample-deck.pptx', { type: b.type })))
      .catch(() => dispatch({ type: 'ANNOUNCE', text: 'The sample deck could not be loaded.' }));
  }, [openFile]);

  const cancelScan = useCallback(() => {
    engine.cancel();
    sourceFile.current = undefined;
    dispatch({ type: 'CANCEL_SCAN' });
  }, [engine]);

  // ---- AI generation -------------------------------------------------------------
  const ensureChallenge = useCallback((): ChallengeClient | undefined => {
    if (!challenge.current && capabilities?.turnstileSiteKey && challengeHost.current) {
      challenge.current = new ChallengeClient(capabilities.turnstileSiteKey, challengeHost.current);
    }
    return challenge.current;
  }, [capabilities]);

  /** One AI attempt for a picture or a link: prepare, fresh challenge token, request. */
  const attemptFor = useCallback(
    async (targetKey: string, signal: AbortSignal, input?: AiContextInput): Promise<Attempt> => {
      const manifest = stateRef.current.scan!.manifest;
      const obj = findObject(manifest, targetObjectKey(targetKey));
      const slide = manifest.slides.find((sl) => sl.key === obj?.slideKey);
      const client = ensureChallenge();
      if (!obj || !slide || !client) return { ok: false, code: 'AI_UNAVAILABLE', message: 'AI suggestions are unavailable.' };
      const challengeFailed: Attempt = { ok: false, code: 'CHALLENGE_REQUIRED', message: 'The security check could not be completed. Try again; your edits are kept.' };
      if (isLinkTarget(targetKey)) {
        const link = findLink(manifest, targetKey);
        const destination = link?.target ? sanitizeLinkDestination(link.target) : undefined;
        if (!link || !destination) return { ok: false, code: 'NOT_ELIGIBLE', message: 'Only links to web pages can get suggested text.' };
        let token: string;
        try {
          token = await client.token('describe_link');
        } catch {
          return challengeFailed;
        }
        const res = await describeLink({
          slideTitle: truncateCodePoints(slide.title.text, LIMITS.slideTitleCodePoints),
          contextText: linkContext(obj.text ?? '', link.text),
          linkText: truncateCodePoints(link.text, LIMITS.linkTextCodePoints * 4),
          destination,
          token,
          signal,
        });
        return res.ok ? { ok: true, kind: 'link', suggestion: res.data.suggestion, status: res.data.status, model: res.data.model } : res;
      }
      const image = (await loadPreview(targetKey)).image;
      if (!image?.aiEligible) return { ok: false, code: 'NOT_ELIGIBLE', message: 'This picture cannot be sent for suggestions (its visible appearance cannot be reproduced faithfully).' };
      let prepared;
      try {
        prepared = await prepareImageForAi(image, slide.background?.srgb);
      } catch {
        return { ok: false, code: 'IMAGE_LIMIT_EXCEEDED', message: 'The picture could not be prepared for sending.' };
      }
      let token: string;
      try {
        token = await client.token('describe_image');
      } catch {
        return challengeFailed;
      }
      const res = await describeImage({
        image: prepared.blob,
        slideTitle: truncateCodePoints(input?.slideTitle ?? slide.title.text, LIMITS.slideTitleCodePoints),
        contextText: truncateCodePoints(input?.contextText ?? defaultContext(slide, obj), LIMITS.contextCodePoints),
        existingAlt: truncateCodePoints(obj.alt.description, LIMITS.existingAltCodePoints),
        token,
        signal,
      });
      return res.ok ? { ok: true, kind: 'picture', suggestion: res.data.suggestion, status: res.data.status, model: res.data.model } : res;
    },
    [ensureChallenge, loadPreview],
  );

  const generate = useCallback(
    (targetKey: string, input?: AiContextInput, opts?: { consented?: boolean }) => {
      const s = stateRef.current;
      if (!aiAvailable) return;
      if (!s.aiConsent && !opts?.consented) return;
      pendingDrafts.current.set(targetKey, s.drafts[targetKey]?.text);
      setAiErrors((e) => {
        const next = { ...e };
        delete next[targetKey];
        return next;
      });
      const res = queue.enqueue({
        targetKey,
        sessionId: s.sessionId,
        kind: isLinkTarget(targetKey) ? 'link' : 'picture',
        run: (signal) => attemptFor(targetKey, signal, input),
      });
      if (!res.ok) {
        const msg =
          res.reason === 'full'
            ? `At most ${LIMITS.clientQueueObjects} suggestions can be queued. Wait for the queue to finish.`
            : res.reason === 'halted'
              ? 'AI suggestions are paused. Manual editing still works.'
              : 'A suggestion for this item is already pending.';
        dispatch({ type: 'ANNOUNCE', text: msg });
      } else {
        dispatch({ type: 'ANNOUNCE', text: 'Suggestion requested.' });
      }
    },
    [aiAvailable, queue, attemptFor],
  );

  // ---- Export --------------------------------------------------------------------
  const exportDeck = useCallback(
    (patchIds: string[]) => {
      const s = stateRef.current;
      const selected = s.patches.filter((p) => patchIds.includes(p.id));
      const ids = findingIdsByPatch(s, selected);
      const sessionId = s.sessionId;
      dispatch({ type: 'EXPORT_START' });
      void engine
        .export(selected, ids, (stage, done, total) => {
          if (stateRef.current.sessionId === sessionId) dispatch({ type: 'PROGRESS', stage, done, total });
        })
        .then((res) => {
          if (stateRef.current.sessionId !== sessionId) return;
          if (!res.ok) {
            dispatch({ type: 'EXPORT_FAILED', code: res.error.code, message: res.error.message, changes: res.changes });
            return;
          }
          const exportedFindingIds = new Set(Object.values(ids).flat());
          const applied = stateRef.current.findings.map((f) =>
            exportedFindingIds.has(f.id) ? { ...f, state: 'applied' as const, verification: { ...f.verification, package: 'pass' as const } } : f,
          );
          const findings = recheck(applied, res.rescan, exportedFindingIds);
          dispatch({ type: 'EXPORT_OK', outcome: { bytes: res.bytes, outputSha256: res.outputSha256, unchanged: res.unchanged, changes: res.changes, rescan: res.rescan }, findings });
        })
        .catch((e: unknown) => {
          if (stateRef.current.sessionId !== sessionId) return;
          const err = e instanceof EngineError ? e : new EngineError('INTERNAL', 'Export failed.');
          dispatch({ type: 'EXPORT_FAILED', code: err.code, message: err.code === 'CANCELLED' ? 'Export cancelled. Your approved edits are kept.' : err.message });
        });
    },
    [engine],
  );

  const cancelExport = useCallback(() => {
    engine.cancel();
    // The terminated worker held the source; reload it silently from the local File.
    const file = sourceFile.current;
    if (file) {
      void file.arrayBuffer().then((buf) => engine.scan(file.name, buf)).catch(() => undefined);
    }
  }, [engine]);

  // ---- Remediate All (ADR 0003) ------------------------------------------------------
  const remediation = useRef<AbortController | undefined>(undefined);

  const remediateAll = useCallback(async () => {
    const s = stateRef.current;
    const manifest = s.scan?.manifest;
    if (!manifest || s.stage !== 'reviewing') return;
    const sessionId = s.sessionId;
    // Every picture description and link that can be fixed here and is still unfixed.
    const targets: RemediationTarget[] = [];
    const seen = new Set<string>();
    for (const f of s.findings) {
      if (f.state !== 'open' && f.state !== 'suggested') continue;
      const key = findingTarget(f);
      if (!key || seen.has(key) || s.patches.some((p) => patchTarget(p) === key)) continue;
      seen.add(key);
      const kind = isLinkTarget(key) ? 'link' : 'picture';
      // "Label - address" lines are fixed by rule: the label becomes the link. No AI needed.
      const preset = kind === 'link' ? findLink(manifest, key)?.label?.value : undefined;
      const unavailable = s.manualOnly ? 'Manual-only mode is on, so nothing was sent to the AI.' : 'AI suggestions are unavailable right now.';
      if (preset) targets.push({ targetKey: key, kind, preset });
      else targets.push(aiAvailable ? { targetKey: key, kind } : { targetKey: key, kind, ineligible: unavailable });
    }
    dispatch({ type: 'SET_AI_CONSENT', value: aiAvailable });
    dispatch({ type: 'REMEDIATE_START', total: targets.length });
    const controller = new AbortController();
    remediation.current = controller;

    // Pictures whose appearance cannot be sent faithfully are known before any request.
    for (const t of targets) {
      if (t.ineligible || t.kind !== 'picture') continue;
      const entry = await loadPreview(t.targetKey);
      if (entry.status !== 'ready' || !entry.image) t.ineligible = 'This image format cannot be sent for an AI description (for example SVG, EMF or GIF).';
      else if (!entry.image.aiEligible) t.ineligible = 'The picture is cropped, masked, recoloured or rotated in a way that cannot be sent faithfully.';
    }
    for (const t of targets) {
      if (t.ineligible || t.preset || t.kind !== 'link') continue;
      const link = findLink(manifest, t.targetKey);
      if (!link?.target || !sanitizeLinkDestination(link.target)) t.ineligible = 'This link does not point to a web page, so its text cannot be inferred.';
    }

    const summary = await runRemediation(targets, {
      signal: controller.signal,
      onProgress: (done, _total, current) => {
        if (stateRef.current.sessionId === sessionId) dispatch({ type: 'REMEDIATE_PROGRESS', done, ...(current ? { current } : {}) });
      },
      onItem: (item) => {
        if (stateRef.current.sessionId !== sessionId) return;
        if (item.kind === 'applied') {
          dispatch({
            type: 'AUTO_APPLY',
            targetKey: item.targetKey,
            text: item.text,
            origin: item.origin,
            ...(item.ai ? { ai: item.ai } : {}),
            now: new Date().toISOString(),
            patchId: crypto.randomUUID(),
          });
        } else {
          dispatch({ type: 'REMEDIATE_SKIPPED', targetKey: item.targetKey, code: item.code, message: item.message });
        }
      },
      attempt: (target, signal) => attemptFor(target.targetKey, signal),
    });
    remediation.current = undefined;
    if (stateRef.current.sessionId !== sessionId) return;
    dispatch({ type: 'REMEDIATE_END', cancelled: summary.cancelled, ...(summary.halted ? { halted: summary.halted } : {}) });
    if (!summary.cancelled) setRemediationDone(sessionId);
  }, [aiAvailable, loadPreview, attemptFor]);

  // Export once the reducer has absorbed every auto-applied change.
  const [remediationDone, setRemediationDone] = useState<number | undefined>();
  useEffect(() => {
    if (remediationDone === undefined || remediationDone !== state.sessionId || state.stage !== 'remediating') return;
    setRemediationDone(undefined);
    exportDeck(state.patches.map((p) => p.id));
  }, [remediationDone, state.sessionId, state.stage, state.patches, exportDeck]);

  const cancelRemediation = useCallback(() => remediation.current?.abort(), []);

  // ---- Downloads -----------------------------------------------------------------
  const download = useCallback((kind: 'pptx' | 'html' | 'json') => {
    const s = stateRef.current;
    if (!s.scan || !s.exportOutcome || !s.fileName) return;
    const stem = stemOf(s.fileName);
    let blob: Blob;
    let name: string;
    if (kind === 'pptx') {
      blob = new Blob([s.exportOutcome.bytes], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' });
      name = `${stem}-remediated.pptx`;
    } else {
      const report = buildReport({
        manifest: s.scan.manifest,
        findings: s.findings,
        changes: s.exportOutcome.changes,
        coverage: s.scan.coverage,
        limitations: s.scan.limitations,
        outputSha256: s.exportOutcome.outputSha256,
      });
      if (kind === 'html') {
        blob = new Blob([renderReportHtml(report, s.scan.manifest)], { type: 'text/html;charset=utf-8' });
        name = `${stem}-accessibility-report.html`;
      } else {
        blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        name = `${stem}-accessibility-report.json`;
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }, []);

  const clearSession = useCallback(() => {
    queue.cancelAll();
    remediation.current?.abort();
    engine.cancel();
    challenge.current?.dispose();
    challenge.current = undefined;
    sourceFile.current = undefined;
    releasePreviews();
    setAiErrors({});
    dispatch({ type: 'CLEAR' });
  }, [engine, queue, releasePreviews]);

  const api: AppApi = {
    state,
    dispatch,
    engine,
    capabilities,
    aiAvailable,
    queue: queueSnap,
    aiErrors,
    openFile,
    loadSample,
    cancelScan,
    preview: (k) => previews.current.get(k),
    requestPreview,
    generate,
    cancelGenerate: (k) => queue.cancel(k),
    resumeAi: () => queue.resume(),
    exportDeck,
    cancelExport,
    remediateAll: () => void remediateAll(),
    cancelRemediation,
    download,
    clearSession,
  };

  return (
    <AppContext.Provider value={api}>
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <header className="app-header">
        <p className="app-name">
          <span aria-hidden="true">◆ </span>PowerPoint Accessibility Remediator
        </p>
        {state.fileName && state.stage !== 'idle' ? (
          <p className="app-file">
            <span className="visually-hidden">Current file: </span>
            {state.fileName}
          </p>
        ) : null}
      </header>
      <main id="main" tabIndex={-1}>
        {state.stage === 'idle' && <StartScreen />}
        {state.stage === 'rejected' && <Rejection />}
        {(state.stage === 'validating' || state.stage === 'scanning') && <Scanning />}
        {state.stage === 'reviewing' && <Review />}
        {state.stage === 'remediating' && <Remediating />}
        {state.stage === 'exporting' && <Exporting />}
        {state.stage === 'complete' && <Complete />}
      </main>
      <footer className="app-footer">
        <p>
          Free, open-source software (MIT). Your presentation is processed in this browser tab and is not uploaded. This tool does not certify legal
          compliance.
        </p>
      </footer>
      {/* Turnstile widget host; interaction-only appearance shows it only when needed. */}
      <div ref={challengeHost} className="challenge-host" />
      <LiveRegion message={state.announcement} />
    </AppContext.Provider>
  );
}

/** Crop to the visible area and bound the size for on-screen preview. */
async function croppedPreviewUrl(image: ImagePayload): Promise<string> {
  const blob = new Blob([image.bytes], { type: image.mime });
  if (!image.crop || typeof OffscreenCanvas === 'undefined') return URL.createObjectURL(blob);
  const bitmap = await createImageBitmap(blob);
  try {
    const c = image.crop;
    const sx = Math.round(bitmap.width * c.left);
    const sy = Math.round(bitmap.height * c.top);
    const sw = Math.max(1, Math.round(bitmap.width * (1 - c.left - c.right)));
    const sh = Math.max(1, Math.round(bitmap.height * (1 - c.top - c.bottom)));
    const canvas = new OffscreenCanvas(sw, sh);
    canvas.getContext('2d')!.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    return URL.createObjectURL(await canvas.convertToBlob({ type: 'image/png' }));
  } finally {
    bitmap.close();
  }
}

