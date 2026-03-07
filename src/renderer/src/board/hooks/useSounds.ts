import { useCallback, useRef } from 'react'
import { useUIStore } from '@renderer/stores/uiStore'
import type { Move } from 'chess.js'

const SOUND_FILES = {
  move: 'move',
  capture: 'capture',
  check: 'check',
  castle: 'castle',
  promote: 'promote',
  gameEnd: 'game-end'
} as const

type SoundType = keyof typeof SOUND_FILES

export function useSounds() {
  const soundEnabled = useUIStore((s) => s.soundEnabled)
  const audioCache = useRef<Map<string, HTMLAudioElement>>(new Map())

  const play = useCallback(
    (type: SoundType) => {
      if (!soundEnabled) return

      const cached = audioCache.current.get(type)
      if (cached) {
        cached.currentTime = 0
        cached.play().catch(() => {})
        return
      }

      const audio = new Audio(`../../../resources/sounds/${SOUND_FILES[type]}.mp3`)
      audio.volume = 0.5
      audioCache.current.set(type, audio)
      audio.play().catch(() => {
        // Sound file may not exist yet
      })
    },
    [soundEnabled]
  )

  const playSound = useCallback(
    (move: Move) => {
      if (move.san === 'O-O' || move.san === 'O-O-O') {
        play('castle')
      } else if (move.promotion) {
        play('promote')
      } else if (move.captured) {
        play('capture')
      } else {
        play('move')
      }
    },
    [play]
  )

  return playSound
}
