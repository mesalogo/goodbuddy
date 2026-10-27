import { useEffect, useState, useSyncExternalStore } from 'react'
import { shareServerConnection } from './shareserver-connection-store'

export function ShareServerConnectionSettings(): React.JSX.Element {
  const state = useSyncExternalStore(shareServerConnection.subscribe, shareServerConnection.getState)
  const [address, setAddress] = useState('')
  useEffect(() => {
    let mounted = true
    void shareServerConnection.load().then(value => {
      if (mounted) setAddress(current => current || value)
    }).catch(() => { /* load() exposes the error in the shared connection state. */ })
    return () => { mounted = false }
  }, [])
  return <section className="settings-section" aria-label="ShareServer 连接">
    <h3>ShareServer 连接</h3>
    <p>所有文件在线编辑入口共用此连接。服务器需要启用 Office 能力；支持内网 IP 和端口。</p>
    {state.serverUrl && <p>当前保存的连接：{state.serverUrl}</p>}
    <label className="field">ShareServer 地址
      <input type="url" value={address} placeholder="http://主机IP:8088" disabled={state.checking} onChange={event => setAddress(event.target.value)} />
    </label>
    <button type="button" className="secondary-button" disabled={state.checking || !address.trim()} onClick={() => void shareServerConnection.connect(address)}>
      {state.checking ? '正在检查…' : '连接并检查能力'}
    </button>
    {state.capabilities && <p role="status">{state.capabilities.enabled
      ? `Office 已启用；支持 ${state.capabilities.formats.join('、')}；上传上限 ${Math.floor(state.capabilities.maxBytes / 1024 / 1024)} MiB${state.capabilities.versionedDownload ? '' : '；请升级服务以支持版本下载'}`
      : '已连接 ShareServer，但服务器未启用 Office 在线编辑。'}</p>}
    {state.capabilities?.conversions && <p>转换后编辑：{Object.entries(state.capabilities.conversions).map(([from, to]) => `${from} → ${to}`).join('、')}。转换结果另存为，保留原文件。</p>}
    {state.error && <p role="alert" className="settings-error">{state.error}</p>}
  </section>
}
