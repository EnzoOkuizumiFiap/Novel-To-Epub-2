import { useEffect, useRef, useState } from 'react'
import { Link2 } from 'lucide-react'

interface RawHtmlEditorProps {
  chapterKey: number
  htmlEn: string
  htmlPt: string
  language: string
  onChangeHtmlPt: (html: string) => void
}

export function RawHtmlEditor({
  chapterKey,
  htmlEn,
  htmlPt,
  language,
  onChangeHtmlPt
}: RawHtmlEditorProps): React.JSX.Element {
  const [syncScroll, setSyncScroll] = useState(true)
  const enScrollRef = useRef<HTMLPreElement | null>(null)
  const ptScrollRef = useRef<HTMLTextAreaElement | null>(null)
  const ignoreScrollRef = useRef<{ side: 'en' | 'pt'; top: number } | null>(null)

  useEffect(() => {
    ignoreScrollRef.current = null
    if (enScrollRef.current) enScrollRef.current.scrollTop = 0
    if (ptScrollRef.current) ptScrollRef.current.scrollTop = 0
  }, [chapterKey])

  function syncScrollFrom(source: 'en' | 'pt'): void {
    if (!syncScroll) return
    const src = source === 'en' ? enScrollRef.current : ptScrollRef.current
    const dst = source === 'en' ? ptScrollRef.current : enScrollRef.current
    if (!src || !dst) return
    if (
      ignoreScrollRef.current?.side === source &&
      Math.abs(src.scrollTop - ignoreScrollRef.current.top) < 2
    ) {
      ignoreScrollRef.current = null
      return
    }
    const maxSrc = src.scrollHeight - src.clientHeight
    const maxDst = dst.scrollHeight - dst.clientHeight
    if (maxSrc <= 0 || maxDst <= 0) return
    const nextTop = (src.scrollTop / maxSrc) * maxDst
    if (Math.abs(dst.scrollTop - nextTop) < 1) return
    dst.scrollTop = nextTop
    ignoreScrollRef.current = { side: source === 'en' ? 'pt' : 'en', top: dst.scrollTop }
  }

  return (
    <div className="grid min-h-0 flex-1 grid-cols-2">
      <section className="flex min-h-0 flex-col border-r border-[var(--border-soft)] bg-[var(--paper-100)]">
        <div className="font-sans flex items-center justify-between border-b border-[var(--border-soft)] px-4 py-2 text-[10px] tracking-[0.18em] uppercase text-[var(--ink-500)]">
          <span>Original (EN) · read-only</span>
          <button
            type="button"
            aria-pressed={syncScroll}
            onClick={() => setSyncScroll((v) => !v)}
            title="Sincroniza a rolagem proporcional entre o original e a tradução"
            className={[
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] normal-case tracking-normal transition-colors',
              syncScroll
                ? 'bg-[var(--paper-300)] font-medium text-[var(--ink-900)]'
                : 'text-[var(--ink-400)] hover:text-[var(--ink-700)]'
            ].join(' ')}
          >
            <Link2 className="size-3" />
            {syncScroll ? 'Rolagem ligada' : 'Rolagem solta'}
          </button>
        </div>
        <pre
          ref={enScrollRef}
          onScroll={() => syncScrollFrom('en')}
          className="font-sans flex-1 overflow-auto whitespace-pre-wrap break-words p-4 text-[13px] leading-relaxed text-[var(--ink-700)]"
        >
          {htmlEn}
        </pre>
      </section>
      <section className="flex min-h-0 flex-col">
        <div className="font-sans flex items-center justify-between border-b border-[var(--border-soft)] px-4 py-2 text-[10px] tracking-[0.18em] uppercase text-[var(--ink-500)]">
          <span>Tradução ({language})</span>
        </div>
        <textarea
          ref={ptScrollRef}
          onScroll={() => syncScrollFrom('pt')}
          value={htmlPt}
          onChange={(e) => onChangeHtmlPt(e.target.value)}
          spellCheck={false}
          className="font-sans min-h-0 flex-1 resize-none bg-transparent p-4 text-[13px] leading-relaxed text-[var(--ink-900)] outline-none"
          placeholder="Cole a tradução em HTML (preserve as tags <p>)"
        />
      </section>
    </div>
  )
}
