import { useLayoutEffect, useState } from 'react'
import { createMessageEditStore, type MessageEditHost } from './message-edit-store'

export function useMessageEdit(host: MessageEditHost) {
  const [binding] = useState(() => {
    let current = host
    return { store: createMessageEditStore(() => current), connect: (next: MessageEditHost) => { current = next } }
  })
  useLayoutEffect(() => { binding.connect(host) })
  return binding.store
}
