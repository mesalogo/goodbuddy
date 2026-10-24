import React from 'react'
import { createRoot } from 'react-dom/client'
import '../../src/renderer/src/i18n'
import { StaticHtmlPreview } from '../../src/renderer/src/StaticHtmlPreview'

const origin = new URL(location.href).searchParams.get('origin')!
const source = `<html><head><link rel="stylesheet" href="${origin}/style.css"></head><body>
<button onclick="this.textContent='Clicked'">Interact</button>
<img src="${origin}/image.svg">
<script src="${origin}/script.js"></script>
<script>
document.body.dataset.inline = 'yes';
try { parent.document.body.dataset.escaped = 'yes' } catch { document.body.dataset.isolated = 'yes' }
fetch('${origin}/api').then(r => r.text()).then(text => document.body.dataset.network = text);
</script></body></html>`
createRoot(document.getElementById('root')!).render(<StaticHtmlPreview source={source} />)
