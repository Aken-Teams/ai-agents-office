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
 * Supports: PDF, DOCX, PPTX, XLSX.
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

  const pages = pdfDoc.getPages();
  for (const page of pages) {
    const { width, height } = page.getSize();
    const fontSize = Math.min(width, height) * 0.07;

    // Draw repeated watermarks in a grid pattern
    const texts = [WATERMARK_TEXT];
    for (const text of texts) {
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      // Center main watermark
      page.drawText(text, {
        x: width / 2 - textWidth / 2,
        y: height / 2,
        size: fontSize,
        font,
        color: rgb(0.7, 0.7, 0.7),
        opacity: 0.25,
        rotate: degrees(-45),
      });
      // Additional copies for coverage
      const positions = [
        { x: width * 0.2, y: height * 0.8 },
        { x: width * 0.8, y: height * 0.8 },
        { x: width * 0.2, y: height * 0.2 },
        { x: width * 0.8, y: height * 0.2 },
      ];
      for (const pos of positions) {
        page.drawText(text, {
          x: pos.x - textWidth / 2,
          y: pos.y,
          size: fontSize * 0.7,
          font,
          color: rgb(0.7, 0.7, 0.7),
          opacity: 0.18,
          rotate: degrees(-45),
        });
      }
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

  // Create watermark header XML
  const headerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
       xmlns:v="urn:schemas-microsoft-com:vml"
       xmlns:o="urn:schemas-microsoft-com:office:office"
       xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:p>
    <w:pPr><w:pStyle w:val="Header"/></w:pPr>
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
        <v:shape id="PowerPlusWaterMarkObject" o:spid="_x0000_s2049" type="#_x0000_t136"
          style="position:absolute;margin-left:0;margin-top:0;width:494pt;height:141pt;rotation:315;z-index:-251657216;mso-position-horizontal:center;mso-position-horizontal-relative:margin;mso-position-vertical:center;mso-position-vertical-relative:margin"
          o:allowincell="f" fillcolor="silver" stroked="f">
          <v:fill opacity=".20"/>
          <v:textpath style="font-family:&quot;Arial&quot;;font-size:1pt" string="${WATERMARK_TEXT}"/>
        </v:shape>
      </w:pict>
    </w:r>
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

    // Watermark shape XML (diagonal semi-transparent text)
    const watermarkShape = `
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="99999" name="Watermark"/>
          <p:cNvSpPr txBox="1"/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm rot="-2700000">
            <a:off x="1500000" y="2500000"/>
            <a:ext cx="7000000" cy="2000000"/>
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
              <a:rPr lang="zh-TW" sz="4800" dirty="0">
                <a:solidFill><a:srgbClr val="808080"><a:alpha val="25000"/></a:srgbClr></a:solidFill>
                <a:latin typeface="Arial"/>
                <a:ea typeface="Microsoft JhengHei"/>
              </a:rPr>
              <a:t>${WATERMARK_TEXT}</a:t>
            </a:r>
          </a:p>
        </p:txBody>
      </p:sp>`;

    // Insert before closing </p:spTree>
    xml = xml.replace('</p:spTree>', watermarkShape + '</p:spTree>');
    zip.file(slidePath, xml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}

/* ============================================================
   XLSX — add watermark text to sheet header (print header)
   + overlay drawing for on-screen visibility
   ============================================================ */
async function watermarkXlsx(filePath: string): Promise<Buffer> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  // Find all sheet XML files
  const sheetFiles: string[] = [];
  zip.forEach((p) => {
    if (/^xl\/worksheets\/sheet\d+\.xml$/.test(p)) sheetFiles.push(p);
  });

  for (const sheetPath of sheetFiles) {
    let xml = await zip.file(sheetPath)!.async('text');

    // Add print header/footer with watermark
    const headerFooter = `<headerFooter><oddHeader>&amp;C&amp;"Arial,Regular"&amp;18&amp;K808080${WATERMARK_TEXT}</oddHeader></headerFooter>`;

    if (xml.includes('<headerFooter')) {
      // Replace existing
      xml = xml.replace(/<headerFooter[^>]*>[\s\S]*?<\/headerFooter>/, headerFooter);
    } else {
      // Insert before </worksheet>
      xml = xml.replace('</worksheet>', headerFooter + '</worksheet>');
    }

    zip.file(sheetPath, xml);
  }

  const buf = await zip.generateAsync({ type: 'nodebuffer' });
  return buf;
}
