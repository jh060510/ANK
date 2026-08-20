import type { RefinedTranscriptGroup } from './api'
import type { TranscriptItem } from '../types'

export function selectRefinementCandidates(
  segments: TranscriptItem[],
  cutoff: number,
  maximum = 80,
): TranscriptItem[] {
  let start = 0
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].kind === 'question') {
      start = index + 1
      break
    }
  }
  const selected: TranscriptItem[] = []
  let collecting = false
  for (let index = start; index < segments.length && selected.length < maximum; index += 1) {
    const segment = segments[index]
    const needsTranslationRecovery = (
      segment.translationState === 'error'
      || segment.translationState === 'waiting'
      || !segment.korean.trim()
    )
    if (segment.kind === 'transcript' && segment.refinedAt && !needsTranslationRecovery) {
      if (collecting) break
      continue
    }
    if (
      segment.kind !== 'transcript'
      || segment.translationState === 'pending'
      || segment.createdAt > cutoff
    ) break
    selected.push(segment)
    collecting = true
  }
  return selected
}

export function applyRefinedGroups(
  current: TranscriptItem[],
  source: TranscriptItem[],
  groups: RefinedTranscriptGroup[],
): { segments: TranscriptItem[]; applied: boolean } {
  if (!source.length || !groups.length) return { segments: current, applied: false }
  const sourceIds = source.map((segment) => segment.id)
  const returnedIds = groups.flatMap((group) => group.sourceIds)
  if (
    returnedIds.length !== sourceIds.length
    || returnedIds.some((id, index) => id !== sourceIds[index])
  ) return { segments: current, applied: false }

  const firstIndex = current.findIndex((segment) => segment.id === sourceIds[0])
  if (firstIndex < 0) return { segments: current, applied: false }
  for (let offset = 0; offset < source.length; offset += 1) {
    const latest = current[firstIndex + offset]
    const snapshot = source[offset]
    if (
      !latest
      || latest.id !== snapshot.id
      || latest.kind !== 'transcript'
      || latest.english !== snapshot.english
      || latest.korean !== snapshot.korean
      || latest.speaker !== snapshot.speaker
      || latest.refinedAt !== snapshot.refinedAt
      || latest.translationState !== snapshot.translationState
    ) return { segments: current, applied: false }
  }

  const sourceById = new Map(source.map((segment) => [segment.id, segment]))
  const refinementTime = Date.now()
  const replacements = groups.map((group) => {
    const first = sourceById.get(group.sourceIds[0])!
    const groupSources = group.sourceIds.map((id) => sourceById.get(id)!)
    const normalizedSpeaker = group.speaker.trim()
    const reliableSpeaker = /^Speaker\s+\d+$/i.test(normalizedSpeaker)
      && groupSources.every((segment) => segment.speaker?.trim() === normalizedSpeaker)
      ? normalizedSpeaker
      : undefined
    return {
      ...first,
      english: group.english.trim(),
      korean: group.korean.trim(),
      // `Speaker` is an API-only placeholder for absent diarization. Never turn
      // it into durable evidence that later refinements may use for merging.
      speaker: reliableSpeaker,
      refinedAt: refinementTime,
      sourceIds: groupSources.flatMap((segment) => segment.sourceIds ?? [segment.id]),
      rawEnglish: groupSources.map((segment) => segment.rawEnglish ?? segment.english).join('\n'),
      rawKorean: groupSources.map((segment) => segment.rawKorean ?? segment.korean).join('\n'),
      translationState: 'ready' as const,
    }
  })
  return {
    segments: [
      ...current.slice(0, firstIndex),
      ...replacements,
      ...current.slice(firstIndex + source.length),
    ],
    applied: true,
  }
}
