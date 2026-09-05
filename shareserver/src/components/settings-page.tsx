import {
  Braces,
  CheckCircle2,
  CloudCog,
  Database,
  KeyRound,
  Mail,
  RadioTower,
  Save,
  ShieldCheck
} from 'lucide-react'
import { useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { PrototypeSnapshot } from '../../shared/prototype-data'
import { PageHeader } from './page-header'
import { Button } from './ui/button'
import { StatusBadge } from './ui/status-badge'

function SettingCard({
  icon: Icon,
  title,
  description,
  children
}: {
  icon: LucideIcon
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-white/[0.075] bg-[var(--panel)] p-5">
      <header className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-cyan-300/15 bg-cyan-300/[0.065] text-cyan-300">
          <Icon className="size-5" />
        </span>
        <div>
          <h2 className="text-sm font-semibold text-[var(--text-strong)]">{title}</h2>
          <p className="mt-1 text-xs leading-5 text-[var(--text-muted)]">{description}</p>
        </div>
      </header>
      <div className="mt-5 border-t border-white/[0.06] pt-5">{children}</div>
    </section>
  )
}

function Toggle({
  label,
  description,
  checked,
  onChange
}: {
  label: string
  description: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4 rounded-xl p-2 outline-none hover:bg-white/[0.025]">
      <span>
        <span className="block text-sm font-medium text-[var(--text-primary)]">{label}</span>
        <span className="mt-1 block text-xs leading-5 text-[var(--text-muted)]">{description}</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="peer sr-only"
      />
      <span className="relative mt-0.5 h-6 w-11 shrink-0 rounded-full border border-white/10 bg-slate-700 transition peer-checked:border-cyan-300/30 peer-checked:bg-cyan-400/80 peer-focus-visible:ring-2 peer-focus-visible:ring-cyan-400/70 after:absolute after:left-0.5 after:top-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition-transform peer-checked:after:translate-x-5" />
    </label>
  )
}

export function SettingsPage({ snapshot }: { snapshot: PrototypeSnapshot }) {
  const [relay, setRelay] = useState(true)
  const [federation, setFederation] = useState(true)
  const [oidc, setOidc] = useState(false)
  const [saved, setSaved] = useState(false)

  return (
    <>
      <PageHeader
        eyebrow="实例范围"
        title="系统设置"
        description="管理实例公开信息与功能开关。数据库连接、主密钥和容器挂载路径只从部署环境读取。"
        action={
          <Button
            onClick={() => {
              setSaved(true)
              window.setTimeout(() => setSaved(false), 4500)
            }}
          >
            <Save className="size-4" />
            保存设置
          </Button>
        }
      />
      {saved ? (
        <div role="status" className="mb-5 rounded-xl border border-emerald-400/20 bg-emerald-400/[0.07] px-4 py-3 text-sm text-emerald-200">
          原型设置已保存到当前浏览器会话，不会写入生产配置。
        </div>
      ) : null}
      <div className="grid gap-5 xl:grid-cols-2">
        <SettingCard
          icon={CloudCog}
          title="实例信息"
          description="公开名称、地址与协议协商信息。"
        >
          <div className="grid gap-4">
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">实例名称</span>
              <input
                defaultValue={snapshot.instance.name}
                className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.025] px-3 text-sm outline-none focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-400/10"
              />
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">公开地址</span>
              <input
                defaultValue="https://share.mesalab.internal"
                className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.025] px-3 font-mono text-xs outline-none focus:border-cyan-300/40 focus:ring-2 focus:ring-cyan-400/10"
              />
            </label>
            <div className="flex items-center justify-between rounded-xl bg-white/[0.025] px-3 py-2.5">
              <span className="text-xs text-[var(--text-muted)]">{snapshot.instance.protocol}</span>
              <StatusBadge status="兼容" tone="online" />
            </div>
          </div>
        </SettingCard>

        <SettingCard
          icon={Database}
          title="基础设施"
          description="状态可见，敏感连接信息不在 Web 控制台回显。"
        >
          <div className="space-y-2">
            {[
              ['PostgreSQL', '正常', '主数据与审计权威'],
              ['对象存储', '正常', 'Package 与有界中继暂存'],
              ['网关身份', '正常', '证书将在 82 天后轮换']
            ].map(([name, status, copy]) => (
              <div key={name} className="flex items-center gap-3 rounded-xl bg-white/[0.025] px-3 py-3">
                <CheckCircle2 className="size-4 shrink-0 text-emerald-300" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-[var(--text-primary)]">{name}</span>
                  <span className="block truncate text-xs text-[var(--text-muted)]">{copy}</span>
                </span>
                <span className="text-xs text-emerald-300">{status}</span>
              </div>
            ))}
          </div>
        </SettingCard>

        <SettingCard
          icon={KeyRound}
          title="身份与登录"
          description="本地账号可用；OIDC 需要部署管理员配置固定回调地址。"
        >
          <div className="space-y-2">
            <Toggle
              checked={oidc}
              onChange={setOidc}
              label="允许企业 OIDC"
              description="使用 state、nonce 和 PKCE 完成登录。"
            />
            <div className="flex items-center justify-between rounded-xl p-2">
              <span>
                <span className="block text-sm text-[var(--text-primary)]">本地账号</span>
                <span className="mt-1 block text-xs text-[var(--text-muted)]">首个系统管理员已完成初始化</span>
              </span>
              <StatusBadge status="已启用" tone="online" />
            </div>
          </div>
        </SettingCard>

        <SettingCard
          icon={RadioTower}
          title="中继与联邦"
          description="控制面独立运行，关闭中继不会影响设备注册和目录。"
        >
          <div className="space-y-2">
            <Toggle
              checked={relay}
              onChange={setRelay}
              label="启用数据中继"
              description="网络无法直连且双方策略允许时提供有界中继。"
            />
            <Toggle
              checked={federation}
              onChange={setFederation}
              label="允许网关联邦"
              description="仍需双方管理员核对指纹并分别确认关系。"
            />
          </div>
        </SettingCard>

        <SettingCard
          icon={Mail}
          title="通知"
          description="用于邀请、审批和高影响状态通知。"
        >
          <div className="flex items-center justify-between rounded-xl bg-white/[0.025] px-3 py-3">
            <span>
              <span className="block text-sm text-[var(--text-primary)]">SMTP 邮件</span>
              <span className="mt-1 block text-xs text-[var(--text-muted)]">凭据由部署环境提供，永不回显</span>
            </span>
            <Button size="sm" variant="secondary">发送测试</Button>
          </div>
        </SettingCard>

        <SettingCard
          icon={Braces}
          title="保留与审计"
          description="默认只保留有界元数据，不保存提示正文、文件与模型输出。"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">审计保留期</span>
              <select className="h-10 w-full rounded-lg border border-white/10 bg-[var(--control)] px-3 text-sm outline-none">
                <option>365 天</option>
                <option>180 天</option>
                <option>90 天</option>
              </select>
            </label>
            <label>
              <span className="mb-1.5 block text-xs font-medium text-[var(--text-muted)]">实例时区</span>
              <select className="h-10 w-full rounded-lg border border-white/10 bg-[var(--control)] px-3 text-sm outline-none">
                <option>Asia/Shanghai (UTC+8)</option>
                <option>UTC</option>
              </select>
            </label>
          </div>
        </SettingCard>
      </div>
      <section className="mt-5 rounded-2xl border border-rose-400/15 bg-rose-400/[0.035] p-5">
        <div className="flex items-start gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-rose-300" />
          <div className="flex-1">
            <h2 className="text-sm font-semibold text-rose-200">危险操作</h2>
            <p className="mt-1 text-xs leading-5 text-rose-200/60">
              删除组织前必须停止新任务、撤销联邦和设备，并按保留策略归档审计。
            </p>
          </div>
          <Button variant="danger">删除组织</Button>
        </div>
      </section>
    </>
  )
}
