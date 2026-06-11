import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import { config } from '../config.js';
import { dbGet, dbRun } from '../db.js';

// CJK font so PDF watermarks can render Traditional Chinese (the pdf-lib
// StandardFonts are Latin-only). Static OTF embeds real CFF outlines when
// subset — a variable .ttf does NOT subset reliably in pdf-lib (metrics only).
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const CJK_FONT_PATH = path.join(__dirname_, '../../assets/fonts/NotoSansTC-Regular.otf');
let cjkFontBytes: Buffer | null | undefined; // undefined = not loaded, null = unavailable
function loadCjkFont(): Buffer | null {
  if (cjkFontBytes === undefined) {
    try { cjkFontBytes = fs.readFileSync(CJK_FONT_PATH); }
    catch { cjkFontBytes = null; console.warn('[Watermark] CJK font not found, PDF watermark falls back to Latin'); }
  }
  return cjkFontBytes;
}

/**
 * Unified watermark config — matches the web preview tiled style.
 * Single configurable text line, -30° rotation, ~15% opacity, gray, repeating grid.
 */
const WM_ROTATION_DEG = -30;
const WM_COLOR_HEX = 'B0B0B0';
const WM_OPACITY = 0.15; // 15%

export const DEFAULT_WM_TEXT = 'CONFIDENTIAL · 機密文件';

export interface WatermarkSettings { enabled: boolean; text: string; }

/**
 * Watermark on/off + text, stored in system_settings under the 'watermark' key.
 * Until an admin saves an explicit value, falls back to the legacy `Version=Beta`
 * env gate (config.isBeta) so existing behaviour is preserved.
 */
export async function getWatermarkSettings(): Promise<WatermarkSettings> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'watermark'");
  if (!row) return { enabled: config.isBeta, text: DEFAULT_WM_TEXT };
  try {
    const v = JSON.parse(row.value);
    const text = typeof v.text === 'string' && v.text.trim() ? v.text : DEFAULT_WM_TEXT;
    return { enabled: !!v.enabled, text };
  } catch {
    return { enabled: config.isBeta, text: DEFAULT_WM_TEXT };
  }
}

export async function setWatermarkSettings(s: WatermarkSettings): Promise<void> {
  const text = s.text && s.text.trim() ? s.text.trim().slice(0, 120) : DEFAULT_WM_TEXT;
  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'watermark', JSON.stringify({ enabled: !!s.enabled, text }),
  );
}

/** Escape text for safe use inside XML element/attribute content. */
function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/* ============================================================
   Public API
   ============================================================ */

/**
 * Returns a Buffer with watermark applied for the given file.
 * Supports: PDF, DOCX, PPTX, XLSX, HTML.
 * For unsupported types, returns null (caller should serve original).
 */
export async function applyWatermark(filePath: string): Promise<Buffer | null> {
  const { enabled, text } = await getWatermarkSettings();
  if (!enabled) return null;

  const ext = path.extname(filePath).slice(1).toLowerCase();

  switch (ext) {
    case 'pdf':
      return watermarkPdf(filePath, text);
    case 'docx':
    case 'doc':
      return watermarkDocx(filePath, text);
    case 'pptx':
    case 'ppt':
      return watermarkPptx(filePath, text);
    case 'xlsx':
    case 'xls':
      return watermarkXlsx(filePath, text);
    case 'html':
    case 'htm':
      return watermarkHtml(filePath, text);
    default:
      return null;
  }
}

/* ============================================================
   PDF — pdf-lib: tiled diagonal text on every page
   Embeds a CJK font so the configured text (incl. Chinese) renders as-is;
   falls back to Latin-only Helvetica if the font asset is unavailable.
   ============================================================ */
async function watermarkPdf(filePath: string, text: string): Promise<Buffer> {
  const existing = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(existing);

  // Prefer the bundled CJK font (subset-embedded) so Chinese watermark text
  // shows correctly. If it can't be loaded/embedded, drop to Helvetica and
  // strip non-ASCII (Helvetica can't draw CJK).
  const fontBytes = loadCjkFont();
  let font;
  let pdfText = text;
  if (fontBytes) {
    try {
      pdfDoc.registerFontkit(fontkit);
      font = await pdfDoc.embedFont(fontBytes, { subset: true });
    } catch (err) {
      console.warn('[Watermark] CJK font embed failed, using Helvetica:', err);
      font = undefined;
    }
  }
  if (!font) {
    font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    pdfText = text.replace(/[^\x20-\x7E]/g, '').trim() || 'CONFIDENTIAL';
  }

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();

    // Create a tiled grid of watermarks (like the web preview)
    const fontSize = Math.min(width, height) * 0.04;
    const textWidth = font.widthOfTextAtSize(pdfText, fontSize);
    const spacingX = textWidth + 60;
    const spacingY = 120;

    // Cover the page with a grid, offset to ensure coverage after rotation
    for (let y = -height * 0.3; y < height * 1.3; y += spacingY) {
      for (let x = -width * 0.3; x < width * 1.3; x += spacingX) {
        page.drawText(pdfText, {
          x,
          y,
          size: fontSize,
          font,
          color: rgb(0.69, 0.69, 0.69),
          opacity: WM_OPACITY,
          rotate: degrees(WM_ROTATION_DEG),
        });
      }
    }
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/* ============================================================
   DOCX — inject VML watermark shapes into header XML
   Tiled pattern: 5 rows × 2 columns = 10 watermarks per page
   ============================================================ */
async function watermarkDocx(filePath: string, text: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // VML rotation: 360 - 30 = 330 degrees
  const vmlRotation = 360 + WM_ROTATION_DEG; // 330

  // Helper: generate a VML watermark shape
  const makeShape = (id: string, spid: string, marginTop: string, marginLeft: string, size: string) => `
    <w:r>
      <w:rPr><w:noProof/></w:rPr>
      <w:pict>
        <v:shapetype id="_x0000_t136" coordsize="21600,21600" o:spt="136" adj="10800"
          path="m@7,l@8,m@5,21600l@6,21600e">
          <v:formulas>
            <v:f eqn="sum #0 0 10800"/>
            <v:f eqn="prod #0 2 1"/>
            <v:f eqn="sum 21600 0 @1"/>
            <v:f eqn="sum 0 0 @2"/>
            <v:f eqn="sum 21600 0 @3"/>
            <v:f eqn="if @0 @3 0"/>
            <v:f eqn="if @0 21600 @1"/>
            <v:f eqn="if @0 0 @2"/>
            <v:f eqn="if @0 @4 21600"/>
            <v:f eqn="mid @5 @6"/>
            <v:f eqn="mid @8 @5"/>
            <v:f eqn="mid @7 @8"/>
            <v:f eqn="mid @6 @7"/>
            <v:f eqn="sum @6 0 @5"/>
          </v:formulas>
          <v:path textpathok="t" o:connecttype="custom" o:connectlocs="@9,0;@10,10800;@11,21600;@12,10800" o:connectangles="270,180,90,0"/>
          <v:textpath on="t" fitshape="t"/>
          <v:handles><v:h position="#0,bottomRight" xrange="6629,14971"/></v:handles>
          <o:lock v:ext="edit" text="t" shapetype="t"/>
        </v:shapetype>
        <v:shape id="${id}" o:spid="${spid}" type="#_x0000_t136"
          style="position:absolute;margin-left:${marginLeft};margin-top:${marginTop};width:${size};height:60pt;rotation:${vmlRotation};z-index:-251657216;mso-position-horizontal-relative:margin;mso-position-vertical-relative:margin"
          o:allowincell="f" fillcolor="#${WM_COLOR_HEX}" stroked="f">
          <v:fill opacity=".15"/>
          <v:textpath style="font-family:&quot;Arial&quot;;font-size:1pt" string="${xmlEscape(text)}"/>
        </v:shape>
      </w:pict>
    </w:r>`;

  // Tiled grid: 3 cols × 4 rows = 12 watermarks
  const grid: { id: string; spid: string; top: string; left: string; size: string }[] = [];
  const cols = ['-80pt', '120pt', '320pt'];
  const rows = ['-60pt', '140pt', '340pt', '540pt'];
  let idx = 0;
  for (const top of rows) {
    for (const left of cols) {
      grid.push({
        id: `WM_${idx}`,
        spid: `_x0000_s${2049 + idx}`,
        top,
        left,
        size: '320pt',
      });
      idx++;
    }
  }

  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:v="urn:schemas-microsoft-com:vml"
       xmlns:o="urn:schemas-microsoft-com:office:office"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:pStyle w:val="Header"/></w:pPr>
    ${grid.map(g => makeShape(g.id, g.spid, g.top, g.left, g.size)).join('')}
  </w:p>
</w:hdr>`;

  // Add header file
  const headerPath = 'word/header_watermark.xml';
  zip.file(headerPath, headerXml);

  // Ensure header relationship exists in word/_rels/document.xml.rels
  const relsPath = 'word/_rels/document.xml.rels';
  let relsXml = await zip.file(relsPath)?.async('text') || '';

  const relId = 'rIdWatermark';
  if (!relsXml.includes(relId)) {
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header_watermark.xml"/></Relationships>`
    );
    zip.file(relsPath, relsXml);
  }

  // Reference header in document.xml sectPr
  const docPath = 'word/document.xml';
  let docXml = await zip.file(docPath)?.async('text') || '';

  const headerRef = `<w:headerReference w:type="default" r:id="${relId}"/>`;
  if (!docXml.includes('rIdWatermark')) {
    if (docXml.includes('<w:sectPr')) {
      docXml = docXml.replace(/<w:sectPr([^>]*)>/, `<w:sectPr$1>${headerRef}`);
    } else {
      docXml = docXml.replace('</w:body>', `<w:sectPr>${headerRef}</w:sectPr></w:body>`);
    }
    zip.file(docPath, docXml);
  }

  // Ensure Content_Types has header content type
  const ctPath = '[Content_Types].xml';
  let ctXml = await zip.file(ctPath)?.async('text') || '';
  if (!ctXml.includes('header_watermark.xml')) {
    ctXml = ctXml.replace(
      '</Types>',
      `<Override PartName="/word/header_watermark.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/></Types>`
    );
    zip.file(ctPath, ctXml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

/* ============================================================
   PPTX — add tiled semi-transparent text shapes to each slide
   ============================================================ */
async function watermarkPptx(filePath: string, text: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // EMU rotation: -30° = -1800000 (60000 EMU per degree)
  const rotEmu = WM_ROTATION_DEG * 60000; // -1800000
  // Alpha: 15% = 15000 in OOXML
  const alphaVal = Math.round(WM_OPACITY * 100000);

  // Slide dimensions (standard 16:9): 12192000 x 6858000 EMU
  // Tiled grid: 3 cols × 3 rows = 9 watermarks per slide
  const positions: { x: number; y: number; cx: number; cy: number; sz: number }[] = [];
  const colXs = [200000, 4200000, 8200000];
  const rowYs = [200000, 2600000, 5000000];
  for (const y of rowYs) {
    for (const x of colXs) {
      positions.push({ x, y, cx: 4000000, cy: 1200000, sz: 2400 });
    }
  }

  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });

  for (const slidePath of slideFiles) {
    let xml = await zip.file(slidePath)!.async('text');

    const watermarkShapes = positions.map((p, i) => `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${99901 + i}" name="WM_${i}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm rot="${rotEmu}">
            <a:off x="${p.x}" y="${p.y}"/>
            <a:ext cx="${p.cx}" cy="${p.cy}"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:noFill/>
        </p:spPr>
        <p:txBody>
          <a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
          <a:lstStyle/>
          <a:p>
            <a:pPr algn="ctr"/>
            <a:r>
              <a:rPr lang="zh-TW" sz="${p.sz}" dirty="0">
                <a:solidFill><a:srgbClr val="${WM_COLOR_HEX}"><a:alpha val="${alphaVal}"/></a:srgbClr></a:solidFill>
                <a:latin typeface="Arial"/>
                <a:ea typeface="Microsoft JhengHei"/>
              </a:rPr>
              <a:t>${xmlEscape(text)}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`).join('');

    xml = xml.replace('</p:spTree>', watermarkShapes + '</p:spTree>');
    zip.file(slidePath, xml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

/* ============================================================
   XLSX — add DrawingML tiled watermark shapes on each sheet
   ============================================================ */
async function watermarkXlsx(filePath: string, text: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const rotEmu = WM_ROTATION_DEG * 60000; // -1800000
  const alphaVal = Math.round(WM_OPACITY * 100000);

  // Tiled grid: 2 cols × 3 rows = 6 watermarks per sheet
  const anchors: { x: number; y: number; cx: number; cy: number; sz: number }[] = [];
  const colXs = [300000, 4500000];
  const rowYs = [400000, 3200000, 6000000];
  for (const y of rowYs) {
    for (const x of colXs) {
      anchors.push({ x, y, cx: 4500000, cy: 1500000, sz: 2800 });
    }
  }

  const sheetFiles: string[] = [];
  zip.forEach((p) => {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(p)) sheetFiles.push(p);
  });

  for (const sheetPath of sheetFiles) {
    const sheetNum = sheetPath.match(/sheet(\d+)/)?.[1] || '1';
    let xml = await zip.file(sheetPath)!.async('text');

    // Skip if sheet already has a drawing (avoid conflicts with charts etc.)
    if (xml.includes('<drawing ')) continue;

    const drawingName = `drawingWM${sheetNum}`;
    const drawingPath = `xl/drawings/${drawingName}.xml`;
    const relId = `rIdWM${sheetNum}`;

    const anchorXml = anchors.map((a, i) => `
  <xdr:absoluteAnchor>
    <xdr:pos x="${a.x}" y="${a.y}"/>
    <xdr:ext cx="${a.cx}" cy="${a.cy}"/>
    <xdr:sp macro="" textlink="">
      <xdr:nvSpPr>
        <xdr:cNvPr id="${99901 + i}" name="WM_${i}"/>
        <xdr:cNvSpPr txBox="1"/>
      </xdr:nvSpPr>
      <xdr:spPr>
        <a:xfrm rot="${rotEmu}">
          <a:off x="0" y="0"/>
          <a:ext cx="${a.cx}" cy="${a.cy}"/>
        </a:xfrm>
        <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
        <a:noFill/>
        <a:ln><a:noFill/></a:ln>
      </xdr:spPr>
      <xdr:txBody>
        <a:bodyPr wrap="square" rtlCol="0" anchor="ctr"/>
        <a:lstStyle/>
        <a:p>
          <a:pPr algn="ctr"/>
          <a:r>
            <a:rPr lang="zh-TW" sz="${a.sz}">
              <a:solidFill><a:srgbClr val="${WM_COLOR_HEX}"><a:alpha val="${alphaVal}"/></a:srgbClr></a:solidFill>
              <a:latin typeface="Arial"/>
              <a:ea typeface="Microsoft JhengHei"/>
            </a:rPr>
            <a:t>${xmlEscape(text)}</a:t>
          </a:r>
        </a:p>
      </xdr:txBody>
    </xdr:sp>
  </xdr:absoluteAnchor>`).join('');

    const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchorXml}
</xdr:wsDr>`;
    zip.file(drawingPath, drawingXml);

    // Add/update sheet rels
    const relsFile = `xl/worksheets/_rels/sheet${sheetNum}.xml.rels`;
    let relsXml = await zip.file(relsFile)?.async('text') || '';
    if (!relsXml) {
      relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}.xml"/>
</Relationships>`;
    } else if (!relsXml.includes(relId)) {
      relsXml = relsXml.replace('</Relationships>',
        `<Relationship Id="${relId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/${drawingName}.xml"/></Relationships>`);
    }
    zip.file(relsFile, relsXml);

    // Add <drawing> reference in sheet XML
    if (!xml.includes(`r:id="${relId}"`)) {
      if (!xml.includes('xmlns:r=')) {
        xml = xml.replace('<worksheet', '<worksheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"');
      }
      xml = xml.replace('</worksheet>', `<drawing r:id="${relId}"/></worksheet>`);
    }
    zip.file(sheetPath, xml);

    // Add content type
    const ctPath = '[Content_Types].xml';
    let ctXml = await zip.file(ctPath)?.async('text') || '';
    if (!ctXml.includes(drawingName)) {
      ctXml = ctXml.replace('</Types>',
        `<Override PartName="/xl/drawings/${drawingName}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
      zip.file(ctPath, ctXml);
    }
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

/* ============================================================
   HTML — inject CSS watermark overlay before </body>
   ============================================================ */
async function watermarkHtml(filePath: string, text: string): Promise<Buffer | null> {
  const html = fs.readFileSync(filePath, 'utf-8');

  // Skip if already has a watermark (e.g. slides-gen embeds its own)
  if (html.includes('watermark-overlay')) return null;

  // Build the tiled SVG from the configured text (CJK falls back to a system
  // sans font in the browser). The whole SVG is percent-encoded for the data URI.
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='480' height='320'><g transform='rotate(-30 240 160)'><text x='240' y='160' dominant-baseline='middle' text-anchor='middle' font-family='Arial,sans-serif' font-size='18' font-weight='700' fill='rgba(0,0,0,0.05)'>${xmlEscape(text)}</text></g></svg>`;
  const dataUri = `data:image/svg+xml,${encodeURIComponent(svg)}`;

  const wmCss = `
<style data-watermark>
.watermark-overlay {
  position: fixed; inset: 0; z-index: 999999;
  pointer-events: none; user-select: none;
  overflow: hidden;
  background-image: url("${dataUri}");
  background-repeat: repeat;
  background-size: 480px 320px;
}
@media print { .watermark-overlay { position: absolute; } }
</style>`;

  const wmDiv = '<div class="watermark-overlay" aria-hidden="true"></div>';

  let result = html;
  if (result.includes('</body>')) {
    result = result.replace('</body>', `${wmCss}\n${wmDiv}\n</body>`);
  } else {
    result += `\n${wmCss}\n${wmDiv}`;
  }

  return Buffer.from(result, 'utf-8');
}
