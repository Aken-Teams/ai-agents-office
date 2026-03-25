import fs from 'fs';
import path from 'path';
import { PDFDocument, rgb, degrees, StandardFonts } from 'pdf-lib';
import JSZip from 'jszip';

const WATERMARK_TEXT = '測試版 TEST VERSION';

/* ============================================================
   Public API
   ============================================================ */

/**
 * Returns a Buffer with watermark applied for the given file.
 * Supports: PDF, DOCX, PPTX, XLSX, HTML.
 * For unsupported types, returns null (caller should serve original).
 */
export async function applyWatermark(filePath: string): Promise<Buffer | null> {
  const ext = path.extname(filePath).slice(1).toLowerCase();

  switch (ext) {
    case 'pdf':
      return watermarkPdf(filePath);
    case 'docx':
    case 'doc':
      return watermarkDocx(filePath);
    case 'pptx':
    case 'ppt':
      return watermarkPptx(filePath);
    case 'xlsx':
    case 'xls':
      return watermarkXlsx(filePath);
    case 'html':
    case 'htm':
      return watermarkHtml(filePath);
    default:
      return null;
  }
}

/* ============================================================
   PDF — pdf-lib: draw diagonal text on every page
   ============================================================ */
async function watermarkPdf(filePath: string): Promise<Buffer> {
  const existing = fs.readFileSync(filePath);
  const pdfDoc = await PDFDocument.load(existing);
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  // StandardFonts only support Latin chars — use English-only text for PDF
  const pdfWatermarkText = 'TEST VERSION';

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.07;
    const textWidth = font.widthOfTextAtSize(pdfWatermarkText, fontSize);

    // Center main watermark
    page.drawText(pdfWatermarkText, {
      x: width / 2 - textWidth / 2,
      y: height / 2,
      size: fontSize,
      font,
      color: rgb(0.75, 0.75, 0.75),
      opacity: 0.12,
      rotate: degrees(-45),
    });
    // Additional copies for coverage
    const positions = [
      { x: width * 0.2, y: height * 0.8 },
      { x: width * 0.8, y: height * 0.8 },
      { x: width * 0.2, y: height * 0.2 },
      { x: width * 0.8, y: height * 0.2 },
    ];
    const smallWidth = font.widthOfTextAtSize(pdfWatermarkText, fontSize * 0.7);
    for (const pos of positions) {
      page.drawText(pdfWatermarkText, {
        x: pos.x - smallWidth / 2,
        y: pos.y,
        size: fontSize * 0.7,
        font,
        color: rgb(0.75, 0.75, 0.75),
        opacity: 0.10,
        rotate: degrees(-45),
      });
    }
  }

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}

/* ============================================================
   DOCX — inject VML watermark shape into header XML
   ============================================================ */
async function watermarkDocx(filePath: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Helper: generate a VML watermark shape
  const makeShape = (id: string, spid: string, marginTop: string, size: string) => `
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
          style="position:absolute;margin-left:0;margin-top:${marginTop};width:${size};height:80pt;rotation:315;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical-relative:margin"
          o:allowincell="f" fillcolor="silver" stroked="f">
          <v:fill opacity=".20"/>
          <v:textpath style="font-family:&quot;Arial&quot;;font-size:1pt" string="${WATERMARK_TEXT}"/>
        </v:shape>
      </w:pict>
    </w:r>`;

  // 3 watermarks: top, center, bottom of each page
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:v="urn:schemas-microsoft-com:vml"
       xmlns:o="urn:schemas-microsoft-com:office:office"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:pStyle w:val="Header"/></w:pPr>
    ${makeShape('WM_Top', '_x0000_s2049', '-50pt', '400pt')}
    ${makeShape('WM_Center', '_x0000_s2050', '280pt', '494pt')}
    ${makeShape('WM_Bottom', '_x0000_s2051', '600pt', '400pt')}
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

  // Add headerReference to the section properties
  const headerRef = `<w:headerReference w:type="default" r:id="${relId}"/>`;
  if (!docXml.includes('rIdWatermark')) {
    // Insert into existing sectPr or create one
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
   PPTX — add semi-transparent text shape to each slide
   ============================================================ */
async function watermarkPptx(filePath: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Find all slide XML files
  const slideFiles: string[] = [];
  zip.forEach((p) => {
    if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) slideFiles.push(p);
  });

  for (const slidePath of slideFiles) {
    let xml = await zip.file(slidePath)!.async('text');

    // 3 watermark shapes per slide: top-left, center, bottom-right
    const positions = [
      { id: 99901, name: 'WM_TopLeft',     x: 500000,  y: 400000,  cx: 5500000, cy: 1200000, sz: 3200 },
      { id: 99902, name: 'WM_Center',      x: 1500000, y: 2500000, cx: 7000000, cy: 1600000, sz: 4800 },
      { id: 99903, name: 'WM_BottomRight', x: 3000000, y: 4600000, cx: 5500000, cy: 1200000, sz: 3200 },
    ];

    const watermarkShapes = positions.map(p => `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="${p.id}" name="${p.name}"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm rot="-2700000">
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
                <a:solidFill><a:srgbClr val="C0C0C0"><a:alpha val="12000"/></a:srgbClr></a:solidFill>
                <a:latin typeface="Arial"/>
                <a:ea typeface="Microsoft JhengHei"/>
              </a:rPr>
              <a:t>${WATERMARK_TEXT}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`).join('');

    // Insert before closing </p:spTree>
    xml = xml.replace('</p:spTree>', watermarkShapes + '</p:spTree>');
    zip.file(slidePath, xml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

/* ============================================================
   XLSX — add DrawingML watermark shape overlay on each sheet
   ============================================================ */
async function watermarkXlsx(filePath: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Find all sheet XML files
  const sheetFiles: string[] = [];
  zip.forEach((p) => {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(p)) sheetFiles.push(p);
  });

  const wmText = 'TEST VERSION';

  for (const sheetPath of sheetFiles) {
    const sheetNum = sheetPath.match(/sheet(\d+)/)?.[1] || '1';
    let xml = await zip.file(sheetPath)!.async('text');

    // Skip if sheet already has a drawing (avoid conflicts with charts etc.)
    if (xml.includes('<drawing ')) continue;

    const drawingName = `drawingWM${sheetNum}`;
    const drawingPath = `xl/drawings/${drawingName}.xml`;
    const relId = `rIdWM${sheetNum}`;

    // Create DrawingML with watermark text shapes
    const drawingXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"
          xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <xdr:absoluteAnchor>
    <xdr:pos x="1500000" y="2500000"/>
    <xdr:ext cx="7000000" cy="2000000"/>
    <xdr:sp macro="" textlink="">
      <xdr:nvSpPr>
        <xdr:cNvPr id="99901" name="WM_Center"/>
        <xdr:cNvSpPr txBox="1"/>
      </xdr:nvSpPr>
      <xdr:spPr>
        <a:xfrm rot="-2700000">
          <a:off x="0" y="0"/>
          <a:ext cx="7000000" cy="2000000"/>
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
            <a:rPr lang="en-US" sz="4800">
              <a:solidFill><a:srgbClr val="C0C0C0"><a:alpha val="15000"/></a:srgbClr></a:solidFill>
              <a:latin typeface="Arial"/>
            </a:rPr>
            <a:t>${wmText}</a:t>
          </a:r>
        </a:p>
      </xdr:txBody>
    </xdr:sp>
  </xdr:absoluteAnchor>
  <xdr:absoluteAnchor>
    <xdr:pos x="300000" y="500000"/>
    <xdr:ext cx="5000000" cy="1500000"/>
    <xdr:sp macro="" textlink="">
      <xdr:nvSpPr>
        <xdr:cNvPr id="99902" name="WM_TopLeft"/>
        <xdr:cNvSpPr txBox="1"/>
      </xdr:nvSpPr>
      <xdr:spPr>
        <a:xfrm rot="-2700000">
          <a:off x="0" y="0"/>
          <a:ext cx="5000000" cy="1500000"/>
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
            <a:rPr lang="en-US" sz="3200">
              <a:solidFill><a:srgbClr val="C0C0C0"><a:alpha val="12000"/></a:srgbClr></a:solidFill>
              <a:latin typeface="Arial"/>
            </a:rPr>
            <a:t>${wmText}</a:t>
          </a:r>
        </a:p>
      </xdr:txBody>
    </xdr:sp>
  </xdr:absoluteAnchor>
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

    // Add <drawing> reference in sheet XML — before </worksheet>
    if (!xml.includes(`r:id="${relId}"`)) {
      // Ensure r: namespace
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
async function watermarkHtml(filePath: string): Promise<Buffer | null> {
  const html = fs.readFileSync(filePath, 'utf-8');

  // Skip if already has a watermark (e.g. slides-gen embeds its own)
  if (html.includes('watermark-overlay')) return null;

  const wmCss = `
<style data-watermark>
.watermark-overlay {
  position: fixed; inset: 0; z-index: 999999;
  pointer-events: none; user-select: none;
  overflow: hidden;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='320'%3E%3Cg transform='rotate(-30 240 160)'%3E%3Ctext x='240' y='145' dominant-baseline='middle' text-anchor='middle' font-family='Arial,sans-serif' font-size='20' font-weight='700' fill='rgba(0,0,0,0.045)'%3ECONFIDENTIAL%3C/text%3E%3Ctext x='240' y='172' dominant-baseline='middle' text-anchor='middle' font-family='Arial,sans-serif' font-size='14' font-weight='500' fill='rgba(0,0,0,0.04)'%3E%E6%A9%9F%E5%AF%86%E6%96%87%E4%BB%B6 %C2%B7 %E6%B8%AC%E8%A9%A6%E7%89%88%3C/text%3E%3C/g%3E%3C/svg%3E");
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
