import { useEffect, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, X } from 'lucide-react'
import { api, type GlossaryEntry, type NovelSummary } from '@renderer/lib/api'
import { cn } from '@renderer/lib/utils'
import { Folio } from '@renderer/components/decorative/Folio'
import { GlossaryCleanup } from '@renderer/components/glossary/GlossaryCleanup'

const KIND_META: Record<string, { label: string; color: string }> = {
  character: { label: 'personagem', color: 'var(--book-4)' },
  place: { label: 'lugar', color: 'var(--book-3)' },
  ability: { label: 'habilidade', color: 'var(--book-5)' },
  organization: { label: 'organização', color: 'var(--book-2)' },
  system_term: { label: 'sistema', color: 'var(--book-1)' },
  other: { label: 'outro', color: 'var(--ink-400)' }
}

const KIND_ORDER = ['character', 'place', 'ability', 'organization', 'system_term', 'other']

const CONFIDENCES = ['high', 'medium', 'low'] as const

function KindPill({ kind }: { kind: string }): React.JSX.Element {
  const meta = KIND_META[kind] ?? KIND_META.other
  return (
    <span
      className="font-sans inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-medium tracking-wide"
      style={{ color: meta.color, border: `1px solid ${meta.color}` }}
    >
      <span
        className="inline-block size-1.5 rounded-full"
        style={{ backgroundColor: meta.color }}
      />
      {meta.label}
    </span>
  )
}

function ConfBadge({ conf }: { conf: string }): React.JSX.Element {
  const color =
    conf === 'high' ? 'var(--book-3)' : conf === 'medium' ? 'var(--ink-400)' : 'var(--ink-stamp)'
  return (
    <span className="font-sans text-[10px] tracking-[0.18em] uppercase" style={{ color }}>
      {conf}
    </span>
  )
}

function FilterChip({
  active,
  onClick,
  children,
  color
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  color?: string
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'font-sans inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium tracking-wide transition-colors',
        active
          ? 'bg-[var(--paper-200)] text-[var(--ink-900)]'
          : 'bg-transparent text-[var(--ink-500)] hover:bg-[var(--paper-200)] hover:text-[var(--ink-700)]'
      )}
      style={{ borderColor: color ?? 'var(--border-medium)' }}
    >
      {color && (
        <span className="inline-block size-1.5 rounded-full" style={{ backgroundColor: color }} />
      )}
      {children}
    </button>
  )
}

export function Glossary({
  initialNovelId
}: {
  initialNovelId?: number | null
} = {}): React.JSX.Element {
  const [novels, setNovels] = useState<NovelSummary[] | null>(null)
  const [novelId, setNovelId] = useState<number | null>(initialNovelId ?? null)
  const [entries, setEntries] = useState<GlossaryEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Filtros
  const [search, setSearch] = useState('')
  const [activeKinds, setActiveKinds] = useState<Set<string>>(new Set())
  const [activeConfs, setActiveConfs] = useState<Set<string>>(new Set())
  const [selectedTerm, setSelectedTerm] = useState<string | null>(null)

  useEffect(() => {
    api
      .library()
      .then((list) => {
        setNovels(list)
        if (list.length > 0 && novelId === null) setNovelId(list[0].id)
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Incrementa pra re-buscar o glossário (ex.: depois da limpeza).
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    if (novelId == null) return
    let active = true
    api
      .getGlossary(novelId)
      .then((list) => active && setEntries(list))
      .catch((err) => active && setError(err instanceof Error ? err.message : String(err)))
    return () => {
      active = false
    }
  }, [novelId, reloadKey])

  const selected = novels?.find((n) => n.id === novelId)

  // Aplica filtros
  const filtered = useMemo(() => {
    if (!entries) return null
    const term = search.trim().toLowerCase()
    let out = entries
    if (term) {
      out = out.filter(
        (e) =>
          e.term.toLowerCase().includes(term) ||
          e.canonical_pt.toLowerCase().includes(term) ||
          (e.notes ?? '').toLowerCase().includes(term)
      )
    }
    if (activeKinds.size > 0) {
      out = out.filter((e) => activeKinds.has(e.kind))
    }
    if (activeConfs.size > 0) {
      out = out.filter((e) => activeConfs.has(e.confidence))
    }
    // ordena por kind (na ordem visual) + termo alfabetico
    const order: Record<string, number> = Object.fromEntries(KIND_ORDER.map((k, i) => [k, i]))
    return [...out].sort((a, b) => {
      const ka = order[a.kind] ?? 99
      const kb = order[b.kind] ?? 99
      if (ka !== kb) return ka - kb
      return a.term.localeCompare(b.term)
    })
  }, [entries, search, activeKinds, activeConfs])

  // Contagem por kind/conf — pros badges no filtro
  const kindCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const e of entries ?? []) m.set(e.kind, (m.get(e.kind) ?? 0) + 1)
    return m
  }, [entries])

  function toggleKind(k: string): void {
    setActiveKinds((prev) => {
      const next = new Set(prev)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next
    })
  }
  function toggleConf(c: string): void {
    setActiveConfs((prev) => {
      const next = new Set(prev)
      if (next.has(c)) next.delete(c)
      else next.add(c)
      return next
    })
  }
  function clearAllFilters(): void {
    setSearch('')
    setActiveKinds(new Set())
    setActiveConfs(new Set())
  }

  const hasFilters = !!search || activeKinds.size > 0 || activeConfs.size > 0

  const selectedIndex =
    filtered && selectedTerm ? filtered.findIndex((e) => e.term === selectedTerm) : -1
  const selectedEntry = selectedIndex >= 0 && filtered ? filtered[selectedIndex] : null

  return (
    <div className="space-y-8">
      <header className="space-y-3">
        <Folio n="iv" />
        <h2 className="font-display text-[2.5rem] leading-none font-medium tracking-tight">
          Glossário
        </h2>
        <p className="font-sans max-w-md text-[15px] leading-relaxed text-[var(--ink-500)]">
          Personagens, lugares, habilidades — aprendidos pela tradutora a cada capítulo. Travados
          aqui pra consistência através de toda a obra.
        </p>
      </header>

      {novels && novels.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            {selected && (
              <h3 className="font-display text-2xl font-medium tracking-tight">{selected.title}</h3>
            )}
            <p className="font-sans text-[12px] tracking-[0.16em] uppercase text-[var(--ink-400)]">
              {entries?.length ?? '—'} entrada{(entries?.length ?? 0) === 1 ? '' : 's'} ·{' '}
              {selected?.chapters ?? 0} caps
            </p>
          </div>
          <select
            value={novelId ?? ''}
            onChange={(e) => {
              setEntries(null)
              setSelectedTerm(null)
              setNovelId(Number(e.target.value))
            }}
            className="font-sans h-10 rounded-xl border border-[var(--border-medium)] bg-[var(--paper-100)] px-4 text-sm text-[var(--ink-900)] shadow-[inset_0_1px_2px_rgba(80,50,20,0.05)] outline-none focus-visible:border-[var(--stamp-red)] focus-visible:ring-2 focus-visible:ring-[var(--stamp-red)]/15"
          >
            {novels.map((n) => (
              <option key={n.id} value={n.id}>
                {n.title}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* So depende da novel (nao de `entries`): durante o reload pos-limpeza
          entries vira null e o componente desmontaria, perdendo a mensagem. */}
      {novelId != null && (
        <GlossaryCleanup
          key={novelId}
          novelId={novelId}
          onApplied={() => {
            setEntries(null)
            setReloadKey((k) => k + 1)
          }}
        />
      )}

      {error && <p className="font-sans text-sm text-[var(--ink-stamp)]">{error}</p>}

      {/* Filtros */}
      {entries && entries.length > 0 && (
        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-[var(--ink-400)]" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar termo, tradução ou notas…"
              className="font-sans h-10 w-full rounded-xl border border-[var(--border-medium)] bg-[var(--paper-50)] pl-10 pr-10 text-sm text-[var(--ink-900)] placeholder:text-[var(--ink-300)] shadow-[inset_0_1px_2px_rgba(80,50,20,0.05)] outline-none focus-visible:border-[var(--stamp-red)] focus-visible:bg-[var(--paper-100)] focus-visible:ring-2 focus-visible:ring-[var(--stamp-red)]/15"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute top-1/2 right-3 -translate-y-1/2 rounded-full p-0.5 text-[var(--ink-400)] hover:bg-[var(--paper-200)] hover:text-[var(--ink-700)]"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-[10px] tracking-[0.18em] uppercase text-[var(--ink-400)]">
              tipo:
            </span>
            {KIND_ORDER.filter((k) => (kindCounts.get(k) ?? 0) > 0).map((k) => {
              const meta = KIND_META[k]
              return (
                <FilterChip
                  key={k}
                  active={activeKinds.has(k)}
                  onClick={() => toggleKind(k)}
                  color={meta.color}
                >
                  {meta.label} <span className="opacity-50">· {kindCounts.get(k)}</span>
                </FilterChip>
              )
            })}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-[10px] tracking-[0.18em] uppercase text-[var(--ink-400)]">
              confiança:
            </span>
            {CONFIDENCES.map((c) => (
              <FilterChip key={c} active={activeConfs.has(c)} onClick={() => toggleConf(c)}>
                {c}
              </FilterChip>
            ))}
            {hasFilters && (
              <button
                type="button"
                onClick={clearAllFilters}
                className="font-sans ml-auto text-[11px] tracking-wide text-[var(--stamp-red)] hover:underline"
              >
                limpar filtros
              </button>
            )}
          </div>
        </div>
      )}

      {novels && novels.length === 0 && (
        <div className="py-16 text-center">
          <p className="font-display text-xl italic text-[var(--ink-400)]">
            Nenhuma novel em cache.
          </p>
        </div>
      )}

      {entries && entries.length === 0 && (
        <div className="py-16 text-center">
          <p className="font-display text-xl italic text-[var(--ink-400)]">Glossário vazio.</p>
          <p className="font-sans mt-2 text-sm text-[var(--ink-500)]">
            Será preenchido conforme você traduz capítulos.
          </p>
        </div>
      )}

      {filtered && entries && entries.length > 0 && filtered.length === 0 && (
        <div className="py-16 text-center">
          <p className="font-display text-xl italic text-[var(--ink-400)]">
            Nenhuma entrada combina com os filtros.
          </p>
          <button
            type="button"
            onClick={clearAllFilters}
            className="font-sans mt-3 text-sm text-[var(--stamp-red)] hover:underline"
          >
            limpar filtros
          </button>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <>
          <div
            className={[
              'overflow-hidden rounded-2xl border bg-[var(--paper-100)]',
              'border-[var(--border-soft)]',
              'shadow-[0_1px_0_rgba(255,250,235,0.85)_inset,0_1px_3px_rgba(80,50,20,0.05),0_14px_28px_-18px_rgba(80,50,20,0.20)]'
            ].join(' ')}
          >
            <div
              className="overflow-x-auto focus:outline-none"
              tabIndex={0}
              role="region"
              aria-label="Tabela do glossário"
            >
              <table className="w-full">
                <thead>
                  <tr className="border-b border-[var(--border-soft)]">
                    <th
                      scope="col"
                      className="font-sans px-6 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Termo
                    </th>
                    <th
                      scope="col"
                      className="font-sans px-3 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Canônico
                    </th>
                    <th
                      scope="col"
                      className="font-sans px-3 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Tipo
                    </th>
                    <th
                      scope="col"
                      className="font-sans px-3 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Gênero
                    </th>
                    <th
                      scope="col"
                      className="font-sans px-3 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Conf
                    </th>
                    <th
                      scope="col"
                      className="font-sans px-6 py-3 text-left text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]"
                    >
                      Notas
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((e, i) => (
                    <GlossaryRow
                      key={e.term}
                      entry={e}
                      striped={i % 2 === 1}
                      onOpen={() => setSelectedTerm(e.term)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="font-sans text-right text-[11px] tracking-wide text-[var(--ink-400)]">
            mostrando {filtered.length} de {entries?.length ?? 0} entradas
            {hasFilters && ' (filtrado)'} · clique em qualquer linha para ler a nota completa
          </p>
        </>
      )}

      {selectedEntry && filtered && (
        <GlossaryDetailModal
          entry={selectedEntry}
          index={selectedIndex}
          total={filtered.length}
          onClose={() => setSelectedTerm(null)}
          onNavigate={(nextIdx) => {
            const target = filtered[nextIdx]
            if (target) setSelectedTerm(target.term)
          }}
        />
      )}
    </div>
  )
}

function GlossaryRow({
  entry,
  striped,
  onOpen
}: {
  entry: GlossaryEntry
  striped: boolean
  onOpen: () => void
}): React.JSX.Element {
  return (
    <tr
      onClick={onOpen}
      className={cn(
        'cursor-pointer border-b border-[var(--border-soft)] align-top transition-colors last:border-b-0 hover:bg-[var(--paper-200)]/60',
        striped && 'bg-[var(--paper-50)]/40'
      )}
    >
      <th
        scope="row"
        className="font-display px-6 py-3 text-left text-[15px] font-medium text-[var(--ink-900)]"
      >
        {entry.term}
      </th>
      <td className="font-sans px-3 py-3 text-[13px] italic text-[var(--ink-500)]">
        {entry.canonical_pt}
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <KindPill kind={entry.kind} />
      </td>
      <td className="font-sans whitespace-nowrap px-3 py-3 text-[12px] text-[var(--ink-700)]">
        {entry.gender === 'n/a' || entry.gender === 'unknown' ? (
          <span className="text-[var(--ink-300)]">—</span>
        ) : (
          entry.gender
        )}
      </td>
      <td className="whitespace-nowrap px-3 py-3">
        <ConfBadge conf={entry.confidence} />
        {entry.source === 'wiki' && (
          <span className="font-sans ml-1 text-[9px] tracking-[0.18em] uppercase text-[var(--book-4)]">
            · wiki
          </span>
        )}
      </td>
      <td className="font-sans px-6 py-3 text-[12px] leading-relaxed text-[var(--ink-500)]">
        {entry.notes ? (
          <>
            <span className="line-clamp-2 max-w-md italic">{entry.notes}</span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation()
                onOpen()
              }}
              className="mt-1 text-[11px] font-medium text-[var(--ink-700)] underline decoration-dotted hover:text-[var(--ink-900)]"
            >
              abrir nota
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onOpen()
            }}
            className="text-[11px] text-[var(--ink-400)] hover:text-[var(--ink-700)] hover:underline"
          >
            detalhes
          </button>
        )}
      </td>
    </tr>
  )
}

function GlossaryDetailModal({
  entry,
  index,
  total,
  onClose,
  onNavigate
}: {
  entry: GlossaryEntry
  index: number
  total: number
  onClose: () => void
  onNavigate: (nextIdx: number) => void
}): React.JSX.Element {
  const hasPrev = index > 0
  const hasNext = index < total - 1

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1)
      else if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, onNavigate, index, hasPrev, hasNext])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-[2px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="glossary-detail-title"
    >
      <div
        className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl border border-[var(--border-soft)] bg-[var(--paper-100)] p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-[var(--border-soft)] pb-4">
          <div className="min-w-0 space-y-1">
            <h3
              id="glossary-detail-title"
              className="font-display text-2xl font-medium tracking-tight text-[var(--ink-900)]"
            >
              {entry.term}
            </h3>
            <p className="font-sans text-sm italic text-[var(--ink-500)]">{entry.canonical_pt}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar"
            className="rounded-lg p-1.5 text-[var(--ink-400)] transition-colors hover:bg-[var(--paper-200)] hover:text-[var(--ink-800)]"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2.5 text-[12px]">
          <KindPill kind={entry.kind} />
          <ConfBadge conf={entry.confidence} />
          {entry.gender !== 'n/a' && entry.gender !== 'unknown' && (
            <span className="font-sans rounded-full border border-[var(--border-medium)] px-2.5 py-0.5 text-[11px] text-[var(--ink-700)]">
              gênero: {entry.gender}
            </span>
          )}
          <span className="font-sans rounded-full border border-[var(--border-medium)] px-2.5 py-0.5 text-[11px] uppercase tracking-wide text-[var(--ink-500)]">
            {entry.source === 'wiki' ? 'wiki' : 'IA'}
          </span>
          {entry.first_seen_chapter != null && (
            <span className="font-sans text-[11px] text-[var(--ink-400)]">
              visto no cap. {entry.first_seen_chapter}
            </span>
          )}
        </div>

        <div className="mt-5 space-y-2">
          <div className="font-sans text-[10px] font-semibold tracking-[0.18em] uppercase text-[var(--ink-400)]">
            Notas completas
          </div>
          <div className="rounded-xl border border-[var(--border-soft)] bg-[var(--paper-50)] p-4">
            {entry.notes ? (
              <p className="font-sans whitespace-pre-wrap break-words text-[14px] leading-relaxed text-[var(--ink-800)]">
                {entry.notes}
              </p>
            ) : (
              <p className="font-sans text-[13px] italic text-[var(--ink-400)]">
                Sem notas registradas para esta entrada.
              </p>
            )}
          </div>
        </div>

        <div className="mt-5 flex items-center justify-between border-t border-[var(--border-soft)] pt-4">
          <span className="font-sans text-[11px] tracking-wide text-[var(--ink-400)]">
            {index + 1} de {total}
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={!hasPrev}
              onClick={() => onNavigate(index - 1)}
              className="font-sans inline-flex items-center gap-1 rounded-lg border border-[var(--border-medium)] px-3 py-1.5 text-[12px] text-[var(--ink-700)] transition-colors hover:bg-[var(--paper-200)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="size-3.5" />
              Anterior
            </button>
            <button
              type="button"
              disabled={!hasNext}
              onClick={() => onNavigate(index + 1)}
              className="font-sans inline-flex items-center gap-1 rounded-lg border border-[var(--border-medium)] px-3 py-1.5 text-[12px] text-[var(--ink-700)] transition-colors hover:bg-[var(--paper-200)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Próxima
              <ChevronRight className="size-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
