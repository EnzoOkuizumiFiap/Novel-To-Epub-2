import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  api,
  type UsageByNovel,
  type UsageByProvider,
  type UsageDay,
  type UsageSummary
} from '@renderer/lib/api'
import { Folio } from '@renderer/components/decorative/Folio'

// Taxa aproximada — pra dashboard pessoal, fixo basta. Se virar feature
// de mercado, puxar de algum FX provider.
const USD_TO_BRL = 5.0

function fmtBrl(usd: number): string {
  const brl = usd * USD_TO_BRL
  return brl.toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    minimumFractionDigits: brl < 1 ? 4 : 2
  })
}

function fmtUsd(usd: number): string {
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toLocaleString('pt-BR')
}

function fmtShortDate(iso: string): string {
  const [, m, d] = iso.split('-')
  return `${d}/${m}`
}

function providerColor(name: string): string {
  // Cores tiradas das vars de book do design system pra ficar coerente
  switch (name) {
    case 'claude':
      return 'var(--book-3)' // verde
    case 'openrouter':
      return 'var(--book-5)' // roxo
    case 'cerebras':
      return 'var(--book-2)' // âmbar
    case 'gemini':
      return 'var(--book-7)' // azul
    default:
      return 'var(--ink-400)'
  }
}

export function Usage(): React.JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [byDay, setByDay] = useState<UsageDay[] | null>(null)
  const [byNovel, setByNovel] = useState<UsageByNovel[] | null>(null)
  const [byProvider, setByProvider] = useState<UsageByProvider[] | null>(null)
  const [chartMetric, setChartMetric] = useState<'tokens' | 'cost'>('cost')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    Promise.all([api.usageSummary(), api.usageByDay(30), api.usageByNovel(), api.usageByProvider()])
      .then(([s, d, n, p]) => {
        setSummary(s)
        setByDay(d)
        setByNovel(n)
        setByProvider(p)
        if (s.total_usd === 0 && s.total_tokens > 0) setChartMetric('tokens')
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const maxDayCost = useMemo(
    () => Math.max(0.0001, ...(byDay ?? []).map((d) => d.cost_usd)),
    [byDay]
  )
  const maxDayTokens = useMemo(
    () => Math.max(1, ...(byDay ?? []).map((d) => d.total_tokens)),
    [byDay]
  )

  if (error) {
    return (
      <div className="font-sans text-[14px] text-[var(--ink-stamp)]">
        Erro ao carregar custos: {error}
      </div>
    )
  }
  if (!summary || !byDay || !byNovel || !byProvider) {
    return (
      <div className="flex items-center gap-2 text-[var(--ink-400)]">
        <Loader2 className="size-4 animate-spin" /> Carregando…
      </div>
    )
  }

  return (
    <div className="space-y-10">
      <header className="space-y-3">
        <Folio n="vi" />
        <h2 className="font-display text-[2.5rem] leading-none font-medium tracking-tight">
          Custos
        </h2>
        <p className="font-sans max-w-md text-[15px] leading-relaxed text-[var(--ink-500)]">
          Consumo de tokens (inclusive modelos gratuitos) e gastos estimados nos providers
          configurados — tradução de capítulos, capas e briefs (taxa fixa USD{' '}
          {USD_TO_BRL.toFixed(2)}).
        </p>
      </header>

      {/* Stats principais */}
      <section className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatCard
          label="total acumulado"
          value={fmtBrl(summary.total_usd)}
          sub={fmtUsd(summary.total_usd)}
        />
        <StatCard
          label="últimos 30 dias"
          value={fmtBrl(summary.last_30d_usd)}
          sub={fmtUsd(summary.last_30d_usd)}
        />
        <StatCard
          label="últimos 7 dias"
          value={fmtBrl(summary.last_7d_usd)}
          sub={fmtUsd(summary.last_7d_usd)}
        />
        <StatCard
          label="custo médio/capítulo"
          value={fmtBrl(summary.avg_per_chapter_usd)}
          sub={`${summary.chapters_translated} caps · ${summary.covers_generated} capas`}
        />
      </section>

      {/* Consumo de tokens */}
      <section className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <StatCard
          label="tokens consumidos (total)"
          value={fmtTokens(summary.total_tokens)}
          sub={`${summary.total_tokens.toLocaleString('pt-BR')} tokens · ${summary.total_ops} chamadas`}
        />
        <StatCard
          label="tokens de entrada (prompt)"
          value={fmtTokens(summary.total_input_tokens)}
          sub={`${summary.total_input_tokens.toLocaleString('pt-BR')} tokens`}
        />
        <StatCard
          label="tokens de saída (tradução)"
          value={fmtTokens(summary.total_output_tokens)}
          sub={`${summary.total_output_tokens.toLocaleString('pt-BR')} tokens · 7d: ${fmtTokens(summary.last_7d_tokens)}`}
        />
      </section>

      {/* Gráfico por dia */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-display flex items-baseline gap-3 text-lg font-medium tracking-tight">
            Por dia
            <span className="font-sans text-[11px] tracking-[0.16em] uppercase text-[var(--ink-400)]">
              últimos 30 dias
            </span>
          </h3>
          <div className="flex rounded-lg border border-[var(--border-soft)] bg-[var(--paper-100)] p-0.5 text-[11px]">
            <button
              type="button"
              onClick={() => setChartMetric('tokens')}
              className={[
                'rounded-md px-2.5 py-1 font-sans transition-colors',
                chartMetric === 'tokens'
                  ? 'bg-[var(--ink-900)] text-[var(--paper-50)]'
                  : 'text-[var(--ink-500)] hover:text-[var(--ink-900)]'
              ].join(' ')}
            >
              Tokens
            </button>
            <button
              type="button"
              onClick={() => setChartMetric('cost')}
              className={[
                'rounded-md px-2.5 py-1 font-sans transition-colors',
                chartMetric === 'cost'
                  ? 'bg-[var(--ink-900)] text-[var(--paper-50)]'
                  : 'text-[var(--ink-500)] hover:text-[var(--ink-900)]'
              ].join(' ')}
            >
              Custo (R$)
            </button>
          </div>
        </div>
        <div
          className={[
            'rounded-2xl border bg-[var(--paper-100)] px-6 py-5',
            'border-[var(--border-soft)]',
            'shadow-[0_1px_0_rgba(255,250,235,0.85)_inset,0_1px_2px_rgba(80,50,20,0.04)]'
          ].join(' ')}
        >
          <div className="flex h-40 items-end gap-1">
            {byDay.map((d) => {
              const val = chartMetric === 'tokens' ? d.total_tokens : d.cost_usd
              const maxVal = chartMetric === 'tokens' ? maxDayTokens : maxDayCost
              const pct = (val / maxVal) * 100
              const hasUse = val > 0
              return (
                <div
                  key={d.day}
                  title={`${d.day} · ${fmtBrl(d.cost_usd)} · ${d.total_tokens.toLocaleString('pt-BR')} tokens · ${d.ops} chamadas`}
                  className={[
                    'flex-1 rounded-t-sm transition-all hover:opacity-100',
                    hasUse
                      ? 'bg-[var(--stamp-red)] opacity-75 hover:opacity-100'
                      : 'bg-[var(--paper-300)]'
                  ].join(' ')}
                  style={{ height: `${Math.max(2, pct)}%` }}
                />
              )
            })}
          </div>
          <div className="folio mt-3 flex justify-between text-[10px] text-[var(--ink-400)]">
            <span>{fmtShortDate(byDay[0].day)}</span>
            <span>{fmtShortDate(byDay[Math.floor(byDay.length / 2)].day)}</span>
            <span>{fmtShortDate(byDay[byDay.length - 1].day)}</span>
          </div>
          <div className="font-sans mt-2 flex justify-between text-[11px] text-[var(--ink-500)]">
            {chartMetric === 'tokens' ? (
              <>
                <span>pico: {fmtTokens(maxDayTokens)} tokens/dia</span>
                <span>total 30d: {summary.last_30d_tokens.toLocaleString('pt-BR')} tokens</span>
              </>
            ) : (
              <>
                <span>pico: {fmtBrl(maxDayCost)}/dia</span>
                <span>total 30d: {fmtBrl(summary.last_30d_usd)}</span>
              </>
            )}
          </div>
        </div>
      </section>

      {/* Por provider (free vs pago aparece visualmente) */}
      <section className="space-y-3">
        <h3 className="font-display flex items-baseline gap-3 text-lg font-medium tracking-tight">
          Por provider
          <span className="font-sans text-[11px] tracking-[0.16em] uppercase text-[var(--ink-400)]">
            cascade breakdown
          </span>
        </h3>
        {byProvider.length === 0 ? (
          <p className="font-sans text-[13px] text-[var(--ink-500)]">
            Nenhuma chamada registrada ainda.
          </p>
        ) : (
          <div
            className={[
              'rounded-2xl border bg-[var(--paper-100)] px-5 py-4',
              'border-[var(--border-soft)]',
              'shadow-[0_1px_0_rgba(255,250,235,0.85)_inset,0_1px_2px_rgba(80,50,20,0.04)]'
            ].join(' ')}
          >
            <ul className="space-y-2">
              {byProvider.map((p) => {
                const color = providerColor(p.provider)
                const isFree = p.total_usd === 0
                return (
                  <li key={p.provider} className="flex items-center gap-3">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                    <span className="font-display flex-1 capitalize text-[14px]">
                      {p.provider}
                      {isFree && (
                        <span className="font-sans ml-2 rounded bg-[var(--book-3)]/15 px-1.5 py-0.5 text-[10px] tracking-wide uppercase text-[var(--book-3)]">
                          free
                        </span>
                      )}
                    </span>
                    <span className="font-sans text-[11px] text-[var(--ink-500)]">
                      {fmtTokens(p.total_tokens)} tokens · {p.ops}{' '}
                      {p.ops === 1 ? 'chamada' : 'chamadas'}
                    </span>
                    <span className="font-display w-24 text-right text-[14px] italic text-[var(--ink-900)]">
                      {fmtBrl(p.total_usd)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </div>
        )}
      </section>

      {/* Tabela por novel */}
      <section className="space-y-3">
        <h3 className="font-display flex items-baseline gap-3 text-lg font-medium tracking-tight">
          Por novel
          <span className="font-sans text-[11px] tracking-[0.16em] uppercase text-[var(--ink-400)]">
            {byNovel.length} {byNovel.length === 1 ? 'novel' : 'novels'}
          </span>
        </h3>
        {byNovel.length === 0 ? (
          <p className="font-sans text-[13px] text-[var(--ink-500)]">
            Nenhum gasto registrado ainda. Custos aparecem aqui depois que rodar uma tradução.
          </p>
        ) : (
          <ul className="space-y-2">
            {byNovel.map((n, i) => (
              <li
                key={n.novel_id ?? `null-${i}`}
                className="flex flex-wrap items-center gap-4 rounded-xl border bg-[var(--paper-100)] px-4 py-3 border-[var(--border-soft)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-display truncate text-[15px] font-medium tracking-tight">
                    {n.novel_title}
                  </div>
                  <div className="font-sans text-[11px] tracking-wide text-[var(--ink-500)]">
                    {n.chapters_translated} caps traduzidos · {n.covers_generated} capa(s) ·{' '}
                    {fmtTokens(n.total_tokens)} tokens · {n.ops} chamadas
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-display text-[18px] italic text-[var(--ink-900)]">
                    {fmtBrl(n.total_usd)}
                  </div>
                  <div className="folio text-[10px] text-[var(--ink-400)]">
                    {fmtUsd(n.total_usd)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub
}: {
  label: string
  value: string
  sub?: string
}): React.JSX.Element {
  return (
    <div
      className={[
        'rounded-2xl border bg-[var(--paper-100)] px-5 py-4',
        'border-[var(--border-soft)]',
        'shadow-[0_1px_0_rgba(255,250,235,0.85)_inset,0_1px_2px_rgba(80,50,20,0.04)]'
      ].join(' ')}
    >
      <div className="font-sans text-[10px] tracking-[0.16em] uppercase text-[var(--ink-400)]">
        {label}
      </div>
      <div className="font-display mt-1 text-[26px] leading-none font-medium tracking-tight italic text-[var(--ink-900)]">
        {value}
      </div>
      {sub && (
        <div className="font-sans mt-1 text-[11px] tracking-wide text-[var(--ink-500)]">{sub}</div>
      )}
    </div>
  )
}
