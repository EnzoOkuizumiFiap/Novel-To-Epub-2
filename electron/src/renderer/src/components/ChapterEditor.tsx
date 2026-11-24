import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, Save, Trash2, X, RotateCcw, FileText, Search } from 'lucide-react'
import { api, type ChapterDetail, type ChapterSummary, type VolumeOut } from '@renderer/lib/api'
import {
  alignHtmlParagraphs,
  parseHtmlParagraphs,
  serializeHtmlParagraphs,
  type AlignedPair,
  type HtmlParagraph
} from '@renderer/lib/chapterHtml'
import { ParagraphRow } from '@renderer/components/editor/ParagraphRow'
import { RawHtmlEditor } from '@renderer/components/editor/RawHtmlEditor'
import { Button } from '@renderer/components/ui/button'

interface Props {
  novelId: number
  volume: VolumeOut // contexto: range + language + volume_id pra rebuild
  onClose: () => void
  /** Disparado quando uma tradução é salva — caller pode atualizar lista/contadores. */
  onTranslationSaved?: () => void
}

/**
 * Editor manual de capítulos. Lista os caps do volume à esquerda (highlight nos
 * sem tradução), editor alinhado por parágrafos (ou HTML bruto) à direita: EN read-only | PT editável.
 * Após salvar, dispara rebuild do volume pra atualizar o .epub.
 */
export function ChapterEditor({
  novelId,
  volume,
  onClose,
  onTranslationSaved
}: Props): React.JSX.Element {
  const language = volume.translate_to ?? 'pt-BR'
  const [chapters, setChapters] = useState<ChapterSummary[]>([])
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null)
  const [detail, setDetail] = useState<ChapterDetail | null>(null)
  const [draft, setDraft] = useState<{ title: string; html: string }>({ title: '', html: '' })
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [rebuilding, setRebuilding] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [filter, setFilter] = useState<'all' | 'failed'>('failed')
  const [mode, setMode] = useState<'aligned' | 'raw'>('aligned')
  const [doc, setDoc] = useState<{ ptParagraphs: HtmlParagraph[]; alignedPairs: AlignedPair[] }>({
    ptParagraphs: [],
    alignedPairs: []
  })
  const ptParagraphs = doc.ptParagraphs
  const alignedPairs = doc.alignedPairs
  const [editingIdx, setEditingIdx] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const enParagraphs = useMemo(() => (detail ? parseHtmlParagraphs(detail.html_en) : []), [detail])

  const alignedRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const rows: { pairIdx: number; pair: AlignedPair }[] = []
    for (let i = 0; i < alignedPairs.length; i++) {
      const pair = alignedPairs[i]
      if (q) {
        const hitEn = pair.enIndices.some((k) =>
          (enParagraphs[k]?.inner.toLowerCase() ?? '').includes(q)
        )
        const hitPt = pair.ptIndices.some((k) =>
          (ptParagraphs[k]?.inner.toLowerCase() ?? '').includes(q)
        )
        if (!hitEn && !hitPt) continue
      }
      rows.push({ pairIdx: i, pair })
    }
    return rows
  }, [alignedPairs, enParagraphs, ptParagraphs, searchQuery])

  const switchMode = useCallback(
    (next: 'aligned' | 'raw') => {
      if (next === mode) return
      if (next === 'raw') {
        setDraft((prev) => ({ ...prev, html: serializeHtmlParagraphs(ptParagraphs) }))
        setEditingIdx(null)
      } else {
        const parsed = parseHtmlParagraphs(draft.html)
        setDoc({
          ptParagraphs: parsed,
          alignedPairs: alignHtmlParagraphs(enParagraphs, parsed)
        })
      }
      setMode(next)
    },
    [mode, ptParagraphs, draft.html, enParagraphs]
  )

  const handleStartEdit = useCallback((idx: number) => setEditingIdx(idx), [])
  const handleDoneEdit = useCallback(() => setEditingIdx(null), [])

  const handleChangeParagraph = useCallback((idx: number, inner: string) => {
    setDoc((prev) => {
      if (idx < 0 || idx >= prev.ptParagraphs.length) return prev
      const nextPt = [...prev.ptParagraphs]
      nextPt[idx] = { ...nextPt[idx], inner }
      return { ptParagraphs: nextPt, alignedPairs: prev.alignedPairs }
    })
  }, [])

  const handleMergeAbove = useCallback(
    (ptIdx: number) => {
      if (ptIdx <= 0) return
      setDoc((prev) => {
        if (ptIdx >= prev.ptParagraphs.length) return prev
        const above = prev.ptParagraphs[ptIdx - 1].inner.trimEnd()
        const curr = prev.ptParagraphs[ptIdx].inner.trimStart()
        const nextPt = [...prev.ptParagraphs]
        nextPt[ptIdx - 1] = {
          ...nextPt[ptIdx - 1],
          inner: curr ? `${above} ${curr}` : above
        }
        nextPt.splice(ptIdx, 1)
        return {
          ptParagraphs: nextPt,
          alignedPairs: alignHtmlParagraphs(enParagraphs, nextPt)
        }
      })
      setEditingIdx(ptIdx - 1)
    },
    [enParagraphs]
  )

  const handleInsertBelow = useCallback(
    (ptIdx: number) => {
      const at = Math.max(0, ptIdx + 1)
      setDoc((prev) => {
        const safeAt = Math.min(at, prev.ptParagraphs.length)
        const nextPt = [...prev.ptParagraphs]
        nextPt.splice(safeAt, 0, { openTag: '<p>', inner: '' })
        return {
          ptParagraphs: nextPt,
          alignedPairs: alignHtmlParagraphs(enParagraphs, nextPt)
        }
      })
      setEditingIdx(at)
    },
    [enParagraphs]
  )

  const handleInsertGapAt = useCallback(
    (pairIdx: number) => {
      let insertedIdx = 0
      setDoc((prev) => {
        // Encontra o índice logo após o último parágrafo PT antes de `pairIdx`
        let pos = 0
        for (let i = pairIdx - 1; i >= 0; i--) {
          const pts = prev.alignedPairs[i]?.ptIndices
          if (pts && pts.length > 0) {
            pos = pts[pts.length - 1] + 1
            break
          }
        }
        insertedIdx = Math.min(pos, prev.ptParagraphs.length)
        const nextPt = [...prev.ptParagraphs]
        nextPt.splice(insertedIdx, 0, { openTag: '<p>', inner: '' })
        return {
          ptParagraphs: nextPt,
          alignedPairs: alignHtmlParagraphs(enParagraphs, nextPt)
        }
      })
      setEditingIdx(insertedIdx)
    },
    [enParagraphs]
  )

  const loadingDetail = selectedIdx != null && detail?.index !== selectedIdx && !msg

  // Carrega lista de caps
  useEffect(() => {
    let active = true
    api
      .listChapters(novelId, { language, start: volume.start, end: volume.end ?? undefined })
      .then((list) => {
        if (!active) return
        setChapters(list)
        // Auto-seleciona o primeiro sem tradução; se tudo já está traduzido, abre na aba "Todos"
        const firstFailed = list.find((c) => !c.has_translation)
        if (!firstFailed) setFilter('all')
        setSelectedIdx(firstFailed?.index ?? list[0]?.index ?? null)
      })
      .catch((err) => active && setMsg({ ok: false, text: String(err) }))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [novelId, language, volume.start, volume.end])

  // Carrega detalhe quando muda cap selecionado
  useEffect(() => {
    if (selectedIdx == null) return
    let active = true
    api
      .getChapter(novelId, selectedIdx, language)
      .then((d) => {
        if (!active) return
        const initialHtml = d.html_pt ?? d.html_en
        const enPars = parseHtmlParagraphs(d.html_en)
        const ptPars = parseHtmlParagraphs(initialHtml)
        setDetail(d)
        setDraft({
          title: d.title_pt ?? d.title_en,
          html: initialHtml
        })
        setDoc({
          ptParagraphs: ptPars,
          alignedPairs: alignHtmlParagraphs(enPars, ptPars)
        })
      })
      .catch((err) => active && setMsg({ ok: false, text: String(err) }))
    return () => {
      active = false
    }
  }, [selectedIdx, novelId, language])

  const visibleChapters = useMemo(
    () => (filter === 'failed' ? chapters.filter((c) => !c.has_translation) : chapters),
    [chapters, filter]
  )
  const failedCount = chapters.filter((c) => !c.has_translation).length

  async function save(): Promise<void> {
    if (selectedIdx == null) return
    const htmlToSave = mode === 'aligned' ? serializeHtmlParagraphs(ptParagraphs) : draft.html
    setSaving(true)
    setMsg(null)
    try {
      await api.saveChapterTranslation(novelId, selectedIdx, {
        title: draft.title,
        html: htmlToSave,
        language
      })
      setDraft((prev) => ({ ...prev, html: htmlToSave }))
      setEditingIdx(null)
      // Atualiza lista localmente
      setChapters((prev) =>
        prev.map((c) =>
          c.index === selectedIdx
            ? { ...c, has_translation: true, translation_source: 'manual', title_pt: draft.title }
            : c
        )
      )
      setDetail((d) =>
        d ? { ...d, title_pt: draft.title, html_pt: htmlToSave, translation_source: 'manual' } : d
      )
      setMsg({ ok: true, text: 'Tradução salva. Clique Recompilar pra atualizar o EPUB.' })
      onTranslationSaved?.()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  async function discard(): Promise<void> {
    if (selectedIdx == null || !detail?.translation_source) return
    if (!confirm(`Remover tradução do cap ${selectedIdx}? O capítulo voltará pro inglês no EPUB.`))
      return
    try {
      await api.deleteChapterTranslation(novelId, selectedIdx, language)
      setChapters((prev) =>
        prev.map((c) =>
          c.index === selectedIdx
            ? { ...c, has_translation: false, translation_source: null, title_pt: null }
            : c
        )
      )
      setDetail((d) => (d ? { ...d, title_pt: null, html_pt: null, translation_source: null } : d))
      setDraft({ title: detail.title_en, html: detail.html_en })
      const resetPars = parseHtmlParagraphs(detail.html_en)
      setDoc({
        ptParagraphs: resetPars,
        alignedPairs: alignHtmlParagraphs(enParagraphs, resetPars)
      })
      setEditingIdx(null)
      setMsg({ ok: true, text: 'Tradução removida.' })
      onTranslationSaved?.()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    }
  }

  async function rebuild(): Promise<void> {
    setRebuilding(true)
    setMsg(null)
    try {
      await api.rebuildVolume(volume.id)
      setMsg({ ok: true, text: 'EPUB recompilado.' })
      onTranslationSaved?.()
    } catch (err) {
      setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) })
    } finally {
      setRebuilding(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--paper-50)]">
      {/* Header */}
      <header className="flex items-center gap-4 border-b border-[var(--border-soft)] bg-[var(--paper-100)] px-6 py-3">
        <FileText className="size-4 shrink-0 text-[var(--ink-400)]" />
        <div className="min-w-0 flex-1">
          <div className="font-display truncate text-[15px] font-medium tracking-tight">
            Editor · {volume.volume_title ?? `caps ${volume.start}–${volume.end}`}
          </div>
          <div className="font-sans text-[11px] tracking-wide text-[var(--ink-500)]">
            {chapters.length} caps · {failedCount} sem tradução · lingua: {language}
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={rebuild} disabled={rebuilding}>
          {rebuilding ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCcw className="size-3.5" />
          )}
          Recompilar EPUB
        </Button>
        <Button variant="outline" size="sm" onClick={onClose}>
          <X className="size-3.5" /> Fechar
        </Button>
      </header>

      {/* Body: split */}
      <div className="flex min-h-0 flex-1">
        {/* Sidebar: lista de caps */}
        <aside className="flex w-72 shrink-0 flex-col border-r border-[var(--border-soft)] bg-[var(--paper-100)]">
          <div className="flex gap-1 border-b border-[var(--border-soft)] p-2 text-[11px]">
            <button
              type="button"
              onClick={() => setFilter('failed')}
              className={[
                'font-sans flex-1 rounded px-2 py-1 tracking-wide uppercase',
                filter === 'failed'
                  ? 'bg-[var(--ink-stamp)]/15 text-[var(--ink-stamp)]'
                  : 'text-[var(--ink-500)]'
              ].join(' ')}
            >
              Sem tradução ({failedCount})
            </button>
            <button
              type="button"
              onClick={() => setFilter('all')}
              className={[
                'font-sans flex-1 rounded px-2 py-1 tracking-wide uppercase',
                filter === 'all'
                  ? 'bg-[var(--paper-300)] text-[var(--ink-700)]'
                  : 'text-[var(--ink-500)]'
              ].join(' ')}
            >
              Todos ({chapters.length})
            </button>
          </div>
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-5 animate-spin text-[var(--ink-400)]" />
            </div>
          ) : (
            <ul className="flex-1 overflow-y-auto py-1">
              {visibleChapters.map((c) => {
                const active = c.index === selectedIdx
                return (
                  <li key={c.index}>
                    <button
                      type="button"
                      onClick={() => {
                        setMsg(null)
                        setEditingIdx(null)
                        setSearchQuery('')
                        setSelectedIdx(c.index)
                      }}
                      className={[
                        'font-sans flex w-full items-start gap-2 px-3 py-2 text-left text-[12px]',
                        active
                          ? 'bg-[var(--paper-200)] border-l-2 border-[var(--stamp-red)]'
                          : 'hover:bg-[var(--paper-200)] border-l-2 border-transparent'
                      ].join(' ')}
                    >
                      <span className="folio shrink-0 w-7 text-[var(--ink-400)]">
                        {String(c.index).padStart(2, '0')}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{c.title_pt ?? c.title_en}</span>
                        <span className="block text-[10px] tracking-wide text-[var(--ink-400)]">
                          {c.has_translation
                            ? c.translation_source === 'manual'
                              ? '✎ manual'
                              : '✓ IA'
                            : '— sem tradução'}
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
              {visibleChapters.length === 0 && (
                <li className="px-3 py-6 text-center text-[12px] text-[var(--ink-500)]">
                  {filter === 'failed' ? 'Nenhum cap falhou ✨' : 'Vazio.'}
                </li>
              )}
            </ul>
          )}
        </aside>

        {/* Main: editor */}
        <main className="flex min-w-0 flex-1 flex-col">
          {selectedIdx == null ? (
            <div className="flex flex-1 items-center justify-center text-[var(--ink-400)]">
              Selecione um capítulo
            </div>
          ) : loadingDetail ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-[var(--ink-400)]" />
            </div>
          ) : !detail ? (
            <div className="flex flex-1 items-center justify-center font-sans text-sm text-[var(--ink-stamp)]">
              {msg?.text ?? 'Falha ao carregar capítulo.'}
            </div>
          ) : (
            <>
              {/* Title bar + mode/search toolbar */}
              <div className="space-y-2.5 border-b border-[var(--border-soft)] px-6 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="folio text-[var(--ink-400)]">cap {detail.index}</div>
                  <div className="flex flex-wrap items-center gap-2">
                    {detail.translation_source && (
                      <span
                        className={[
                          'rounded px-1.5 py-0.5 text-[10px]',
                          detail.translation_source === 'manual'
                            ? 'bg-[var(--stamp-red)]/10 text-[var(--stamp-red)]'
                            : 'bg-[var(--paper-300)] text-[var(--ink-500)]'
                        ].join(' ')}
                      >
                        {detail.translation_source === 'manual'
                          ? '✎ manual'
                          : detail.translation_source}
                      </span>
                    )}
                    {enParagraphs.length === ptParagraphs.length ? (
                      <span className="font-sans rounded bg-[var(--paper-200)] px-2 py-0.5 text-[10px] text-[var(--ink-600)]">
                        {ptParagraphs.length} parágrafos
                      </span>
                    ) : (
                      <span
                        title="Contagem diferente entre EN e PT — os blocos foram auto-alinhados; use 'Unir acima' ou '+ Abaixo' se quiser ajustar."
                        className="font-sans rounded bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium text-amber-800"
                      >
                        EN {enParagraphs.length} · PT {ptParagraphs.length} (auto-alinhado)
                      </span>
                    )}
                    <div className="flex rounded-lg border border-[var(--border-soft)] bg-[var(--paper-100)] p-0.5 text-[11px]">
                      <button
                        type="button"
                        onClick={() => switchMode('aligned')}
                        className={[
                          'font-sans rounded-md px-2.5 py-0.5 transition-colors',
                          mode === 'aligned'
                            ? 'bg-[var(--ink-900)] text-[var(--paper-50)]'
                            : 'text-[var(--ink-500)] hover:text-[var(--ink-900)]'
                        ].join(' ')}
                      >
                        Parágrafos
                      </button>
                      <button
                        type="button"
                        onClick={() => switchMode('raw')}
                        className={[
                          'font-sans rounded-md px-2.5 py-0.5 transition-colors',
                          mode === 'raw'
                            ? 'bg-[var(--ink-900)] text-[var(--paper-50)]'
                            : 'text-[var(--ink-500)] hover:text-[var(--ink-900)]'
                        ].join(' ')}
                      >
                        HTML bruto
                      </button>
                    </div>
                  </div>
                </div>
                <input
                  value={draft.title}
                  onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  className="font-display mt-0.5 w-full bg-transparent text-[20px] font-medium tracking-tight outline-none focus:border-b focus:border-[var(--stamp-red)]"
                  placeholder="Título traduzido"
                />
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="font-sans text-[11px] tracking-wide text-[var(--ink-400)]">
                    EN: <span className="italic">{detail.title_en}</span>
                  </div>
                  {mode === 'aligned' && (
                    <div className="relative flex items-center">
                      <Search className="pointer-events-none absolute left-2.5 size-3.5 text-[var(--ink-400)]" />
                      <input
                        type="text"
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        placeholder="Buscar no capítulo…"
                        className="font-sans h-7 w-60 rounded-lg border border-[var(--border-soft)] bg-[var(--paper-100)] pr-16 pl-8 text-[12px] text-[var(--ink-900)] placeholder:text-[var(--ink-400)] focus:border-[var(--stamp-red)] focus:outline-none"
                      />
                      {searchQuery && (
                        <div className="absolute right-1.5 flex items-center gap-1">
                          <span className="font-sans text-[10px] text-[var(--ink-400)]">
                            {alignedRows.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => setSearchQuery('')}
                            aria-label="Limpar busca"
                            className="rounded p-0.5 text-[var(--ink-400)] hover:text-[var(--ink-700)]"
                          >
                            <X className="size-3" />
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {mode === 'aligned' ? (
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <div className="sticky top-0 z-10 grid grid-cols-2 border-b border-[var(--border-soft)] bg-[var(--paper-100)] text-[10px] tracking-[0.18em] uppercase text-[var(--ink-500)]">
                    <div className="font-sans border-r border-[var(--border-soft)] px-4 py-2">
                      Original (EN) · read-only
                    </div>
                    <div className="font-sans flex items-center justify-between px-4 py-2">
                      <span>Tradução ({language})</span>
                      <span className="font-sans text-[10px] normal-case tracking-normal text-[var(--ink-400)]">
                        clique em um parágrafo para editar
                      </span>
                    </div>
                  </div>
                  {alignedRows.length === 0 ? (
                    <div className="font-sans py-12 text-center text-[13px] text-[var(--ink-400)]">
                      Nenhum parágrafo corresponde à busca.
                    </div>
                  ) : (
                    <div>
                      {alignedRows.map(({ pairIdx, pair }, rowPosition) => {
                        const en0 = pair.enIndices[0] ?? -1
                        const en1 = pair.enIndices[1] ?? -1
                        const pt0 = pair.ptIndices[0] ?? -1
                        const pt1 = pair.ptIndices[1] ?? -1
                        const enLabel =
                          en0 < 0
                            ? '·'
                            : en1 >= 0
                              ? `#${String(en0 + 1).padStart(3, '0')}–${String(en1 + 1).padStart(3, '0')}`
                              : `#${String(en0 + 1).padStart(3, '0')}`
                        const editingSlot: 0 | 1 | null =
                          editingIdx !== null && editingIdx === pt0
                            ? 0
                            : editingIdx !== null && editingIdx === pt1
                              ? 1
                              : null
                        return (
                          <ParagraphRow
                            key={pairIdx}
                            pairIdx={pairIdx}
                            rowPosition={rowPosition}
                            enLabel={enLabel}
                            enText0={en0 >= 0 ? (enParagraphs[en0]?.inner ?? '') : null}
                            enText1={en1 >= 0 ? (enParagraphs[en1]?.inner ?? '') : null}
                            ptIdx0={pt0}
                            ptIdx1={pt1}
                            ptText0={pt0 >= 0 ? (ptParagraphs[pt0]?.inner ?? '') : null}
                            ptText1={pt1 >= 0 ? (ptParagraphs[pt1]?.inner ?? '') : null}
                            language={language}
                            editingSlot={editingSlot}
                            onStartEdit={handleStartEdit}
                            onDoneEdit={handleDoneEdit}
                            onChange={handleChangeParagraph}
                            onMergeAbove={handleMergeAbove}
                            onInsertBelow={handleInsertBelow}
                            onInsertGapAt={handleInsertGapAt}
                          />
                        )
                      })}
                    </div>
                  )}
                </div>
              ) : (
                <RawHtmlEditor
                  chapterKey={detail.index}
                  htmlEn={detail.html_en}
                  htmlPt={draft.html}
                  language={language}
                  onChangeHtmlPt={(html) => setDraft({ ...draft, html })}
                />
              )}

              {/* Footer */}
              <footer className="flex flex-wrap items-center gap-3 border-t border-[var(--border-soft)] bg-[var(--paper-100)] px-6 py-3">
                <Button onClick={save} disabled={saving} size="sm">
                  {saving ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Save className="size-3.5" />
                  )}
                  Salvar
                </Button>
                {detail.translation_source && (
                  <Button variant="outline" size="sm" onClick={discard}>
                    <Trash2 className="size-3.5" /> Remover tradução
                  </Button>
                )}
                {msg && (
                  <span
                    className={[
                      'font-sans text-[12px]',
                      msg.ok ? 'text-[var(--book-3)]' : 'text-[var(--ink-stamp)]'
                    ].join(' ')}
                  >
                    {msg.text}
                  </span>
                )}
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  )
}
