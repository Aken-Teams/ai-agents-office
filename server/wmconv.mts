import fs from 'fs'; import path from 'path'; import os from 'os';
import { applyWatermark } from './src/services/watermark.ts';
import { convertOfficeFile } from './src/services/filePreview.ts';
import JSZip from 'jszip';
const src = '../workspace/fd6be60d-7158-41f4-8c1c-d46d3f4ba830/fcc147eb-dc8e-4507-bd22-2146029b64ec/FlowDesk_產品需求規格文件_PRD_v1.0.docx';
console.log('src exists:', fs.existsSync(src));
const wm = await applyWatermark(src);
console.log('applyWatermark:', wm ? `buffer ${wm.length}` : 'NULL');
if (wm) {
  const z = await JSZip.loadAsync(wm);
  const hdr = Object.keys(z.files).find(p => /header.*watermark|watermark.*header/i.test(p));
  const allHdr = Object.keys(z.files).filter(p=>/header/i.test(p));
  console.log('headers in zip:', allHdr.join(','));
  const tmp = path.join(os.tmpdir(), 'wmtest.docx'); fs.writeFileSync(tmp, wm);
  const res = await convertOfficeFile(tmp, 'docx');
  console.log('convert mime:', res.mime, '| buffer:', Buffer.isBuffer(res.content) ? res.content.length : 'str-'+String(res.content).length);
  const u8 = Buffer.isBuffer(res.content) ? res.content.toString('utf8') : String(res.content);
  console.log('output contains CONFIDENTIAL:', /CONFIDENTIAL/i.test(u8), '| contains 強茂:', /強茂/.test(u8));
}
