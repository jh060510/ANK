import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  exportChatText,
  generateEnglishPronunciation,
  polishQuestionDetailed,
  refineContext,
  retryFailedTranslation,
  translate,
} from './api'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('live translation request', () => {
  it('makes one browser request because provider failover is handled by the server', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ translation: '안녕하세요' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(translate('Hello', '')).resolves.toBe('안녕하세요')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('marks an individual retry intent in one safe server request', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ translation: '복구된 번역' }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(retryFailedTranslation('Recovered text.', 'Earlier context.'))
      .resolves.toBe('복구된 번역')
    const init = fetchMock.mock.calls[0][1]
    expect(JSON.parse(String(init?.body))).toMatchObject({ retry: true })
  })
})

describe('Q Translate API', () => {
  it('returns English and its Hangul pronunciation together', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      english: 'Could you clarify that?',
      pronunciation: '쿠드 유 클래러파이 댓?',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    await expect(polishQuestionDetailed('그 부분을 명확히 해주시겠습니까?')).resolves.toEqual({
      english: 'Could you clarify that?',
      pronunciation: '쿠드 유 클래러파이 댓?',
    })
  })

  it('requests pronunciation from the exact displayed English sentence', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      pronunciation: '인 왓 스페시픽 웨이즈?',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(generateEnglishPronunciation('In what specific ways?'))
      .resolves.toBe('인 왓 스페시픽 웨이즈?')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/english-pronunciation')
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body)))
      .toEqual({ english: 'In what specific ways?' })
  })
})

describe('transcript refinement APIs', () => {
  it('returns source-id-preserving context groups', async () => {
    const groups = [{
      sourceIds: ['one', 'two'],
      speaker: 'Speaker 1',
      english: 'A complete answer.',
      korean: '완전한 답변입니다.',
    }]
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ groups }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ))
    vi.stubGlobal('fetch', fetchMock)

    await expect(refineContext([
      { id: 'one', english: 'A complete', korean: '' },
      { id: 'two', english: 'answer.', korean: '답변입니다.' },
    ])).resolves.toEqual(groups)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/refine-context')
  })

  it('reads the chat-only export as plain text', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      'Speaker 1\nHello.\n안녕하세요.',
      { status: 200, headers: { 'Content-Type': 'text/plain' } },
    )))

    await expect(exportChatText([
      { id: 'one', english: 'Hello.', korean: '안녕하세요.' },
    ])).resolves.toBe('Speaker 1\nHello.\n안녕하세요.')
  })
})
