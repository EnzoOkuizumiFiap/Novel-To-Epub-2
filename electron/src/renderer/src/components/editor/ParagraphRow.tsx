import { memo } from 'react'

interface ParagraphRowProps {
  pairIdx: number
  rowPosition: number
  enLabel: string
  enText0: string | null
  enText1: string | null
  ptIdx0: number
  ptIdx1: number
  ptText0: string | null
  ptText1: string | null
  language: string
  editingSlot: 0 | 1 | null
  onStartEdit: (idx: number) => void
  onDoneEdit: () => void
  onChange: (idx: number, inner: string) => void
  onMergeAbove: (idx: number) => void
  onInsertBelow: (idx: number) => void
  onInsertGapAt: (pairIdx: number) => void
}

export const ParagraphRow = memo(function ParagraphRow({
  pairIdx,
  rowPosition,
  enLabel,
  enText0,
  enText1,
  ptIdx0,
  ptIdx1,
  ptText0,
  ptText1,
  language,
  editingSlot,
  onStartEdit,
  onDoneEdit,
  onChange,
  onMergeAbove,
  onInsertBelow,
  onInsertGapAt
}: ParagraphRowProps): React.JSX.Element {
  const isSplit = ptIdx0 >= 0 && ptIdx1 >= 0

  function renderPtBlock(
    ptIdx: number,
    text: string | null,
    isEditing: boolean
  ): React.JSX.Element {
    if (isEditing) {
      return (
        <div key={ptIdx} className="space-y-1.5">
          <textarea
            autoFocus
            spellCheck={false}
            value={text ?? ''}
            onChange={(e) => onChange(ptIdx, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onDoneEdit()
            }}
            className="auto-grow-textarea font-sans resize-none rounded-lg border border-[var(--stamp-red)]/50 bg-[var(--paper-50)] px-3 py-2 text-[13px] leading-relaxed text-[var(--ink-900)] outline-none"
          />
          <div className="flex flex-wrap items-center justify-end gap-2 text-[11px]">
            {ptIdx > 0 && (
              <button
                type="button"
                onClick={() => onMergeAbove(ptIdx)}
                className="font-sans rounded px-2 py-0.5 text-[var(--ink-500)] hover:bg-[var(--paper-200)] hover:text-[var(--ink-900)]"
              >
                Unir acima
              </button>
            )}
            <button
              type="button"
              onClick={() => onInsertBelow(ptIdx)}
              className="font-sans rounded px-2 py-0.5 text-[var(--ink-500)] hover:bg-[var(--paper-200)] hover:text-[var(--ink-900)]"
            >
              + Abaixo
            </button>
            <button
              type="button"
              onClick={onDoneEdit}
              className="font-sans rounded bg-[var(--ink-900)] px-2.5 py-0.5 font-medium text-[var(--paper-50)]"
            >
              Pronto
            </button>
          </div>
        </div>
      )
    }

    return (
      <button
        key={ptIdx}
        type="button"
        onClick={() => onStartEdit(ptIdx)}
        className="font-sans block w-full rounded-lg px-2 py-1 text-left text-[13px] leading-relaxed whitespace-pre-wrap break-words text-[var(--ink-900)] transition-colors hover:bg-[var(--paper-200)]/60"
      >
        {text ? (
          text
        ) : (
          <span className="italic text-[var(--ink-400)]">— vazio (clique para editar) —</span>
        )}
      </button>
    )
  }

  return (
    <div
      className={[
        'grid grid-cols-2 border-b border-[var(--border-soft)]/70',
        rowPosition >= 15 ? 'deferred-paragraph-row' : '',
        pairIdx % 2 === 1 ? 'bg-[var(--paper-100)]/45' : ''
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="flex gap-2.5 border-r border-[var(--border-soft)] bg-[var(--paper-100)]/65 px-4 py-3">
        <span className="folio w-12 shrink-0 pt-0.5 text-[10px] text-[var(--ink-400)]">
          {enLabel}
        </span>
        <div className="font-sans min-w-0 flex-1 space-y-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--ink-700)]">
          {enText0 !== null ? (
            <>
              <div>
                {enText0 || <span className="italic text-[var(--ink-400)]">— vazio —</span>}
              </div>
              {enText1 !== null && (
                <div className="border-t border-dashed border-[var(--border-soft)] pt-1.5">
                  {enText1}
                </div>
              )}
            </>
          ) : (
            <span className="italic text-[var(--ink-400)]">— parágrafo extra na tradução —</span>
          )}
        </div>
      </div>

      <div className="space-y-1.5 px-4 py-2.5" lang={language}>
        {isSplit && (
          <div className="font-sans inline-block rounded bg-[var(--paper-200)] px-1.5 py-0.5 text-[9px] font-medium tracking-wider uppercase text-[var(--ink-500)]">
            1 → 2 parágrafos
          </div>
        )}
        {ptIdx0 < 0 ? (
          <button
            type="button"
            onClick={() => onInsertGapAt(pairIdx)}
            className="font-sans block w-full rounded-lg px-2 py-1 text-left text-[13px] italic text-[var(--ink-400)] transition-colors hover:bg-[var(--paper-200)]/60 hover:text-[var(--ink-700)]"
          >
            — sem tradução correspondente (clique para inserir) —
          </button>
        ) : (
          <>
            {renderPtBlock(ptIdx0, ptText0, editingSlot === 0)}
            {ptIdx1 >= 0 && (
              <div className="border-t border-dashed border-[var(--border-soft)] pt-1.5">
                {renderPtBlock(ptIdx1, ptText1, editingSlot === 1)}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
})
