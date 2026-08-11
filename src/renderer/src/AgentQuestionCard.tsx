import { CircleHelp } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  AgentEvent,
  AgentQuestionAnswer
} from '../../shared/contracts'

type AgentQuestion = Extract<AgentEvent, { type: 'question' }>

type AgentQuestionCardProps = {
  value: AgentQuestion
  onReject: () => Promise<void>
  onSubmit: (answers: AgentQuestionAnswer[]) => Promise<void>
}

export function AgentQuestionCard({
  value,
  onReject,
  onSubmit
}: AgentQuestionCardProps): React.JSX.Element {
  const { t } = useTranslation('workspace')
  const [selected, setSelected] = useState<string[][]>(
    value.questions.map(() => [])
  )
  const [custom, setCustom] = useState<string[]>(
    value.questions.map(() => '')
  )
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')
  const answers = useMemo(
    () =>
      value.questions.map((question, index) => {
        const ownAnswer = custom[index]?.trim()
        const choices = selected[index] ?? []
        return [
          ...choices,
          ...(ownAnswer && (question.multiple || choices.length === 0)
            ? [ownAnswer]
            : [])
        ]
      }),
    [custom, selected, value.questions]
  )
  const complete = answers.every((answer) => answer.length > 0)

  const run = async (action: () => Promise<void>): Promise<void> => {
    setSubmitting(true)
    setError('')
    try {
      await action()
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t('question.error')
      )
      setSubmitting(false)
    }
  }

  return (
    <form
      className="agent-question-card"
      onSubmit={(event) => {
        event.preventDefault()
        if (complete) {
          void run(() => onSubmit(answers))
        }
      }}
    >
      <header>
        <CircleHelp aria-hidden="true" size={18} />
        <strong>{t('question.title')}</strong>
      </header>
      {value.questions.map((question, questionIndex) => (
        <fieldset key={`${question.header}:${questionIndex}`}>
          <legend>
            <span>{question.header}</span>
            {question.question}
          </legend>
          {question.options.map((option) => {
            const checked =
              selected[questionIndex]?.includes(option.label) ?? false
            return (
              <label key={option.label}>
                <input
                  checked={checked}
                  disabled={submitting}
                  name={`agent-question-${value.questionId}-${questionIndex}`}
                  onChange={() => {
                    setSelected((current) =>
                      current.map((answer, index) =>
                        index !== questionIndex
                          ? answer
                          : question.multiple
                            ? checked
                              ? answer.filter(
                                  (label) => label !== option.label
                                )
                              : [...answer, option.label]
                            : [option.label]
                      )
                    )
                    if (!question.multiple) {
                      setCustom((current) =>
                        current.map((answer, index) =>
                          index === questionIndex ? '' : answer
                        )
                      )
                    }
                  }}
                  type={question.multiple ? 'checkbox' : 'radio'}
                />
                <span>
                  <strong>{option.label}</strong>
                  {option.description && <small>{option.description}</small>}
                </span>
              </label>
            )
          })}
          {(question.custom || question.options.length === 0) && (
            <label className="agent-question-card__custom">
              <span>{t('question.otherAnswer')}</span>
              <input
                disabled={submitting}
                maxLength={2_000}
                onChange={(event) => {
                  const answer = event.target.value
                  setCustom((current) =>
                    current.map((item, index) =>
                      index === questionIndex ? answer : item
                    )
                  )
                  if (!question.multiple && answer.trim()) {
                    setSelected((current) =>
                      current.map((item, index) =>
                        index === questionIndex ? [] : item
                      )
                    )
                  }
                }}
                placeholder={t('question.answerPlaceholder')}
                type="text"
                value={custom[questionIndex] ?? ''}
              />
            </label>
          )}
        </fieldset>
      ))}
      {error && (
        <p className="agent-question-card__error" role="alert">
          {error}
        </p>
      )}
      <footer>
        <button
          className="secondary-button"
          disabled={submitting}
          onClick={() => void run(onReject)}
          type="button"
        >
          {t('question.skip')}
        </button>
        <button
          className="primary-button"
          disabled={submitting || !complete}
          type="submit"
        >
          {submitting
            ? t('question.submitting')
            : t('question.submit')}
        </button>
      </footer>
    </form>
  )
}
