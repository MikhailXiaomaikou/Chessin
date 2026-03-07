import { useUIStore } from '@renderer/stores/uiStore'
import { locales, type TranslationKey } from './locales'

export function useT() {
  const locale = useUIStore((s) => s.locale)
  const strings = locales[locale]
  return (key: TranslationKey) => strings[key]
}
