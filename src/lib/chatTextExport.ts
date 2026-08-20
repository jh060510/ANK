import type { TranscriptRefineBlock } from './api'
import type { ConversationContext, TranscriptItem } from '../types'

export const EXPORT_PAYLOAD_LIMIT_BYTES = 48_000
const EXPORT_BLOCK_FIELD_LIMIT_BYTES = 18_000
const EXPORT_BLOCK_FIELD_LIMIT_CHARS = 5_800
const EXPORT_BATCH_BLOCK_LIMIT = 60
const ENGLISH_HEADING = 'English'
const KOREAN_HEADING = '한국어'

type BilingualTextItem = {
  english: string
  korean: string
  speaker?: string
}

export function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(
    typeof value === 'string' ? value : JSON.stringify(value),
  ).byteLength
}

function reliableSpeakerLabel(speaker: string | undefined, language: 'en' | 'ko'): string {
  const match = speaker?.trim().match(/^Speaker\s+(\d+)$/i)
  if (!match) return ''
  return language === 'en' ? `Speaker ${match[1]}` : `화자 ${match[1]}`
}

export function formatBilingualText(items: BilingualTextItem[]): string {
  const formatLanguage = (language: 'en' | 'ko') => {
    const paragraphs: string[] = []
    let previousSpeaker = ''
    for (const item of items) {
      const text = (language === 'en' ? item.english : item.korean).trim()
      if (!text) continue
      const speaker = reliableSpeakerLabel(item.speaker, language)
      if (speaker && speaker !== previousSpeaker) paragraphs.push(`[${speaker}]`)
      paragraphs.push(text)
      previousSpeaker = speaker
    }
    return paragraphs.join('\n\n')
  }
  return [
    ENGLISH_HEADING,
    formatLanguage('en'),
    KOREAN_HEADING,
    formatLanguage('ko'),
  ].join('\n\n').trim()
}

export function combineBilingualExportParts(parts: string[]): string {
  const english: string[] = []
  const korean: string[] = []
  const divider = `\n\n${KOREAN_HEADING}\n\n`
  for (const part of parts) {
    const normalized = part.trim()
    const body = normalized.startsWith(`${ENGLISH_HEADING}\n\n`)
      ? normalized.slice(ENGLISH_HEADING.length + 2)
      : normalized
    const dividerIndex = body.indexOf(divider)
    if (dividerIndex < 0) continue
    const englishPart = body.slice(0, dividerIndex).trim()
    const koreanPart = body.slice(dividerIndex + divider.length).trim()
    if (englishPart) english.push(englishPart)
    if (koreanPart) korean.push(koreanPart)
  }
  return [ENGLISH_HEADING, english.join('\n\n'), KOREAN_HEADING, korean.join('\n\n')]
    .join('\n\n')
    .trim()
}

/** Builds the lossless fallback download. Questions, metadata, and timestamps are
 * intentionally excluded: Chat Text contains only the bilingual transcript. */
export function rawChatText(context: ConversationContext): string {
  return formatBilingualText(context.segments
    .filter((segment) => segment.kind === 'transcript' && segment.english.trim())
    .map((segment) => ({
      english: segment.english,
      korean: segment.korean,
      speaker: segment.speaker,
    })))
}

function splitByRequestLimits(value: string): string[] {
  if (!value) return ['']
  const chunks: string[] = []
  let current = ''
  let currentBytes = 0
  let currentCharacters = 0

  for (const character of value) {
    const characterBytes = utf8Bytes(character)
    const characterLength = character.length
    if (
      current
      && (
        currentBytes + characterBytes > EXPORT_BLOCK_FIELD_LIMIT_BYTES
        || currentCharacters + characterLength > EXPORT_BLOCK_FIELD_LIMIT_CHARS
      )
    ) {
      chunks.push(current)
      current = ''
      currentBytes = 0
      currentCharacters = 0
    }
    current += character
    currentBytes += characterBytes
    currentCharacters += characterLength
  }

  if (current || !chunks.length) chunks.push(current)
  return chunks
}

function splitOversizeExportBlock(block: TranscriptRefineBlock): TranscriptRefineBlock[] {
  if (
    block.english.length <= 6_000
    && block.korean.length <= 6_000
    && utf8Bytes({ blocks: [block] }) <= EXPORT_PAYLOAD_LIMIT_BYTES
  ) return [block]

  // This preserves the established request contract for legacy oversized blocks.
  // Normal live transcript blocks never reach these limits.
  const englishParts = splitByRequestLimits(block.english)
  const koreanParts = splitByRequestLimits(block.korean)
  const count = Math.max(englishParts.length, koreanParts.length)
  return Array.from({ length: count }, (_, index) => ({
    ...block,
    id: `${block.id.slice(0, 180)}-part-${index + 1}`,
    english: englishParts[index] || '…',
    korean: koreanParts[index] ?? '',
  }))
}

export function exportBatches(segments: TranscriptItem[]): TranscriptRefineBlock[][] {
  const blocks = segments
    .filter((segment) => segment.kind === 'transcript' && segment.english.trim())
    .map((segment) => ({
      id: segment.id,
      english: segment.english,
      korean: segment.korean,
      ...(segment.speaker ? { speaker: segment.speaker } : {}),
    }))
    .flatMap(splitOversizeExportBlock)

  const batches: TranscriptRefineBlock[][] = []
  let current: TranscriptRefineBlock[] = []
  for (const block of blocks) {
    const candidate = [...current, block]
    if (
      current.length
      && (
        current.length >= EXPORT_BATCH_BLOCK_LIMIT
        || utf8Bytes({ blocks: candidate }) > EXPORT_PAYLOAD_LIMIT_BYTES
      )
    ) {
      batches.push(current)
      current = []
    }
    current.push(block)
  }
  if (current.length) batches.push(current)
  return batches
}
