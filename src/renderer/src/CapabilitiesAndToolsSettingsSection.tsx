import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { McpSettingsSection } from './McpSettingsSection'
import { SettingsCategoryHeader } from './SettingsPrimitives'
import { SkillsSettingsSection } from './SkillsSettingsSection'
import { ToolEnvironmentSettingsSection } from './ToolEnvironmentSettingsSection'
import { PageTabs } from './WorkspacePrimitives'
import type { AppNotificationInput } from './notifications'

type CapabilitySettingsTab = 'skills' | 'mcp' | 'tools'

export function CapabilitiesAndToolsSettingsSection({
  magicNotesEnabled,
  onNotify
}: {
  magicNotesEnabled: boolean
  onNotify?: (notification: AppNotificationInput) => void
}): React.JSX.Element {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] =
    useState<CapabilitySettingsTab>('skills')
  const [mcpVisited, setMcpVisited] = useState(false)
  const [toolsVisited, setToolsVisited] = useState(false)

  return (
    <>
      <SettingsCategoryHeader
        category="capabilities"
        headingId="capabilities-settings-heading"
      />
      <div className="capabilities-settings__tabs">
        <PageTabs
          ariaLabel={t('capabilities.tabs.ariaLabel')}
          idPrefix="capabilities-settings"
          onChange={(tab) => {
            setActiveTab(tab)
            if (tab === 'mcp') {
              setMcpVisited(true)
            }
            if (tab === 'tools') {
              setToolsVisited(true)
            }
          }}
          tabs={[
            {
              id: 'skills',
              label: t('capabilities.tabs.skills')
            },
            {
              id: 'mcp',
              label: t('capabilities.tabs.mcp')
            },
            {
              id: 'tools',
              label: t('capabilities.tabs.tools')
            }
          ]}
          value={activeTab}
          variant="segmented"
        />
      </div>
      <section
        aria-labelledby="capabilities-settings-tab-skills"
        className="capabilities-settings__panel"
        hidden={activeTab !== 'skills'}
        id="capabilities-settings-panel-skills"
        role="tabpanel"
      >
        <SkillsSettingsSection />
      </section>
      <section
        aria-labelledby="capabilities-settings-tab-mcp"
        className="capabilities-settings__panel"
        hidden={activeTab !== 'mcp'}
        id="capabilities-settings-panel-mcp"
        role="tabpanel"
      >
        {mcpVisited && (
          <McpSettingsSection magicNotesEnabled={magicNotesEnabled} />
        )}
      </section>
      <section
        aria-labelledby="capabilities-settings-tab-tools"
        className="capabilities-settings__panel"
        hidden={activeTab !== 'tools'}
        id="capabilities-settings-panel-tools"
        role="tabpanel"
      >
        {toolsVisited && (
          <ToolEnvironmentSettingsSection onNotify={onNotify} />
        )}
      </section>
    </>
  )
}
