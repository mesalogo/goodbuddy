import { useState } from 'react'
import type { defaultHttpOcrSettings } from '../../shared/document-parsing-contracts'
import { SegmentedControl } from './WorkspacePrimitives'

type HttpSettings = typeof defaultHttpOcrSettings
const booleanOptions = {
  useDocOrientationClassify: '方向分类', useDocUnwarping: '页面去扭曲',
  useLayoutDetection: '版面检测', useChartRecognition: '图表识别',
  useSealRecognition: '印章识别', useOcrForImageBlock: '图片块文字识别',
  prettifyMarkdown: '美化 Markdown', showFormulaNumber: '显示公式编号',
  formatBlockContent: '格式化块内容', mergeLayoutBlocks: '合并版面块', layoutNms: '版面非极大值抑制'
} as const
const labels: Record<string, string> = {
  header: '页眉文字', header_image: '页眉图片', footer: '页脚文字',
  footer_image: '页脚图片', number: '页码', footnote: '脚注', aside_text: '侧栏文字'
}
const numericOptions = {
  layoutThreshold: '版面检测阈值', layoutUnclipRatio: '版面扩展比例',
  repetitionPenalty: '重复惩罚', temperature: '采样温度', topP: 'Top P',
  minPixels: '最小像素数', maxPixels: '最大像素数', maxNewTokens: '最大输出 Token'
} as const

export function HttpOcrSettings({ value, onChange, dirty, credentialConfigured, apiKey, onApiKey,
  clearApiKey, onClearApiKey }: {
  value: HttpSettings; onChange: (value: HttpSettings) => void; dirty: boolean
  credentialConfigured: boolean; apiKey: string; onApiKey: (value: string) => void
  clearApiKey: boolean; onClearApiKey: (value: boolean) => void
}): React.JSX.Element {
  const [checking, setChecking] = useState(false)
  const [check, setCheck] = useState('')
  const [error, setError] = useState('')
  return <section className="settings-section">
    <strong>HTTP PaddleOCR-VL</strong>
    <label className="field"><span>服务地址</span><input type="url" value={value.baseUrl}
      onChange={(event) => onChange({ ...value, baseUrl: event.target.value })} /></label>
    <p className="settings-notice">需要 OCR 的页面或图片将发送到此服务；快速文本模式不自动上传，主动提取图片文字仍使用此服务。</p>
    <label className="field"><span>认证方式</span><select value={value.authentication}
      onChange={(event) => onChange({ ...value, authentication: event.target.value as HttpSettings['authentication'] })}>
      <option value="none">无需认证</option><option value="bearer">Bearer API Key</option>
    </select></label>
    {value.authentication === 'bearer' && <label className="field"><span>API Key</span>
      <input type="password" autoComplete="off" value={apiKey} onChange={(event) => onApiKey(event.target.value)} />
      <small>{credentialConfigured ? '已保存凭据；留空保持原值' : '未配置凭据'}</small>
    </label>}
    {credentialConfigured && <label><input type="checkbox" checked={clearApiKey}
      onChange={(event) => onClearApiKey(event.target.checked)} />保存时清除凭据</label>}
    <button type="button" className="secondary-button" disabled={dirty || checking}
      aria-describedby={dirty ? 'document-parsing-unsaved-notice' : undefined}
      onClick={() => {
        setChecking(true); setError(''); setCheck('')
        void window.goodbuddy.documentParsing!.checkHttp().then((result) => {
          setCheck(`服务可连接，解析能力需用文件测试。检查时间：${new Date(result.checkedAt).toLocaleString()}`)
        }, (reason: unknown) => { setError(reason instanceof Error ? reason.message : '连接检查失败') })
          .finally(() => setChecking(false))
      }}>{checking ? '正在检查连接' : '检查连接'}</button>
    {check && <p role="status">{check}</p>}{error && <p role="alert">{error}</p>}
    <details><summary>HTTP 高级设置</summary>
      <p>高级能力取决于服务部署；接口声明不代表模型已安装或效果已经实测。</p>
      <SegmentedControl ariaLabel="内容过滤" value={value.filterMode}
        options={[{ value: 'default', label: '服务默认' }, { value: 'all', label: '全部保留' }, { value: 'custom', label: '自定义' }]}
        onChange={(filterMode) => onChange({ ...value, filterMode })} />
      {value.filterMode === 'custom' && <>
        <small>未设置自定义排除项时，从全部保留开始。</small>
        {[...new Set([...Object.keys(labels), ...value.ignoredLabels])].map((key) => <label className="toggle-row" key={key}>
          <span>保留{labels[key] ?? key}</span><input type="checkbox" role="switch" checked={!value.ignoredLabels.includes(key)}
            onChange={(event) => onChange({ ...value, ignoredLabels: event.target.checked
              ? value.ignoredLabels.filter((label) => label !== key) : [...value.ignoredLabels, key] })} />
        </label>)}
      </>}
      <div className="document-parsing-grid">
        {Object.entries(booleanOptions).map(([key, label]) => <label className="field" key={key}><span>{label}</span>
          <select value={String(value.options[key as keyof typeof booleanOptions] ?? 'default')}
            onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value === 'default') delete options[key as keyof typeof booleanOptions]
              else options[key as keyof typeof booleanOptions] = event.target.value === 'true'
              onChange({ ...value, options })
            }}><option value="default">服务默认</option><option value="true">开启</option><option value="false">关闭</option></select>
        </label>)}
        <label className="field"><span>HTTP 请求超时（秒）</span><input type="number" min={10} max={300} value={value.timeoutSeconds}
          onChange={(event) => onChange({ ...value, timeoutSeconds: Number(event.target.value) })} /></label>
      </div>
      <details><summary>版面与生成参数</summary><p>留空使用服务默认；接口字段的实际边界与效果需用当前部署测试。</p>
        <div className="document-parsing-grid">
          {Object.entries(numericOptions).map(([key, label]) => <label className="field" key={key}><span>{label}</span>
            <input type="number" step="any" value={value.options[key as keyof typeof numericOptions] ?? ''} onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value === '') delete options[key as keyof typeof numericOptions]
              else options[key as keyof typeof numericOptions] = Number(event.target.value)
              onChange({ ...value, options })
            }} />
          </label>)}
          {(['promptLabel', 'layoutMergeBboxesMode'] as const).map((key) => <label className="field" key={key}><span>{key === 'promptLabel' ? '提示标签' : '边框合并模式'}</span>
            <input value={value.options[key] ?? ''} onChange={(event) => {
              const options = { ...value.options }
              if (event.target.value) options[key] = event.target.value
              else delete options[key]
              onChange({ ...value, options })
            }} /></label>)}
          <label className="field"><span>版面形状</span><select value={value.options.layoutShapeMode ?? ''} onChange={(event) => {
            const options = { ...value.options }
            if (event.target.value) options.layoutShapeMode = event.target.value as NonNullable<typeof options.layoutShapeMode>
            else delete options.layoutShapeMode
            onChange({ ...value, options })
          }}><option value="">服务默认</option>{['rect', 'quad', 'poly', 'auto'].map((mode) => <option key={mode} value={mode}>{mode}</option>)}</select></label>
        </div>
      </details>
      {(['mergeTables', 'relevelTitles'] as const).map((key) => <label className="toggle-row" key={key}>
        <span>{key === 'mergeTables' ? '合并跨页表格' : '调整标题层级'}</span>
        <input type="checkbox" role="switch" checked={value[key]} onChange={(event) => onChange({ ...value, [key]: event.target.checked })} />
      </label>)}
      <small>跨页整理会增加请求；当前部署尚未验证合并效果。来源无法映射时报告未完成并保留逐页结果。</small>
    </details>
  </section>
}
