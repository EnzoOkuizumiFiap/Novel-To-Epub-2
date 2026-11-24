import { useState } from 'react'
import { JobsProvider } from '@renderer/context/JobsContext'
import { Sidebar, type View } from '@renderer/components/Sidebar'
import { About } from '@renderer/components/About'
import { NewCapture } from '@renderer/components/NewCapture'
import { Downloads } from '@renderer/components/Downloads'
import { Library } from '@renderer/components/Library'
import { NovelDetail } from '@renderer/components/NovelDetail'
import { Glossary } from '@renderer/components/Glossary'
import { Usage } from '@renderer/components/Usage'
import { Settings } from '@renderer/components/Settings'

function App(): React.JSX.Element {
  // Default 'about' — primeira impressao do app. User navega pra 'new' depois.
  const [view, setView] = useState<View>('about')
  const [selectedNovelId, setSelectedNovelId] = useState<number | null>(null)
  // Prefill da Nova captura: URL + estilo de capa travado da novel, ou novelId pra EPUB.
  const [prefill, setPrefill] = useState<{
    url?: string | null
    coverStyle?: string | null
    novelId?: number | null
  } | null>(null)
  const [glossaryNovelId, setGlossaryNovelId] = useState<number | null>(null)

  function navigate(v: View): void {
    setView(v)
    // muda de tela: limpa drill-down dentro da Biblioteca
    if (v !== 'library') setSelectedNovelId(null)
    // limpa prefill ao sair de Nova captura
    if (v !== 'new') setPrefill(null)
    // glossario filter por novel so vale quando voce abre via NovelDetail
    if (v !== 'glossary') setGlossaryNovelId(null)
  }

  function openCaptureWithUrl(url: string, coverStyle: string | null): void {
    setPrefill({ url, coverStyle, novelId: null })
    setSelectedNovelId(null)
    setView('new')
  }

  function openImportEpubForNovel(novelId: number): void {
    setPrefill({ url: null, coverStyle: null, novelId })
    setSelectedNovelId(null)
    setView('new')
  }

  function openGlossaryFor(novelId: number): void {
    setGlossaryNovelId(novelId)
    setView('glossary')
  }

  return (
    <JobsProvider>
      <div className="flex h-screen min-h-screen">
        <Sidebar view={view} onNavigate={navigate} />
        <main className="relative flex-1 overflow-auto">
          <div className={`mx-auto px-10 py-12 ${view === 'glossary' ? 'max-w-5xl' : 'max-w-3xl'}`}>
            {view === 'about' && <About />}
            {view === 'new' && (
              <NewCapture
                key={prefill ? `${prefill.url ?? ''}:${prefill.novelId ?? ''}` : 'fresh'}
                prefilledUrl={prefill?.url ?? null}
                prefilledCoverStyle={prefill?.coverStyle ?? null}
                prefilledNovelId={prefill?.novelId ?? null}
              />
            )}
            {view === 'downloads' && <Downloads />}
            {view === 'library' &&
              (selectedNovelId !== null ? (
                <NovelDetail
                  // key: trocar de novel remonta tudo (estado, seções, mensagens)
                  // em vez de mostrar a novel anterior até a nova carregar.
                  key={selectedNovelId}
                  novelId={selectedNovelId}
                  onBack={() => setSelectedNovelId(null)}
                  onCaptureMore={openCaptureWithUrl}
                  onImportEpub={openImportEpubForNovel}
                  onOpenGlossary={openGlossaryFor}
                />
              ) : (
                <Library onOpenNovel={(id) => setSelectedNovelId(id)} />
              ))}
            {view === 'glossary' && <Glossary initialNovelId={glossaryNovelId} />}
            {view === 'usage' && <Usage />}
            {view === 'settings' && <Settings />}
          </div>
        </main>
      </div>
    </JobsProvider>
  )
}

export default App
