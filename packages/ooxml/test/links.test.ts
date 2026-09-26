import { describe, expect, it } from 'vitest';
import type { ApprovedPatch, LinkRecord, ObjectRecord } from '@ppt-remedy/contracts';
import { exportPackage, scanPackage, validateLinkText, type ScanSession } from '../src/index.ts';
import { editText, fixture, mutate, sha, unzip } from './helpers.ts';

function linkPatch(session: ScanSession, obj: ObjectRecord, link: LinkRecord, text: string, id = `l-${link.key}`): ApprovedPatch {
  const slide = session.manifest.slides.find((s) => s.key === obj.slideKey)!;
  return {
    id,
    sourceSha256: session.manifest.sourceSha256,
    slideKey: slide.key,
    objectKey: obj.key,
    targetKey: link.key!,
    part: slide.part,
    shapeId: obj.shapeId,
    expectedOriginalPartSha256: session.partSha256.get(slide.part)!,
    operation: {
      kind: 'set_link_text',
      relationshipId: link.relationshipId,
      paragraphIndex: link.paragraphIndex!,
      runIndex: link.runIndex!,
      runCount: link.runCount!,
      expectedText: link.text,
      text,
    },
    origin: 'ai_suggestion',
    featureVersion: 'LINK-01',
    approvedAt: '2026-09-25T00:00:00.000Z',
  };
}

const linksOn = (s: ScanSession, slide: number) =>
  s.manifest.slides[slide - 1]!.objects.flatMap((o) => (o.links ?? []).map((l) => ({ obj: o, link: l })));

describe('link text edits (LINK-01)', () => {
  it('records link positions, keys and editability', async () => {
    const s = await scanPackage(fixture('basic.pptx'), { sourceName: 'b' });
    const links = linksOn(s, 7);
    expect(links.map((l) => l.link.text)).toEqual(['click here', 'https://library.example.edu/guides', 'accessibility guidelines']);
    expect(links.every((l) => l.link.editable)).toBe(true);
    expect(links[0]!.link).toMatchObject({ paragraphIndex: 0, linkOrdinal: 0, runCount: 1 });
    expect(new Set(links.map((l) => l.link.key)).size).toBe(3);
  });

  it('replaces only the link words, keeping the hyperlink, formatting and everything else', async () => {
    const bytes = fixture('basic.pptx');
    const s = await scanPackage(bytes, { sourceName: 'b' });
    const [generic, raw] = linksOn(s, 7);
    const res = await exportPackage(s, [
      linkPatch(s, generic!.obj, generic!.link, 'the course syllabus'),
      linkPatch(s, raw!.obj, raw!.link, 'Library research guides & tips'),
    ]);
    if (!res.ok) throw new Error(res.error.message);
    const out = linksOn({ manifest: res.rescan } as ScanSession, 7);
    expect(out.map((l) => [l.link.text, l.link.target])).toEqual([
      ['the course syllabus', 'https://example.edu/syllabus'],
      ['Library research guides & tips', 'https://library.example.edu/guides'],
      ['accessibility guidelines', 'https://example.edu/a11y'],
    ]);
    expect(res.rescan.slides[6]!.objects[1]!.text).toBe('For the syllabus the course syllabus');
    const src = unzip(bytes);
    const dst = unzip(res.bytes);
    for (const name of Object.keys(src)) if (name !== 'ppt/slides/slide7.xml') expect(await sha(dst[name]!), name).toBe(await sha(src[name]!));
    const xml = new TextDecoder().decode(dst['ppt/slides/slide7.xml']);
    expect(xml).toContain('<a:t>Library research guides &amp; tips</a:t>');
    expect(res.changes[1]).toMatchObject({ before: { linkText: 'https://library.example.edu/guides' }, after: { linkText: 'Library research guides & tips' } });
  });

  it('merges a link split across several runs into one run with the first run’s formatting', async () => {
    const bytes = mutate(fixture('basic.pptx'), (f) =>
      editText(f, 'ppt/slides/slide7.xml', (x) => {
        // Split the raw-URL link into two runs sharing the relationship.
        const m = /<a:r><a:rPr[^>]*><a:hlinkClick r:id="rId3"\/><\/a:rPr><a:t>https:\/\/library.example.edu\/guides<\/a:t><\/a:r>/.exec(x);
        if (!m) throw new Error('fixture changed');
        const run = m[0];
        const split = run.replace('https://library.example.edu/guides', 'https://library.') + run.replace('https://library.example.edu/guides', 'example.edu/guides').replace('<a:rPr', '<a:rPr b="1"');
        return x.replace(run, split);
      }),
    );
    const s = await scanPackage(bytes, { sourceName: 'b' });
    const raw = linksOn(s, 7)[1]!;
    expect(raw.link).toMatchObject({ text: 'https://library.example.edu/guides', runCount: 2 });
    const res = await exportPackage(s, [linkPatch(s, raw.obj, raw.link, 'Library research guides')]);
    if (!res.ok) throw new Error(res.error.message);
    const out = linksOn({ manifest: res.rescan } as ScanSession, 7)[1]!;
    expect(out.link).toMatchObject({ text: 'Library research guides', runCount: 1, target: 'https://library.example.edu/guides' });
  });

  it('fails safely when the link no longer matches or the text is not descriptive', async () => {
    const s = await scanPackage(fixture('basic.pptx'), { sourceName: 'b' });
    const { obj, link } = linksOn(s, 7)[0]!;
    const stale = linkPatch(s, obj, link, 'Syllabus');
    if (stale.operation.kind === 'set_link_text') stale.operation.expectedText = 'something else';
    const r1 = await exportPackage(s, [stale]);
    expect(!r1.ok && r1.error.code).toBe('PART_CHANGED');
    for (const bad of ['click here', 'https://x.edu', 'www.example.edu/page', 'two\nlines', ' padded ', 'x'.repeat(121)]) {
      const r = await exportPackage(s, [linkPatch(s, obj, link, bad)]);
      expect(!r.ok && r.error.code, bad).toBe('PATCH_INVALID_VALUE');
      expect(validateLinkText(bad)).toBeDefined();
    }
  });

  it('detects "Label - address" lines and folds the label into the link', async () => {
    const bytes = fixture('basic.pptx');
    const s = await scanPackage(bytes, { sourceName: 'b' });
    const [generic, raw] = linksOn(s, 7);
    expect(generic!.link.label).toBeUndefined(); // "For the syllabus click here" is prose, not a label line
    expect(raw!.link.label).toMatchObject({ text: 'Library: ', value: 'Library' });
    const patch = linkPatch(s, raw!.obj, raw!.link, 'Library');
    if (patch.operation.kind === 'set_link_text') patch.operation.label = { runIndex: raw!.link.label!.runIndex, runCount: raw!.link.label!.runCount, expectedText: 'Library: ' };
    const res = await exportPackage(s, [patch]);
    if (!res.ok) throw new Error(res.error.message);
    const out = linksOn({ manifest: res.rescan } as ScanSession, 7)[1]!;
    expect(out.link).toMatchObject({ text: 'Library', target: 'https://library.example.edu/guides' });
    expect(out.obj.text).toBe('Library');
    expect(res.changes[0]!.before).toMatchObject({ label: 'Library: ', linkText: 'https://library.example.edu/guides' });
    const xml = new TextDecoder().decode(unzip(res.bytes)['ppt/slides/slide7.xml']);
    expect(xml).not.toContain('Library: ');
  });

  it('refuses a fold when the label no longer matches', async () => {
    const s = await scanPackage(fixture('basic.pptx'), { sourceName: 'b' });
    const raw = linksOn(s, 7)[1]!;
    const patch = linkPatch(s, raw.obj, raw.link, 'Library');
    if (patch.operation.kind === 'set_link_text') patch.operation.label = { runIndex: raw.link.label!.runIndex, runCount: 1, expectedText: 'Something else: ' };
    const res = await exportPackage(s, [patch]);
    expect(!res.ok && res.error.code).toBe('PART_CHANGED');
  });
});
