interface ClockDisplayProps {
  timeWhite: number // seconds
  timeBlack: number // seconds
  activeSide: 'w' | 'b' | null
  orientation: 'white' | 'black'
}

function formatTime(seconds: number): string {
  if (seconds <= 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export default function ClockDisplay({
  timeWhite,
  timeBlack,
  activeSide,
  orientation
}: ClockDisplayProps) {
  const topTime = orientation === 'white' ? timeBlack : timeWhite
  const bottomTime = orientation === 'white' ? timeWhite : timeBlack
  const topActive = orientation === 'white' ? activeSide === 'b' : activeSide === 'w'
  const bottomActive = orientation === 'white' ? activeSide === 'w' : activeSide === 'b'
  const topLabel = orientation === 'white' ? 'Black' : 'White'
  const bottomLabel = orientation === 'white' ? 'White' : 'Black'

  return (
    <div className="flex flex-col gap-1">
      <ClockSide
        label={topLabel}
        time={topTime}
        active={topActive}
      />
      <ClockSide
        label={bottomLabel}
        time={bottomTime}
        active={bottomActive}
      />
    </div>
  )
}

function ClockSide({
  label,
  time,
  active
}: {
  label: string
  time: number
  active: boolean
}) {
  const isLow = time < 30
  return (
    <div
      className={`flex items-center justify-between px-3 py-1 rounded text-sm font-mono ${
        active
          ? 'bg-accent text-white'
          : 'bg-surface-tertiary text-gray-400'
      }`}
    >
      <span className="text-xs">{label}</span>
      <span className={isLow && active ? 'text-red-300' : ''}>
        {formatTime(time)}
      </span>
    </div>
  )
}
