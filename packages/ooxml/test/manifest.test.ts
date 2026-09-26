import { describe, expect, it } from 'vitest';
import { scanPackage } from '../src/index.ts';
import { editText, fixture, mutate } from './helpers.ts';

const scan = (bytes: Uint8Array) => scanPackage(bytes, { sourceName: 'test.pptx' });
const rejects = async (bytes: Uint8Array) => {
  try {
    await scan(bytes);
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return 'NO_ERROR';
};

describe('manifest (FR-01..FR-03)', () => {
  it('orders slides by presentation relationships, not file names (FR-01)', async () => {
    const { manifest } = await scan(fixture('reordered.pptx'));
    expect(manifest.slides.map((s) => s.title.text)).toEqual(['Third', 'Second', 'First']);
    expect(manifest.slides.map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(manifest.slides[0]!.part).toBe('ppt/slides/slide3.xml');
  });

  it('distinguishes each instance of reused media (FR-02)', async () => {
    const { manifest } = await scan(fixture('basic.pptx'));
    const pics = manifest.slides.flatMap((s) => s.objects).filter((o) => o.kind === 'picture' && o.media?.part === 'ppt/media/image1.png');
    expect(pics).toHaveLength(2);
    expect(new Set(pics.map((p) => p.key)).size).toBe(2);
    expect(pics[0]!.media!.sha256).toBe(pics[1]!.media!.sha256);
    expect(pics[0]!.media!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records slide part, shape id, kind, alt fields and media for each object (FR-03)', async () => {
    const { manifest } = await scan(fixture('basic.pptx'));
    const s2 = manifest.slides[1]!;
    expect(s2.title).toMatchObject({ text: 'Enrollment trends', kind: 'title' });
    const [, missing, good] = s2.objects;
    expect(missing).toMatchObject({ shapeId: '3', kind: 'picture', support: 'editable', alt: { description: '', title: '', decorative: false } });
    expect(missing!.media).toMatchObject({ part: 'ppt/media/image1.png', mime: 'image/png' });
    expect(good!.alt.description).toBe('Students collaborate at computers in a teaching lab.');
    expect(missing!.key).toContain('ppt/slides/slide2.xml#3');
  });

  it('inventories hidden slides, groups, crops, tables, charts, links and notes', async () => {
    const { manifest } = await scan(fixture('basic.pptx'));
    const bySlide = (n: number) => manifest.slides[n - 1]!;
    expect(bySlide(11).hidden).toBe(true);
    expect(bySlide(4).title.kind).toBe('none'); // a text box is not a title
    const grouped = bySlide(10).objects.find((o) => o.kind === 'picture' && o.parentKey);
    expect(grouped?.support).toBe('inspection_only');
    expect(grouped?.transform?.blockers).toContain('GROUPED');
    const cropped = bySlide(10).objects.find((o) => o.kind === 'picture' && !o.parentKey);
    expect(cropped?.transform?.srcRect).toEqual({ l: 10000, t: 0, r: 20000, b: 0 });
    const tables = bySlide(8).objects.filter((o) => o.kind === 'table');
    expect(tables.map((t) => [t.table?.firstRow, t.table?.merged])).toEqual([[false, false], [true, true]]);
    expect(bySlide(9).objects.some((o) => o.kind === 'chart')).toBe(true);
    const links = bySlide(7).objects.flatMap((o) => o.links ?? []);
    expect(links.map((l) => l.text)).toEqual(['click here', 'https://library.example.edu/guides', 'accessibility guidelines']);
    expect(links.every((l) => l.external)).toBe(true);
    expect(manifest.unsupported.some((u) => u.code === 'NOTES_NOT_ASSESSED')).toBe(true);
    expect(bySlide(12).title.text).toBe('Café & “Résumé” — مرحبا');
  });

  it('resolves inherited placeholder types through the layout', async () => {
    const bytes = mutate(fixture('reordered.pptx'), (f) => {
      editText(f, 'ppt/slides/slide1.xml', (s) => s.replace('<p:ph type="title"/>', '<p:ph idx="0"/>'));
      editText(f, 'ppt/slideLayouts/slideLayout6.xml', (s) => s.replace('<p:ph type="title"/>', '<p:ph type="title" idx="0"/>'));
    });
    const { manifest } = await scan(bytes);
    const slide = manifest.slides.find((s) => s.part === 'ppt/slides/slide1.xml')!;
    expect(slide.title.text).toBe('First');
    expect(slide.objects[0]!.placeholder).toMatchObject({ type: 'title', inherited: true });
  });

  it('marks duplicate shape IDs as unsupported rather than targeting one', async () => {
    const bytes = mutate(fixture('basic.pptx'), (f) => editText(f, 'ppt/slides/slide2.xml', (s) => s.replace('id="4" name="Picture 3"', 'id="3" name="Picture 3"')));
    const { manifest } = await scan(bytes);
    const objs = manifest.slides[1]!.objects.filter((o) => o.shapeId === '3');
    expect(objs).toHaveLength(2);
    expect(objs.every((o) => o.support === 'unsupported')).toBe(true);
    expect(new Set(objs.map((o) => o.key)).size).toBe(2);
  });
});

describe('package rejections (SEC-01)', () => {
  const base = () => fixture('basic.pptx');
  it('rejects macro-enabled packages even when named .pptx', async () => {
    const bytes = mutate(base(), (f) =>
      editText(f, '[Content_Types].xml', (s) =>
        s.replace('application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml', 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml'),
      ),
    );
    expect(await rejects(bytes)).toBe('MACRO_ENABLED');
    const vba = mutate(base(), (f) => {
      f['ppt/vbaProject.bin'] = new Uint8Array([1, 2, 3]);
    });
    expect(await rejects(vba)).toBe('MACRO_ENABLED');
  });

  it('rejects signed packages', async () => {
    const bytes = mutate(base(), (f) => {
      f['_xmlsignatures/origin.sigs'] = new Uint8Array(0);
    });
    expect(await rejects(bytes)).toBe('SIGNED_PACKAGE');
  });

  it('rejects Strict OOXML with a specific code', async () => {
    const bytes = mutate(base(), (f) => editText(f, '_rels/.rels', (s) => s.replace('http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument')));
    expect(await rejects(bytes)).toBe('UNSUPPORTED_OOXML_DIALECT');
  });

  it('rejects slideshow/template types and non-presentations', async () => {
    const show = mutate(base(), (f) => editText(f, '[Content_Types].xml', (s) => s.replace('presentationml.presentation.main+xml', 'presentationml.slideshow.main+xml')));
    expect(await rejects(show)).toBe('NOT_A_PRESENTATION');
    const noCt = mutate(base(), (f) => {
      delete f['[Content_Types].xml'];
    });
    expect(await rejects(noCt)).toBe('NOT_A_PRESENTATION');
  });

  it('rejects entity declarations inside parts', async () => {
    const bytes = mutate(base(), (f) => editText(f, 'ppt/slides/slide2.xml', (s) => s.replace("<?xml version='1.0' encoding='UTF-8' standalone='yes'?>", "<?xml version='1.0'?><!DOCTYPE x [<!ENTITY a 'b'>]>")));
    expect(await rejects(bytes)).toBe('XML_DTD_FORBIDDEN');
  });

  it('enforces the slide limit before object analysis', async () => {
    await expect(scanPackage(fixture('basic.pptx'), { sourceName: 'x', maxSlides: 5 })).rejects.toMatchObject({ code: 'TOO_MANY_SLIDES' });
    await expect(scanPackage(fixture('basic.pptx'), { sourceName: 'x', maxShapes: 5 })).rejects.toMatchObject({ code: 'TOO_MANY_SHAPES' });
  });

  it('never resolves relationship targets outside the package', async () => {
    const bytes = mutate(base(), (f) => editText(f, 'ppt/_rels/presentation.xml.rels', (s) => s.replace('Target="slides/slide2.xml"', 'Target="../../../etc/passwd"')));
    const { manifest } = await scan(bytes);
    expect(manifest.slides).toHaveLength(11);
    expect(manifest.unsupported.some((u) => u.code === 'SLIDE_UNRESOLVED')).toBe(true);
  });
});
