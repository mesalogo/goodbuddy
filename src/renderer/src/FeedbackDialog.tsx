import {
  CheckCircle2,
  Copy,
  ImagePlus,
  Trash2,
  X
} from 'lucide-react'
import {
  useEffect,
  useId,
  useRef,
  useState
} from 'react'
import { useTranslation } from 'react-i18next'
import type { AppInfo } from '../../shared/contracts'
import {
  feedbackCategories,
  feedbackCategorySchema,
  feedbackContactEmailSchema,
  feedbackLimits,
  feedbackScreenshotMimeTypeSchema,
  type FeedbackCategory,
  type FeedbackScreenshotInput,
  type FeedbackSubmissionErrorCode
} from '../../shared/feedback-contracts'
import { activateModalFocus, trapTabFocus } from './dialog-focus'

type FeedbackDialogProps = {
  appInfo: AppInfo
  onClose: () => void
}

type FieldErrors = {
  title?: string
  description?: string
  contactEmail?: string
}

type ScreenshotDraft = FeedbackScreenshotInput & {
  objectUrl: string
  width: number
  height: number
  size: number
}

function formatScreenshotBytes(bytes: number): string {
  return bytes >= 1_024 * 1_024
    ? `${(bytes / (1_024 * 1_024)).toFixed(1)} MB`
    : `${Math.max(1, Math.ceil(bytes / 1_024))} KB`
}

function imageDimensions(
  objectUrl: string
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () =>
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight
      })
    image.onerror = () => reject(new Error('Image could not be decoded'))
    image.src = objectUrl
  })
}

export function FeedbackDialog({
  appInfo,
  onClose
}: FeedbackDialogProps): React.JSX.Element {
  const { i18n, t } = useTranslation('settingsSections')
  const locale =
    (i18n.resolvedLanguage ?? i18n.language) === 'en-US'
      ? 'en-US'
      : 'zh-CN'
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const categoryRef = useRef<HTMLSelectElement>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const descriptionRef = useRef<HTMLTextAreaElement>(null)
  const emailRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const screenshotUrlRef = useRef<string | undefined>(undefined)
  const screenshotSelectionRef = useRef(0)
  const pendingScreenshotUrlsRef = useRef(new Set<string>())
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [contactEmail, setContactEmail] = useState('')
  const [screenshot, setScreenshot] = useState<ScreenshotDraft>()
  const [screenshotProcessing, setScreenshotProcessing] =
    useState(false)
  const [screenshotError, setScreenshotError] = useState<string>()
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [submitting, setSubmitting] = useState(false)
  const [submissionError, setSubmissionError] =
    useState<FeedbackSubmissionErrorCode>()
  const [reference, setReference] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [clientRequestId] = useState(() => crypto.randomUUID())

  useEffect(
    () => activateModalFocus(() => categoryRef.current),
    []
  )

  useEffect(
    () => () => {
      screenshotSelectionRef.current += 1
      for (const objectUrl of pendingScreenshotUrlsRef.current) {
        URL.revokeObjectURL(objectUrl)
      }
      pendingScreenshotUrlsRef.current.clear()
      if (screenshotUrlRef.current) {
        URL.revokeObjectURL(screenshotUrlRef.current)
      }
    },
    []
  )

  const releaseScreenshotUrl = (): void => {
    if (screenshotUrlRef.current) {
      URL.revokeObjectURL(screenshotUrlRef.current)
      screenshotUrlRef.current = undefined
    }
  }

  const removeScreenshot = (): void => {
    screenshotSelectionRef.current += 1
    for (const objectUrl of pendingScreenshotUrlsRef.current) {
      URL.revokeObjectURL(objectUrl)
    }
    pendingScreenshotUrlsRef.current.clear()
    releaseScreenshotUrl()
    setScreenshot(undefined)
    setScreenshotProcessing(false)
    setScreenshotError(undefined)
    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const setScreenshotFile = async (file: File): Promise<void> => {
    const selection = screenshotSelectionRef.current + 1
    screenshotSelectionRef.current = selection
    setScreenshotProcessing(true)
    setScreenshotError(undefined)
    const mimeType = feedbackScreenshotMimeTypeSchema.safeParse(
      file.type
    )
    if (!mimeType.success) {
      setScreenshotError(t('feedback.screenshot.unsupported'))
      setScreenshotProcessing(false)
      return
    }
    if (
      file.size === 0 ||
      file.size > feedbackLimits.maximumScreenshotBytes
    ) {
      setScreenshotError(t('feedback.screenshot.tooLarge'))
      setScreenshotProcessing(false)
      return
    }
    let objectUrl: string | undefined
    try {
      const data = new Uint8Array(await file.arrayBuffer())
      if (selection !== screenshotSelectionRef.current) {
        return
      }
      if (data.byteLength > feedbackLimits.maximumScreenshotBytes) {
        setScreenshotError(t('feedback.screenshot.tooLarge'))
        return
      }
      objectUrl = URL.createObjectURL(file)
      pendingScreenshotUrlsRef.current.add(objectUrl)
      const { width, height } = await imageDimensions(objectUrl)
      if (selection !== screenshotSelectionRef.current) {
        pendingScreenshotUrlsRef.current.delete(objectUrl)
        URL.revokeObjectURL(objectUrl)
        return
      }
      if (
        width <= 0 ||
        height <= 0 ||
        width > feedbackLimits.maximumScreenshotDimension ||
        height > feedbackLimits.maximumScreenshotDimension ||
        width * height > feedbackLimits.maximumScreenshotPixels
      ) {
        throw new Error('Image dimensions are unsupported')
      }
      pendingScreenshotUrlsRef.current.delete(objectUrl)
      releaseScreenshotUrl()
      screenshotUrlRef.current = objectUrl
      setScreenshot({
        data,
        mimeType: mimeType.data,
        objectUrl,
        width,
        height,
        size: file.size
      })
    } catch {
      if (objectUrl) {
        pendingScreenshotUrlsRef.current.delete(objectUrl)
        URL.revokeObjectURL(objectUrl)
      }
      if (selection === screenshotSelectionRef.current) {
        setScreenshotError(t('feedback.screenshot.invalid'))
      }
    } finally {
      if (selection === screenshotSelectionRef.current) {
        setScreenshotProcessing(false)
      }
    }
  }

  const validate = (): FieldErrors => {
    const errors: FieldErrors = {}
    if (!title.trim()) {
      errors.title = t('feedback.validation.titleRequired')
    }
    if (
      description.trim().length <
      feedbackLimits.minimumDescriptionCharacters
    ) {
      errors.description = t(
        'feedback.validation.descriptionMinimum'
      )
    }
    if (
      contactEmail.trim() &&
      !feedbackContactEmailSchema.safeParse(contactEmail.trim())
        .success
    ) {
      errors.contactEmail = t('feedback.validation.emailInvalid')
    }
    return errors
  }

  const canSubmit =
    title.trim().length > 0 &&
    description.trim().length >=
      feedbackLimits.minimumDescriptionCharacters &&
    (!contactEmail.trim() ||
      feedbackContactEmailSchema.safeParse(contactEmail.trim())
        .success) &&
    !screenshotProcessing

  const focusFirstError = (errors: FieldErrors): void => {
    if (errors.title) {
      titleRef.current?.focus()
    } else if (errors.description) {
      descriptionRef.current?.focus()
    } else if (errors.contactEmail) {
      emailRef.current?.focus()
    }
  }

  const submit = async (): Promise<void> => {
    if (screenshotProcessing) {
      return
    }
    const errors = validate()
    setFieldErrors(errors)
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors)
      return
    }
    setSubmitting(true)
    setSubmissionError(undefined)
    try {
      const result = await window.goodbuddy.feedback.submit({
        category,
        title,
        description,
        ...(contactEmail.trim()
          ? { contactEmail: contactEmail.trim() }
          : {}),
        locale,
        clientRequestId,
        ...(screenshot
          ? {
              screenshot: {
                data: screenshot.data,
                mimeType: screenshot.mimeType
              }
            }
          : {})
      })
      if (result.ok) {
        setReference(result.reference)
      } else {
        setSubmissionError(result.error)
      }
    } catch {
      setSubmissionError('network')
    } finally {
      setSubmitting(false)
    }
  }

  const close = (): void => {
    if (!submitting) {
      onClose()
    }
  }

  const platformLabel = (): string => {
    switch (appInfo.platform) {
      case 'win32':
        return t('feedback.environment.platforms.windows')
      case 'darwin':
        return t('feedback.environment.platforms.macos')
      case 'linux':
        return t('feedback.environment.platforms.linux')
      default:
        return t('feedback.environment.platforms.unknown')
    }
  }

  return (
    <div
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-modal="true"
      className="feedback-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !submitting) {
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
      <div className="feedback-dialog">
        <header className="feedback-dialog__header">
          <div>
            <strong id={titleId}>{t('feedback.dialog.title')}</strong>
            <p id={descriptionId}>
              {t('feedback.dialog.description')}
            </p>
          </div>
          <button
            aria-label={t('feedback.actions.close')}
            className="icon-button"
            disabled={submitting}
            onClick={close}
            type="button"
          >
            <X aria-hidden="true" size={17} />
          </button>
        </header>

        {reference ? (
          <div
            aria-live="polite"
            className="feedback-dialog__success"
          >
            <CheckCircle2 aria-hidden="true" size={34} />
            <div>
              <strong>{t('feedback.success.title')}</strong>
              <p>{t('feedback.success.description')}</p>
            </div>
            <code>{reference}</code>
            <button
              className="secondary-button"
              onClick={() => {
                void navigator.clipboard
                  .writeText(reference)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false))
              }}
              type="button"
            >
              <Copy aria-hidden="true" size={14} />
              {copied
                ? t('feedback.actions.copied')
                : t('feedback.actions.copyReference')}
            </button>
            <button
              className="primary-button"
              onClick={close}
              type="button"
            >
              {t('feedback.actions.done')}
            </button>
          </div>
        ) : (
          <form
            className="feedback-dialog__form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              void submit()
            }}
          >
            <div className="feedback-dialog__fields">
              <label className="field">
                <span>{t('feedback.fields.category')}</span>
                <select
                  disabled={submitting}
                  onChange={(event) =>
                    setCategory(
                      feedbackCategorySchema.parse(event.target.value)
                    )
                  }
                  ref={categoryRef}
                  value={category}
                >
                  {feedbackCategories.map((value) => (
                    <option key={value} value={value}>
                      {t(`feedback.categories.${value}`)}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>{t('feedback.fields.title')}</span>
                <input
                  aria-label={t('feedback.fields.title')}
                  aria-invalid={Boolean(fieldErrors.title)}
                  disabled={submitting}
                  maxLength={feedbackLimits.maximumTitleCharacters}
                  onBlur={() =>
                    setFieldErrors((current) => ({
                      ...current,
                      title: title.trim()
                        ? undefined
                        : t('feedback.validation.titleRequired')
                    }))
                  }
                  onChange={(event) => {
                    setTitle(event.target.value)
                    setFieldErrors((current) => ({
                      ...current,
                      title: undefined
                    }))
                  }}
                  placeholder={t('feedback.fields.titlePlaceholder')}
                  ref={titleRef}
                  required
                  type="text"
                  value={title}
                />
                <small>
                  {t('feedback.fields.characterCount', {
                    count: title.length,
                    maximum: feedbackLimits.maximumTitleCharacters
                  })}
                </small>
                {fieldErrors.title && (
                  <small role="alert">{fieldErrors.title}</small>
                )}
              </label>

              <label className="field">
                <span>{t('feedback.fields.description')}</span>
                <textarea
                  aria-label={t('feedback.fields.description')}
                  aria-invalid={Boolean(fieldErrors.description)}
                  disabled={submitting}
                  maxLength={
                    feedbackLimits.maximumDescriptionCharacters
                  }
                  onBlur={() =>
                    setFieldErrors((current) => ({
                      ...current,
                      description:
                        description.trim().length >=
                        feedbackLimits.minimumDescriptionCharacters
                          ? undefined
                          : t(
                              'feedback.validation.descriptionMinimum'
                            )
                    }))
                  }
                  onChange={(event) => {
                    setDescription(event.target.value)
                    setFieldErrors((current) => ({
                      ...current,
                      description: undefined
                    }))
                  }}
                  placeholder={t(
                    'feedback.fields.descriptionPlaceholder'
                  )}
                  ref={descriptionRef}
                  required
                  rows={6}
                  value={description}
                />
                <small>
                  {t('feedback.fields.characterCount', {
                    count: description.length,
                    maximum:
                      feedbackLimits.maximumDescriptionCharacters
                  })}
                </small>
                {fieldErrors.description && (
                  <small role="alert">
                    {fieldErrors.description}
                  </small>
                )}
              </label>

              <label className="field">
                <span>{t('feedback.fields.contactEmail')}</span>
                <input
                  aria-label={t('feedback.fields.contactEmail')}
                  aria-invalid={Boolean(fieldErrors.contactEmail)}
                  disabled={submitting}
                  maxLength={feedbackLimits.maximumEmailCharacters}
                  onBlur={() =>
                    setFieldErrors((current) => ({
                      ...current,
                      contactEmail:
                        !contactEmail.trim() ||
                        feedbackContactEmailSchema.safeParse(
                          contactEmail.trim()
                        ).success
                          ? undefined
                          : t('feedback.validation.emailInvalid')
                    }))
                  }
                  onChange={(event) => {
                    setContactEmail(event.target.value)
                    setFieldErrors((current) => ({
                      ...current,
                      contactEmail: undefined
                    }))
                  }}
                  placeholder={t('feedback.fields.emailPlaceholder')}
                  ref={emailRef}
                  type="email"
                  value={contactEmail}
                />
                <small>{t('feedback.fields.emailHelp')}</small>
                {fieldErrors.contactEmail && (
                  <small role="alert">
                    {fieldErrors.contactEmail}
                  </small>
                )}
              </label>

              <div
                className="feedback-screenshot"
                onPaste={(event) => {
                  const imageItem = Array.from(
                    event.clipboardData.items
                  ).find(
                    (item) =>
                      item.kind === 'file' &&
                      item.type.startsWith('image/')
                  )
                  const file =
                    imageItem?.getAsFile() ??
                    Array.from(event.clipboardData.files).find(
                      (candidate) =>
                        candidate.type.startsWith('image/')
                    )
                  if (file) {
                    event.preventDefault()
                    void setScreenshotFile(file)
                  }
                }}
              >
                <div className="feedback-screenshot__heading">
                  <div>
                    <strong>{t('feedback.screenshot.title')}</strong>
                    <small>{t('feedback.screenshot.help')}</small>
                  </div>
                  <input
                    accept="image/png,image/jpeg,image/webp"
                    aria-label={t('feedback.screenshot.fileInput')}
                    hidden
                    onChange={(event) => {
                      const file = event.currentTarget.files?.[0]
                      event.currentTarget.value = ''
                      if (file) {
                        void setScreenshotFile(file)
                      }
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                  <button
                    className="secondary-button"
                    disabled={submitting || screenshotProcessing}
                    onClick={() => fileInputRef.current?.click()}
                    type="button"
                  >
                    <ImagePlus aria-hidden="true" size={14} />
                    {screenshotProcessing
                      ? t('feedback.actions.processingScreenshot')
                      : screenshot
                      ? t('feedback.actions.replaceScreenshot')
                      : t('feedback.actions.addScreenshot')}
                  </button>
                </div>
                {screenshot && (
                  <div className="feedback-screenshot__preview">
                    <img
                      alt={t('feedback.screenshot.previewAlt')}
                      src={screenshot.objectUrl}
                    />
                    <div>
                      <span>
                        {screenshot.width} × {screenshot.height}
                      </span>
                      <small>
                        {formatScreenshotBytes(screenshot.size)}
                      </small>
                    </div>
                    <button
                      aria-label={t(
                        'feedback.actions.removeScreenshot'
                      )}
                      className="secondary-button"
                      disabled={submitting || screenshotProcessing}
                      onClick={removeScreenshot}
                      type="button"
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      {t('feedback.actions.removeScreenshot')}
                    </button>
                  </div>
                )}
                <small>{t('feedback.screenshot.privacy')}</small>
                {screenshotError && (
                  <small role="alert">{screenshotError}</small>
                )}
              </div>

              <div className="feedback-environment">
                <strong>{t('feedback.environment.title')}</strong>
                <dl>
                  <div>
                    <dt>{t('feedback.environment.version')}</dt>
                    <dd>{appInfo.version}</dd>
                  </div>
                  <div>
                    <dt>{t('feedback.environment.system')}</dt>
                    <dd>
                      {platformLabel()} · {appInfo.arch}
                    </dd>
                  </div>
                  <div>
                    <dt>{t('feedback.environment.locale')}</dt>
                    <dd>{locale}</dd>
                  </div>
                </dl>
              </div>

              <p className="feedback-dialog__privacy">
                {t('feedback.privacy')}
              </p>

              {submissionError && (
                <div
                  className="feedback-dialog__error"
                  role="alert"
                >
                  <strong>{t('feedback.errors.title')}</strong>
                  <p>
                    {t(`feedback.errors.${submissionError}`)}
                  </p>
                </div>
              )}
            </div>

            <footer className="feedback-dialog__actions">
              <button
                className="secondary-button"
                disabled={submitting}
                onClick={close}
                type="button"
              >
                {t('feedback.actions.cancel')}
              </button>
              <button
                className="primary-button"
                disabled={!canSubmit || submitting}
                type="submit"
              >
                {submitting
                  ? t('feedback.actions.submitting')
                  : submissionError
                    ? t('feedback.actions.retry')
                    : t('feedback.actions.submit')}
              </button>
            </footer>
          </form>
        )}
      </div>
    </div>
  )
}
