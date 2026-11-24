import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BookUp,
  CircleAlert,
  CircleCheck,
  Download,
  Globe,
  ImageIcon,
  Languages,
  Loader2,
  Sparkles
} from 'lucide-react'
import { api, type EpubPreview, type JobStatus } from '@renderer/lib/api'
import { useJobs } from '@renderer/context/JobsContext'
import { jobProgressPct } from '@renderer/lib/jobsMerge'
import { COVER_STYLES } from '@renderer/lib/coverStyles'
import { CoverStyleMixer } from '@renderer/components/CoverStyleMixer'
import { EpubSourceSection } from '@renderer/components/capture/EpubSourceSection'
import { UrlSourceSection } from '@renderer/components/capture/UrlSourceSection'
import { matchHost, PT_NATIVE_HOSTS } from '@renderer/lib/novel'
import { Button } from '@renderer/components/ui/button'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'
import { Checkbox } from '@renderer/components/ui/checkbox'
import { Progress } from '@renderer/components/ui/progress'
import { Card } from '@renderer/components/ui/card'
import { Folio } from '@renderer/components/decorative/Folio'

function statusLabel(job: JobStatus): string {
  switch (job.status) {
    case 'queued':
      return 'Na fila...'
    case 'running':
      if (job.stage === 'meta') return 'Buscando lista de capítulos...'
      if (job.stage === 'translate') return 'Traduzindo capítulos'
      if (job.stage === 'cover') return 'Gerando capa com IA'
      return 'Baixando capítulos'
    case 'done':
      return 'Concluído'
    case 'error':
      return `Erro: ${job.error ?? 'desconhecido'}`
    case 'cancelled':
      return 'Cancelado'
    case 'interrupted':
      return 'Interrompido'
  }
}

// "1, 3, 5" → [1,3,5] (ignora lixo, dedup). Vazio → [].
function parseSkip(s: string): number[] {
  return [
    ...new Set(
      s
        .split(/[\s,]+/)
        .map((x) => parseInt(x, 10))
        .filter((n) => Number.isFinite(n))
    )
  ]
}

export function NewCapture({
  prefilledUrl,
  prefilledCoverStyle,
  prefilledNovelId
}: {
  prefilledUrl?: string | null
  prefilledCoverStyle?: string | null
  prefilledNovelId?: number | null
} = {}): React.JSX.Element {
  const [sourceMode, setSourceMode] = useState<'url' | 'epub'>(() =>
    prefilledNovelId ? 'epub' : 'url'
  )
  const [url, setUrl] = useState(() => prefilledUrl ?? '')
  const [volumeTitle, setVolumeTitle] = useState('')
  const [start, setStart] = useState('1')
  const [end, setEnd] = useState('')
  // Capítulos a ignorar (ex: "1" pula o cap-lixo inicial tipo "Chapter -1/0").
  const [skipChapters, setSkipChapters] = useState('')
  const [withCover, setWithCover] = useState(true)
  const [translate, setTranslate] = useState(false)
  const [aiCover, setAiCover] = useState(() => !!prefilledCoverStyle)
  // Recaptura mantendo a capa: reusa a capa já gerada do volume (sem gerar nada).
  // Mutuamente exclusivo com "Gerar capa com IA".
  const [preserveCover, setPreserveCover] = useState(false)
  // Estilo de arte da capa ('' = automático/IA decide). Pré-preenchido pelo
  // default salvo da novel quando o preview roda.
  const [coverStyle, setCoverStyle] = useState(() => prefilledCoverStyle ?? '')
  // Estilos habilitados nas Configurações (curadoria do usuário).
  const [enabledStyles, setEnabledStyles] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const { jobs } = useJobs()

  // Estado do modo EPUB local (mantido no pai pra não perder seleção ao trocar de aba)
  const [epubFilePath, setEpubFilePath] = useState('')
  const [epubFileName, setEpubFileName] = useState('')
  const [epubPreview, setEpubPreview] = useState<EpubPreview | null>(null)
  const [selectedNovelId, setSelectedNovelId] = useState<number | 'new'>(
    () => prefilledNovelId ?? 'new'
  )
  const [seriesTitle, setSeriesTitle] = useState('')
  const epubPickBtnRef = useRef<HTMLButtonElement | null>(null)

  // Carrega a curadoria de estilos das Configurações (uma vez).
  useEffect(() => {
    api
      .getSettings()
      .then((s) => setEnabledStyles(s.cover_styles_enabled ?? []))
      .catch(() => {})
  }, [])

  // Opções do seletor: estilos habilitados (ou todos os 24 se nenhum curado, pra
  // sempre ser usável). Garante que o default salvo apareça mesmo fora da curadoria.
  const styleOptions = useMemo(() => {
    const base = enabledStyles.length
      ? COVER_STYLES.filter((s) => enabledStyles.includes(s.id))
      : COVER_STYLES
    if (coverStyle && !base.some((s) => s.id === coverStyle)) {
      const extra = COVER_STYLES.filter((s) => s.id === coverStyle)
      return [...extra, ...base]
    }
    return base
  }, [enabledStyles, coverStyle])

  const job = jobId ? jobs[jobId] : undefined
  const pct = job ? jobProgressPct(job) : 0

  const sourceIsPtNative = useMemo(() => matchHost(url, PT_NATIVE_HOSTS), [url])
  const epubIsPtNative =
    sourceMode === 'epub' && !!epubPreview?.language?.toLowerCase().startsWith('pt')
  const effectivePtNative = sourceMode === 'url' ? sourceIsPtNative : epubIsPtNative
  const effectiveTranslate = effectivePtNative ? false : translate

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault()
    setError(null)
    if (sourceMode === 'epub' && !epubFilePath) {
      setError('Selecione um arquivo .epub antes de iniciar.')
      epubPickBtnRef.current?.focus()
      return
    }
    setSubmitting(true)
    try {
      const res =
        sourceMode === 'epub'
          ? await api.importEpub({
              file_path: epubFilePath,
              novel_id: selectedNovelId === 'new' ? null : selectedNovelId,
              series_title: selectedNovelId === 'new' ? seriesTitle.trim() || null : null,
              volume_title: volumeTitle.trim() || null,
              start: Number(start) || 1,
              end: end ? Number(end) : null,
              skip_chapters: parseSkip(skipChapters),
              with_cover: withCover,
              translate_to: effectiveTranslate ? 'pt-BR' : null,
              ai_cover: aiCover,
              cover_style: aiCover ? coverStyle || null : null
            })
          : await api.createDownload({
              url: url.trim(),
              start: Number(start) || 1,
              end: end ? Number(end) : null,
              with_cover: withCover,
              translate_to: effectiveTranslate ? 'pt-BR' : null,
              volume_title: volumeTitle.trim() || null,
              ai_cover: aiCover,
              cover_style: aiCover ? coverStyle || null : null,
              skip_chapters: parseSkip(skipChapters),
              preserve_cover: preserveCover
            })
      setJobId(res.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Folio n="i" />
        <h2 className="font-display text-[2.5rem] leading-none font-medium tracking-tight">
          Nova captura
        </h2>
        <p className="font-sans max-w-md text-[15px] leading-relaxed text-[var(--ink-500)]">
          Cole a URL de uma novel ou importe um <code className="font-mono text-[13px]">.epub</code>{' '}
          local, escolha os capítulos, e deixe a alquimia transformar em{' '}
          <em className="font-display italic text-[var(--ink-700)]">livro de verdade</em>.
        </p>
      </header>

      <Card>
        <form onSubmit={onSubmit} className="space-y-5">
          <fieldset className="space-y-2">
            <legend className="font-sans text-[11px] font-medium tracking-[0.18em] uppercase text-[var(--ink-500)]">
              Origem da obra
            </legend>
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border-soft)] bg-[var(--paper-50)] p-1">
              {(
                [
                  { value: 'url', label: 'URL da web', icon: Globe },
                  { value: 'epub', label: 'Arquivo .epub local', icon: BookUp }
                ] as const
              ).map(({ value, label, icon: Icon }) => {
                const active = sourceMode === value
                return (
                  <label
                    key={value}
                    className={[
                      'font-sans flex cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] transition-all',
                      'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-[var(--stamp-red)]/35',
                      active
                        ? 'bg-[var(--paper-200)] font-semibold text-[var(--ink-900)] shadow-xs'
                        : 'text-[var(--ink-500)] hover:text-[var(--ink-800)]'
                    ].join(' ')}
                  >
                    <input
                      type="radio"
                      name="capture-source"
                      value={value}
                      checked={active}
                      onChange={() => {
                        setSourceMode(value)
                        setError(null)
                        if (value === 'epub') setPreserveCover(false)
                      }}
                      className="sr-only"
                    />
                    <Icon className="size-4" />
                    {label}
                  </label>
                )
              })}
            </div>
          </fieldset>

          {sourceMode === 'url' ? (
            <UrlSourceSection
              url={url}
              onUrlChange={(next) => {
                setUrl(next)
                setCoverStyle('') // edição manual da URL descarta estilo pré-selecionado
              }}
              onSelectVolume={(v) => {
                setStart(v.start)
                setEnd(v.end)
                setVolumeTitle(v.volumeTitle)
              }}
              onDefaultCoverStyle={(style) => {
                setCoverStyle(style)
                setAiCover(true)
              }}
            />
          ) : (
            <EpubSourceSection
              pickBtnRef={epubPickBtnRef}
              epubFileName={epubFileName}
              epubPreview={epubPreview}
              selectedNovelId={selectedNovelId}
              onSelectNovel={setSelectedNovelId}
              seriesTitle={seriesTitle}
              onSeriesTitleChange={setSeriesTitle}
              onClearError={() => setError(null)}
              onEpubLoadFailed={() => {
                setEpubPreview(null)
                setEpubFilePath('')
              }}
              onEpubLoaded={({ filePath, fileName, preview }) => {
                setEpubFilePath(filePath)
                setEpubFileName(fileName)
                setEpubPreview(preview)
                setVolumeTitle(preview.title)
                setSeriesTitle(preview.series_name)
                setStart('1')
                setEnd('')
                setSkipChapters('')
                if (!prefilledNovelId) {
                  setSelectedNovelId(preview.matched_novel_id ?? 'new')
                }
                if (!preview.language?.toLowerCase().startsWith('pt')) {
                  setTranslate(true)
                }
              }}
            />
          )}

          <div className="space-y-2">
            <Label htmlFor="volume-title">
              Título do volume
              <span className="font-sans ml-1 text-[10px] tracking-[0.18em] text-[var(--ink-400)]">
                opcional
              </span>
            </Label>
            <Input
              id="volume-title"
              placeholder="ex: Volume 1 — O Sistema Vampírico"
              value={volumeTitle}
              onChange={(e) => setVolumeTitle(e.target.value)}
            />
            <p className="font-sans text-[11px] leading-relaxed text-[var(--ink-400)]">
              Se preenchido, vira o título do EPUB e o nome do arquivo. A novel original fica como
              série (Kindle agrupa).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="start">Início</Label>
              <Input
                id="start"
                type="number"
                min={1}
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="end">Fim</Label>
              <Input
                id="end"
                type="number"
                min={1}
                placeholder="até o último"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="skip">
              Ignorar capítulos
              <span className="font-sans ml-1 text-[10px] tracking-[0.18em] text-[var(--ink-400)]">
                opcional
              </span>
            </Label>
            <Input
              id="skip"
              placeholder="ex: 1  (pula entradas-lixo tipo 'Chapter -1/0')"
              value={skipChapters}
              onChange={(e) => setSkipChapters(e.target.value)}
            />
            <p className="font-sans text-[11px] leading-relaxed text-[var(--ink-400)]">
              Índices (posição na lista) separados por vírgula. Ex: pegar 1–41 e ignorar{' '}
              <code className="font-mono">1</code> → sai com 40 capítulos, sem o primeiro.
            </p>
          </div>

          <div className="space-y-3 border-t border-[var(--border-soft)] pt-5">
            <label className="font-sans flex cursor-pointer items-center gap-3 text-[14px] text-[var(--ink-700)]">
              <Checkbox checked={withCover} onCheckedChange={(v) => setWithCover(v === true)} />
              Incluir capa
            </label>
            <label
              className={[
                'font-sans flex items-start gap-3 text-[14px]',
                effectivePtNative
                  ? 'cursor-not-allowed text-[var(--ink-400)]'
                  : 'cursor-pointer text-[var(--ink-700)]'
              ].join(' ')}
            >
              <Checkbox
                className="mt-0.5"
                checked={effectiveTranslate}
                disabled={effectivePtNative}
                onCheckedChange={(v) => setTranslate(v === true)}
              />
              <div className="flex flex-col">
                <span className="inline-flex items-center gap-1.5">
                  <Languages className="size-4 text-[var(--stamp-red)]" />
                  Traduzir para PT-BR <span className="text-[var(--ink-400)]">(cascade IA)</span>
                </span>
                {effectivePtNative && (
                  <span className="font-sans text-[11px] leading-relaxed text-[var(--book-3)]">
                    ✓ Fonte já está em português — tradução desnecessária (R$ 0).
                  </span>
                )}
              </div>
            </label>
            <label className="font-sans flex cursor-pointer items-start gap-3 text-[14px] text-[var(--ink-700)]">
              <Checkbox
                className="mt-0.5"
                checked={aiCover}
                onCheckedChange={(v) => {
                  setAiCover(v === true)
                  if (v === true) setPreserveCover(false) // exclusivos
                }}
              />
              <div className="flex flex-col">
                <span className="inline-flex items-center gap-1.5">
                  <Sparkles className="size-4 text-[var(--book-5)]" />
                  Gerar capa com IA <span className="text-[var(--ink-400)]">(Gemini Image)</span>
                </span>
                <span className="font-sans text-[11px] leading-relaxed text-[var(--ink-400)]">
                  Lê o glossário + amostras dos capítulos pra criar uma capa que reflete o arco do
                  volume.
                </span>
              </div>
            </label>

            {/* Manter capa atual — pra recapturar capítulos da web sem mexer na capa já gerada. */}
            {sourceMode === 'url' && (
              <label className="font-sans flex cursor-pointer items-start gap-3 text-[14px] text-[var(--ink-700)]">
                <Checkbox
                  className="mt-0.5"
                  checked={preserveCover}
                  onCheckedChange={(v) => {
                    setPreserveCover(v === true)
                    if (v === true) setAiCover(false) // exclusivos
                  }}
                />
                <div className="flex flex-col">
                  <span className="inline-flex items-center gap-1.5">
                    <ImageIcon className="size-4 text-[var(--book-3)]" />
                    Manter capa atual <span className="text-[var(--ink-400)]">(recaptura)</span>
                  </span>
                  <span className="font-sans text-[11px] leading-relaxed text-[var(--ink-400)]">
                    Reusa a capa já gerada deste volume — não regenera nada (R$ 0). Use pra
                    recapturar capítulos sem alterar a capa.
                  </span>
                </div>
              </label>
            )}

            {/* Mistura de estilos de arte — só faz sentido com capa IA ligada. */}
            {aiCover && (
              <div className="space-y-1.5 pl-7">
                <Label htmlFor="cover-style">Estilo de arte (mistura com pesos)</Label>
                <CoverStyleMixer
                  value={coverStyle}
                  onChange={setCoverStyle}
                  options={styleOptions}
                />
                <p className="font-sans text-[11px] leading-relaxed text-[var(--ink-400)]">
                  Fica salvo como estilo padrão desta novel — vem pré-selecionado na próxima
                  captura. Cure a lista em Configurações.
                </p>
              </div>
            )}
          </div>

          {error && (
            <p
              className="font-sans flex items-center gap-2 text-sm text-[var(--ink-stamp)]"
              role="status"
            >
              <CircleAlert className="size-4" />
              {error}
            </p>
          )}

          <Button
            type="submit"
            variant="rainbow"
            size="lg"
            disabled={submitting || (sourceMode === 'url' && !url.trim())}
            className="w-full"
          >
            {submitting ? (
              <>
                <Loader2 className="size-5 animate-spin" />
                Enviando...
              </>
            ) : (
              <>
                <Download className="size-5" />
                {sourceMode === 'epub' ? 'Importar e traduzir EPUB' : 'Baixar e gerar EPUB'}
              </>
            )}
          </Button>
        </form>
      </Card>

      {job && (
        <Card>
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h3 className="font-display flex items-center gap-2 text-lg font-medium">
                {job.status === 'done' && <CircleCheck className="size-5 text-[var(--book-3)]" />}
                {job.status === 'error' && (
                  <CircleAlert className="size-5 text-[var(--ink-stamp)]" />
                )}
                {job.title ?? 'Processando...'}
              </h3>
              <p className="font-sans text-sm text-[var(--ink-500)]">{statusLabel(job)}</p>
            </div>
            <span className="font-display text-2xl italic text-[var(--ink-400)]">
              {pct}
              <span className="text-base">%</span>
            </span>
          </div>
          <Progress value={pct} rainbow />
          <div className="font-sans flex items-center justify-between text-[12px] text-[var(--ink-500)]">
            <span className="truncate">{job.current ?? '—'}</span>
            <span className="folio shrink-0 pl-3 text-[var(--ink-400)]">
              {job.done}/{job.total || '?'}
            </span>
          </div>
        </Card>
      )}
    </div>
  )
}
