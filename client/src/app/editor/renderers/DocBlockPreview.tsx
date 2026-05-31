'use client';

/**
 * Preview renderer for DOCX / PDF block types (sections/paragraphs).
 */
export default function DocBlockPreview({ data, type }: { data: Record<string, unknown>; type: string }) {
  const title = (data.title as string) || (data.heading as string) || '';
  const content = (data.content as string) || (data.text as string) || (data.body as string) || '';
  const bullets = (data.bullets as string[]) || (data.items as string[]) || (data.points as string[]) || [];
  const subsections = (data.subsections as any[]) || [];

  return (
    <div className="w-full bg-surface-container-lowest rounded-lg p-3 md:p-4 flex flex-col gap-1.5 overflow-hidden border border-outline-variant/5 min-h-[60px]">
      {/* Section heading */}
      {(type === 'heading' || type === 'section' || type === 'header') && (
        <>
          <div className="text-sm font-bold text-on-surface border-b border-outline-variant/10 pb-1">{title}</div>
          {content && <div className="text-[11px] text-on-surface-variant line-clamp-3">{content}</div>}
        </>
      )}

      {/* Paragraph / body text */}
      {(type === 'paragraph' || type === 'body' || type === 'text') && (
        <>
          {title && <div className="text-xs font-semibold text-on-surface">{title}</div>}
          <div className="text-[11px] text-on-surface-variant line-clamp-4 leading-relaxed">{content}</div>
        </>
      )}

      {/* List */}
      {(type === 'list' || type === 'bullets') && (
        <>
          {title && <div className="text-xs font-semibold text-on-surface">{title}</div>}
          <ul className="text-[11px] text-on-surface-variant space-y-0.5 list-disc pl-4">
            {bullets.slice(0, 6).map((b, i) => (
              <li key={i} className="truncate">{typeof b === 'string' ? b : (b as any).text || JSON.stringify(b)}</li>
            ))}
            {bullets.length > 6 && <li className="text-outline">+{bullets.length - 6} more</li>}
          </ul>
        </>
      )}

      {/* Table of contents */}
      {(type === 'toc' || type === 'table_of_contents') && (
        <div className="flex flex-col gap-0.5">
          <div className="text-xs font-bold text-on-surface">Table of Contents</div>
          {bullets.slice(0, 5).map((b, i) => (
            <div key={i} className="text-[10px] text-on-surface-variant pl-2 truncate">{i + 1}. {typeof b === 'string' ? b : (b as any).title || ''}</div>
          ))}
        </div>
      )}

      {/* Cover page */}
      {(type === 'cover' || type === 'title' || type === 'title_page') && (
        <div className="flex flex-col items-center justify-center py-3 gap-1">
          <div className="text-sm font-bold text-on-surface text-center">{title}</div>
          {(data.subtitle || data.author) ? (
            <div className="text-[10px] text-on-surface-variant">{(data.subtitle as string) || (data.author as string) || ''}</div>
          ) : null}
        </div>
      )}

      {/* Complex section with subsections */}
      {type === 'section' && subsections.length > 0 && (
        <div className="space-y-1 mt-1">
          {subsections.slice(0, 3).map((sub, i) => (
            <div key={i} className="pl-2 border-l-2 border-primary/20">
              <div className="text-[10px] font-medium text-on-surface truncate">{sub.title || sub.heading || `Section ${i + 1}`}</div>
            </div>
          ))}
          {subsections.length > 3 && <div className="text-[9px] text-outline pl-2">+{subsections.length - 3} more sections</div>}
        </div>
      )}

      {/* Generic fallback */}
      {!['heading', 'section', 'header', 'paragraph', 'body', 'text', 'list', 'bullets',
        'toc', 'table_of_contents', 'cover', 'title', 'title_page'].includes(type) && (
        <>
          {title && <div className="text-xs font-semibold text-on-surface">{title}</div>}
          {content ? (
            <div className="text-[11px] text-on-surface-variant line-clamp-4">{content}</div>
          ) : (
            <div className="text-[10px] text-on-surface-variant/50 uppercase tracking-wider">{type}</div>
          )}
        </>
      )}
    </div>
  );
}
