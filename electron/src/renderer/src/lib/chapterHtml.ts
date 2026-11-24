export interface HtmlParagraph {
  openTag: string
  inner: string
}

const P_TAG_RE = /<p(\b[^>]*)>([\s\S]*?)<\/p>/gi

/**
 * Extrai sequência de blocos `<p>...</p>` preservando atributos da tag de abertura
 * e o HTML interno (`<em>`, `<strong>`, etc). Se o HTML não usar `<p>`, divide
 * por linhas não vazias como fallback.
 */
export function parseHtmlParagraphs(html: string): HtmlParagraph[] {
  const out: HtmlParagraph[] = []
  P_TAG_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = P_TAG_RE.exec(html)) !== null) {
    out.push({
      openTag: `<p${m[1] ?? ''}>`,
      inner: m[2]
    })
  }
  if (out.length > 0) return out
  const trimmed = html.trim()
  if (!trimmed) return []
  return trimmed
    .split(/\r?\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((inner) => ({ openTag: '<p>', inner }))
}

export function serializeHtmlParagraphs(paragraphs: HtmlParagraph[]): string {
  return paragraphs.map((p) => `${p.openTag}${p.inner}</p>`).join('\n')
}

export interface AlignedPair {
  enIndices: number[]
  ptIndices: number[]
}

const HTML_TAGS_RE = /<[^>]+>/g

function stripAndTrim(inner: string): string {
  return inner.replace(HTML_TAGS_RE, '').trim()
}

function normLen(inner: string): number {
  return Math.max(1, stripAndTrim(inner).length)
}

function isDialog(inner: string): boolean {
  const t = stripAndTrim(inner)
  return (
    t.startsWith('—') ||
    t.startsWith('-') ||
    t.startsWith('“') ||
    t.startsWith('"') ||
    t.startsWith('‘') ||
    t.startsWith("'")
  )
}

function pairCost(le: number, lp: number, dEn: boolean, dPt: boolean): number {
  // PT-BR fica ~1.05x maior que EN na média
  const exp = le * 1.05
  const diff = Math.abs(lp - exp) / Math.sqrt(Math.max(20, exp))
  const bonus = dEn === dPt ? -0.3 : 0.4
  return diff + bonus
}

/**
 * Alinha sequências de `<p>` (EN vs PT) com programação dinâmica em faixa (Gale-Church).
 * Suporta 1:1, 1:2 (IA dividiu parágrafo), 2:1 (IA uniu) e 1:0 / 0:1 (lacunas),
 * impedindo que 1 parágrafo extra propague desvio pelo resto do capítulo.
 */
export function alignHtmlParagraphs(en: HtmlParagraph[], pt: HtmlParagraph[]): AlignedPair[] {
  const n = en.length
  const m = pt.length
  if (n === 0 && m === 0) return []
  if (n === 0) return pt.map((_, j) => ({ enIndices: [], ptIndices: [j] }))
  if (m === 0) return en.map((_, i) => ({ enIndices: [i], ptIndices: [] }))

  const le = en.map((p) => normLen(p.inner))
  const lp = pt.map((p) => normLen(p.inner))
  const de = en.map((p) => isDialog(p.inner))
  const dpFlag = pt.map((p) => isDialog(p.inner))

  const band = Math.max(20, Math.abs(n - m) + 16)
  const stride = 2 * band + 1
  const centerAt = (i: number): number => Math.round((i * m) / n)
  const toOffset = (i: number, j: number): number => j - (centerAt(i) - band)

  const dp = new Float64Array((n + 1) * stride)
  dp.fill(Infinity)
  // Step packed as (di << 4) | dj
  const bt = new Uint8Array((n + 1) * stride)

  const setCell = (i: number, j: number, cost: number, di: number, dj: number): void => {
    const off = toOffset(i, j)
    if (off < 0 || off >= stride) return
    const idx = i * stride + off
    if (cost < dp[idx]) {
      dp[idx] = cost
      bt[idx] = (di << 4) | dj
    }
  }

  setCell(0, 0, 0, 0, 0)

  for (let i = 0; i <= n; i++) {
    const cCenter = centerAt(i)
    const jLo = Math.max(0, cCenter - band)
    const jHi = Math.min(m, cCenter + band)
    for (let j = jLo; j <= jHi; j++) {
      const off = j - (cCenter - band)
      const cur = dp[i * stride + off]
      if (!Number.isFinite(cur)) continue

      // 1-1
      if (i < n && j < m) {
        setCell(i + 1, j + 1, cur + pairCost(le[i], lp[j], de[i], dpFlag[j]), 1, 1)
      }
      // 1-2 (dividido no PT)
      if (i < n && j + 1 < m) {
        setCell(
          i + 1,
          j + 2,
          cur + 1.8 + pairCost(le[i], lp[j] + lp[j + 1], de[i], dpFlag[j] || dpFlag[j + 1]),
          1,
          2
        )
      }
      // 2-1 (unido no PT)
      if (i + 1 < n && j < m) {
        setCell(
          i + 2,
          j + 1,
          cur + 1.8 + pairCost(le[i] + le[i + 1], lp[j], de[i] || de[i + 1], dpFlag[j]),
          2,
          1
        )
      }
      // 1-0 (lacuna no PT)
      if (i < n) {
        setCell(i + 1, j, cur + 6.5 + le[i] / 80, 1, 0)
      }
      // 0-1 (parágrafo extra no PT)
      if (j < m) {
        setCell(i, j + 1, cur + 6.5 + lp[j] / 80, 0, 1)
      }
    }
  }

  const out: AlignedPair[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const off = toOffset(i, j)
    const step = off >= 0 && off < stride ? bt[i * stride + off] : 0
    const di = step >> 4
    const dj = step & 0xf
    if (di === 0 && dj === 0) {
      // Fallback defensivo caso algum caso extremo escape da banda
      while (i > 0 && j > 0) {
        out.push({ enIndices: [i - 1], ptIndices: [j - 1] })
        i--
        j--
      }
      while (i > 0) {
        out.push({ enIndices: [i - 1], ptIndices: [] })
        i--
      }
      while (j > 0) {
        out.push({ enIndices: [], ptIndices: [j - 1] })
        j--
      }
      break
    }
    const enIndices: number[] = []
    for (let k = i - di; k < i; k++) enIndices.push(k)
    const ptIndices: number[] = []
    for (let k = j - dj; k < j; k++) ptIndices.push(k)
    out.push({ enIndices, ptIndices })
    i -= di
    j -= dj
  }
  out.reverse()
  return out
}
