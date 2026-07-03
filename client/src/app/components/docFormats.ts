/**
 * Document-export catalogue — mirrors the front-end 範本精靈 (format + per-format
 * styles). Style prompts reuse the same i18n keys the template wizard uses.
 *
 * Shared so both the (former) team "產生文件" picker and the schedule setup can
 * offer the same format/style choices.
 */

export type ExportFormat = 'docx' | 'pdf' | 'pptx' | 'html';

export const DOC_EXPORT: Array<{ format: ExportFormat; icon: string; label: string; desc: string; styles: Array<{ id: string; labelKey: string; promptKey: string }> }> = [
  { format: 'pptx', icon: 'slideshow', label: '簡報', desc: 'PPT 投影片', styles: [
    { id: 'panjit', labelKey: 'templates.pptx.panjit', promptKey: 'templates.pptx.panjit.prompt' },
    { id: 'corporate', labelKey: 'templates.pptx.corporate', promptKey: 'templates.pptx.corporate.prompt' },
    { id: 'minimalPro', labelKey: 'templates.pptx.minimalPro', promptKey: 'templates.pptx.minimalPro.prompt' },
    { id: 'techDark', labelKey: 'templates.pptx.techDark', promptKey: 'templates.pptx.techDark.prompt' },
    { id: 'creative', labelKey: 'templates.pptx.creative', promptKey: 'templates.pptx.creative.prompt' },
  ] },
  { format: 'docx', icon: 'description', label: 'Word', desc: '文書文件', styles: [
    { id: 'formal', labelKey: 'templates.docx.formal', promptKey: 'templates.docx.formal.prompt' },
    { id: 'modern', labelKey: 'templates.docx.modern', promptKey: 'templates.docx.modern.prompt' },
    { id: 'academic', labelKey: 'templates.docx.academic', promptKey: 'templates.docx.academic.prompt' },
    { id: 'compact', labelKey: 'templates.docx.compact', promptKey: 'templates.docx.compact.prompt' },
  ] },
  { format: 'pdf', icon: 'picture_as_pdf', label: 'PDF', desc: '文件輸出', styles: [
    { id: 'formal', labelKey: 'templates.pdf.formal', promptKey: 'templates.pdf.formal.prompt' },
    { id: 'modern', labelKey: 'templates.pdf.modern', promptKey: 'templates.pdf.modern.prompt' },
    { id: 'magazine', labelKey: 'templates.pdf.magazine', promptKey: 'templates.pdf.magazine.prompt' },
    { id: 'technical', labelKey: 'templates.pdf.technical', promptKey: 'templates.pdf.technical.prompt' },
  ] },
  { format: 'html', icon: 'web', label: '網頁簡報', desc: '互動 HTML', styles: [
    { id: 'business', labelKey: 'templates.slides.business', promptKey: 'templates.slides.business.prompt' },
    { id: 'data', labelKey: 'templates.slides.data', promptKey: 'templates.slides.data.prompt' },
    { id: 'personal', labelKey: 'templates.slides.personal', promptKey: 'templates.slides.personal.prompt' },
    { id: 'creative', labelKey: 'templates.slides.creative', promptKey: 'templates.slides.creative.prompt' },
  ] },
];
