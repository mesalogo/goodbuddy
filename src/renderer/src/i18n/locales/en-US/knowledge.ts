import type { TranslationShape } from '../../resource-types'
import type { knowledge as chineseKnowledge } from '../zh-CN/knowledge'

export const knowledge = {
  page: {
    eyebrow: 'Knowledge',
    title: 'Knowledge Base',
    description:
      'Organize files, folders, and web sources into traceable indexes and graphs that work across projects.'
  },
  actions: {
    cancel: 'Cancel',
    createLibrary: 'Create library',
    creating: 'Creating…',
    newLibrary: 'New library',
    saveChanges: 'Save changes',
    saving: 'Saving…',
    confirmDelete: 'Delete library',
    deleting: 'Deleting…',
    importFiles: 'Import files',
    importDirectory: 'Import folder',
    importUrl: 'Import URL',
    import: 'Import',
    pause: 'Pause',
    retry: 'Retry',
    sync: 'Sync',
    remove: 'Remove',
    saveEntity: 'Save entity',
    addEntity: 'Add entity',
    saveRelation: 'Save relation',
    addRelation: 'Add relation',
    reextract: 'Re-extract',
    reextracting: 'Re-extracting…',
    edit: 'Edit',
    delete: 'Delete',
    add: 'Add',
    backToLibraryList: 'Back to library list',
    goToSettings: 'Go to settings'
  },
  fields: {
    name: 'Name',
    description: 'Description',
    storageMode: 'Storage mode',
    graphGenerationStrategy: 'Graph generation strategy',
    graphExtractionStrategy: 'Graph extraction strategy',
    type: 'Type',
    aliases: 'Aliases (comma-separated)',
    source: 'Source',
    target: 'Target',
    relationType: 'Relation type',
    notes: 'Notes'
  },
  storageModes: {
    reference: {
      label: 'Reference original files',
      description:
        'Store only file locations; deleting the library does not delete the original files.'
    },
    managed: {
      label: 'Managed copies',
      description: 'Copy content into storage managed by the app.'
    }
  },
  strategies: {
    rules: 'Rule extraction',
    model: 'Model extraction',
    hybrid: 'Rules and model',
    ask: 'Ask when needed'
  },
  sourceStatuses: {
    queued: 'Waiting to sync',
    syncing: 'Syncing',
    paused: 'Paused',
    ready: 'Synced',
    failed: 'Sync failed'
  },
  documentStatuses: {
    queued: 'Waiting',
    parsing: 'Parsing',
    indexing: 'Indexing',
    ready: 'Indexed',
    failed: 'Processing failed'
  },
  taskKinds: {
    parsing: 'Document parsing',
    embedding: 'Embedding',
    graph: 'Graph extraction'
  },
  taskStatuses: {
    queued: 'Waiting',
    running: 'In progress',
    succeeded: 'Completed',
    failed: 'Failed',
    skipped: 'Skipped'
  },
  format: {
    neverSynced: 'Never synced',
    unknownTime: 'Unknown time',
    unknownSize: 'Unknown size',
    localFile: 'Local file',
    localFileNamed: 'Local file · {{filename}}',
    listSeparator: ', '
  },
  validation: {
    libraryNameRequired: 'Enter a library name.',
    urlRequired: 'Enter a URL.',
    urlInvalid: 'Enter a valid URL.',
    urlProtocol: 'Only HTTP or HTTPS URLs are supported.'
  },
  errors: {
    operationFailed: 'The operation did not finish. Try again.',
    refreshTitle: 'Could not refresh the knowledge base',
    loadTitle: 'Could not load the knowledge base'
  },
  create: {
    ariaLabel: 'Create library',
    eyebrow: 'New library',
    title: 'Create library'
  },
  edit: {
    ariaLabel: 'Edit library',
    formAriaLabel: 'Edit library form',
    title: 'Edit library',
    description:
      'Changing the name or description does not affect sources, indexes, or the knowledge graph.'
  },
  delete: {
    ariaLabel: 'Confirm library deletion',
    title: 'Delete “{{name}}”?',
    managedDescription:
      'This library uses managed storage. Deleting it permanently removes managed copies, indexes, and graphs saved by the app.',
    referenceDescription:
      'This library references original files. Deleting it removes only indexes and graphs, not the original files on disk.',
    triggerAriaLabel: 'Delete library {{name}}'
  },
  graph: {
    title: 'Knowledge graph',
    enable: 'Enable knowledge graph',
    enableDescription:
      'Extract entities, relations, and evidence from documents.',
    unknownEntity: 'Unknown entity',
    selectEntity: 'Select entity',
    sidebar: {
      ariaLabel: 'Graph sidebar',
      topology: 'Topology',
      details: 'Details'
    },
    canvasAriaLabel: 'Knowledge graph canvas',
    searchAriaLabel: 'Search graph entities',
    searchPlaceholder: 'Search entities',
    typeFilterAriaLabel: 'Filter entity type',
    allTypes: 'All types',
    entityPickerAriaLabel: 'Select graph entity',
    zoomOutAriaLabel: 'Zoom out graph',
    zoomInAriaLabel: 'Zoom in graph',
    empty: 'This library does not have any generated entity relations yet.',
    topologyAriaLabel: 'Graph topology',
    visibleRelations: {
      title: 'Visible relations',
      description: 'Updates with the current search and type filter.',
      count: '{{count}} relations',
      empty: 'No relations are visible with the current filters.',
      listAriaLabel: 'Visible relations list'
    },
    addEntityPanelAriaLabel: 'Add entity panel',
    entityDetailsAriaLabel: 'Entity details',
    closeEntityDetailsAriaLabel: 'Close entity details',
    noEntityDescription: 'This entity has no additional description.',
    aliases: 'Aliases: {{aliases}}',
    relations: 'Relations',
    editRelationAriaLabel: 'Edit relation {{type}}',
    deleteRelationAriaLabel: 'Delete relation {{type}}',
    merge: {
      title: 'Merge entities',
      targetAriaLabel: 'Select merge target',
      targetPlaceholder: 'Select the entity to keep',
      actionAriaLabel: 'Merge into target entity'
    },
    evidence: {
      title: 'Evidence ({{count}})',
      empty: 'This entity and its relations have no linked evidence.'
    },
    detailsAriaLabel: 'Graph details',
    detailsPrompt: 'Select a graph node to view entity details.',
    disabledTitle: 'Knowledge graph is disabled',
    disabledDescription:
      'Enable the knowledge graph in Settings to view entity relations and re-extract them.'
  },
  documents: {
    sources: {
      title: 'Content sources',
      description:
        'Imported content is parsed, indexed, and added to the graph automatically.',
      emptyTitle: 'No content sources connected',
      emptyDescription:
        'Choose files, a folder, or a URL, or drag files into the area above.',
      listAriaLabel: 'Content source list'
    },
    importStrategy: 'Graph extraction strategy for this import',
    importStrategies: {
      rules: 'Local rules only',
      model: 'Model only',
      hybrid: 'Rules first, completed by the model'
    },
    urlImport: {
      ariaLabel: 'Import URL',
      addressAriaLabel: 'URL address',
      closeAriaLabel: 'Close URL import'
    },
    dropFiles: 'Drop files here to add them to “{{name}}”',
    sourceMeta: '{{count}} documents · {{time}}',
    syncProgress: '{{name}} sync progress',
    actions: {
      pauseSource: 'Pause {{name}}',
      retrySource: 'Retry {{name}}',
      syncSource: 'Sync {{name}}',
      removeSource: 'Remove source {{name}}'
    },
    table: {
      title: 'Documents and index',
      empty:
        'No documents yet. Processing status appears here after you import a content source.',
      noResults: 'No documents match your search.',
      columns: {
        document: 'Document',
        status: 'Status',
        indexProgress: 'Index progress',
        chunks: 'Chunks',
        size: 'Size'
      }
    },
    search: {
      label: 'Search documents',
      placeholder: 'Search names or paths'
    },
    indexProgress: '{{name}} index progress'
  },
  entityEditor: {
    editAriaLabel: 'Edit entity',
    addAriaLabel: 'Add entity'
  },
  relationEditor: {
    editAriaLabel: 'Edit relation',
    addAriaLabel: 'Add relation'
  },
  settings: {
    description:
      'Choose whether to extract entities, relations, and evidence from library documents.',
    enableDescription:
      'When enabled, newly imported and resynced documents use the selected graph strategy.',
    strategyAriaLabel: 'Knowledge graph extraction strategy',
    askDescription:
      '“Ask when needed” does not generate a graph automatically and cannot run re-extraction.'
  },
  tasks: {
    emptyDescription:
      'Import or sync documents to track parsing, embedding, and graph extraction here.',
    emptyTitle: 'No knowledge tasks yet',
    title: 'Task center',
    recentCount: '{{count}} recent tasks',
    activeCount: '{{count}} in progress',
    failedCount: '{{count}} failed',
    progressAriaLabel: '{{name}} {{kind}} progress',
    waiting: 'Waiting to process'
  },
  tabs: {
    documents: 'Documents and sources',
    graph: 'Knowledge graph',
    tasks: 'Task center',
    settings: 'Settings'
  },
  workspace: {
    ariaLabel: 'Knowledge workspace',
    libraryList: 'Library list',
    libraryListEmpty:
      'Create a library to manage reusable sources, indexes, and entity relations.',
    libraryMeta: '{{count}} documents · {{storageMode}}',
    detailsAriaLabel: 'Library details',
    tabsAriaLabel: 'Knowledge base views',
    scopeGlobal: 'Global',
    librarySummary:
      '{{sourceCount}} sources, {{indexedCount}}/{{documentCount}} documents indexed.'
  },
  loading: {
    title: 'Loading knowledge base',
    description: 'Reading libraries, sources, and index status.'
  },
  empty: {
    title: 'Create your first library',
    description:
      'Organize files, folders, and web sources into traceable indexes and graphs that work across projects.'
  },
  graphChart: {
    ariaLabel: 'Entity relation graph',
    renderError: 'Graph rendering failed',
    relation: 'Relation',
    errorWithContext: 'Graph rendering failed: {{error}}'
  }
} satisfies TranslationShape<typeof chineseKnowledge>
