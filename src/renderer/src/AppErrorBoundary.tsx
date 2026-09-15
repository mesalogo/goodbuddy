import { Component, type ErrorInfo, type ReactNode } from 'react'
import { loadUiLocalePreference, resolveUiLocale, systemUiLanguages } from './i18n/locale'
import './AppErrorBoundary.css'

export class AppErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('GoodBuddy UI failed', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children

    // Recovery must work even when the locale provider or application failed.
    const locale = resolveUiLocale(loadUiLocalePreference(), systemUiLanguages())
    const en = locale === 'en-US'
    return (
      <main className="app-error-recovery" lang={locale} aria-labelledby="app-error-title">
        <div role="alert">
          <h1 id="app-error-title">{en ? 'GoodBuddy could not display this page' : 'GoodBuddy 无法显示当前页面'}</h1>
          <p>{en
            ? 'Reload to try again. Unsaved input may be lost. If this happens again, quit and reopen GoodBuddy.'
            : '请重新加载后重试。尚未保存的输入可能丢失。如果再次出现，请退出并重新打开 GoodBuddy。'}</p>
        </div>
        <button className="primary-button" type="button" onClick={() => window.location.reload()}>
          {en ? 'Reload' : '重新加载'}
        </button>
      </main>
    )
  }
}
