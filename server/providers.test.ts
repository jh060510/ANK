import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  exportTranscriptText,
  generateEnglishPronunciation,
  polishQuestionDetailed,
  refineTranscriptContext,
  resetTranslationProviderHealthForTests,
  translateText,
  translateTextDetailed,
} from './providers.js'

afterEach(() => {
  vi.restoreAllMocks()
  resetTranslationProviderHealthForTests()
  delete process.env.GROQ_API_KEY
  delete process.env.GROQ_MODEL
  delete process.env.GEMINI_API_KEY
  delete process.env.GEMINI_MODEL
  delete process.env.TRANSLATION_SCRIPT_URL
  delete process.env.CEREBRAS_API_KEY
  delete process.env.CEREBRAS_MODEL
  delete process.env.NVIDIA_API_KEY
  delete process.env.NVIDIA_MODEL
})

describe('live translation provider', () => {
  it('routes live translation through the configured Groq production model', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    process.env.GROQ_MODEL = 'openai/gpt-oss-20b'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '빠른 번역' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(translateText({ text: 'Unique provider routing test.' })).resolves.toBe('빠른 번역')
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
    const init = request.mock.calls[0][1]
    const body = JSON.parse(String(init?.body)) as {
      model: string
      reasoning_effort: string
      messages: Array<{ content: string }>
    }
    expect(body).toMatchObject({ model: 'openai/gpt-oss-20b', reasoning_effort: 'low' })
    expect(body.messages[0].content).toContain('Anthropic')
    expect(body.messages[0].content).toContain('retrieval')
  })

  it('falls back from Groq to the translation script without exposing credentials', async () => {
    process.env.GROQ_API_KEY = 'secret-groq-key'
    process.env.TRANSLATION_SCRIPT_URL = 'https://example.test/translate'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'busy' } }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('대체 번역', { status: 200 }))

    await expect(translateTextDetailed({ text: 'Unique fallback chain test.' })).resolves.toEqual({
      translation: '대체 번역',
      provider: 'script',
    })
    expect(request).toHaveBeenCalledTimes(2)
    expect(String(request.mock.calls[1][0])).toContain('source=en')
    expect(String(request.mock.calls[1][0])).toContain('target=ko')
  })

  it('keeps Groq on cooldown after rate limiting and routes following speech to Cerebras', async () => {
    process.env.GROQ_API_KEY = 'rate-limited-groq'
    process.env.CEREBRAS_API_KEY = 'standby-cerebras'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'rate limited' } }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '600' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '첫 번째 우회 번역' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '두 번째 우회 번역' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(translateTextDetailed({ text: 'First rate-limit failover sentence.' })).resolves.toEqual({
      translation: '첫 번째 우회 번역',
      provider: 'cerebras',
    })
    await expect(translateTextDetailed({ text: 'Second sentence during cooldown.' })).resolves.toEqual({
      translation: '두 번째 우회 번역',
      provider: 'cerebras',
    })

    expect(request).toHaveBeenCalledTimes(3)
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.groq.com/openai/v1/chat/completions',
      'https://api.cerebras.ai/v1/chat/completions',
      'https://api.cerebras.ai/v1/chat/completions',
    ])
  })

  it('uses Gemini as the final configured translation fallback', async () => {
    process.env.GROQ_API_KEY = 'test-groq'
    process.env.TRANSLATION_SCRIPT_URL = 'https://example.test/translate'
    process.env.GEMINI_API_KEY = 'test-gemini'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(new Response('ERROR: unavailable', { status: 502 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ translation: '최종 번역' }) }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(translateTextDetailed({ text: 'Unique Gemini fallback test.' })).resolves.toEqual({
      translation: '최종 번역',
      provider: 'gemini',
    })
    expect(request).toHaveBeenCalledTimes(3)
  })

  it('reuses an accepted routed translation without another provider call', async () => {
    process.env.GROQ_API_KEY = 'cache-test-groq'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '캐시된 번역' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const input = { text: 'Unique final route cache sentence.', context: 'Stable context.' }

    await expect(translateTextDetailed(input)).resolves.toEqual({
      translation: '캐시된 번역',
      provider: 'groq',
    })
    await expect(translateTextDetailed(input)).resolves.toEqual({
      translation: '캐시된 번역',
      provider: 'groq',
    })
    expect(request).toHaveBeenCalledOnce()
  })

  it('does not share routed translations across different effective contexts', async () => {
    process.env.GROQ_API_KEY = 'context-cache-test-groq'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '첫 번역' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '둘째 번역' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await translateTextDetailed({ text: 'The same current sentence.', context: 'Context A' })
    await translateTextDetailed({ text: 'The same current sentence.', context: 'Context B' })
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('reports only safe provider identifiers when every fallback fails', async () => {
    process.env.GROQ_API_KEY = 'private-groq'
    process.env.TRANSLATION_SCRIPT_URL = 'https://example.test/translate'
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(new Response('ERROR: unavailable', { status: 502 }))

    await expect(translateTextDetailed({ text: 'Unique total failure test.' })).rejects.toMatchObject({
      message: 'All configured translation providers failed',
      providers: ['groq', 'script'],
    })
  })
})

describe('transcript refinement contract', () => {
  it('uses the working Groq free tier before slower cleanup fallbacks', async () => {
    process.env.GROQ_API_KEY = 'test-groq'
    process.env.GEMINI_API_KEY = 'standby-gemini'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        groups: [{
          sourceIds: ['groq-cleanup'],
          speaker: 'Speaker',
          english: 'AI changes professional work.',
          korean: 'AI는 전문 업무를 변화시킵니다.',
        }],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{ id: 'groq-cleanup', english: 'AI changes professional work', korean: '' }],
    })).resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions')
  })

  it('falls through when a free cleanup provider returns unsafe JSON', async () => {
    process.env.GROQ_API_KEY = 'test-groq'
    process.env.GEMINI_API_KEY = 'test-gemini'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          groups: [{
            sourceIds: ['wrong-id'],
            speaker: 'Speaker',
            english: 'Wrong.',
            korean: '잘못됐습니다.',
          }],
        }) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          groups: [{
            sourceIds: ['safe-fallback'],
            speaker: 'Speaker',
            english: 'Safe fallback.',
            korean: '안전한 대체 결과입니다.',
          }],
        }) }] } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{ id: 'safe-fallback', english: 'Safe fallback.', korean: '' }],
    })).resolves.toHaveLength(1)
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls.map(([url]) => String(url))).toEqual([
      'https://api.groq.com/openai/v1/chat/completions',
      expect.stringContaining('generativelanguage.googleapis.com'),
    ])
  })

  it('uses the fast Cerebras free-tier route for transcript refinement', async () => {
    process.env.CEREBRAS_API_KEY = 'test-cerebras'
    process.env.CEREBRAS_MODEL = 'gemma-4-31b'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        groups: [{
          sourceIds: ['cerebras-only'],
          speaker: 'Speaker 1',
          english: 'NVIDIA accelerates inference.',
          korean: 'NVIDIA는 추론을 가속합니다.',
        }],
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{
        id: 'cerebras-only',
        english: 'NVIDIA accelerates inference.',
        korean: '',
        speaker: 'Speaker 1',
      }],
    })).resolves.toHaveLength(1)
    expect(request.mock.calls[0][0]).toBe('https://api.cerebras.ai/v1/chat/completions')
  })

  it('accepts only contiguous groups that preserve every source id exactly once', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['a', 'b'],
          speaker: 'Speaker 1',
          english: 'OpenAI builds models.',
          korean: 'OpenAI는 모델을 개발합니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [
        { id: 'a', english: 'OpenAI builds', korean: '', speaker: 'Speaker 1' },
        { id: 'b', english: 'models.', korean: '모델입니다.', speaker: 'Speaker 1' },
      ],
    })).resolves.toEqual([{
      sourceIds: ['a', 'b'],
      speaker: 'Speaker 1',
      english: 'OpenAI builds models.',
      korean: 'OpenAI는 모델을 개발합니다.',
    }])
  })

  it('rejects a model response that drops or reorders source ids', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['b'],
          speaker: 'Speaker 1',
          english: 'Second.',
          korean: '두 번째.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [
        { id: 'a', english: 'First.', korean: '첫 번째.' },
        { id: 'b', english: 'Second.', korean: '두 번째.' },
      ],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('recovers only missing Korean and preserves the existing bilingual text', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'RAG란 무엇인가요?' } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(exportTranscriptText({
      blocks: [
        {
          id: 'existing-id',
          english: 'The existing translation stays unchanged.',
          korean: '기존 번역은 변경하지 않습니다.',
          speaker: 'Speaker 2',
        },
        {
          id: 'internal-id',
          english: 'What is RAG?',
          korean: '',
          speaker: 'Speaker 2',
        },
      ],
    })).resolves.toBe([
      'English',
      '[Speaker 2]',
      'The existing translation stays unchanged.',
      'What is RAG?',
      '한국어',
      '[화자 2]',
      '기존 번역은 변경하지 않습니다.',
      'RAG란 무엇인가요?',
    ].join('\n\n'))
    expect(request).toHaveBeenCalledOnce()
    expect(String(request.mock.calls[0][1]?.body)).toContain('What is RAG?')
    expect(String(request.mock.calls[0][1]?.body)).not.toContain('Current English:\\n<current>The existing translation')
  })

  it('recovers every missing block independently without dropping later translations', async () => {
    process.env.GROQ_API_KEY = 'test-key'
    const request = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '첫 번째 번역입니다.' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: '두 번째 번역입니다.' } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(exportTranscriptText({
      blocks: [
        { id: 'missing-a', english: 'First missing block.', korean: '', speaker: 'Speaker 1' },
        { id: 'missing-b', english: 'Second missing block.', korean: '', speaker: 'Speaker 1' },
      ],
    })).resolves.toBe([
      'English',
      '[Speaker 1]',
      'First missing block.',
      'Second missing block.',
      '한국어',
      '[화자 1]',
      '첫 번째 번역입니다.',
      '두 번째 번역입니다.',
    ].join('\n\n'))
    expect(request).toHaveBeenCalledTimes(2)
  })

  it('does not call an AI provider when every block already has Korean', async () => {
    process.env.GROQ_API_KEY = 'configured-but-unused'
    const request = vi.spyOn(globalThis, 'fetch')

    await expect(exportTranscriptText({
      blocks: [
        { id: 'raw-a', english: 'Original English one.', korean: '원래 한국어 하나.' },
        { id: 'raw-b', english: 'Original English two.', korean: '원래 한국어 둘.' },
      ],
    })).resolves.toBe([
      'English',
      'Original English one.',
      'Original English two.',
      '한국어',
      '원래 한국어 하나.',
      '원래 한국어 둘.',
    ].join('\n\n'))
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps captured English and existing Korean when missing translation recovery fails', async () => {
    process.env.GROQ_API_KEY = 'unavailable-free-groq'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: { message: 'free tier temporarily unavailable' },
    }), { status: 503, headers: { 'Content-Type': 'application/json' } }))

    await expect(exportTranscriptText({
      blocks: [
        { id: 'ready', english: 'Already translated.', korean: '이미 번역되었습니다.' },
        { id: 'missing', english: 'Still captured in English.', korean: '' },
      ],
    })).resolves.toBe([
      'English',
      'Already translated.',
      'Still captured in English.',
      '한국어',
      '이미 번역되었습니다.',
    ].join('\n\n'))
  })

  it('rejects an invented numbered speaker when diarization is absent', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['unknown'],
          speaker: 'Speaker 1',
          english: 'Unknown speaker.',
          korean: '알 수 없는 발화자입니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{ id: 'unknown', english: 'Unknown speaker.', korean: '' }],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('does not treat a legacy Speaker placeholder as mergeable diarization', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['unknown-a', 'unknown-b'],
          speaker: 'Speaker',
          english: 'Unknown one. Unknown two.',
          korean: '알 수 없는 첫째와 둘째입니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [
        { id: 'unknown-a', english: 'Unknown one.', korean: '알 수 없는 첫째입니다.', speaker: 'Speaker' },
        { id: 'unknown-b', english: 'Unknown two.', korean: '알 수 없는 둘째입니다.', speaker: 'Speaker' },
      ],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('rejects refinement that drops protected AI names or numeric facts', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['protected'],
          speaker: 'Speaker 1',
          english: 'The accelerator improved inference throughput.',
          korean: '가속기가 추론 처리량을 향상했습니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{
        id: 'protected',
        english: 'The NVIDIA H100 accelerator improved inference throughput by 42%.',
        korean: '',
        speaker: 'Speaker 1',
      }],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('rejects a numeric fact changed to a value with the same prefix', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['numeric-prefix'],
          speaker: 'Speaker 1',
          english: 'The model scored 100 points in the benchmark.',
          korean: '모델은 벤치마크에서 100점을 받았습니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{
        id: 'numeric-prefix',
        english: 'The model scored 10 points in the benchmark.',
        korean: '',
        speaker: 'Speaker 1',
      }],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('rejects a numeric fact changed only in the Korean result', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['korean-numeric'],
          speaker: 'Speaker 1',
          english: 'The model scored 10 points in the benchmark.',
          korean: '모델은 벤치마크에서 100점을 받았습니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{
        id: 'korean-numeric',
        english: 'The model scored 10 points in the benchmark.',
        korean: '모델은 벤치마크에서 10점을 받았습니다.',
        speaker: 'Speaker 1',
      }],
    })).rejects.toThrow('unsafe transcript grouping')
  })

  it('rejects a percentage changed to a different unit', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify({
        groups: [{
          sourceIds: ['numeric-unit'],
          speaker: 'Speaker 1',
          english: 'Inference improved by 42 dollars.',
          korean: '추론이 42달러 향상됐습니다.',
        }],
      }) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(refineTranscriptContext({
      blocks: [{
        id: 'numeric-unit',
        english: 'Inference improved by 42%.',
        korean: '추론이 42% 향상됐습니다.',
        speaker: 'Speaker 1',
      }],
    })).rejects.toThrow('unsafe transcript grouping')
  })
})

describe('Q Translate provider', () => {
  it('transcribes the exact English sentence instead of retranslating Korean', async () => {
    process.env.CEREBRAS_API_KEY = 'test-cerebras'
    const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        pronunciation: '인 왓 스페시픽 웨이즈 이즈 에이아이 트랜스포밍 워크?',
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(generateEnglishPronunciation({
      english: 'In what specific ways is AI transforming work?',
    })).resolves.toContain('인 왓 스페시픽 웨이즈')
    const body = JSON.parse(String(request.mock.calls[0][1]?.body)) as {
      messages: Array<{ content: string }>
    }
    expect(body.messages[0].content).toContain('<english>In what specific ways is AI transforming work?</english>')
    expect(body.messages[0].content).toContain('Never translate, paraphrase')
  })

  it('returns polished English and a Hangul pronunciation guide together', async () => {
    process.env.CEREBRAS_API_KEY = 'test-cerebras'
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify({
        english: 'Would you elaborate on that trade-off?',
        pronunciation: '우드 유 일래버레이트 온 댓 트레이드오프?',
      }) } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))

    await expect(polishQuestionDetailed({ korean: '그 상충 관계를 자세히 설명해 주시겠습니까?' }))
      .resolves.toEqual({
        english: 'Would you elaborate on that trade-off?',
        pronunciation: '우드 유 일래버레이트 온 댓 트레이드오프?',
      })
  })
})
