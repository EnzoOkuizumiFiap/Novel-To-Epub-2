import { useEffect, useRef, useState } from 'react'
import { FileText, Loader2 } from 'lucide-react'
import { api, type EpubPreview, type NovelSummary } from '@renderer/lib/api'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

interface EpubSourceSectionProps {
  pickBtnRef: React.RefObject<HTMLButtonElement | null>
  epubFileName: string
  epubPreview: EpubPreview | null
  selectedNovelId: number | 'new'
  onSelectNovel: (value: number | 'new') => void
  seriesTitle: string
  onSeriesTitleChange: (value: string) => void
  onEpubLoaded: (data: { filePath: string; fileName: string; preview: EpubPreview }) => void
  onEpubLoadFailed: () => void
  onClearError: () => void
}

export function EpubSourceSection({
  pickBtnRef,
  epubFileName,
  epubPreview,
  selectedNovelId,
  onSelectNovel,
  seriesTitle,
  onSeriesTitleChange,
  onEpubLoaded,
  onEpubLoadFailed,
  onClearError
}: EpubSourceSectionProps): React.JSX.Element {
  const [epubLoading, setEpubLoading] = useState(false)
  const [epubErr, setEpubErr] = useState<string | null>(null)
  const [epubNovels, setEpubNovels] = useState<NovelSummary[]>([])
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Carrega obras EPUB existentes na biblioteca (pra compartilhar glossário entre volumes).
  useEffect(() => {
    api
      .library()
      .then((list) => setEpubNovels(list.filter((n) => n.source === 'epub')))
      .catch(() => {})
  }, [])

  async function loadEpubPreview(path: string, displayName?: string): Promise<void> {
    setEpubLoading(true)
    setEpubErr(null)
    onClearError()
    try {
      const data = await api.previewEpub(path)
      onEpubLoaded({
        filePath: path,
        fileName: displayName ?? path.split(/[\\/]/).pop() ?? path,
        preview: data
      })
    } catch (err) {
      onEpubLoadFailed()
      setEpubErr(err instanceof Error ? err.message : String(err))
    } finally {
      setEpubLoading(false)
    }
  }

  async function pickEpub(): Promise<void> {
    setEpubErr(null)
    onClearError()
    if (window.api?.pickEpubFile) {
      try {
        const res = await window.api.pickEpubFile()
        if (res.canceled || !res.filePath) return
        await loadEpubPreview(res.filePath)
      } catch (err) {
        setEpubErr(err instanceof Error ? err.message : String(err))
      }
      return
    }
    fileInputRef.current?.click()
  }

  async function onBrowserFileSelected(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setEpubLoading(true)
    setEpubErr(null)
    try {
      const uploaded = await api.uploadEpub(file)
      await loadEpubPreview(uploaded.file_path, uploaded.filename)
    } catch (err) {
      setEpubErr(err instanceof Error ? err.message : String(err))
      setEpubLoading(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="epub-pick-btn">Arquivo .epub do computador</Label>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            id="epub-pick-btn"
            ref={pickBtnRef}
            type="button"
            variant="outline"
            onClick={() => void pickEpub()}
            disabled={epubLoading}
            aria-describedby="epub-pick-help"
          >
            {epubLoading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <FileText className="size-4" />
            )}
            {epubFileName ? 'Trocar arquivo .epub…' : 'Escolher arquivo .epub…'}
          </Button>
          <span
            className="font-sans min-w-0 flex-1 truncate text-[13px] text-[var(--ink-700)]"
            aria-live="polite"
          >
            {epubFileName || 'Nenhum arquivo selecionado'}
          </span>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub,application/epub+zip"
          onChange={(e) => void onBrowserFileSelected(e)}
          className="sr-only"
          tabIndex={-1}
        />
        <p id="epub-pick-help" className="font-sans text-[11px] text-[var(--ink-400)]">
          Lê os capítulos e a capa direto do EPUB local — sem scraping nem rede.
        </p>
        {epubErr && (
          <p className="font-sans text-[12px] text-[var(--ink-stamp)]" role="status">
            {epubErr}
          </p>
        )}
      </div>

      {epubPreview && (
        <div className="space-y-3 rounded-xl border border-[var(--border-soft)] bg-[var(--paper-50)] p-3.5">
          <div className="flex gap-4">
            {epubPreview.cover_data_url ? (
              <img
                src={epubPreview.cover_data_url}
                alt={epubPreview.title}
                className="h-24 w-16 shrink-0 rounded object-cover shadow-sm"
              />
            ) : (
              <div className="flex h-24 w-16 shrink-0 items-center justify-center rounded bg-[var(--paper-300)] text-[var(--ink-400)]">
                <FileText className="size-6" />
              </div>
            )}
            <div className="min-w-0 flex-1 space-y-1">
              <div className="font-display truncate text-[16px] font-medium tracking-tight">
                {epubPreview.title}
              </div>
              <div className="font-sans text-[12px] text-[var(--ink-500)]">
                {epubPreview.author ?? 'autor desconhecido'} ·{' '}
                <strong>{epubPreview.total_chapters}</strong> caps ·{' '}
                {Math.round(epubPreview.total_chars / 1000)}k caracteres
                {epubPreview.language ? ` · ${epubPreview.language}` : ''}
              </div>
              {epubPreview.matched_novel_id && (
                <div className="font-sans text-[11px] text-[var(--book-3)]">
                  ✓ Obra correspondente encontrada: “{epubPreview.matched_novel_title}” (glossário
                  compartilhado)
                </div>
              )}
            </div>
          </div>
          <details className="pt-1">
            <summary className="font-sans cursor-pointer text-[12px] text-[var(--ink-500)] hover:text-[var(--stamp-red)]">
              Ver capítulos detectados ({epubPreview.chapters.length})
            </summary>
            <ul className="mt-2 max-h-44 space-y-1 overflow-y-auto border-t border-[var(--border-soft)] pt-2">
              {epubPreview.chapters.map((c) => (
                <li
                  key={c.index}
                  className="font-sans flex items-center justify-between gap-2 text-[12px] text-[var(--ink-700)]"
                >
                  <span className="truncate">
                    <span className="folio mr-2 text-[var(--ink-400)]">#{c.index}</span>
                    {c.title}
                  </span>
                  <span className="font-mono shrink-0 text-[11px] text-[var(--ink-400)]">
                    {Math.round(c.char_count / 1000)}k
                  </span>
                </li>
              ))}
            </ul>
          </details>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="epub-series-select">Série / Obra (glossário compartilhado)</Label>
        <select
          id="epub-series-select"
          value={selectedNovelId}
          onChange={(e) => {
            const v = e.target.value
            onSelectNovel(v === 'new' ? 'new' : Number(v))
          }}
          aria-describedby="epub-series-help"
          className={[
            'font-sans h-10 w-full rounded-xl border bg-[var(--paper-50)] px-4 text-sm',
            'border-[var(--border-medium)] text-[var(--ink-900)]',
            'shadow-[inset_0_1px_2px_rgba(80,50,20,0.05)]',
            'outline-none focus-visible:border-[var(--stamp-red)] focus-visible:ring-2 focus-visible:ring-[var(--stamp-red)]/15'
          ].join(' ')}
        >
          <option value="new">+ Nova obra na Biblioteca</option>
          {epubNovels.map((n) => (
            <option key={n.id} value={n.id}>
              {n.title} ({n.chapters} caps em cache)
            </option>
          ))}
        </select>
        <p id="epub-series-help" className="font-sans text-[11px] text-[var(--ink-400)]">
          Volumes da mesma obra compartilham o mesmo glossário de personagens e estilo.
        </p>
      </div>

      {selectedNovelId === 'new' && (
        <div className="space-y-2">
          <Label htmlFor="epub-series-title">Nome da série / obra</Label>
          <Input
            id="epub-series-title"
            placeholder="ex: Your Forma"
            value={seriesTitle}
            onChange={(e) => onSeriesTitleChange(e.target.value)}
          />
        </div>
      )}
    </div>
  )
}
