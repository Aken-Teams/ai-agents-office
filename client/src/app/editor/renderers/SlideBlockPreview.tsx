'use client';

/**
 * Preview renderer for PPTX / Slides block types.
 * Compact card preview for each slide block.
 */
export default function SlideBlockPreview({ data, type }: { data: Record<string, unknown>; type: string }) {
  const title = (data.title as string) || '';
  const subtitle = (data.subtitle as string) || '';
  const description = (data.description as string) || '';
  const content = (data.content as string) || '';
  const bullets = (data.bullets as string[]) || (data.points as string[]) || [];
  const items = (data.items as any[]) || (data.stats as any[]) || (data.kpis as any[]) || [];
  const steps = (data.steps as any[]) || [];
  const headers = (data.headers as string[]) || (data.columns as string[]) || [];
  const rows = (data.rows as any[][]) || [];
  const highlights = (data.highlights as any[]) || [];
  const quote = (data.quote as string) || '';
  const attribution = (data.attribution as string) || '';

  return (
    <div className="w-full bg-surface-container-lowest rounded-lg p-3 flex flex-col gap-1.5 overflow-hidden border border-outline-variant/5">
      {/* Title slide */}
      {(type === 'title' || type === 'title_slide') && (
        <div className="flex flex-col items-center text-center gap-0.5 py-2">
          <div className="text-sm font-bold text-on-surface">{title}</div>
          {subtitle && <div className="text-[11px] text-on-surface-variant">{subtitle}</div>}
          {description && <div className="text-[10px] text-outline mt-1 line-clamp-2">{description}</div>}
        </div>
      )}

      {/* Dashboard / KPI */}
      {(type === 'dashboard' || type === 'kpi') && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {items.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {items.slice(0, 6).map((item, i) => (
                <div key={i} className="bg-surface-container rounded px-2 py-1.5 text-center">
                  <div className="text-[11px] font-bold text-primary truncate">{item.value || '—'}</div>
                  <div className="text-[8px] text-on-surface-variant truncate">{item.label || ''}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Content / bullets */}
      {type === 'content' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {bullets.length > 0 && (
            <ul className="text-[10px] text-on-surface-variant space-y-0.5 list-disc pl-3">
              {bullets.slice(0, 4).map((b, i) => (
                <li key={i} className="truncate">{typeof b === 'string' ? b : (b as any).text || JSON.stringify(b)}</li>
              ))}
              {bullets.length > 4 && <li className="text-outline">+{bullets.length - 4}</li>}
            </ul>
          )}
          {!bullets.length && content && <div className="text-[10px] text-on-surface-variant line-clamp-3">{content}</div>}
        </>
      )}

      {/* Stats */}
      {type === 'stats' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          <div className="grid grid-cols-2 gap-1">
            {items.slice(0, 4).map((item, i) => (
              <div key={i} className="bg-surface-container rounded p-1.5 text-center">
                <div className="text-[10px] font-bold text-primary truncate">{item.value || item.number || '—'}</div>
                <div className="text-[8px] text-on-surface-variant truncate">{item.label || item.title || ''}</div>
              </div>
            ))}
          </div>
          {description && <div className="text-[9px] text-outline line-clamp-1">{description}</div>}
        </>
      )}

      {/* Chart */}
      {type === 'chart' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          <div className="bg-surface-container rounded h-10 flex items-center justify-center gap-1.5">
            <span className="material-symbols-outlined text-lg text-on-surface-variant/30">bar_chart</span>
            <span className="text-[9px] text-on-surface-variant/50">{(data.chart as any)?.type || 'chart'}</span>
          </div>
          {description && <div className="text-[9px] text-outline line-clamp-1">{description}</div>}
        </>
      )}

      {/* Table */}
      {type === 'table' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {headers.length > 0 && (
            <div className="overflow-hidden rounded border border-outline-variant/10">
              <table className="w-full text-[8px]">
                <thead>
                  <tr className="bg-surface-container">
                    {headers.slice(0, 4).map((h, i) => (
                      <th key={i} className="px-1.5 py-0.5 text-left font-medium text-on-surface-variant truncate">{String(h)}</th>
                    ))}
                    {headers.length > 4 && <th className="px-1 text-outline">+{headers.length - 4}</th>}
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, 2).map((row, ri) => (
                    <tr key={ri} className="border-t border-outline-variant/5">
                      {(Array.isArray(row) ? row : Object.values(row)).slice(0, 4).map((cell, ci) => (
                        <td key={ci} className="px-1.5 py-0.5 text-on-surface-variant truncate">{String(cell ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {rows.length > 2 && <div className="text-[7px] text-outline text-center py-0.5 bg-surface-container/50">+{rows.length - 2} rows</div>}
            </div>
          )}
        </>
      )}

      {/* Icon grid */}
      {type === 'icon-grid' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {highlights.length > 0 && (
            <div className="grid grid-cols-3 gap-1">
              {highlights.slice(0, 6).map((item, i) => (
                <div key={i} className="bg-surface-container rounded px-1.5 py-1 text-center">
                  {item.icon && <span className="material-symbols-outlined text-primary text-xs">{item.icon}</span>}
                  <div className="text-[8px] text-on-surface-variant truncate">{item.title || item.label || ''}</div>
                </div>
              ))}
            </div>
          )}
          {description && <div className="text-[9px] text-outline line-clamp-1">{description}</div>}
        </>
      )}

      {/* Process / Timeline */}
      {type === 'process' && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {steps.length > 0 && (
            <div className="flex items-start gap-1">
              {steps.slice(0, 5).map((step, i) => (
                <div key={i} className="flex-1 flex flex-col items-center text-center">
                  <div className="w-5 h-5 rounded-full bg-primary/20 text-primary text-[9px] font-bold flex items-center justify-center">{i + 1}</div>
                  <div className="text-[7px] text-on-surface-variant mt-0.5 line-clamp-2">{step.title || step.label || ''}</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Quote */}
      {type === 'quote' && (
        <div className="py-1">
          <div className="text-primary text-lg leading-none">&ldquo;</div>
          <div className="text-[11px] text-on-surface italic line-clamp-3 px-2">{quote}</div>
          {attribution && <div className="text-[9px] text-on-surface-variant mt-1 px-2">— {attribution}</div>}
        </div>
      )}

      {/* Image */}
      {(type === 'image' || type === 'photo' || type === 'media') && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          <div className="bg-surface-container rounded h-10 flex items-center justify-center">
            <span className="material-symbols-outlined text-lg text-on-surface-variant/30">image</span>
          </div>
        </>
      )}

      {/* Timeline / Roadmap */}
      {(type === 'timeline' || type === 'roadmap') && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          <div className="flex items-center gap-1">
            {items.slice(0, 4).map((item, i) => (
              <div key={i} className="flex-1 flex flex-col items-center">
                <div className="w-3 h-3 rounded-full bg-primary/60" />
                <div className="w-px h-1.5 bg-outline-variant/30" />
                <div className="text-[7px] text-on-surface-variant text-center truncate w-full">{item.title || item.label || ''}</div>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Generic fallback */}
      {!['title', 'title_slide', 'content', 'dashboard', 'kpi', 'stats', 'chart',
        'table', 'icon-grid', 'process', 'quote', 'image', 'photo', 'media',
        'timeline', 'roadmap'].includes(type) && (
        <>
          {title && <div className="text-xs font-bold text-on-surface truncate">{title}</div>}
          {description ? (
            <div className="text-[10px] text-on-surface-variant line-clamp-2">{description}</div>
          ) : content ? (
            <div className="text-[10px] text-on-surface-variant line-clamp-2">{content}</div>
          ) : (
            <div className="text-[10px] text-on-surface-variant/50 uppercase tracking-wider py-2 text-center">{type}</div>
          )}
        </>
      )}
    </div>
  );
}
