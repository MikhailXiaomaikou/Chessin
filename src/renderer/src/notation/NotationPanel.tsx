import MoveList from './MoveList'
import MoveNavigation from '@renderer/game/MoveNavigation'
import GameInfo from '@renderer/game/GameInfo'
import EvalChart from '@renderer/analysis/EvalChart'

export default function NotationPanel() {
  return (
    <div className="flex flex-col h-full bg-[var(--bg-secondary)] border-l border-[var(--border-color)]">
      <GameInfo />
      <EvalChart />
      <MoveList />
      <MoveNavigation />
    </div>
  )
}
