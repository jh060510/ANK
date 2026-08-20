import type { DeepgramResult } from '../types'

export type TranscriptBuffer = {
  finalized: string[]
  finalizedKeys: string[]
  finalizedStart: number | null
  finalizedEnd: number | null
  finalizedSpeakerRuns: SpeakerTextRun[]
  interim: string
  interimSpeakerRuns: SpeakerTextRun[]
}

export type SpeakerTextRun = {
  text: string
  speaker?: number
}

export type StableTranscriptBlock = SpeakerTextRun & {
  stableKey?: string
}

export type TranscriptUpdate = {
  buffer: TranscriptBuffer
  liveText: string
  stableBlocks?: StableTranscriptBlock[]
  stableText?: string
  stableKey?: string
  stableSpeaker?: number
  commitBlocks?: SpeakerTextRun[]
  commitText?: string
  commitSpeaker?: number
}

export const emptyTranscriptBuffer = (): TranscriptBuffer => ({
  finalized: [],
  finalizedKeys: [],
  finalizedStart: null,
  finalizedEnd: null,
  finalizedSpeakerRuns: [],
  interim: '',
  interimSpeakerRuns: [],
})

// Keep a spoken thought intact, but do not make a continuous speaker wait several
// seconds before translation starts. Natural VAD endpoints still win first.
// Interview answers benefit from longer semantic blocks. A real sentence end
// can still flush early, while uninterrupted speech is bounded so translation
// never waits indefinitely.
const PHRASE_MAX_WORDS = 18
const PHRASE_MAX_SECONDS = 5
const SENTENCE_FLUSH_MIN_WORDS = 6

function joinTranscriptParts(parts: string[]): string {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function resultKey(result: DeepgramResult, text: string): string | undefined {
  return typeof result.start === 'number' && typeof result.duration === 'number'
    ? `${result.start.toFixed(3)}:${result.duration.toFixed(3)}:${text}`
    : undefined
}

function wordCount(text: string): number {
  return text
    .split(/\s+/)
    .filter((token) => /[\p{L}\p{N}]/u.test(token))
    .length
}

function compactSpeakerRuns(runs: SpeakerTextRun[]): SpeakerTextRun[] {
  const compacted: SpeakerTextRun[] = []
  for (const run of runs) {
    const text = run.text.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const previous = compacted.at(-1)
    if (previous && previous.speaker === run.speaker) {
      previous.text = joinTranscriptParts([previous.text, text])
    } else {
      compacted.push({ text, ...(run.speaker !== undefined ? { speaker: run.speaker } : {}) })
    }
  }
  return compacted
}

function speakerRuns(result: DeepgramResult, text: string): SpeakerTextRun[] {
  if (!text) return []
  const words = result.channel?.alternatives?.[0]?.words ?? []
  const normalized = words.flatMap((word) => {
    const token = (word.punctuated_word || word.word || '').trim()
    const speaker = word.speaker
    return token
      && typeof speaker === 'number'
      && Number.isInteger(speaker)
      && speaker >= 0
      ? [{ text: token, speaker }]
      : []
  })

  // Partial word metadata cannot safely identify which portion of the full
  // transcript belongs to a speaker. Preserve the exact transcript as unknown.
  if (!words.length || normalized.length !== words.length) return [{ text }]
  const unique = new Set(normalized.map((word) => word.speaker))
  // Preserve Deepgram's exact punctuation/casing for the common one-speaker case.
  if (unique.size === 1) return [{ text, speaker: normalized[0].speaker }]
  return compactSpeakerRuns(normalized)
}

function shouldFlushPhrase(buffer: TranscriptBuffer): boolean {
  const text = joinTranscriptParts(buffer.finalized)
  const words = wordCount(text)
  const endsSentence = /[.!?]["')\]]*$/.test(text)
  const duration = buffer.finalizedStart !== null && buffer.finalizedEnd !== null
    ? buffer.finalizedEnd - buffer.finalizedStart
    : 0

  return (
    words >= PHRASE_MAX_WORDS
    || duration >= PHRASE_MAX_SECONDS
    || (words >= SENTENCE_FLUSH_MIN_WORDS && endsSentence)
  )
}

function stabilizeTranscriptBuffer(buffer: TranscriptBuffer): TranscriptUpdate {
  const stableText = joinTranscriptParts([...buffer.finalized, buffer.interim])
  const stableRuns = compactSpeakerRuns([
    ...buffer.finalizedSpeakerRuns,
    ...buffer.interimSpeakerRuns,
  ])
  const stableKey =
    stableText && !buffer.interim && buffer.finalizedKeys.length === buffer.finalized.length
      ? buffer.finalizedKeys.join('|')
      : undefined
  const stableBlocks = stableRuns.map((run, index) => ({
    ...run,
    ...(stableKey ? { stableKey: `${stableKey}#${index}` } : {}),
  }))
  return {
    buffer: emptyTranscriptBuffer(),
    liveText: '',
    stableBlocks: stableBlocks.length ? stableBlocks : undefined,
    stableText: stableText || undefined,
    stableSpeaker: stableBlocks.length === 1 ? stableBlocks[0].speaker : undefined,
    stableKey,
  }
}

export function consumeDeepgramResult(
  previous: TranscriptBuffer,
  result: DeepgramResult,
): TranscriptUpdate {
  const text = result.channel?.alternatives?.[0]?.transcript?.trim() ?? ''

  if (result.is_final) {
    const key = text ? resultKey(result, text) : undefined
    const alreadyBuffered = Boolean(key && previous.finalizedKeys.includes(key))
    const chunkStart = typeof result.start === 'number' ? result.start : null
    const chunkEnd = chunkStart !== null && typeof result.duration === 'number'
      ? chunkStart + result.duration
      : null
    const buffer: TranscriptBuffer = {
      finalized: text && !alreadyBuffered
        ? [...previous.finalized, text]
        : previous.finalized,
      finalizedKeys: key && !alreadyBuffered
        ? [...previous.finalizedKeys, key]
        : previous.finalizedKeys,
      finalizedStart: text && !alreadyBuffered
        ? previous.finalizedStart ?? chunkStart
        : previous.finalizedStart,
      finalizedEnd: text && !alreadyBuffered
        ? chunkEnd ?? previous.finalizedEnd
        : previous.finalizedEnd,
      finalizedSpeakerRuns: text && !alreadyBuffered
        ? [...previous.finalizedSpeakerRuns, ...speakerRuns(result, text)]
        : previous.finalizedSpeakerRuns,
      interim: '',
      interimSpeakerRuns: [],
    }

    // is_final only finalizes a model time range. Deepgram can emit several of
    // these chunks for one spoken thought, so wait for the VAD endpoint (or an
    // explicit Finalize during stop) before creating a permanent UI block.
    if (
      result.speech_final
      || result.from_finalize
      || shouldFlushPhrase(buffer)
    ) return stabilizeTranscriptBuffer(buffer)

    return {
      buffer,
      liveText: joinTranscriptParts(buffer.finalized),
    }
  }

  // A non-final empty result can retract a false-positive interim.
  const buffer = {
    ...previous,
    interim: text,
    interimSpeakerRuns: speakerRuns(result, text),
  }

  // These flags normally accompany an is_final result, but they are independent
  // protocol fields. Preserve a complete endpoint/finalize result even if an
  // upstream version sends it without is_final.
  if (result.speech_final || result.from_finalize) return stabilizeTranscriptBuffer(buffer)

  return {
    buffer,
    liveText: joinTranscriptParts([...buffer.finalized, buffer.interim]),
  }
}

export function closeTranscriptBuffer(previous: TranscriptBuffer): TranscriptUpdate {
  const commitText = joinTranscriptParts([...previous.finalized, previous.interim])
  const commitBlocks = compactSpeakerRuns([
    ...previous.finalizedSpeakerRuns,
    ...previous.interimSpeakerRuns,
  ])
  return {
    buffer: emptyTranscriptBuffer(),
    liveText: '',
    commitBlocks: commitBlocks.length ? commitBlocks : undefined,
    commitText: commitText || undefined,
    commitSpeaker: commitBlocks.length === 1 ? commitBlocks[0].speaker : undefined,
  }
}

export function closeFinalizedTranscriptBuffer(previous: TranscriptBuffer): TranscriptUpdate {
  const commitText = joinTranscriptParts(previous.finalized)
  const commitBlocks = compactSpeakerRuns(previous.finalizedSpeakerRuns)
  return {
    buffer: emptyTranscriptBuffer(),
    liveText: '',
    commitBlocks: commitBlocks.length ? commitBlocks : undefined,
    commitText: commitText || undefined,
    commitSpeaker: commitBlocks.length === 1 ? commitBlocks[0].speaker : undefined,
  }
}
