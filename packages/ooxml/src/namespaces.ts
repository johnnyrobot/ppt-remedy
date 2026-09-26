/** Namespace, relationship-type and content-type constants (OOXML Transitional). */
export const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  rels: 'http://schemas.openxmlformats.org/package/2006/relationships',
  ct: 'http://schemas.openxmlformats.org/package/2006/content-types',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  p14: 'http://schemas.microsoft.com/office/powerpoint/2010/main',
  /**
   * Office decorative extension namespace. Used for READ-ONLY detection. Writing the
   * decorative flag stays disabled until the DEC-01 PowerPoint-authored fixture gate
   * confirms namespace, extension URI, ordering and behaviour (spec §16).
   */
  adec: 'http://schemas.microsoft.com/office/drawing/2017/decorative',
} as const;

/** Strict-dialect namespaces; R1 rejects these with UNSUPPORTED_OOXML_DIALECT. */
export const STRICT_NS = {
  p: 'http://purl.oclc.org/ooxml/presentationml/main',
  a: 'http://purl.oclc.org/ooxml/drawingml/main',
  r: 'http://purl.oclc.org/ooxml/officeDocument/relationships',
} as const;

export const DECORATIVE_EXT_URI = '{C183D7F6-B498-43B3-948B-1728B52AA6E4}';

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const REL = {
  officeDocument: `${R}/officeDocument`,
  officeDocumentStrict: 'http://purl.oclc.org/ooxml/officeDocument/relationships/officeDocument',
  slide: `${R}/slide`,
  slideLayout: `${R}/slideLayout`,
  slideMaster: `${R}/slideMaster`,
  notesSlide: `${R}/notesSlide`,
  image: `${R}/image`,
  hyperlink: `${R}/hyperlink`,
  chart: `${R}/chart`,
  video: `${R}/video`,
  audio: `${R}/audio`,
  oleObject: `${R}/oleObject`,
  diagramData: `${R}/diagramData`,
  media: 'http://schemas.microsoft.com/office/2007/relationships/media',
  vbaProject: 'http://schemas.microsoft.com/office/2006/relationships/vbaProject',
  signatureOrigin: 'http://schemas.openxmlformats.org/package/2006/relationships/digital-signature/origin',
} as const;

export const CT = {
  presentation: 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
  macroPresentation: 'application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml',
  slideshow: 'application/vnd.openxmlformats-officedocument.presentationml.slideshow.main+xml',
  macroSlideshow: 'application/vnd.ms-powerpoint.slideshow.macroEnabled.main+xml',
  template: 'application/vnd.openxmlformats-officedocument.presentationml.template.main+xml',
  macroTemplate: 'application/vnd.ms-powerpoint.template.macroEnabled.main+xml',
  vba: 'application/vnd.ms-office.vbaProject',
  signatureOrigin: 'application/vnd.openxmlformats-package.digital-signature-origin',
  signatureXml: 'application/vnd.openxmlformats-package.digital-signature-xmlsignature+xml',
} as const;

export const GRAPHIC_DATA = {
  table: 'http://schemas.openxmlformats.org/drawingml/2006/table',
  chart: 'http://schemas.openxmlformats.org/drawingml/2006/chart',
  chartex: 'http://schemas.microsoft.com/office/drawing/2014/chartex',
  diagram: 'http://schemas.openxmlformats.org/drawingml/2006/diagram',
  ole: 'http://schemas.openxmlformats.org/presentationml/2006/ole',
} as const;
