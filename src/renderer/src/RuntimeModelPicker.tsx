import { forwardRef, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { RuntimeSettings } from '../../shared/contracts'
import {
  allowedRuntimeProviders,
  compactRuntimeSelectionLayer,
  globalDefaultModel,
  isResolvableStatus,
  runtimeSelectionLayerSchema,
  resolveRuntimeChoice,
  runtimeModelChoiceStatus,
  selectableModelProfiles,
  supportsRuntimeConfig,
  type AgentRuntimeProvider,
  type RuntimeModelChoice,
  type RuntimeSelectionLayer
} from '../../shared/runtime-selection-contracts'
import {
  ignoredChoiceMessage,
  runtimeModelDetail,
  runtimeModelLabel,
  runtimeProviderLabel,
  sourceLabel
} from './runtime-selection'

type RuntimeModelPickerProps = {
  runtimeSettings: RuntimeSettings
  projectLayer?: RuntimeSelectionLayer
  conversationLayer?: RuntimeSelectionLayer
  remote: boolean
  onSelect: (layer: RuntimeSelectionLayer | undefined) => void
  onManage: () => void
  onClose: () => void
}

const VIEWPORT_MARGIN = 8

/** The nearest ancestor that clips overflow, whose edges the menu must stay within. */
function clippingBounds(element: HTMLElement): { left: number; right: number } {
  let bounds = { left: VIEWPORT_MARGIN, right: window.innerWidth - VIEWPORT_MARGIN }
  for (let node = element.parentElement; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(hidden|clip|auto|scroll)/u.test(style.overflowX + style.overflow)) {
      const rect = node.getBoundingClientRect()
      bounds = {
        left: Math.max(bounds.left, rect.left + VIEWPORT_MARGIN),
        right: Math.min(bounds.right, rect.right - VIEWPORT_MARGIN)
      }
    }
  }
  return bounds
}

function sameModel(
  left: RuntimeModelChoice | undefined,
  right: RuntimeModelChoice | undefined
): boolean {
  if (!left || !right) return left === right
  if (left.kind !== right.kind) return false
  return left.kind === 'runtime-config' || left.profileId === (right as { profileId: string }).profileId
}

/**
 * Two-column composer menu: execution modes on the left, models for the
 * highlighted mode on the right. Choices write the conversation layer only.
 */
export const RuntimeModelPicker = forwardRef<HTMLDivElement, RuntimeModelPickerProps>(
  function RuntimeModelPicker(
    {
      runtimeSettings,
      projectLayer,
      conversationLayer: rawConversationLayer,
      remote,
      onSelect,
      onManage,
      onClose
    },
    ref
  ) {
    const { t } = useTranslation('app')
    const menuRef = useRef<HTMLDivElement | null>(null)
    const setMenuRef = useCallback(
      (node: HTMLDivElement | null) => {
        menuRef.current = node
        if (typeof ref === 'function') ref(node)
        else if (ref) ref.current = node
      },
      [ref]
    )
    // Keep the wide two-column menu inside the chat pane instead of under the sidebar.
    useLayoutEffect(() => {
      const menu = menuRef.current
      if (!menu) return
      const place = (): void => {
        menu.style.transform = ''
        menu.style.maxWidth = ''
        const bounds = clippingBounds(menu)
        const available = Math.max(0, bounds.right - bounds.left)
        if (menu.offsetWidth > available) menu.style.maxWidth = `${available}px`
        const rect = menu.getBoundingClientRect()
        const shift =
          rect.left < bounds.left
            ? bounds.left - rect.left
            : rect.right > bounds.right
              ? bounds.right - rect.right
              : 0
        if (shift) menu.style.transform = `translateX(${Math.round(shift)}px)`
      }
      place()
      window.addEventListener('resize', place)
      return () => window.removeEventListener('resize', place)
    }, [])
    const options = { remote }
    // Cached conversations may still hold pre-layer shapes.
    const parsedLayer = runtimeSelectionLayerSchema.safeParse(rawConversationLayer)
    const conversationLayer = rawConversationLayer === undefined || !parsedLayer.success
      ? undefined
      : compactRuntimeSelectionLayer(parsedLayer.data)
    const current = resolveRuntimeChoice(
      runtimeSettings,
      { project: projectLayer, conversation: conversationLayer },
      options
    )
    const [focusedProvider, setFocusedProvider] = useState<AgentRuntimeProvider>(
      current.provider
    )
    // What this conversation gets for the focused mode if it does not pick a model itself.
    const inheritedForFocused = resolveRuntimeChoice(
      runtimeSettings,
      { project: projectLayer, conversation: { provider: focusedProvider } },
      options
    )
    // A conversation model counts as chosen only while it is the one in effect.
    const conversationModel =
      focusedProvider === current.provider && current.modelSource === 'conversation'
        ? current.model
        : undefined
    const hasOverride = Boolean(conversationLayer?.provider || conversationLayer?.model)
    const warning = ignoredChoiceMessage(current, runtimeSettings, t)

    const providerIsInherited = (provider: AgentRuntimeProvider): boolean =>
      resolveRuntimeChoice(runtimeSettings, { project: projectLayer }, options).provider === provider

    const selectProvider = (provider: AgentRuntimeProvider): void => {
      // Switching modes drops the conversation's model so the new mode's default applies.
      onSelect(
        providerIsInherited(provider) ? undefined : { provider }
      )
    }

    const selectModel = (model: RuntimeModelChoice | undefined): void => {
      const provider = providerIsInherited(focusedProvider) ? undefined : focusedProvider
      onSelect({ ...(provider ? { provider } : {}), ...(model ? { model } : {}) })
    }

    const moveFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
      const container = event.currentTarget
      const active = document.activeElement as HTMLElement | null
      const column = active?.closest<HTMLElement>('[data-runtime-column]')
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      const columns = Array.from(
        container.querySelectorAll<HTMLElement>('[data-runtime-column]')
      )
      const itemsOf = (element: HTMLElement | null | undefined): HTMLButtonElement[] =>
        element
          ? Array.from(
              element.querySelectorAll<HTMLButtonElement>(
                '[role="menuitemradio"], [role="menuitem"]'
              )
            ).filter((item) => !item.disabled)
          : []
      let target: HTMLButtonElement | undefined
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const index = column ? columns.indexOf(column) : 0
        const next = columns[index + (event.key === 'ArrowRight' ? 1 : -1)]
        const items = itemsOf(next)
        target =
          items.find((item) => item.getAttribute('aria-checked') === 'true') ??
          items[0]
      } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        const items = itemsOf(column ?? container)
        const index = items.indexOf(active as HTMLButtonElement)
        target =
          event.key === 'Home'
            ? items[0]
            : event.key === 'End'
              ? items.at(-1)
              : items.at(
                  (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                    items.length
                )
      }
      if (target) {
        event.preventDefault()
        container
          .querySelectorAll<HTMLButtonElement>('[role="menuitemradio"], [role="menuitem"]')
          .forEach((item) => {
            item.tabIndex = item === target ? 0 : -1
          })
        target.focus()
        const provider = target.dataset.provider as AgentRuntimeProvider | undefined
        if (provider) setFocusedProvider(provider)
      }
    }

    const profiles = selectableModelProfiles(focusedProvider, runtimeSettings)
    // Reserve room for the longest model list so previewing another mode never
    // resizes the menu; a bottom-anchored menu would otherwise jump under the pointer.
    const modelRows = Math.max(
      ...allowedRuntimeProviders(options).map(
        (provider) =>
          1 +
          selectableModelProfiles(provider, runtimeSettings).length +
          (supportsRuntimeConfig(provider, options) ? 1 : 0)
      )
    )
    const defaultModel = inheritedForFocused.model ??
      globalDefaultModel(focusedProvider, runtimeSettings, options)
    const defaultSource = inheritedForFocused.modelSource
    const modelItem = (
      key: string,
      model: RuntimeModelChoice | undefined,
      label: string,
      detail: string | undefined,
      badge?: string,
      disabled = false
    ): React.JSX.Element => {
      const checked =
        focusedProvider === current.provider &&
        (model === undefined ? !conversationModel : sameModel(conversationModel, model))
      return (
        <button
          aria-checked={checked}
          aria-label={[label, badge, detail].filter(Boolean).join(' · ')}
          disabled={disabled}
          key={key}
          onClick={() => selectModel(model)}
          role="menuitemradio"
          tabIndex={-1}
          title={detail ? `${label}\n${detail}` : label}
          type="button"
        >
          <span>
            <span className="runtime-picker__label">{label}</span>
            {badge && <span className="runtime-picker__source">{badge}</span>}
          </span>
          {detail && <small>{detail}</small>}
        </button>
      )
    }

    return (
      <div
        aria-label={t('runtimeSelection.menuLabel')}
        className="runtime-picker__menu runtime-picker__menu--columns"
        onKeyDown={moveFocus}
        ref={setMenuRef}
        role="menu"
      >
        <div
          aria-label={t('runtimeSelection.providerListLabel')}
          className="runtime-picker__column"
          data-runtime-column="provider"
          role="group"
        >
          <strong role="presentation">{t('runtimeSelection.providerListLabel')}</strong>
          {allowedRuntimeProviders(options).map((provider) => (
            <button
              aria-checked={provider === current.provider}
              className={provider === focusedProvider ? 'runtime-picker__focused' : undefined}
              data-provider={provider}
              key={provider}
              onClick={() => selectProvider(provider)}
              onFocus={() => setFocusedProvider(provider)}
              onMouseEnter={() => setFocusedProvider(provider)}
              role="menuitemradio"
              tabIndex={-1}
              type="button"
            >
              <span>{runtimeProviderLabel(provider, t)}</span>
            </button>
          ))}
        </div>
        <div
          aria-label={t('runtimeSelection.modelListLabel')}
          className="runtime-picker__column runtime-picker__column--models"
          data-runtime-column="model"
          role="group"
          style={{ '--runtime-model-rows': modelRows } as React.CSSProperties}
        >
          <strong role="presentation">{t('runtimeSelection.modelListLabel')}</strong>
          {modelItem(
            'default',
            undefined,
            t('runtimeSelection.defaultModel', {
              value: runtimeModelLabel(focusedProvider, defaultModel, runtimeSettings, t)
            }),
            runtimeModelDetail(focusedProvider, defaultModel, runtimeSettings, t),
            sourceLabel(defaultSource, t)
          )}
          {profiles.map((profile) => {
            const model = { kind: 'profile' as const, profileId: profile.id }
            const status = runtimeModelChoiceStatus(focusedProvider, model, runtimeSettings, options)
            return modelItem(
              profile.id,
              model,
              profile.name ?? profile.id,
              status === 'unavailable'
                ? `${profile.modelName ?? ''}${t('runtimeSelection.unavailableSuffix')}`
                : profile.modelName,
              undefined,
              !isResolvableStatus(status)
            )
          })}
          {supportsRuntimeConfig(focusedProvider, options) &&
            modelItem(
              'runtime-config',
              { kind: 'runtime-config' },
              t('runtimeSelection.runtimeConfig', {
                runtime: runtimeProviderLabel(focusedProvider, t)
              }),
              focusedProvider === 'deepseek-harness'
                ? runtimeModelLabel(focusedProvider, { kind: 'runtime-config' }, runtimeSettings, t)
                : undefined
            )}
        </div>
        <div className="runtime-picker__footer">
          {warning && (
            <p className="runtime-picker__warning" role="status">
              {warning}
            </p>
          )}
          <div className="runtime-picker__footer-row">
            <small>
              {hasOverride
                ? t('runtimeSelection.conversationOverride')
                : t('runtimeSelection.conversationOnly')}
            </small>
            {hasOverride && (
              <button
                onClick={() => onSelect(undefined)}
                role="menuitem"
                tabIndex={-1}
                type="button"
              >
                {t('runtimeSelection.resetToProject')}
              </button>
            )}
          </div>
          <button
            className="runtime-picker__manage"
            onClick={onManage}
            role="menuitem"
            tabIndex={-1}
            type="button"
          >
            {t('runtimeSelection.manage')}
          </button>
        </div>
      </div>
    )
  }
)
