import type { TranslationShape } from '../../resource-types'
import type { knowledge as chineseKnowledge } from '../zh-CN/knowledge'

export const knowledge = {
  page: {
    eyebrow: 'Knowledge',
    title: 'Knowledge Base',
    description: 'Manage files, folders, and web sources, then inspect their indexes and graph.'
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
    viewTasks: 'View tasks',
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
    sourceSync: 'Source sync',
    documentProcess: 'Document processing',
    documentRebuild: 'Document rebuild',
    libraryRebuild: 'Library rebuild',
    embeddingRebuild: 'Embedding index rebuild',
    graphRebuild: 'Knowledge graph rebuild',
    parsing: 'Document parsing',
    embedding: 'Embedding',
    graph: 'Graph extraction'
  },
  taskStages: {
    queued: 'Waiting to start',
    syncing: 'Syncing source',
    reading: 'Reading content',
    parsing: 'Parsing document',
    chunking: 'Creating chunks',
    indexing: 'Building index',
    embedding: 'Creating embeddings',
    graph: 'Extracting graph',
    finalizing: 'Finalizing'
  },
  taskStatuses: {
    queued: 'Waiting',
    running: 'In progress',
    succeeded: 'Completed',
    failed: 'Failed',
    cancelled: 'Cancelled',
    skipped: 'Skipped',
    interrupted: 'Interrupted'
  },
  taskScopes: {
    library: 'Library scope',
    source: 'Source scope',
    document: 'Document scope'
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
  retrieval: {
    eyebrow: 'Current library: {{libraryName}}',
    title: 'Retrieval test',
    description:
      'Validate retrieval from this library with temporary settings. This test does not create a conversation, call an LLM, or modify knowledge content.',
    close: 'Close retrieval test',
    query: {
      title: 'Test question',
      help: 'Enter a real question to inspect channels, ranking, and final context.',
      label: 'Retrieval question',
      placeholder: 'For example: How do I configure document parsing offline?',
      count: '{{count}} / 4000 characters'
    },
    pipeline: {
      recall: {
        title: 'Recall candidates',
        summary: 'Up to {{count}} fused candidates',
        pending: 'Enter valid settings to calculate'
      },
      rerank: {
        title: 'Local reranking',
        enabled: 'Rerank up to {{count}} candidates',
        disabled: 'Off; keep fused ranking'
      },
      select: {
        title: 'Final results',
        summary: 'Keep the top {{count}} chunks'
      },
      context: {
        title: 'Assemble context',
        summary: '{{count}} character budget'
      }
    },
    settings: {
      title: 'Settings for this test',
      temporary:
        'These changes apply only to this test. Save them as the current library defaults to keep using them.',
      groups: {
        recall: {
          title: 'Candidate recall',
          description:
            'Control the initial search pool, filtering threshold, and each channel’s influence on fused ranking.'
        },
        output: {
          title: 'Reranking and context',
          description:
            'Control candidate ordering, final result count, and the context sent to the model.'
        }
      },
      candidateMultiplier: 'Recall multiplier',
      candidateMultiplierHelp:
        'From 2 to 10; currently recalls up to {{count}} fused candidates',
      channelWeights: 'Channel fusion share (100% total)',
      topK: 'Final result count',
      topKHelp: 'Keep 1 to 20 results after reranking',
      vectorSimilarity: 'Minimum vector similarity (%)',
      vectorSimilarityHelp:
        'From 0% to 100%; 0% keeps all non-negative similarities',
      ftsWeight: 'Full-text share',
      vectorWeight: 'Vector share',
      graphWeight: 'Graph share',
      weightHelp:
        'Used as a relative fusion share; available channels should normally total 100%',
      graphUnavailable:
        'The graph is disabled for this library, so this weight is not currently used.',
      contextBudget: 'Context character budget',
      contextBudgetHelp: 'From 2,000 to 48,000',
      adjacentCount: 'Adjacent chunk count',
      adjacentCountHelp: 'Merge 0 to 2 chunks before and after each match',
      localRerank: 'Enable local reranking',
      localRerankHelp:
        'Deterministically rerank every fused candidate recalled for this run without calling another AI model, so no separate rerank count is needed.',
      rerankMode: 'Reranking method',
      rerankModeHelp:
        'Learned reranking calls the configured Cohere/Jina-compatible model and reports safe fallback details.',
      rerankModes: {
        none: 'No reranking',
        local: 'Local rules',
        learned: 'Learned model'
      }
    },
    validation: {
      queryRequired: 'Enter a test question.',
      queryTooLong: 'The test question cannot exceed 4,000 characters.',
      topK: 'Top K must be an integer from 1 to 20.',
      candidateMultiplier:
        'The recall multiplier must be an integer from 2 to 10.',
      vectorSimilarity:
        'Minimum vector similarity must be between 0% and 100%.',
      weight: 'Channel fusion shares must be between 0% and 100%.',
      weightTotal:
        'Fusion shares for the available retrieval channels must total 100%.',
      activeWeight:
        'At least one currently available retrieval channel must have a weight greater than 0.',
      contextBudget:
        'The context budget must be an integer from 2,000 to 48,000.',
      adjacentCount:
        'The adjacent chunk count must be an integer from 0 to 2.'
    },
    actions: {
      test: 'Test retrieval',
      running: 'Retrieving…',
      saveDefaults: 'Save as defaults',
      savingDefaults: 'Saving…',
      viewContext: 'View chunk',
      openSource: 'Open source'
    },
    states: {
      runningTitle: 'Searching the current library',
      runningDescription:
        'Scanning bounded candidates and assembling context.',
      errorTitle: 'Retrieval test failed',
      errorDescription:
        'Check the library index status or adjust the settings, then try again.'
    },
    channels: {
      fts: 'Full text',
      cjk: 'CJK',
      vector: 'Vector',
      graph: 'Graph'
    },
    diagnostics: {
      duration: 'Total duration',
      milliseconds: '{{count}} ms',
      requested: 'Requested channels',
      used: 'Used channels',
      none: 'None',
      vectorScanned: 'Vectors scanned',
      channelSummary: '{{candidates}} candidates · {{duration}} ms',
      degradedTitle: 'This retrieval was degraded',
      rerank: 'Reranking',
      rerankSummary:
        'Requested {{requested}}, used {{used}} · {{status}} · {{count}} candidates · {{duration}} ms',
      rerankStatuses: {
        skipped: 'Skipped',
        applied: 'Applied',
        fallback: 'Fallback',
        failed: 'Failed'
      }
    },
    zero: {
      'empty-library': {
        title: 'This library has no searchable content',
        description:
          'Import and finish indexing a document before testing again.'
      },
      'index-unavailable': {
        title: 'The current index is unavailable',
        description:
          'Check parsing and index status, repair failed items, and try again.'
      },
      'no-match': {
        title: 'No relevant content found',
        description:
          'Try different keywords, use a specific name from the source, or increase Top K.'
      },
      filtered: {
        title: 'Results were removed by the threshold',
        description:
          'Lower the minimum vector similarity or check the channel weights, then try again.'
      }
    },
    results: {
      title: 'Retrieval results ({{count}})',
      contextSummary:
        'Final context: {{count}} / {{budget}} characters',
      truncated: 'Truncated',
      listAriaLabel: 'Retrieval results',
      resultAriaLabel: 'Result {{rank}}, {{documentName}}',
      unknownLocator: 'Unknown location',
      relevance: 'Relevance',
      fusedScore: 'Fused score',
      channelDetail:
        'Rank {{rank}} · raw score {{score}} · similarity {{similarity}}',
      beforeRerank: 'Rank before reranking',
      context: 'Context',
      contextDetail: '{{count}} characters · {{truncated}}',
      complete: 'Complete',
      diagnostics: 'Result diagnostics',
      actualContext: 'View actual context'
    }
  },
  chunks: {
    title: 'Document chunks',
    documentUnavailable:
      'The document for this retrieval result is currently unavailable.',
    description:
      'Search, preview, and maintain the bounded chunk list for this document.',
    close: 'Close document chunks',
    listAriaLabel: 'Document chunk list',
    syncWarningTitle: 'Manual changes may be replaced.',
    syncWarning:
      'Syncing the source or rebuilding the document may recreate chunks from the original content. Deleting a chunk does not delete the original file.',
    search: {
      label: 'Search chunks in this document',
      placeholder: 'Search headings, locations, or content',
      action: 'Search'
    },
    loadErrorTitle: 'The chunk operation did not finish',
    loadingTitle: 'Loading chunks',
    loadingDescription: 'Reading chunks on the current page.',
    zeroTitle: 'No chunks match',
    zeroDescription:
      'Change the search query or rebuild the document to regenerate chunks.',
    ordinal: 'Chunk {{count}}',
    headingSeparator: ' · {{heading}}',
    parentMetadata: ' · parent {{parentId}}',
    unknownLocator: 'Unknown location',
    characterCount: '{{count}} characters',
    enabled: 'Include in retrieval',
    enabledAriaLabel: 'Enable chunk {{count}}',
    roles: {
      standalone: 'Standalone',
      parent: 'Parent',
      child: 'Child'
    },
    pagination: {
      ariaLabel: 'Chunk pagination',
      previous: 'Previous chunk page',
      next: 'Next chunk page',
      summary: 'Page {{page}} of {{total}}, {{count}} total'
    },
    editor: {
      title: 'Edit chunk {{count}}',
      metadata: '{{role}} · {{locator}}',
      manuallyEdited: 'Manually edited',
      role: 'Chunk role',
      parent: 'Parent chunk ID',
      content: 'Chunk content',
      count: '{{count}} / {{max}} characters',
      save: 'Save chunk',
      saving: 'Saving…',
      noSelectionTitle: 'Select a chunk',
      noSelectionDescription:
        'Select a chunk from the list to view its complete content and parent-child relationship.'
    },
    validation: {
      contentRequired: 'Chunk content cannot be empty.',
      contentTooLong: 'Chunk content cannot exceed {{count}} characters.'
    },
    delete: {
      trigger: 'Delete chunk',
      triggerAriaLabel: 'Delete chunk {{count}}',
      confirmAriaLabel: 'Confirm deletion of chunk {{count}}',
      confirm: 'Delete chunk',
      deleting: 'Deleting…',
      message:
        'Deleting chunk {{count}} removes its full-text, CJK, vector, and graph evidence. A source sync or rebuild may recreate it; the original file is not deleted.'
    },
    rebuild: {
      action: 'Rebuild document',
      running: 'Rebuilding…',
      description:
        'Rebuilding reads the source again; a failed rebuild should preserve the last usable index.'
    }
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
    fitView: 'Show all',
    interactionHint:
      'Drag nodes to arrange them. Drag the canvas to pan, and use the wheel to zoom.',
    empty: 'This library does not have any generated entity relations yet.',
    chunk: {
      loading: 'Loading knowledge graph…',
      loadFailed: 'The knowledge graph could not load. Try again.'
    },
    topologyAriaLabel: 'Graph topology',
    visibleRelations: {
      title: 'Visible relations',
      description: 'Shows relations in the current filter results.',
      count: '{{count}} relations',
      empty: 'No relations are visible with the current filters.',
      listAriaLabel: 'Visible relations list'
    },
    addEntityPanelAriaLabel: 'Add entity panel',
    entityDetailsAriaLabel: 'Entity details',
    deleteEntityAriaLabel: 'Delete entity {{name}}',
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
    confirm: {
      processing: 'Working…',
      deleteEntity: {
        title: 'Delete entity “{{name}}”?',
        description:
          'This permanently deletes “{{name}}”, its {{count}} connected relations, and their graph evidence references. It cannot be undone.',
        action: 'Delete entity'
      },
      deleteRelation: {
        title: 'Delete relation “{{type}}”?',
        description:
          'This permanently deletes the “{{type}}” relation from “{{source}}” to “{{target}}” and its graph evidence references. Both entities remain. It cannot be undone.',
        action: 'Delete relation'
      },
      merge: {
        title: 'Merge “{{source}}” into “{{target}}”?',
        description:
          'Relations, aliases, and evidence from “{{source}}” are moved into “{{target}}”, then the source entity is deleted. This cannot be undone.',
        action: 'Merge entities'
      }
    },
    evidence: {
      title: 'Evidence ({{count}})',
      empty: 'This entity and its relations have no linked evidence.'
    },
    detailsAriaLabel: 'Graph details',
    detailsPrompt: 'Select a graph node to view entity details.',
    workspace: {
      tabsAriaLabel: 'Knowledge graph workspace',
      explore: 'Graph explorer',
      settings: 'Graph settings'
    }
  },
  documents: {
    sources: {
      title: 'Content sources',
      description:
        'Imported content is parsed and added to the retrieval index automatically.',
      descriptionWithGraph:
        'Imported content is parsed, indexed for retrieval, and added to the knowledge graph with the current strategy.',
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
        processingStatus: 'Processing status',
        chunks: 'Chunks',
        size: 'Size',
        actions: 'Actions'
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
    addAriaLabel: 'Add relation',
    selectType: 'Select a relation type',
    noCompatibleTypes:
      'No relation type allows the current source and target types.'
  },
  settings: {
    description:
      'Choose whether to extract entities, relations, and evidence from library documents.',
    enableDescription:
      'When enabled, newly imported and resynced documents use the selected graph strategy.',
    strategyAriaLabel: 'Knowledge graph extraction strategy',
    askDescription:
      '“Ask when needed” does not generate a graph automatically and cannot run re-extraction.',
    graphCapability: {
      title: 'Optional capabilities',
      description:
        'Enable extra capabilities when needed. Disabled capabilities stay out of the workspace.',
      enabledDescription:
        'The knowledge graph is enabled. Explore relations and manage graph settings from Knowledge graph.',
      disabledDescription:
        'Enable it to expose graph exploration, extraction strategy, and ontology definitions.'
    },
    graphConfiguration: {
      title: 'Extraction method',
      description:
        'Control how new imports, resyncs, and explicit rebuilds generate entities, relations, and evidence.'
    },
    chunking: {
      title: 'Chunking strategy',
      description:
        'Configure chunking for future imports and rebuilds. Saving does not immediately rewrite existing documents.',
      mode: 'Chunking mode',
      modes: {
        fixed: 'Fixed length',
        structure: 'Document structure',
        parentChild: 'Parent-child'
      },
      targetCharacters: 'Target characters',
      overlapCharacters: 'Overlap characters',
      contextualIndexing: 'Enable contextual indexing',
      contextualIndexingDescription:
        'Add the document title, heading path, page, and block type to retrieval and embedding text while keeping citations source-faithful.',
      parentCharacters: 'Parent chunk characters',
      childCharacters: 'Child chunk characters',
      rebuildRequired:
        'Settings changed. Rebuild existing documents to apply them everywhere.',
      save: 'Save chunking settings',
      saving: 'Saving…',
      rebuild: 'Rebuild entire library',
      rebuilding: 'Rebuilding…',
      cancelRebuild: 'Cancel rebuild'
    },
    ontology: {
      title: 'Ontology definitions',
      description:
        'Control entity types, relation types, and relation endpoint constraints for this library. IDs use uppercase letters, numbers, and underscores.',
      entityTypes: 'Entity types',
      relationTypes: 'Relation types',
      id: 'Canonical ID',
      nameZh: 'Chinese name',
      nameEn: 'English name',
      aliases: 'Aliases (comma-separated, up to 32)',
      sourceTypes: 'Allowed source types',
      targetTypes: 'Allowed target types',
      anyEndpoint: 'Allow any entity type',
      anyEndpointHelp: 'No endpoint constraint is set.',
      save: 'Save ontology definitions',
      saving: 'Saving…',
      validation:
        'Fix duplicate IDs, duplicate aliases, empty names, or invalid endpoint constraints.',
      rebuildRequired:
        'Ontology definitions changed. Explicitly rebuild existing documents to normalize the current graph again.',
      noImplicitRebuild:
        'Saving updates only this library’s settings. It does not rebuild documents or the graph automatically.'
    },
    vectorIndex: {
      title: 'Embedding index',
      description:
        'Review coverage for this library with the current embedding model and rebuild only this library.',
      rebuild: 'Rebuild embedding index',
      rebuilding: 'Rebuilding…',
      cancel: 'Cancel rebuild',
      cancelAria: 'Cancel this library embedding index rebuild',
      loading: 'Loading embedding index status…',
      disabledTitle: 'Embedding model is disabled',
      disabledDescription:
        'Enable and save an embedding model under Model connections, then return here to rebuild this library.',
      currentModel: 'Current embedding model',
      coverage: {
        indexed: 'Indexed',
        missing: 'Missing',
        error: 'Error',
        total: 'Total documents'
      },
      statuses: {
        queued: 'Waiting to rebuild',
        running: 'Rebuilding',
        completed: 'Last rebuild succeeded',
        failed: 'Last rebuild failed',
        cancelled: 'Last rebuild was cancelled'
      },
      progressAria: 'Current library embedding index rebuild progress',
      progress: '{{completed}} / {{total}} documents completed',
      preparing: 'Preparing documents…',
      completedAt:
        '{{completed}} / {{total}} documents completed. {{date}}',
      atomicNotice:
        'Each document is updated atomically. If cancelled, completed documents keep new embeddings and all others remain unchanged.',
      cancelledNotice:
        '{{completed}} / {{total}} documents completed. All others remain unchanged.',
      defaultRemedy:
        'Check the embedding model configuration and network connection, then retry.',
      activeTitle: 'An embedding index task is running',
      activeDescription:
        'Open the Task center for details, progress, and available actions.',
      viewTasks: 'View details in Task center'
    }
  },
  tasks: {
    emptyDescription:
      'Import or sync documents to track parsing, embedding, and graph extraction here.',
    emptyTitle: 'No knowledge tasks yet',
    title: 'Task center',
    recentCount: '{{count}} recent tasks',
    totalCount: '{{count}} tasks',
    activeCount: '{{count}} in progress',
    failedCount: '{{count}} failed',
    historyCount: '{{count}} in history',
    progressAriaLabel: '{{name}} {{kind}} progress',
    waiting: 'Waiting to process',
    currentStage: 'Current stage',
    itemProgress: '{{completed}} / {{total}} items',
    errorTitle: 'Task failed',
    defaultRemedy: 'Check the related configuration or source, then retry.',
    noResultsTitle: 'No tasks match',
    noResultsDescription:
      'Choose another filter or clear the current object filter.',
    filters: {
      ariaLabel: 'Filter knowledge tasks',
      all: 'All',
      active: 'Active',
      failed: 'Failed',
      history: 'History'
    },
    context: {
      active: 'Showing tasks related to the current source or document',
      clear: 'Clear object filter'
    },
    actionErrors: {
      cancelTitle: 'Could not cancel task',
      retryTitle: 'Could not retry task',
      recovery:
        'The task and filters were preserved. Resolve the issue and try again.'
    },
    actions: {
      expand: 'Expand stage tasks for {{name}}',
      collapse: 'Collapse stage tasks for {{name}}',
      cancel: 'Cancel task',
      cancelling: 'Cancelling…',
      retry: 'Retry task',
      retrying: 'Retrying…'
    }
  },
  tabs: {
    documents: 'Documents and sources',
    graph: 'Knowledge graph',
    tasks: 'Task center',
    settings: 'Index and retrieval'
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
