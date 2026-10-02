import type {
  KnowledgeGraphNode,
  KnowledgeEntityUpdate,
  KnowledgeRelationInput,
  KnowledgeGraphRelation
} from './types'
import {
  type KnowledgeOntologySettings,
  getKnowledgeOntologyDisplayDefinitions,
  normalizeEntityTypeAlias,
  normalizeRelationTypeAlias,
  isRelationEndpointAllowed
} from '../../../shared/knowledge-ontology'
import { useTranslation } from 'react-i18next'
import { useMemo, useState } from 'react'
import { resolvedLocale } from './formatting'
import { parseAliases } from './helpers'
import { useWorkspaceUnsavedChanges } from '../workspace-unsaved-changes'

export function EntityEditor({
  node,
  ontology,
  onCancel,
  onSave
}: {
  node?: KnowledgeGraphNode
  ontology: KnowledgeOntologySettings
  onCancel: () => void
  onSave: (update: KnowledgeEntityUpdate) => void | Promise<void>
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const display = useMemo(
    () =>
      getKnowledgeOntologyDisplayDefinitions(
        ontology,
        resolvedLocale(i18n.resolvedLanguage ?? i18n.language) === 'zh-CN'
          ? 'zh'
          : 'en'
      ),
    [i18n.language, i18n.resolvedLanguage, ontology]
  )
  const [label, setLabel] = useState(node?.label ?? '')
  const [type, setType] = useState(
    normalizeEntityTypeAlias(node?.type, ontology)
  )
  const [description, setDescription] = useState(node?.description ?? '')
  const [aliases, setAliases] = useState(
    (node?.aliases ?? []).join(t('format.listSeparator'))
  )
  const [initial] = useState(() => ({ label, type, description, aliases }))
  useWorkspaceUnsavedChanges(
    label !== initial.label ||
      type !== initial.type ||
      description !== initial.description ||
      aliases !== initial.aliases
  )

  return (
    <form
      aria-label={
        node ? t('entityEditor.editAriaLabel') : t('entityEditor.addAriaLabel')
      }
      className="knowledge-graph__form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSave({
          label: label.trim(),
          type: type.trim(),
          description: description.trim(),
          aliases: parseAliases(aliases)
        })
      }}
    >
      <label className="knowledge-field">
        {t('fields.name')}
        <input
          onChange={(event) => setLabel(event.currentTarget.value)}
          required
          value={label}
        />
      </label>
      <label className="knowledge-field">
        {t('fields.type')}
        <select
          onChange={(event) => setType(event.currentTarget.value)}
          required
          value={type}
        >
          {display.entityTypes.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label} ({definition.id})
            </option>
          ))}
        </select>
      </label>
      <label className="knowledge-field">
        {t('fields.description')}
        <textarea
          onChange={(event) => setDescription(event.currentTarget.value)}
          rows={3}
          value={description}
        />
      </label>
      <label className="knowledge-field">
        {t('fields.aliases')}
        <input
          onChange={(event) => setAliases(event.currentTarget.value)}
          value={aliases}
        />
      </label>
      <div className="knowledge-graph__form-actions">
        <button className="primary-button">
          {node ? t('actions.saveEntity') : t('actions.addEntity')}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          type="button"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </form>
  )
}

export function RelationForm({
  nodes,
  ontology,
  onCancel,
  onSave,
  relation,
  sourceId
}: {
  nodes: readonly KnowledgeGraphNode[]
  ontology: KnowledgeOntologySettings
  onCancel: () => void
  onSave: (
    input: KnowledgeRelationInput
  ) => void | Promise<void>
  relation?: KnowledgeGraphRelation
  sourceId: string
}): React.JSX.Element {
  const { i18n, t } = useTranslation('knowledge')
  const display = useMemo(
    () =>
      getKnowledgeOntologyDisplayDefinitions(
        ontology,
        resolvedLocale(i18n.resolvedLanguage ?? i18n.language) === 'zh-CN'
          ? 'zh'
          : 'en'
      ),
    [i18n.language, i18n.resolvedLanguage, ontology]
  )
  const [source, setSource] = useState(relation?.sourceId ?? sourceId)
  const [target, setTarget] = useState(
    relation?.targetId ??
      nodes.find((node) => node.id !== sourceId)?.id ??
      ''
  )
  const [type, setType] = useState(
    normalizeRelationTypeAlias(relation?.type, ontology) ?? ''
  )
  const [description, setDescription] = useState(
    relation?.description ?? ''
  )
  const [initial] = useState(() => ({ source, target, type, description }))
  useWorkspaceUnsavedChanges(
    source !== initial.source ||
      target !== initial.target ||
      type !== initial.type ||
      description !== initial.description
  )
  const sourceNode = nodes.find((node) => node.id === source)
  const targetNode = nodes.find((node) => node.id === target)
  const allowedRelationTypes = display.relationTypes.filter(
    (definition) =>
      !sourceNode ||
      !targetNode ||
      isRelationEndpointAllowed(
        definition.id,
        sourceNode.type,
        targetNode.type,
        ontology
      )
  )
  const selectedType = allowedRelationTypes.some(
    (definition) => definition.id === type
  )
    ? type
    : ''

  return (
    <form
      aria-label={
        relation
          ? t('relationEditor.editAriaLabel')
          : t('relationEditor.addAriaLabel')
      }
      className="knowledge-graph__relation-form"
      onSubmit={(event) => {
        event.preventDefault()
        void onSave({
          sourceId: source,
          targetId: target,
          type: type.trim(),
          description: description.trim()
        })
      }}
    >
      <label className="knowledge-field">
        {t('fields.source')}
        <select
          onChange={(event) => setSource(event.currentTarget.value)}
          required
          value={source}
        >
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      <label className="knowledge-field">
        {t('fields.target')}
        <select
          onChange={(event) => setTarget(event.currentTarget.value)}
          required
          value={target}
        >
          <option disabled value="">
            {t('graph.selectEntity')}
          </option>
          {nodes.map((node) => (
            <option key={node.id} value={node.id}>
              {node.label}
            </option>
          ))}
        </select>
      </label>
      <label className="knowledge-field">
        {t('fields.relationType')}
        <select
          onChange={(event) => setType(event.currentTarget.value)}
          required
          value={selectedType}
        >
          <option disabled value="">
            {t('relationEditor.selectType')}
          </option>
          {allowedRelationTypes.map((definition) => (
            <option key={definition.id} value={definition.id}>
              {definition.label} ({definition.id})
            </option>
          ))}
        </select>
        {allowedRelationTypes.length === 0 && (
          <span className="knowledge-settings__field-help">
            {t('relationEditor.noCompatibleTypes')}
          </span>
        )}
      </label>
      <label className="knowledge-field">
        {t('fields.notes')}
        <input
          onChange={(event) =>
            setDescription(event.currentTarget.value)
          }
          value={description}
        />
      </label>
      <div className="knowledge-graph__form-actions">
        <button className="primary-button">
          {relation ? t('actions.saveRelation') : t('actions.addRelation')}
        </button>
        <button
          className="secondary-button"
          onClick={onCancel}
          type="button"
        >
          {t('actions.cancel')}
        </button>
      </div>
    </form>
  )
}
