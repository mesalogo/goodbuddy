import type { TranslationShape } from '../../resource-types'
import type { magicNotes as chineseMagicNotes } from '../zh-CN/magicNotes'

export const magicNotes = {
  page: {
    title: 'Magic Notes',
    description:
      'Capture rich text, local media, attachments, and to-do lists globally, with read-only comments from AI.',
    contentLabel: 'Magic Notes content'
  },
  tabs: {
    notes: 'Notes',
    todos: 'To-dos'
  },
  actions: {
    cancel: 'Cancel',
    retry: 'Retry',
    clearFilters: 'Clear filters',
    createNote: 'Create note',
    newNote: 'New note',
    deleteNote: 'Delete note',
    saveEntry: 'Save entry',
    saveChanges: 'Save changes',
    edit: 'Edit',
    deleteEntry: 'Delete entry',
    analyze: 'Analyze with AI',
    analyzeAgain: 'Analyze again',
    analyzing: 'Analyzing…',
    openSourceNote: 'Open source note',
    hideAiComments: 'Hide AI comments',
    showAiComments: 'Show AI comments',
    pinNote: 'Pin note',
    unpinNote: 'Unpin note',
    continueEditing: 'Continue editing',
    discardAndSwitch: 'Discard and switch'
  },
  status: {
    loading: 'Loading',
    loadingNotes: 'Loading notes…',
    loadingTodos: 'Loading to-dos…',
    pinned: 'Pinned',
    preparingComment: 'Preparing comment…',
    commentingDraft: 'Commenting on the current draft…',
    generatingPoints: 'Generating {{direction}} points…',
    generatingDirection: 'Generating · {{direction}}',
    unsavedDraft: 'Unsaved draft'
  },
  notifications: {
    waitForOperation: 'Wait for the current operation to finish',
    noteCreated: 'Note created',
    noteDeleted: 'Note deleted',
    entrySaved: 'Entry saved',
    entryDeleted: 'Entry deleted',
    entryUpdated: 'Entry updated and previous AI comments cleared',
    aiCommentAdded: 'AI comment added',
    todoCompleted: 'To-do completed',
    todoReopened: 'To-do marked incomplete'
  },
  errors: {
    operationFailed: 'The operation failed. Try again.',
    initialLoadTitle: 'Could not load Magic Notes',
    initialLoadDescription: 'Could not load Magic Notes: {{error}}',
    refreshFailed: 'Refresh failed. Current content was preserved: {{error}}',
    detailLoadFailed:
      'Could not load the note. Current content was preserved: {{error}}'
  },
  validation: {
    createNoteTitle: 'Enter a note title',
    noteTitleRequired: 'The note title cannot be empty',
    newEntryRequired: 'Enter some content first',
    entryRequired: 'Entry content cannot be empty'
  },
  notes: {
    listLabel: 'Notes list',
    streamLabel: 'Note entries',
    heading: 'All notes',
    searchLabel: 'Search notes in the current scope',
    searchPlaceholder: 'Search notes',
    titleLabel: 'Note title',
    noMatches: 'No notes match these filters',
    empty: 'No notes yet',
    noPreview: 'No entries yet',
    entryCountOne: '{{count}} entry',
    entryCountOther: '{{count}} entries',
    updatedAt: 'Updated {{date}}',
    emptySelectionTitle: 'No note selected',
    emptySelectionDescription:
      'Select a note on the left, or create a note to start writing.',
    newEntryLabel: 'New entry content',
    composerImmediateHint:
      'Type -, 1., [ ], or [x] then Space to start a list; AI comments after 5 seconds of inactivity',
    composerRichTextHint:
      'Type -, 1., [ ], or [x] then Space to start a list; you can also paste or drop local files',
    emptyEntries: 'No entries yet. Write the first entry above.',
    editEntryLabel: 'Edit entry content',
    entryAt: '{{date}} entry'
  },
  todos: {
    listLabel: 'To-do list',
    detailLabel: 'To-do details',
    heading: 'All to-dos',
    searchLabel: 'Search to-dos in the current scope',
    searchPlaceholder: 'Search to-dos',
    filterLabel: 'Filter to-dos',
    filters: {
      active: 'Incomplete',
      completed: 'Completed',
      all: 'All'
    },
    empty: 'No to-dos yet',
    noMatches: 'No to-dos match these filters',
    emptySelectionTitle: 'No to-do selected',
    emptySelectionDescription:
      'Select a to-do on the left. All to-dos come from note checklists.',
    sourceNote: 'From note: {{title}}',
    defaultInstructions: 'This to-do comes from a checklist in a note.',
    markComplete: 'Mark complete: {{title}}',
    markIncomplete: 'Mark incomplete: {{title}}'
  },
  confirmations: {
    deleteNote: 'Delete “{{title}}” and all of its entries?',
    deleteEntry: 'Delete this entry? This action cannot be undone.',
    discardDraftTitle: 'Discard this unsaved draft?',
    discardDraftDescription:
      'Switching will discard the text and attachments in the current entry draft.'
  },
  comments: {
    paneLabel: 'AI comments',
    closePane: 'Close AI comments pane',
    selectTodoTitle: 'Select a to-do',
    analyzeTodoTitle: 'Analyze this to-do',
    selectNoteTitle: 'Select a note',
    startWritingTitle: 'Write a sentence',
    saveEntryTitle: 'Save an entry for feedback',
    analyzeEntryTitle: 'Analyze an entry',
    directionLabel: 'Comment direction',
    directionAriaLabel: 'AI comment direction',
    directionHelp:
      'Applies only to the next comment. Change the format in Settings.',
    directions: {
      general: 'General feedback',
      expand: 'Expand writing',
      polish: 'Polish and rewrite',
      challenge: 'Challenge and review',
      brainstorm: 'Brainstorm'
    },
    kinds: {
      narrative: 'Long-form comment',
      warning: 'Caution',
      suggestion: 'Suggestion',
      summary: 'Summary'
    },
    selectTodo: 'Select a to-do to show AI comments.',
    analyzeTodoHint:
      'Choose “Analyze with AI” in the to-do details to show comments here.',
    selectNote: 'Select a note to show AI comments.',
    immediateHint:
      'Finish a sentence and stop typing for 5 seconds to show comments here.',
    autoHint: 'AI comments automatically after you save an entry.',
    manualHint:
      'Choose “Analyze with AI” on an entry to show comments here.'
  },
  accessibility: {
    resizeAiPane: 'Resize the editor and AI comments panes',
    aiPaneWidth: 'AI comments pane, {{width}} pixels'
  },
  editor: {
    toolbarLabel: 'Note formatting toolbar',
    imageReadFailed: 'Could not read the image',
    fileReadFailed: 'Could not read the file',
    maxImages: 'Each entry can contain up to {{count}} images',
    maxVideos: 'Each entry can contain up to {{count}} videos',
    maxAttachments: 'Each entry can contain up to {{count}} attachments',
    unsupportedImage:
      'Only JPEG, PNG, GIF, or WebP images smaller than 2 MB are supported',
    unsupportedFile:
      'Images must be under 2 MB, MP4, WebM, Ogg, or MOV videos under 16 MB, and other attachments under 8 MB',
    totalImageSize: 'The images added at once cannot exceed 8 MB in total',
    totalEmbedSize:
      'Images, videos, and attachments in one entry cannot exceed 32 MB in total',
    placeholder: 'Capture ideas, meeting notes, or to-do leads…',
    paragraphStyle: 'Paragraph style',
    heading1: 'Heading 1',
    heading2: 'Heading 2',
    heading3: 'Heading 3',
    body: 'Body',
    fontSize: 'Font size',
    fontSizeSmall: '12',
    fontSizeNormal: '14',
    fontSizeLarge: '18',
    fontSizeHuge: '24',
    textColor: 'Text color',
    bold: 'Bold',
    italic: 'Italic',
    underline: 'Underline',
    strike: 'Strikethrough',
    todoList: 'To-do list',
    bulletList: 'Bulleted list',
    numberedList: 'Numbered list',
    blockquote: 'Block quote',
    codeBlock: 'Code block',
    insertImage: 'Insert local image',
    uploadAttachment: 'Upload video or attachment',
    undo: 'Undo',
    redo: 'Redo',
    contentLabel: 'Note entry content'
  }
} satisfies TranslationShape<typeof chineseMagicNotes>
