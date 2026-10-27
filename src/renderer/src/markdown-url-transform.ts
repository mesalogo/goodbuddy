import { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import { resolveWorkspaceLink } from './workspace-link'

// A drive letter or a bare filename followed by :line is not a URL scheme.
// Express it as a path before the standard Markdown URL filter. The workspace
// click handler still checks project ownership and removes location suffixes.
export const markdownUrlTransform: UrlTransform = (url, key, node) => {
  if (node.tagName === 'a' && key === 'href') {
    if (/^[A-Za-z]:[/\\]/u.test(url)) {
      return `/${url.replaceAll('\\', '/')}`
    }
    if (/^[^:/\\?#]+\.[^.:/\\?#]+:\d+(?::\d+)?$/u.test(url) && resolveWorkspaceLink(url)) {
      return `./${url}`
    }
  }
  return defaultUrlTransform(url)
}
