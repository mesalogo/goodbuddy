import { createContext } from 'react'

export const DocumentConversationContext = createContext<{
  activeId?: string
  create: () => Promise<{ id: string; title: string }>
  navigate: (id: string) => void
  notify: (message: string) => void
  openImage: (src: string, title: string, trigger: HTMLElement) => void
} | undefined>(undefined)
