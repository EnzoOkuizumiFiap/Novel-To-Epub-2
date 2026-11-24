import type { JobStatus } from './api'

export type JobsMap = Record<string, JobStatus>

const ts = (iso: string): number => Date.parse(iso) || 0

/**
 * Funde o snapshot do GET /api/downloads com o estado local. O snapshot e a
 * verdade sobre QUAIS jobs existem (apos o backend reiniciar, jobs que sumiram
 * dele nao podem ficar "em andamento" pra sempre), mas um evento do WS pode ter
 * chegado DEPOIS de o snapshot ser montado — entao, por job, vence o
 * `updated_at` mais novo, e um job ausente do snapshot so fica se foi
 * atualizado depois que a requisicao saiu.
 */
export function mergeSnapshot(prev: JobsMap, list: JobStatus[], requestedAt: number): JobsMap {
  const next: JobsMap = {}
  for (const job of list) {
    const local = prev[job.id]
    next[job.id] = local && ts(local.updated_at) > ts(job.updated_at) ? local : job
  }
  for (const [id, local] of Object.entries(prev)) {
    if (!(id in next) && ts(local.updated_at) >= requestedAt) next[id] = local
  }
  return next
}

/**
 * Calcula percentual de progresso considerando sub-progresso de chunks
 * quando `job.current` traz "(parte X/Y)" no capítulo atual.
 */
export function jobProgressPct(job: JobStatus): number {
  if (!job.total) return 0
  let fraction = job.done
  if (job.current && job.done < job.total) {
    const m = /\(parte\s+(\d+)\/(\d+)\)/i.exec(job.current)
    if (m) {
      const part = Math.max(0, Number(m[1]) - 1)
      const parts = Number(m[2])
      if (parts > 0) fraction += Math.min(1, part / parts)
    }
  }
  return Math.min(100, Math.round((fraction / job.total) * 100))
}
