import { describe, expect, it } from 'vitest'

import {
  closeFinalizedTranscriptBuffer,
  closeTranscriptBuffer,
  consumeDeepgramResult,
  emptyTranscriptBuffer,
} from './transcript'

function result(text: string, isFinal = false, speechFinal = false) {
  return {
    type: 'Results' as const,
    is_final: isFinal,
    speech_final: speechFinal,
    channel: { alternatives: [{ transcript: text }] },
  }
}

describe('Deepgram transcript accumulator', () => {
  it('replaces interim text instead of duplicating it', () => {
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), result('hello'))
    const second = consumeDeepgramResult(first.buffer, result('hello there'))

    expect(second.liveText).toBe('hello there')
    expect(second.buffer.interim).toBe('hello there')
  })

  it('clears a false-positive interim when Deepgram retracts it', () => {
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), result('background noise'))
    const retracted = consumeDeepgramResult(first.buffer, result(''))
    expect(retracted.liveText).toBe('')
    expect(closeTranscriptBuffer(retracted.buffer).commitText).toBeUndefined()
  })

  it('buffers an is_final chunk until the complete utterance ends', () => {
    const first = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('this is final', true, false),
    )

    expect(first.stableText).toBeUndefined()
    expect(first.liveText).toBe('this is final')
    expect(first.buffer.finalized).toEqual(['this is final'])
  })

  it('combines final chunks and emits one stable utterance on speech_final', () => {
    const first = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('one part', true, false),
    )
    const second = consumeDeepgramResult(
      first.buffer,
      result('second part', true, true),
    )

    expect(first.stableText).toBeUndefined()
    expect(second.stableText).toBe('one part second part')
    expect(second.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('flushes a punctuated sentence without waiting for end of speech', () => {
    const sentence = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('This gives us a complete sentence.', true, false),
    )

    expect(sentence.stableText).toBe('This gives us a complete sentence.')
    expect(sentence.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('does not mistake a short abbreviation for a complete phrase', () => {
    const abbreviation = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('Dr.', true, false),
    )

    expect(abbreviation.stableText).toBeUndefined()
    expect(abbreviation.liveText).toBe('Dr.')
  })

  it('flushes an 18-word continuous phrase before it stalls live translation', () => {
    const longPhrase = Array.from({ length: 18 }, (_, index) => `word${index + 1}`).join(' ')
    const update = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result(longPhrase, true, false),
    )

    expect(update.stableText).toBe(longPhrase)
    expect(update.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('flushes after five seconds of finalized continuous speech', () => {
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('we are still speaking', true, false),
      start: 10,
      duration: 2.5,
    })
    const second = consumeDeepgramResult(first.buffer, {
      ...result('without a natural pause', true, false),
      start: 12.5,
      duration: 2.6,
    })

    expect(second.stableText).toBe('we are still speaking without a natural pause')
    expect(second.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('uses timestamps to distinguish repeated stable speech blocks', () => {
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('yes', true),
      start: 1,
      duration: 0.2,
    })
    const second = consumeDeepgramResult(first.buffer, {
      ...result('yes', true, true),
      start: 2,
      duration: 0.2,
    })

    expect(first.stableKey).toBeUndefined()
    expect(second.stableKey).toContain('1.000:0.200:yes')
    expect(second.stableKey).toContain('2.000:0.200:yes')
    expect(second.stableText).toBe('yes yes')
  })

  it('emits the final block returned by an explicit Finalize request', () => {
    const finalized = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('last words', true, false),
      from_finalize: true,
    })
    expect(finalized.stableText).toBe('last words')
    expect(closeTranscriptBuffer(finalized.buffer).commitText).toBeUndefined()
  })

  it('preserves a speech_final result even when is_final is absent', () => {
    const first = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('the first range', true, false),
    )
    const ended = consumeDeepgramResult(
      first.buffer,
      result('and the endpoint', false, true),
    )

    expect(ended.stableText).toBe('the first range and the endpoint')
    expect(ended.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('flushes already finalized chunks when Finalize returns an empty result', () => {
    const buffered = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('words before stop', true, false),
    )
    const finalized = consumeDeepgramResult(buffered.buffer, {
      ...result('', true, false),
      from_finalize: true,
    })

    expect(finalized.stableText).toBe('words before stop')
    expect(finalized.buffer).toEqual(emptyTranscriptBuffer())
  })

  it('commits a pending interim on an explicit fallback close', () => {
    const pending = consumeDeepgramResult(emptyTranscriptBuffer(), result('still here'))
    expect(closeTranscriptBuffer(pending.buffer).commitText).toBe('still here')
  })

  it('commits finalized and interim parts together on fallback close', () => {
    const finalized = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('a completed range', true, false),
    )
    const interim = consumeDeepgramResult(
      finalized.buffer,
      result('and the trailing words'),
    )

    expect(closeTranscriptBuffer(interim.buffer).commitText)
      .toBe('a completed range and the trailing words')
  })

  it('keeps only model-finalized text when a connection is interrupted', () => {
    const finalized = consumeDeepgramResult(
      emptyTranscriptBuffer(),
      result('confirmed words', true, false),
    )
    const interim = consumeDeepgramResult(
      finalized.buffer,
      result('possibly wrong trailing guess'),
    )

    expect(closeFinalizedTranscriptBuffer(interim.buffer).commitText).toBe('confirmed words')
  })

  it('preserves a unanimous Deepgram word speaker on a stable block', () => {
    const update = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('Could you explain RAG?', true, true),
      channel: {
        alternatives: [{
          transcript: 'Could you explain RAG?',
          words: [
            { word: 'Could', speaker: 1 },
            { word: 'you', speaker: 1 },
            { word: 'explain', speaker: 1 },
            { word: 'RAG', speaker: 1 },
          ],
        }],
      },
    })

    expect(update.stableSpeaker).toBe(1)
  })

  it('does not misattribute a mixed-speaker word run to its majority speaker', () => {
    const update = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('Question and answer', true, true),
      channel: {
        alternatives: [{
          transcript: 'Question and answer',
          words: [
            { word: 'Question', speaker: 0 },
            { word: 'and', speaker: 0 },
            { word: 'answer', speaker: 1 },
          ],
        }],
      },
    })

    expect(update.stableSpeaker).toBeUndefined()
    expect(update.stableBlocks).toEqual([
      { text: 'Question and', speaker: 0 },
      { text: 'answer', speaker: 1 },
    ])
  })

  it('splits speaker changes accumulated across consecutive final chunks', () => {
    const interviewer = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('What changed?', true, false),
      channel: {
        alternatives: [{
          transcript: 'What changed?',
          words: [
            { punctuated_word: 'What', speaker: 0 },
            { punctuated_word: 'changed?', speaker: 0 },
          ],
        }],
      },
    })
    const interviewee = consumeDeepgramResult(interviewer.buffer, {
      ...result('The workflow changed.', true, true),
      channel: {
        alternatives: [{
          transcript: 'The workflow changed.',
          words: [
            { punctuated_word: 'The', speaker: 1 },
            { punctuated_word: 'workflow', speaker: 1 },
            { punctuated_word: 'changed.', speaker: 1 },
          ],
        }],
      },
    })

    expect(interviewee.stableBlocks).toEqual([
      { text: 'What changed?', speaker: 0 },
      { text: 'The workflow changed.', speaker: 1 },
    ])
  })

  it('keeps a result unknown when any word lacks reliable speaker metadata', () => {
    const update = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('Partially attributed speech.', true, true),
      channel: {
        alternatives: [{
          transcript: 'Partially attributed speech.',
          words: [
            { punctuated_word: 'Partially', speaker: 0 },
            { punctuated_word: 'attributed' },
            { punctuated_word: 'speech.', speaker: 0 },
          ],
        }],
      },
    })

    expect(update.stableBlocks).toEqual([{ text: 'Partially attributed speech.' }])
  })

  it('carries finalized speaker evidence through an interruption close', () => {
    const finalized = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('confirmed answer', true, false),
      channel: {
        alternatives: [{
          transcript: 'confirmed answer',
          words: [{ word: 'confirmed', speaker: 0 }, { word: 'answer', speaker: 0 }],
        }],
      },
    })
    const interim = consumeDeepgramResult(finalized.buffer, {
      ...result('unconfirmed tail'),
      channel: {
        alternatives: [{
          transcript: 'unconfirmed tail',
          words: [{ word: 'unconfirmed', speaker: 1 }, { word: 'tail', speaker: 1 }],
        }],
      },
    })

    const closed = closeFinalizedTranscriptBuffer(interim.buffer)
    expect(closed.commitText).toBe('confirmed answer')
    expect(closed.commitSpeaker).toBe(0)
  })

  it('preserves separate finalized speaker runs during an interruption close', () => {
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), {
      ...result('Question', true, false),
      channel: { alternatives: [{ transcript: 'Question', words: [{ word: 'Question', speaker: 0 }] }] },
    })
    const second = consumeDeepgramResult(first.buffer, {
      ...result('Answer', true, false),
      channel: { alternatives: [{ transcript: 'Answer', words: [{ word: 'Answer', speaker: 1 }] }] },
    })

    expect(closeFinalizedTranscriptBuffer(second.buffer).commitBlocks).toEqual([
      { text: 'Question', speaker: 0 },
      { text: 'Answer', speaker: 1 },
    ])
  })

  it('does not append the same timestamped final range twice', () => {
    const chunk = {
      ...result('do not duplicate', true, false),
      start: 1,
      duration: 0.8,
    }
    const first = consumeDeepgramResult(emptyTranscriptBuffer(), chunk)
    const duplicate = consumeDeepgramResult(first.buffer, chunk)
    const ended = consumeDeepgramResult(duplicate.buffer, {
      ...result('', true, true),
      start: 1.8,
      duration: 0,
    })

    expect(ended.stableText).toBe('do not duplicate')
  })
})
