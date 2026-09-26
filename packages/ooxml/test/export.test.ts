import { describe, expect, it } from 'vitest';
import type { ApprovedPatch, ObjectRecord } from '@ppt-remedy/contracts';
import { exportPackage, scanPackage, type ScanSession } from '../src/index.ts';
import { editText, fixture, mutate, sha, unzip } from './helpers.ts';

function patchFor(session: ScanSession, obj: ObjectRecord, value: string, id = `p-${obj.shapeId}-${obj.slideKey}`): ApprovedPatch {
  const slide = session.manifest.slides.find((s) => s.key === obj.slideKey)!;
  return {
    id,
    sourceSha256: session.manifest.sourceSha256,
    slideKey: obj.slideKey,
    objectKey: obj.key,
    part: slide.part,
    shapeId: obj.shapeId,
    expectedOriginalPartSha256: session.partSha256.get(slide.part)!,
    operation: { kind: 'set_description', value },
    origin: 'manual',
    featureVersion: 'ALT-01',
    approvedAt: '2026-09-24T00:00:00.000Z',
  };
}

const pictures = (s: ScanSession, slide: number) => s.manifest.slides[slide - 1]!.objects.filter((o) => o.kind === 'picture');

describe('export', () => {
  it('returns the original bytes when nothing is approved (PKG-01)', async () => {
    const bytes = fixture('basic.pptx');
    const session = await scanPackage(bytes, { sourceName: 'b.pptx' });
    const res = await exportPackage(session, []);
    expect(res.ok && res.unchanged).toBe(true);
    expect(res.ok && res.bytes).toBe(bytes);
  });

  it('writes descriptions on the intended objects only and preserves all other entries (PKG-02, ALT-01)', async () => {
    const bytes = fixture('basic.pptx');
    const session = await scanPackage(bytes, { sourceName: 'b.pptx' });
    const [shared2] = pictures(session, 2);
    const [shared3] = pictures(session, 3);
    const tricky = 'Bar chart: “Q1” & Q2 <rising> — café 🎓\nSecond line';
    const res = await exportPackage(session, [patchFor(session, shared2!, tricky), patchFor(session, shared3!, 'Campus map')]);
    if (!res.ok) throw new Error(res.error.message);

    // Same media, different instances: each gets its own description (no cross-instance overwrite).
    const rescan = res.rescan;
    expect(pictures({ manifest: rescan } as ScanSession, 2)[0]!.alt.description).toBe(tricky);
    expect(pictures({ manifest: rescan } as ScanSession, 3)[0]!.alt.description).toBe('Campus map');
    expect(pictures({ manifest: rescan } as ScanSession, 2)[1]!.alt.description).toBe('Students collaborate at computers in a teaching lab.');
    expect(res.changes).toHaveLength(2);
    expect(res.changes[0]).toMatchObject({ applyStatus: 'applied', before: { descr: '' }, after: { descr: tricky } });

    // Every unchanged entry has identical decompressed bytes.
    const src = unzip(bytes);
    const out = unzip(res.bytes);
    expect(Object.keys(out)).toEqual(Object.keys(src));
    for (const name of Object.keys(src)) {
      if (name === 'ppt/slides/slide2.xml' || name === 'ppt/slides/slide3.xml') continue;
      expect(await sha(out[name]!), name).toBe(await sha(src[name]!));
    }
    // The touched part differs only by the inserted attribute.
    const before = new TextDecoder().decode(src['ppt/slides/slide2.xml']);
    const after = new TextDecoder().decode(out['ppt/slides/slide2.xml']);
    const inserted = ' descr="Bar chart: “Q1” &amp; Q2 &lt;rising&gt; — café 🎓&#xA;Second line"';
    expect(after.replace(inserted, '')).toBe(before);
    expect(res.outputSha256).toBe(await sha(res.bytes));
  });

  it('replaces an existing description and keeps the legacy alt title (ALT-01)', async () => {
    const session = await scanPackage(fixture('basic.pptx'), { sourceName: 'b.pptx' });
    const legacy = pictures(session, 4)[0]!;
    expect(legacy.alt.title).toBe('Legacy title only');
    const generic = pictures(session, 3)[1]!;
    const res = await exportPackage(session, [patchFor(session, legacy, 'Grey placeholder graphic'), patchFor(session, generic, "Red 'warning' banner")]);
    if (!res.ok) throw new Error(res.error.message);
    const out = new TextDecoder().decode(unzip(res.bytes)['ppt/slides/slide4.xml']);
    expect(out).toContain('descr="Grey placeholder graphic" title="Legacy title only"');
    expect(pictures({ manifest: res.rescan } as ScanSession, 3)[1]!.alt.description).toBe("Red 'warning' banner");
  });

  it('preserves unknown extensions and AlternateContent in touched parts (PKG-03)', async () => {
    const ext =
      '<p:extLst><p:ext uri="{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E}"><p14:creationId xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" val="42"/></p:ext></p:extLst>';
    const alt =
      '<mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice xmlns:x="urn:x" Requires="x"><x:thing/></mc:Choice><mc:Fallback/></mc:AlternateContent>';
    const bytes = mutate(fixture('basic.pptx'), (f) =>
      editText(f, 'ppt/slides/slide2.xml', (s) => s.replace('</p:spTree>', `${alt}</p:spTree>`).replace('</p:cSld>', `</p:cSld>`).replace('</p:sld>', `${ext}</p:sld>`)),
    );
    const session = await scanPackage(bytes, { sourceName: 'x.pptx' });
    expect(session.manifest.slides[1]!.objects.some((o) => o.limitations.includes('ALTERNATE_CONTENT'))).toBe(true);
    const res = await exportPackage(session, [patchFor(session, pictures(session, 2)[0]!, 'Chart')]);
    if (!res.ok) throw new Error(res.error.message);
    const out = new TextDecoder().decode(unzip(res.bytes)['ppt/slides/slide2.xml']);
    expect(out).toContain(alt);
    expect(out).toContain(ext);
  });

  it('fails the transaction when the part changed since approval', async () => {
    const session = await scanPackage(fixture('basic.pptx'), { sourceName: 'b.pptx' });
    const p = { ...patchFor(session, pictures(session, 2)[0]!, 'x'), expectedOriginalPartSha256: '0'.repeat(64) };
    const res = await exportPackage(session, [p]);
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error.code).toBe('PART_CHANGED');
  });

  it('rejects patches from another source, unsupported operations, conflicts and invalid values', async () => {
    const session = await scanPackage(fixture('basic.pptx'), { sourceName: 'b.pptx' });
    const pic = pictures(session, 2)[0]!;
    const code = async (p: ApprovedPatch[]) => {
      const r = await exportPackage(session, p);
      return r.ok ? 'OK' : r.error.code;
    };
    expect(await code([{ ...patchFor(session, pic, 'x'), sourceSha256: 'f'.repeat(64) }])).toBe('SOURCE_MISMATCH');
    expect(await code([{ ...patchFor(session, pic, 'x'), operation: { kind: 'set_decorative', value: true } }])).toBe('PATCH_UNSUPPORTED');
    expect(await code([patchFor(session, pic, 'a', 'one'), patchFor(session, pic, 'b', 'two')])).toBe('PATCH_CONFLICT');
    expect(await code([patchFor(session, pic, '  padded  ')])).toBe('PATCH_INVALID_VALUE');
    expect(await code([patchFor(session, pic, 'bad\u0001char')])).toBe('PATCH_INVALID_VALUE');
    expect(await code([patchFor(session, pic, 'x'.repeat(2001))])).toBe('PATCH_INVALID_VALUE');
  });

  it('refuses to edit grouped pictures and non-picture objects', async () => {
    const session = await scanPackage(fixture('basic.pptx'), { sourceName: 'b.pptx' });
    const grouped = pictures(session, 10).find((o) => o.parentKey)!;
    const res = await exportPackage(session, [patchFor(session, grouped, 'Goggles icon')]);
    expect(!res.ok && res.error.code).toBe('PATCH_UNSUPPORTED');
    const title = session.manifest.slides[1]!.objects[0]!;
    const res2 = await exportPackage(session, [patchFor(session, title, 'x')]);
    expect(!res2.ok && res2.error.code).toBe('PATCH_UNSUPPORTED');
  });

  it('exports are deterministic and re-scannable', async () => {
    const session = await scanPackage(fixture('sample-deck.pptx'), { sourceName: 's.pptx' });
    const pic = pictures(session, 2)[0]!;
    const a = await exportPackage(session, [patchFor(session, pic, 'Diagram of a leaf')]);
    const b = await exportPackage(session, [patchFor(session, pic, 'Diagram of a leaf')]);
    if (!a.ok || !b.ok) throw new Error('export failed');
    expect(a.outputSha256).toBe(b.outputSha256);
    const again = await scanPackage(a.bytes, { sourceName: 'out.pptx' });
    expect(pictures(again, 2)[0]!.alt.description).toBe('Diagram of a leaf');
  });
});
