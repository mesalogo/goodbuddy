import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  Server,
  ShieldCheck,
  Wifi,
  X
} from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { SSH_HOST_LIMITS } from '../../shared/ssh-host-contracts'
import type {
  SshAuthenticationKind,
  SshHost,
  SshHostKeyInspection,
  SshHostUpdateInput,
  SshHostValidationResult
} from '../../shared/ssh-host-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'
import { sshHostErrorMessage } from './ssh-host-ui'

type HostDraft = {
  name: string
  hostname: string
  port: string
  username: string
  authentication: SshAuthenticationKind
}

type DialogStage = 'details' | 'host-key' | 'authentication' | 'success'

type SshHostDialogProps = {
  host?: SshHost
  secureStorageAvailable: boolean
  onClose: () => void
  onDirtyChange?: (dirty: boolean) => void
  onSaved: (result: SshHostValidationResult) => void
}

function draftFromHost(
  host: SshHost | undefined,
  secureStorageAvailable: boolean
): HostDraft {
  return host
    ? {
        name: host.name,
        hostname: host.hostname,
        port: String(host.port),
        username: host.username,
        authentication: host.authentication
      }
    : {
        name: '',
        hostname: '',
        port: '22',
        username: '',
        authentication: secureStorageAvailable
          ? 'password'
          : 'system-agent'
      }
}

function draftsEqual(left: HostDraft, right: HostDraft): boolean {
  return (
    left.name === right.name &&
    left.hostname === right.hostname &&
    left.port === right.port &&
    left.username === right.username &&
    left.authentication === right.authentication
  )
}

function targetMatchesHost(draft: HostDraft, host?: SshHost): boolean {
  return (
    host !== undefined &&
    draft.hostname.trim() === host.hostname &&
    Number(draft.port) === host.port &&
    draft.username.trim() === host.username &&
    draft.authentication === host.authentication
  )
}

export function SshHostDialog({
  host,
  secureStorageAvailable,
  onClose,
  onDirtyChange,
  onSaved
}: SshHostDialogProps): React.JSX.Element {
  const { t } = useTranslation('settingsSections')
  const initialDraft = useMemo(
    () => draftFromHost(host, secureStorageAvailable),
    [host, secureStorageAvailable]
  )
  const [draft, setDraft] = useState(initialDraft)
  const [stage, setStage] = useState<DialogStage>('details')
  const [inspection, setInspection] =
    useState<SshHostKeyInspection>()
  const [fingerprintConfirmed, setFingerprintConfirmed] =
    useState(false)
  const [passwordAction, setPasswordAction] = useState<
    'keep' | 'replace'
  >(
    host?.authentication === 'password' &&
      host.credentialConfigured
      ? 'keep'
      : 'replace'
  )
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'inspect' | 'validate'>()
  const [result, setResult] = useState<SshHostValidationResult>()
  const dialogRef = useRef<HTMLElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const stageHeadingRef = useRef<HTMLHeadingElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const candidateIdRef = useRef<string | undefined>(undefined)
  const titleId = useId()
  const descriptionId = useId()
  const formErrorId = useId()
  const api = window.goodbuddy.sshHosts
  const targetUnchanged = targetMatchesHost(draft, host)
  const canKeepPassword =
    host?.authentication === 'password' &&
    host.credentialConfigured &&
    targetUnchanged
  const dirty =
    stage !== 'success' &&
    (stage !== 'details' ||
      !draftsEqual(draft, initialDraft) ||
      password.length > 0)

  useEffect(
    () => activateModalFocus(() => nameRef.current),
    []
  )

  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])

  useEffect(() => {
    if (stage === 'host-key') {
      stageHeadingRef.current?.focus()
    } else if (stage === 'authentication') {
      if (
        draft.authentication === 'password' &&
        passwordAction === 'replace'
      ) {
        passwordRef.current?.focus()
      } else {
        stageHeadingRef.current?.focus()
      }
    } else if (stage === 'success') {
      doneRef.current?.focus()
    }
  }, [draft.authentication, passwordAction, stage])

  useEffect(() => {
    return () => {
      const candidateId = candidateIdRef.current
      if (candidateId && api) {
        void api.discardCandidate(candidateId).catch(() => undefined)
      }
      onDirtyChange?.(false)
    }
  }, [api, onDirtyChange])

  const discardInspection = (): void => {
    const candidateId = candidateIdRef.current
    candidateIdRef.current = undefined
    setInspection(undefined)
    setFingerprintConfirmed(false)
    if (candidateId && api) {
      void api.discardCandidate(candidateId).catch(() => undefined)
    }
  }

  const close = (): void => {
    if (busy) {
      return
    }
    discardInspection()
    onClose()
  }

  const updateDraft = (update: Partial<HostDraft>): void => {
    setDraft((current) => ({ ...current, ...update }))
    setError(undefined)
  }

  const inspect = async (): Promise<void> => {
    if (!api) {
      setError(t('sshHosts.errors.unavailable'))
      return
    }
    const port = Number(draft.port)
    if (!draft.name.trim()) {
      setError(t('sshHosts.validation.nameRequired'))
      nameRef.current?.focus()
      return
    }
    if (!draft.hostname.trim()) {
      setError(t('sshHosts.validation.hostnameRequired'))
      return
    }
    if (
      !Number.isInteger(port) ||
      port < 1 ||
      port > SSH_HOST_LIMITS.maximumPort
    ) {
      setError(t('sshHosts.validation.portInvalid'))
      return
    }
    if (!draft.username.trim()) {
      setError(t('sshHosts.validation.usernameRequired'))
      return
    }
    if (
      draft.authentication === 'password' &&
      !secureStorageAvailable &&
      !canKeepPassword
    ) {
      setError(t('sshHosts.validation.passwordStorageRequired'))
      return
    }

    setBusy('inspect')
    setError(undefined)
    discardInspection()
    try {
      const nextInspection = await api.inspectDraftHostKey({
        ...(host ? { hostId: host.id } : {}),
        hostname: draft.hostname,
        port,
        username: draft.username
      })
      candidateIdRef.current = nextInspection.candidateId
      setDraft((current) => ({
        ...current,
        name: current.name.trim(),
        hostname: current.hostname.trim(),
        port: String(port),
        username: current.username.trim()
      }))
      setInspection(nextInspection)
      setFingerprintConfirmed(nextInspection.state === 'verified')
      if (!canKeepPassword) {
        setPasswordAction('replace')
      }
      setStage('host-key')
    } catch (reason) {
      setError(
        sshHostErrorMessage(
          reason,
          t('sshHosts.errors.inspectFailed')
        )
      )
    } finally {
      setBusy(undefined)
    }
  }

  const returnToDetails = (): void => {
    discardInspection()
    setError(undefined)
    setStage('details')
  }

  const continueToAuthentication = (): void => {
    if (!inspection) {
      return
    }
    if (
      inspection.state !== 'verified' &&
      !fingerprintConfirmed
    ) {
      setError(t('sshHosts.validation.confirmFingerprint'))
      return
    }
    if (!canKeepPassword) {
      setPasswordAction('replace')
    }
    setError(undefined)
    setStage('authentication')
  }

  const validateAndSave = async (): Promise<void> => {
    if (!api || !inspection) {
      return
    }
    if (
      draft.authentication === 'password' &&
      passwordAction === 'replace' &&
      !password
    ) {
      setError(t('sshHosts.validation.passwordRequired'))
      passwordRef.current?.focus()
      return
    }
    const input: SshHostUpdateInput = {
      name: draft.name,
      hostname: draft.hostname,
      port: Number(draft.port),
      username: draft.username,
      authentication: draft.authentication,
      password:
        draft.authentication === 'system-agent'
          ? { action: 'clear' }
          : passwordAction === 'keep' && canKeepPassword
            ? { action: 'keep' }
            : { action: 'replace', value: password }
    }
    setBusy('validate')
    setError(undefined)
    let nextResult: SshHostValidationResult
    try {
      nextResult = await api.validateAndSave({
        candidateId: inspection.candidateId,
        fingerprintSha256: inspection.fingerprintSha256,
        input
      })
    } catch (reason) {
      setError(
        sshHostErrorMessage(
          reason,
          t('sshHosts.errors.validationFailed')
        )
      )
      return
    } finally {
      setBusy(undefined)
    }
    candidateIdRef.current = undefined
    setPassword('')
    setResult(nextResult)
    onSaved(nextResult)
    setStage('success')
  }

  const currentStep =
    stage === 'details'
      ? 1
      : stage === 'host-key'
        ? 2
        : stage === 'authentication'
          ? 3
          : 4

  return createPortal(
    <div
      className="custom-task-dialog ssh-host-dialog"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          close()
        }
      }}
    >
      <section
        aria-describedby={`${descriptionId}${error ? ` ${formErrorId}` : ''}`}
        aria-labelledby={titleId}
        aria-modal="true"
        className="custom-task-dialog__surface ssh-host-dialog__surface"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !busy) {
            event.preventDefault()
            close()
            return
          }
          trapTabFocus(event, dialogRef.current)
        }}
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="custom-task-dialog__header">
          <div>
            <span className="custom-task-dialog__eyebrow">
              <Server aria-hidden="true" size={14} />
              {t('sshHosts.wizard.eyebrow')}
            </span>
            <h2 id={titleId}>
              {host
                ? t('sshHosts.wizard.editTitle')
                : t('sshHosts.wizard.createTitle')}
            </h2>
            <p id={descriptionId}>
              {t('sshHosts.wizard.description')}
            </p>
          </div>
          <button
            aria-label={t('sshHosts.actions.closeDialog')}
            className="icon-button"
            disabled={Boolean(busy)}
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        <div className="ssh-host-dialog__progress">
          <span>
            {t('sshHosts.wizard.progress', {
              current: currentStep,
              total: 4
            })}
          </span>
          <ol aria-label={t('sshHosts.wizard.stepsLabel')}>
            {(
              [
                'details',
                'hostKey',
                'authentication',
                'success'
              ] as const
            ).map((step, index) => (
              <li
                aria-current={
                  currentStep === index + 1 ? 'step' : undefined
                }
                className={
                  currentStep >= index + 1
                    ? 'ssh-host-dialog__step--active'
                    : undefined
                }
                key={step}
              >
                <span>{index + 1}</span>
                {t(`sshHosts.wizard.steps.${step}`)}
              </li>
            ))}
          </ol>
        </div>

        <div className="custom-task-dialog__content ssh-host-dialog__content">
          {stage === 'details' && (
            <div className="ssh-host-dialog__stage">
              <div className="ssh-host-dialog__stage-heading">
                <div>
                  <h3>{t('sshHosts.wizard.details.title')}</h3>
                  <p>{t('sshHosts.wizard.details.description')}</p>
                </div>
              </div>
              <div className="ssh-host-dialog__details-grid">
                <label className="custom-task-dialog__field">
                  <span>{t('sshHosts.fields.name')}</span>
                  <input
                    maxLength={SSH_HOST_LIMITS.maximumNameLength}
                    onChange={(event) =>
                      updateDraft({ name: event.target.value })
                    }
                    ref={nameRef}
                    value={draft.name}
                  />
                </label>
                <label className="custom-task-dialog__field">
                  <span>{t('sshHosts.fields.hostname')}</span>
                  <input
                    maxLength={SSH_HOST_LIMITS.maximumHostnameLength}
                    onChange={(event) =>
                      updateDraft({ hostname: event.target.value })
                    }
                    value={draft.hostname}
                  />
                </label>
                <label className="custom-task-dialog__field">
                  <span>{t('sshHosts.fields.port')}</span>
                  <input
                    max={SSH_HOST_LIMITS.maximumPort}
                    min={1}
                    onChange={(event) =>
                      updateDraft({ port: event.target.value })
                    }
                    type="number"
                    value={draft.port}
                  />
                </label>
                <label className="custom-task-dialog__field">
                  <span>{t('sshHosts.fields.username')}</span>
                  <input
                    maxLength={SSH_HOST_LIMITS.maximumUsernameLength}
                    onChange={(event) =>
                      updateDraft({ username: event.target.value })
                    }
                    value={draft.username}
                  />
                </label>
              </div>
              <label className="custom-task-dialog__field">
                <span>{t('sshHosts.fields.authentication')}</span>
                <select
                  onChange={(event) => {
                    const authentication = event.target
                      .value as SshAuthenticationKind
                    updateDraft({ authentication })
                    setPassword('')
                    setPasswordAction(
                      authentication === 'password' &&
                        host?.authentication === 'password' &&
                        host.credentialConfigured
                        ? 'keep'
                        : 'replace'
                    )
                  }}
                  value={draft.authentication}
                >
                  <option
                    disabled={!secureStorageAvailable}
                    value="password"
                  >
                    {t('sshHosts.authentication.password')}
                  </option>
                  <option value="system-agent">
                    {t('sshHosts.authentication.system-agent')}
                  </option>
                </select>
                {!secureStorageAvailable && (
                  <small>
                    {t('sshHosts.wizard.details.passwordUnavailable')}
                  </small>
                )}
              </label>
            </div>
          )}

          {stage === 'host-key' && inspection && (
            <div className="ssh-host-dialog__stage">
              <div
                aria-live={
                  inspection.state === 'changed'
                    ? 'assertive'
                    : 'polite'
                }
                className={[
                  'ssh-host-dialog__identity',
                  inspection.state === 'changed' &&
                    'ssh-host-dialog__identity--danger'
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <div className="ssh-host-dialog__stage-heading">
                  <KeyRound aria-hidden="true" size={20} />
                  <div>
                    <h3 ref={stageHeadingRef} tabIndex={-1}>
                      {t('sshHosts.hostKey.title')}
                    </h3>
                    <p>
                      {inspection.state === 'changed'
                        ? t('sshHosts.hostKey.changed')
                        : inspection.state === 'verified'
                          ? t('sshHosts.hostKey.matches')
                          : t('sshHosts.hostKey.firstUse')}
                    </p>
                  </div>
                </div>
                {inspection.previousHostKey && (
                  <div className="ssh-host-key-comparison">
                    <span>
                      {t('sshHosts.hostKey.previousFingerprint')}
                    </span>
                    <code className="ssh-host-fingerprint">
                      {inspection.previousHostKey.algorithm}{' '}
                      {inspection.previousHostKey.fingerprintSha256}
                    </code>
                  </div>
                )}
                <div className="ssh-host-key-comparison">
                  <span>
                    {t('sshHosts.hostKey.observedFingerprint')}
                  </span>
                  <code className="ssh-host-fingerprint">
                    {inspection.algorithm}{' '}
                    {inspection.fingerprintSha256}
                  </code>
                </div>
                <p>{t('sshHosts.hostKey.verifyOutOfBand')}</p>
                {inspection.state !== 'verified' && (
                  <label className="ssh-host-dialog__confirmation">
                    <input
                      checked={fingerprintConfirmed}
                      onChange={(event) => {
                        setFingerprintConfirmed(event.target.checked)
                        setError(undefined)
                      }}
                      type="checkbox"
                    />
                    <span>
                      {t('sshHosts.hostKey.confirmedOutOfBand')}
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}

          {stage === 'authentication' && inspection && (
            <div className="ssh-host-dialog__stage">
              <div className="ssh-host-dialog__stage-heading">
                <ShieldCheck aria-hidden="true" size={20} />
                <div>
                  <h3 ref={stageHeadingRef} tabIndex={-1}>
                    {t('sshHosts.wizard.authentication.title')}
                  </h3>
                  <p>
                    {t('sshHosts.wizard.authentication.description')}
                  </p>
                </div>
              </div>
              <div className="ssh-host-dialog__target">
                <Server aria-hidden="true" size={16} />
                <span>
                  {draft.username}@{draft.hostname}:{draft.port}
                </span>
                <small>
                  {inspection.algorithm}{' '}
                  {inspection.fingerprintSha256}
                </small>
              </div>

              {draft.authentication === 'password' ? (
                <>
                  {canKeepPassword && (
                    <label className="custom-task-dialog__field">
                      <span>
                        {t('sshHosts.fields.passwordAction')}
                      </span>
                      <select
                        onChange={(event) => {
                          setPasswordAction(
                            event.target.value as
                              | 'keep'
                              | 'replace'
                          )
                          setPassword('')
                          setError(undefined)
                        }}
                        value={passwordAction}
                      >
                        <option value="keep">
                          {t('sshHosts.passwordActions.keep')}
                        </option>
                        <option value="replace">
                          {t('sshHosts.passwordActions.replace')}
                        </option>
                      </select>
                    </label>
                  )}
                  {(!canKeepPassword ||
                    passwordAction === 'replace') && (
                    <label className="custom-task-dialog__field">
                      <span>{t('sshHosts.fields.password')}</span>
                      <input
                        autoComplete="new-password"
                        maxLength={
                          SSH_HOST_LIMITS.maximumPasswordLength
                        }
                        onChange={(event) => {
                          setPassword(event.target.value)
                          setError(undefined)
                        }}
                        ref={passwordRef}
                        type="password"
                        value={password}
                      />
                      <small>{t('sshHosts.passwordHelp')}</small>
                    </label>
                  )}
                </>
              ) : (
                <div className="settings-notice">
                  <KeyRound aria-hidden="true" size={16} />
                  <span>
                    {t('sshHosts.wizard.authentication.agentHelp')}
                  </span>
                </div>
              )}

              {busy === 'validate' && (
                <div
                  aria-live="polite"
                  className="ssh-host-dialog__working"
                  role="status"
                >
                  <LoaderCircle aria-hidden="true" size={18} />
                  <div>
                    <strong>
                      {t(
                        'sshHosts.wizard.authentication.testingTitle'
                      )}
                    </strong>
                    <span>
                      {t(
                        'sshHosts.wizard.authentication.testingDescription'
                      )}
                    </span>
                  </div>
                </div>
              )}
            </div>
          )}

          {stage === 'success' && result && (
            <div className="ssh-host-dialog__success">
              <CheckCircle2 aria-hidden="true" size={34} />
              <div>
                <h3>{t('sshHosts.wizard.success.title')}</h3>
                <p>
                  {t('sshHosts.wizard.success.description', {
                    name: result.host.name
                  })}
                </p>
              </div>
              <dl>
                <div>
                  <dt>{t('sshHosts.wizard.success.system')}</dt>
                  <dd>
                    {result.connection.platform}/
                    {result.connection.architecture}
                  </dd>
                </div>
                <div>
                  <dt>{t('sshHosts.wizard.success.latency')}</dt>
                  <dd>{result.connection.latencyMs} ms</dd>
                </div>
                <div>
                  <dt>{t('sshHosts.wizard.success.shell')}</dt>
                  <dd>{result.connection.shell}</dd>
                </div>
                <div>
                  <dt>{t('sshHosts.wizard.success.home')}</dt>
                  <dd>{result.connection.homeDirectory}</dd>
                </div>
              </dl>
            </div>
          )}

          {error && (
            <p
              className="custom-task-dialog__form-error"
              id={formErrorId}
              role="alert"
            >
              {error}
            </p>
          )}
        </div>

        <footer className="custom-task-dialog__actions">
          {stage === 'details' && (
            <>
              <button
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={close}
                type="button"
              >
                {t('sshHosts.actions.cancel')}
              </button>
              <button
                className="primary-button"
                disabled={Boolean(busy)}
                onClick={() => void inspect()}
                type="button"
              >
                {busy === 'inspect' ? (
                  <LoaderCircle aria-hidden="true" size={15} />
                ) : (
                  <KeyRound aria-hidden="true" size={15} />
                )}
                {busy === 'inspect'
                  ? t('sshHosts.actions.inspecting')
                  : t('sshHosts.actions.inspectAndContinue')}
              </button>
            </>
          )}
          {stage === 'host-key' && inspection && (
            <>
              <button
                className="secondary-button"
                onClick={returnToDetails}
                type="button"
              >
                {t('sshHosts.actions.back')}
              </button>
              <button
                className={
                  inspection.state === 'changed'
                    ? 'danger-button'
                    : 'primary-button'
                }
                disabled={
                  inspection.state !== 'verified' &&
                  !fingerprintConfirmed
                }
                onClick={continueToAuthentication}
                type="button"
              >
                {inspection.state === 'changed'
                  ? t('sshHosts.actions.trustChangedAndContinue')
                  : t('sshHosts.actions.continueToAuthentication')}
              </button>
            </>
          )}
          {stage === 'authentication' && (
            <>
              <button
                className="secondary-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  setError(undefined)
                  setStage('host-key')
                }}
                type="button"
              >
                {t('sshHosts.actions.back')}
              </button>
              <button
                className="primary-button"
                disabled={Boolean(busy)}
                onClick={() => void validateAndSave()}
                type="button"
              >
                {busy === 'validate' ? (
                  <LoaderCircle aria-hidden="true" size={15} />
                ) : (
                  <Wifi aria-hidden="true" size={15} />
                )}
                {busy === 'validate'
                  ? t('sshHosts.actions.validating')
                  : t('sshHosts.actions.validateAndSave')}
              </button>
            </>
          )}
          {stage === 'success' && (
            <button
              className="primary-button"
              onClick={close}
              ref={doneRef}
              type="button"
            >
              {t('sshHosts.actions.done')}
            </button>
          )}
        </footer>
      </section>
    </div>,
    document.body
  )
}
