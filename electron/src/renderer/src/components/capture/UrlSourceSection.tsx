import { useEffect, useMemo, useRef, useState } from 'react'
import { Eye, Globe, Loader2 } from 'lucide-react'
import { api, resolveMediaUrl, type NovelPreview, type SiteInfo } from '@renderer/lib/api'
import { matchHost, PT_NATIVE_HOSTS } from '@renderer/lib/novel'
import { Input } from '@renderer/components/ui/input'
import { Label } from '@renderer/components/ui/label'

// Sites que estruturam volumes nativamente. Pro resto, o preview é opcional sob pedido.
const HOSTS_WITH_VOLUMES = ['novelmania.com.br']

interface UrlSourceSectionProps {
  url: string
  onUrlChange: (url: string) => void
  onSelectVolume: (volume: { start: string; end: string; volumeTitle: string }) => void
  onDefaultCoverStyle: (style: string) => void
}

export function UrlSourceSection({
  url,
  onUrlChange,
  onSelectVolume,
  onDefaultCoverStyle
}: UrlSourceSectionProps): React.JSX.Element {
  // Sites suportados (vem do backend /api/sites — registry de adapters).
  const [sites, setSites] = useState<SiteInfo[]>([])
  const [preview, setPreview] = useState<NovelPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [selectedVolumeIdx, setSelectedVolumeIdx] = useState<number | -1>(-1)
  // Token de cancelamento da request mais recente — evita race condition se o user
  // edita a URL enquanto uma chamada (auto ou manual) ainda está no ar.
  const previewReqRef = useRef(0)

  const sourceHasVolumes = useMemo(() => matchHost(url, HOSTS_WITH_VOLUMES), [url])

  // Lista de sites suportados (uma vez). Self-maintaining: novo adapter no
  // backend aparece aqui automaticamente.
  useEffect(() => {
    api
      .sites()
      .then(setSites)
      .catch(() => {})
  }, [])

  async function runPreview(rawUrl: string): Promise<void> {
    const trimmed = rawUrl.trim()
    if (!trimmed || !trimmed.startsWith('http')) return
    const token = ++previewReqRef.current
    setPreviewLoading(true)
    setPreviewErr(null)
    try {
      const data = await api.previewNovel(trimmed)
      if (token === previewReqRef.current) {
        setPreview(data)
        // Pré-seleciona o estilo default salvo desta novel (se houver e o user
        // ainda não escolheu manualmente). Liga a capa IA pra deixar visível.
        if (data.default_cover_style) {
          onDefaultCoverStyle(data.default_cover_style)
        }
      }
    } catch (err) {
      if (token === previewReqRef.current) {
        setPreviewErr(err instanceof Error ? err.message : String(err))
      }
    } finally {
      if (token === previewReqRef.current) setPreviewLoading(false)
    }
  }

  // Dispara auto-preview (debounced) SÓ se o host suporta volumes.
  // O ++previewReqRef invalida requests in-flight de URLs antigas.
  useEffect(() => {
    previewReqRef.current++
    if (!sourceHasVolumes) return
    const trimmed = url.trim()
    if (!trimmed || !trimmed.startsWith('http')) return
    const t = setTimeout(() => {
      void runPreview(trimmed)
    }, 800)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, sourceHasVolumes])

  // Quando user seleciona um volume, auto-preenche start/end/volume_title
  function selectVolume(idx: number): void {
    setSelectedVolumeIdx(idx)
    if (idx === -1 || !preview) return
    const v = preview.volumes[idx]
    onSelectVolume({
      start: String(v.start),
      end: String(v.end),
      volumeTitle: v.name
    })
  }

  return (
    <div className="space-y-2">
      <Label htmlFor="url">URL da novel</Label>
      <Input
        id="url"
        name="url"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        placeholder="https://novelfull.net/... ou https://novelmania.com.br/novels/..."
        value={url}
        onChange={(e) => {
          onUrlChange(e.target.value)
          setPreview(null)
          setPreviewErr(null)
          setSelectedVolumeIdx(-1)
        }}
        required
      />
      {sites.length > 0 && (
        <details className="group pt-1">
          <summary className="font-sans inline-flex cursor-pointer list-none items-center gap-1.5 text-[12px] text-[var(--ink-500)] transition-colors hover:text-[var(--stamp-red)]">
            <Globe className="size-3.5" />
            Sites suportados ({sites.length})
            <span className="text-[var(--ink-400)] transition-transform group-open:rotate-90">
              ›
            </span>
          </summary>
          <ul className="mt-2 space-y-2 border-l-2 border-[var(--border-soft)] pl-3">
            {sites.map((site) => {
              const isPtNative = site.domains.some((d) => PT_NATIVE_HOSTS.includes(d))
              return (
                <li key={site.name} className="space-y-1">
                  <div className="font-sans flex items-center gap-2 text-[13px] text-[var(--ink-700)]">
                    <span className="font-medium capitalize">{site.name}</span>
                    {isPtNative && (
                      <span className="rounded bg-[var(--paper-200)] px-1.5 py-0.5 text-[9px] font-medium tracking-wide text-[var(--ink-600)] uppercase">
                        PT-BR nativo
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {site.domains.map((d) => (
                      <code
                        key={d}
                        className="font-mono rounded bg-[var(--paper-100)] px-1.5 py-0.5 text-[11px] text-[var(--ink-600)]"
                      >
                        {d}
                      </code>
                    ))}
                  </div>
                </li>
              )
            })}
          </ul>
          <p className="font-sans mt-2 text-[11px] text-[var(--ink-400)]">
            Cole a URL de uma novel de qualquer um desses sites.
          </p>
        </details>
      )}
      {previewLoading && (
        <div className="font-sans flex items-center gap-2 pt-1 text-[12px] text-[var(--ink-500)]">
          <Loader2 className="size-3.5 animate-spin" /> Lendo página da novel…
        </div>
      )}
      {/* Sites sem volumes nativos: nao disparamos preview automatico
          (poupa um request lento que so renderiza titulo/capa decorativos).
          Mostra um link opt-in pra quem quiser ver a previa. */}
      {!sourceHasVolumes && !preview && !previewLoading && url.trim().startsWith('http') && (
        <button
          type="button"
          onClick={() => void runPreview(url)}
          className="font-sans inline-flex items-center gap-1.5 pt-1 text-[12px] text-[var(--ink-500)] underline decoration-[var(--ink-300)] underline-offset-4 transition-colors hover:text-[var(--stamp-red)] hover:decoration-[var(--stamp-red)]"
        >
          <Eye className="size-3.5" /> Pré-visualizar (opcional)
        </button>
      )}
      {previewErr && (
        <div className="font-sans pt-1 text-[12px] text-[var(--ink-stamp)]" role="status">
          {previewErr}
        </div>
      )}
      {preview && (
        <div
          className={[
            'mt-3 flex gap-4 rounded-xl border bg-[var(--paper-50)] p-3',
            'border-[var(--border-soft)]'
          ].join(' ')}
        >
          {preview.cover_url ? (
            <img
              src={resolveMediaUrl(preview.cover_url) ?? undefined}
              alt=""
              className="size-16 shrink-0 rounded object-cover shadow-sm"
            />
          ) : (
            <div className="size-16 shrink-0 rounded bg-[var(--paper-300)]" />
          )}
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-display truncate text-[15px] font-medium tracking-tight">
              {preview.title}
            </div>
            <div className="font-sans text-[11px] tracking-wide text-[var(--ink-500)]">
              {preview.author ?? 'autor desconhecido'} · <strong>{preview.total_chapters}</strong>{' '}
              caps
              {preview.volumes.length > 0 && (
                <>
                  {' '}
                  · <strong>{preview.volumes.length}</strong> volumes detectados
                </>
              )}
            </div>
            {preview.volumes.length > 0 && (
              <div className="pt-1.5">
                <select
                  value={selectedVolumeIdx}
                  onChange={(e) => selectVolume(Number(e.target.value))}
                  className={[
                    'font-sans w-full rounded-md border bg-[var(--paper-100)] px-2 py-1.5 text-[12px]',
                    'border-[var(--border-soft)] focus:border-[var(--stamp-red)] focus:outline-none'
                  ].join(' ')}
                >
                  <option value={-1}>— Selecione um volume pra auto-preencher —</option>
                  {preview.volumes.map((v, i) => (
                    <option key={i} value={i}>
                      {v.name} (caps {v.start}–{v.end}, {v.chapter_count})
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
