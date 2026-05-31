'use client';

/**
 * Preview renderer for XLSX block types (sheets/tables).
 */
export default function SheetBlockPreview({ data, type }: { data: Record<string, unknown>; type: string }) {
  const title = (data.title as string) || (data.name as string) || (data.sheetName as string) || '';
  const headers = (data.headers as string[]) || (data.columns as string[]) || [];
  const rows = (data.rows as any[][]) || (data.data as any[][]) || [];

  return (
    <div className="w-full bg-surface-container-lowest rounded-lg p-3 md:p-4 flex flex-col gap-1.5 overflow-hidden border border-outline-variant/5 min-h-[60px]">
      {title && (
        <div className="text-xs font-bold text-on-surface flex items-center gap-1.5">
          <span className="material-symbols-outlined text-success text-sm">table_chart</span>
          {title}
        </div>
      )}

      {/* Mini table preview */}
      {(headers.length > 0 || rows.length > 0) && (
        <div className="overflow-hidden rounded border border-outline-variant/10">
          <table className="w-full text-[9px]">
            {headers.length > 0 && (
              <thead>
                <tr className="bg-surface-container">
                  {headers.slice(0, 5).map((h, i) => (
                    <th key={i} className="px-1.5 py-1 text-left font-medium text-on-surface-variant truncate max-w-[80px]">
                      {String(h)}
                    </th>
                  ))}
                  {headers.length > 5 && (
                    <th className="px-1 py-1 text-on-surface-variant/50">+{headers.length - 5}</th>
                  )}
                </tr>
              </thead>
            )}
            <tbody>
              {rows.slice(0, 3).map((row, ri) => (
                <tr key={ri} className="border-t border-outline-variant/5">
                  {(Array.isArray(row) ? row : Object.values(row)).slice(0, 5).map((cell, ci) => (
                    <td key={ci} className="px-1.5 py-0.5 text-on-surface-variant truncate max-w-[80px]">
                      {String(cell ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 3 && (
            <div className="text-[8px] text-outline text-center py-0.5 bg-surface-container/50">
              +{rows.length - 3} rows
            </div>
          )}
        </div>
      )}

      {/* No data fallback */}
      {headers.length === 0 && rows.length === 0 && (
        <div className="flex items-center justify-center py-4">
          <span className="text-[10px] text-on-surface-variant/50 uppercase tracking-wider">{type || 'sheet'}</span>
        </div>
      )}
    </div>
  );
}
