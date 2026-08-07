export type ReasoningStreamSegment = {
  type: 'text' | 'reasoning'
  delta: string
}

const openingTags = ['<think>', '<thinking>'] as const

function longestTagPrefixSuffix(
  value: string,
  tags: readonly string[]
): number {
  const lowerValue = value.toLocaleLowerCase()
  let retained = 0
  for (const tag of tags) {
    const maximum = Math.min(value.length, tag.length - 1)
    for (let length = maximum; length > retained; length -= 1) {
      if (
        lowerValue.endsWith(tag.slice(0, length).toLocaleLowerCase())
      ) {
        retained = length
        break
      }
    }
  }
  return retained
}

function appendDelta(
  result: ReasoningStreamSegment[],
  type: ReasoningStreamSegment['type'],
  value: string
): void {
  if (!value) {
    return
  }
  const previous = result.at(-1)
  if (previous?.type === type) {
    previous.delta += value
  } else {
    result.push({ type, delta: value })
  }
}

export class ReasoningTagStreamParser {
  private buffer = ''
  private closingTag: '</think>' | '</thinking>' | undefined

  push(delta: string): ReasoningStreamSegment[] {
    this.buffer += delta
    return this.drain(false)
  }

  finish(): ReasoningStreamSegment[] {
    return this.drain(true)
  }

  private drain(flush: boolean): ReasoningStreamSegment[] {
    const result: ReasoningStreamSegment[] = []
    while (this.buffer) {
      const tags = this.closingTag ? [this.closingTag] : openingTags
      const lowerBuffer = this.buffer.toLocaleLowerCase()
      let tagIndex = -1
      let matchedTag: string | undefined
      for (const tag of tags) {
        const candidateIndex = lowerBuffer.indexOf(
          tag.toLocaleLowerCase()
        )
        if (
          candidateIndex >= 0 &&
          (tagIndex < 0 || candidateIndex < tagIndex)
        ) {
          tagIndex = candidateIndex
          matchedTag = tag
        }
      }

      const target = this.closingTag ? 'reasoning' : 'text'
      if (matchedTag !== undefined) {
        appendDelta(result, target, this.buffer.slice(0, tagIndex))
        this.buffer = this.buffer.slice(tagIndex + matchedTag.length)
        if (this.closingTag) {
          this.closingTag = undefined
        } else {
          this.closingTag =
            matchedTag.toLocaleLowerCase() === '<thinking>'
              ? '</thinking>'
              : '</think>'
        }
        continue
      }

      const retained = flush
        ? 0
        : longestTagPrefixSuffix(this.buffer, tags)
      const boundary = this.buffer.length - retained
      appendDelta(result, target, this.buffer.slice(0, boundary))
      this.buffer = this.buffer.slice(boundary)
      break
    }
    return result
  }
}
