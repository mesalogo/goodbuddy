import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState
} from 'react'
import type { PropsWithChildren } from 'react'
import i18n, { changeUiLocale, type UiLocale } from './index'
import {
  loadUiLocalePreference,
  resolveUiLocale,
  saveUiLocalePreference,
  systemUiLanguages,
  type UiLocalePreference
} from './locale'

type UiLocaleContextValue = {
  preference: UiLocalePreference
  resolvedLocale: UiLocale
  setPreference: (preference: UiLocalePreference) => void
}

const defaultPreference = loadUiLocalePreference()

const UiLocaleContext = createContext<UiLocaleContextValue>({
  preference: defaultPreference,
  resolvedLocale: resolveUiLocale(
    defaultPreference,
    systemUiLanguages()
  ),
  setPreference: () => undefined
})

type UiLocaleProviderProps = PropsWithChildren<{
  initialPreference?: UiLocalePreference
}>

export function UiLocaleProvider({
  children,
  initialPreference = defaultPreference
}: UiLocaleProviderProps): React.JSX.Element {
  const [preference, setPreferenceState] =
    useState<UiLocalePreference>(initialPreference)
  const [systemLanguages, setSystemLanguages] = useState(
    systemUiLanguages
  )
  const resolvedLocale = resolveUiLocale(preference, systemLanguages)

  useEffect(() => {
    if (i18n.resolvedLanguage !== resolvedLocale) {
      void changeUiLocale(resolvedLocale)
    }
  }, [resolvedLocale])

  useEffect(() => {
    if (preference !== 'system') {
      return
    }
    const updateSystemLanguage = (): void => {
      setSystemLanguages(systemUiLanguages())
    }
    window.addEventListener('languagechange', updateSystemLanguage)
    return () =>
      window.removeEventListener(
        'languagechange',
        updateSystemLanguage
      )
  }, [preference])

  const setPreference = useCallback(
    (nextPreference: UiLocalePreference): void => {
      saveUiLocalePreference(nextPreference)
      setPreferenceState(nextPreference)
    },
    []
  )

  const value = useMemo(
    () => ({
      preference,
      resolvedLocale,
      setPreference
    }),
    [preference, resolvedLocale, setPreference]
  )

  return (
    <UiLocaleContext.Provider value={value}>
      {children}
    </UiLocaleContext.Provider>
  )
}

export function useUiLocale(): UiLocaleContextValue {
  return useContext(UiLocaleContext)
}
