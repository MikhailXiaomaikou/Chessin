import { useState } from 'react'
import BoardContainer from '@renderer/board/BoardContainer'
import NotationPanel from '@renderer/notation/NotationPanel'
import EnginePanel from '@renderer/engine/EnginePanel'
import GameControls from '@renderer/game/GameControls'
import DatabasePanel from '@renderer/database/DatabasePanel'
import BoardEditor from '@renderer/board/BoardEditor'
import TabBar from '@renderer/layout/TabBar'
import { useUIStore } from '@renderer/stores/uiStore'
import { useT } from '@renderer/i18n/useI18n'

type RightTab = 'notation' | 'database'

export default function MainLayout() {
  const t = useT()
  const [activeTab, setActiveTab] = useState<RightTab>('notation')
  const boardEditorMode = useUIStore((s) => s.boardEditorMode)

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden">
      <TabBar />
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Board — shrink to fit */}
        <div className="flex items-center justify-center p-4 shrink-0">
          <BoardContainer />
        </div>

        {/* Right: Panel — takes all remaining space */}
        <div className="flex-1 flex flex-col h-full bg-[var(--bg-secondary)] border-l border-[var(--border-color)] min-w-0">
          {boardEditorMode ? (
            <div className="flex-1 overflow-y-auto">
              <BoardEditor />
            </div>
          ) : (
            <>
              <GameControls />
              <div className="shrink-0 max-h-[40%] overflow-y-auto">
                <EnginePanel />
              </div>

              <div className="flex border-b border-[var(--border-color)]">
                <button
                  onClick={() => setActiveTab('notation')}
                  className={`flex-1 py-3 text-base font-medium transition-colors ${
                    activeTab === 'notation'
                      ? 'text-accent border-b-2 border-accent'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t('tab.moves')}
                </button>
                <button
                  onClick={() => setActiveTab('database')}
                  className={`flex-1 py-3 text-base font-medium transition-colors ${
                    activeTab === 'database'
                      ? 'text-accent border-b-2 border-accent'
                      : 'text-gray-500 hover:text-gray-300'
                  }`}
                >
                  {t('tab.database')}
                </button>
              </div>

              <div className="flex-1 overflow-hidden">
                {activeTab === 'notation' && <NotationPanel />}
                {activeTab === 'database' && <DatabasePanel />}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
