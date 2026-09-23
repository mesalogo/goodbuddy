import { createRoot } from 'react-dom/client'
import { MermaidDiagram } from '../../src/renderer/src/MermaidDiagram'
import { UiLocaleProvider } from '../../src/renderer/src/i18n/UiLocaleProvider'
import '../../src/renderer/src/fonts'
import '../../src/renderer/src/styles.css'

const params = new URLSearchParams(location.search)
const shape = params.get('shape') ?? 'wide'
const count = shape === 'small' ? 3 : 24
const nodes = Array.from({ length: count }, (_, index) =>
  `N${index}["${index === 0 ? 'START' : index === count - 1 ? 'FINISH' : `Step ${index}`} \u5b8c\u6574\u56fe\u8868"]`)
const source = [
  `flowchart ${shape === 'tall' ? 'TB' : 'LR'}`,
  nodes.join(' --> '),
  'classDef first fill:#ff0000,stroke:#000000,color:#000000;',
  'classDef middle fill:#00ff00,stroke:#000000,color:#000000;',
  'classDef last fill:#0000ff,stroke:#000000,color:#ffffff;',
  'class N0 first;',
  `class N${Math.floor(count / 2)} middle;`,
  `class N${count - 1} last;`
].join('\n')

document.documentElement.dataset.theme = params.get('theme') ?? 'light'
createRoot(document.getElementById('root')!).render(
  <UiLocaleProvider initialPreference={params.get('locale') === 'en-US' ? 'en-US' : 'zh-CN'}>
    <main className="markdown-content" style={{ padding: 16 }}>
      <MermaidDiagram source={source} />
    </main>
  </UiLocaleProvider>
)
