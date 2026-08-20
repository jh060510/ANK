import 'dotenv/config'

import express, { type NextFunction, type Request, type Response } from 'express'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket, WebSocketServer, type RawData } from 'ws'

import { LocalWorkspaceDatabase } from './localDatabase.js'
import {
  exportTranscriptText,
  generateEnglishPronunciation,
  isTranslationConfigured,
  polishQuestionDetailed,
  ProviderNotConfiguredError,
  refineTranscriptContext,
  type TranscriptRefineBlock,
  TranslationProvidersFailedError,
  translateTextDetailed,
} from './providers.js'

const app = express()
const server = createServer(app)
const port = Number(process.env.PORT || 8787)
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const projectDir = path.resolve(currentDir, '..')
const workspaceDatabasePath = path.resolve(
  process.env.AIYK_DATABASE_PATH || path.join(projectDir, 'data', 'aiyk.sqlite'),
)
const workspaceDatabase = new LocalWorkspaceDatabase(workspaceDatabasePath)
const MAX_WORKSPACE_BYTES = 4_500_000
const allowedOrigins = new Set(
  (process.env.APP_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
)

app.disable('x-powered-by')
const standardJsonParser = express.json({ limit: '64kb' })
const workspaceJsonParser = express.json({ limit: '5mb' })
app.use((request, response, next) => {
  const parser = request.path === '/api/workspace' ? workspaceJsonParser : standardJsonParser
  parser(request, response, next)
})
app.use((_request, response, next) => {
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Permissions-Policy', 'microphone=(self)')
  next()
})

const liveConnectionRequests = new Map<string, { count: number; resetAt: number }>()
function allowLiveConnection(key: string): boolean {
  const now = Date.now()
  const current = liveConnectionRequests.get(key)
  if (!current || current.resetAt <= now) {
    liveConnectionRequests.set(key, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (current.count >= 12) return false
  current.count += 1
  return true
}

function requireAllowedOrigin(request: Request, response: Response, next: NextFunction) {
  const origin = request.get('origin')
  if (origin && !allowedOrigins.has(origin)) {
    response.status(403).json({ error: '허용되지 않은 요청 출처입니다.' })
    return
  }
  next()
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.get('/api/config', (_request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  response.json({
    deepgramConfigured: Boolean(process.env.DEEPGRAM_API_KEY),
    translationConfigured: isTranslationConfigured(),
  })
})

app.get('/api/workspace', requireAllowedOrigin, (_request, response) => {
  response.setHeader('Cache-Control', 'no-store')
  try {
    const snapshot = workspaceDatabase.read()
    response.json(snapshot ?? { workspace: null, savedAt: null })
  } catch (error) {
    console.error(`[AIYK] Local database read failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    response.status(500).json({ error: '로컬 데이터베이스를 읽지 못했습니다.' })
  }
})

app.put('/api/workspace', requireAllowedOrigin, (request, response) => {
  const workspace = request.body?.workspace as unknown
  const expectedSavedAt = request.body?.expectedSavedAt
  if (!workspace || typeof workspace !== 'object') {
    response.status(400).json({ error: '저장할 워크스페이스가 필요합니다.' })
    return
  }
  const candidate = workspace as {
    schemaVersion?: unknown
    activeContextId?: unknown
    contexts?: unknown
  }
  if (
    candidate.schemaVersion !== 2
    || typeof candidate.activeContextId !== 'string'
    || !Array.isArray(candidate.contexts)
    || !candidate.contexts.length
  ) {
    response.status(400).json({ error: '워크스페이스 형식이 올바르지 않습니다.' })
    return
  }

  const serialized = JSON.stringify(workspace)
  if (Buffer.byteLength(serialized, 'utf8') > MAX_WORKSPACE_BYTES) {
    response.status(413).json({ error: '로컬 DB 저장 용량 4.5MB를 초과했습니다.' })
    return
  }

  try {
    const current = workspaceDatabase.read()
    const hasValidExpectation = expectedSavedAt === null || (
      typeof expectedSavedAt === 'number' && Number.isFinite(expectedSavedAt)
    )
    if (!hasValidExpectation || (current?.savedAt ?? null) !== expectedSavedAt) {
      response.status(409).json({
        code: 'WORKSPACE_WRITE_CONFLICT',
        error: '다른 탭에서 로컬 DB가 먼저 변경됐습니다. 현재 데이터는 덮어쓰지 않았습니다.',
        savedAt: current?.savedAt ?? null,
      })
      return
    }
    const nextSavedAt = Math.max(Date.now(), (current?.savedAt ?? 0) + 1)
    const snapshot = workspaceDatabase.write(workspace, nextSavedAt)
    response.setHeader('Cache-Control', 'no-store')
    response.json({ savedAt: snapshot.savedAt })
  } catch (error) {
    console.error(`[AIYK] Local database write failed: ${error instanceof Error ? error.message : 'unknown error'}`)
    response.status(500).json({ error: '로컬 데이터베이스에 저장하지 못했습니다.' })
  }
})

app.post('/api/translate', requireAllowedOrigin, async (request, response, next) => {
  const text = typeof request.body?.text === 'string' ? request.body.text.trim() : ''
  if (!text || text.length > 8_000) {
    response.status(400).json({ error: '번역할 영어 문장이 필요합니다.' })
    return
  }

  try {
    const controller = new AbortController()
    request.once('aborted', () => controller.abort())
    response.once('close', () => {
      if (!response.writableEnded) controller.abort()
    })
    const result = await translateTextDetailed({
      text,
      context:
        typeof request.body?.context === 'string'
          ? request.body.context.slice(-8_000)
          : undefined,
      signal: controller.signal,
    })
    response.json(result)
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      response.status(503).json({
        code: 'TRANSLATION_NOT_CONFIGURED',
        error: '번역 API 연결을 기다리고 있습니다.',
      })
      return
    }
    if (error instanceof TranslationProvidersFailedError) {
      response.status(502).json({
        code: 'TRANSLATION_PROVIDERS_FAILED',
        error: '연결된 번역 서비스에서 번역을 가져오지 못했습니다.',
        providers: error.providers,
      })
      return
    }
    next(error)
  }
})

function parseTranscriptBlocks(value: unknown): TranscriptRefineBlock[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > 240) return undefined
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 52_000) return undefined
  const seenIds = new Set<string>()
  const blocks: TranscriptRefineBlock[] = []
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined
    const record = candidate as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const english = typeof record.english === 'string' ? record.english.trim() : ''
    const korean = typeof record.korean === 'string' ? record.korean.trim() : ''
    const speaker = typeof record.speaker === 'string' ? record.speaker.trim() : ''
    if (
      !id || id.length > 200 || seenIds.has(id)
      || !english || english.length > 6_000 || korean.length > 6_000
      || speaker.length > 100
    ) {
      return undefined
    }
    seenIds.add(id)
    blocks.push({ id, english, korean, ...(speaker ? { speaker } : {}) })
  }
  return blocks
}

app.post('/api/refine-context', requireAllowedOrigin, async (request, response, next) => {
  const blocks = parseTranscriptBlocks(request.body?.blocks)
  if (!blocks) {
    response.status(400).json({
      code: 'TRANSCRIPT_PAYLOAD_INVALID',
      error: '정리할 대화 블록이 없거나 안전한 요청 크기를 초과했습니다.',
    })
    return
  }

  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  try {
    const groups = await refineTranscriptContext({ blocks, signal: controller.signal })
    response.setHeader('Cache-Control', 'no-store')
    response.json({ groups })
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      response.status(503).json({
        code: 'REFINEMENT_NOT_CONFIGURED',
        error: '대화 정리 API 연결을 기다리고 있습니다.',
      })
      return
    }
    next(error)
  }
})

app.post('/api/export-text', requireAllowedOrigin, async (request, response, next) => {
  const blocks = parseTranscriptBlocks(request.body?.blocks)
  if (!blocks) {
    response.status(400).json({
      code: 'TRANSCRIPT_PAYLOAD_INVALID',
      error: '내보낼 대화 블록이 없거나 안전한 요청 크기를 초과했습니다.',
    })
    return
  }

  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  try {
    const text = await exportTranscriptText({ blocks, signal: controller.signal })
    response.setHeader('Cache-Control', 'no-store')
    response.type('text/plain').send(text)
  } catch (error) {
    if (error instanceof ProviderNotConfiguredError) {
      response.status(503).json({
        code: 'EXPORT_REFINEMENT_NOT_CONFIGURED',
        error: 'Text 정리 API 연결을 기다리고 있습니다.',
      })
      return
    }
    next(error)
  }
})

app.post('/api/polish-question', requireAllowedOrigin, async (request, response, next) => {
  const korean = typeof request.body?.korean === 'string' ? request.body.korean.trim() : ''
  if (!korean || korean.length > 2_000) {
    response.status(400).json({ error: '영어로 다듬을 한국어 질문이 필요합니다.' })
    return
  }

  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  try {
    const result = await polishQuestionDetailed({ korean, signal: controller.signal })
    response.json(result)
  } catch (error) {
    next(error)
  }
})

app.post('/api/english-pronunciation', requireAllowedOrigin, async (request, response, next) => {
  const english = typeof request.body?.english === 'string' ? request.body.english.trim() : ''
  if (!english || english.length > 4_000) {
    response.status(400).json({ error: '발음으로 바꿀 영어 문장이 필요합니다.' })
    return
  }

  const controller = new AbortController()
  request.once('aborted', () => controller.abort())
  response.once('close', () => {
    if (!response.writableEnded) controller.abort()
  })

  try {
    const pronunciation = await generateEnglishPronunciation({ english, signal: controller.signal })
    response.json({ pronunciation })
  } catch (error) {
    next(error)
  }
})

const staticDir = path.resolve(currentDir, '../dist')
app.use(express.static(staticDir))
app.use((request, response, next) => {
  if (request.method !== 'GET' || request.path.startsWith('/api/')) {
    next()
    return
  }
  response.sendFile(path.join(staticDir, 'index.html'))
})

app.use(
  (error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if ((error as { status?: number })?.status === 413) {
      response.status(413).json({ error: '요청 내용이 너무 큽니다. 컨텍스트를 나누어 다시 시도해 주세요.' })
      return
    }
    const message = error instanceof Error ? error.message : 'Unknown server error'
    console.error(`[AIYK] ${message}`)
    response.status(502).json({ error: '외부 서비스 연결 중 오류가 발생했습니다.' })
  },
)

const deepgramParams = new URLSearchParams({
  model: 'nova-3',
  language: 'en-US',
  interim_results: 'true',
  // Interview answers contain deliberate thinking pauses. 800 ms preserves a
  // longer turn without making the first stable result feel unresponsive.
  endpointing: '800',
  // This independent gap detector remains above Deepgram's interim-result cadence
  // and closes a truly abandoned turn after two seconds.
  utterance_end_ms: '2000',
  vad_events: 'true',
  punctuate: 'true',
  smart_format: 'true',
  // Word-level diarization is carried through to each persisted transcript
  // block, giving later compaction evidence instead of asking an LLM to guess.
  diarize_model: 'latest',
})

const aiInterviewKeyterms = [
  'OpenAI', 'Anthropic', 'NVIDIA', 'Gemini', 'Google DeepMind', 'DeepMind',
  'ChatGPT', 'Groq', 'Deepgram', 'large language model', 'LLM',
  'retrieval-augmented generation', 'RAG', 'embedding', 'embeddings',
  'inference', 'transformer', 'RLHF', 'fine-tuning', 'multimodal',
  'agentic AI', 'agentic', 'Model Context Protocol', 'MCP', 'CUDA', 'PyTorch',
  'TensorFlow', 'JAX', 'Hugging Face', 'LangChain', 'vector database',
  'tokenization', 'diffusion model', 'reinforcement learning',
  'supervised fine-tuning', 'SFT', 'LoRA', 'quantization', 'hallucination',
  'foundation model',
]
const customKeyterms = (process.env.DEEPGRAM_KEYTERMS || '')
  .split(',')
  .map((term) => term.trim())
  .filter(Boolean)
for (const keyterm of [...aiInterviewKeyterms, ...customKeyterms].slice(0, 100)) {
  // Nova-3 keyterm prompting requires one repeated query parameter per term.
  deepgramParams.append('keyterm', keyterm)
}

const liveServer = new WebSocketServer({ noServer: true })

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, part) => total + part.byteLength, 0)
  }
  return data.byteLength
}

server.on('upgrade', (request, socket, head) => {
  const requestUrl = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  if (requestUrl.pathname !== '/api/deepgram/live') {
    socket.destroy()
    return
  }

  const origin = request.headers.origin
  const remoteAddress = request.socket.remoteAddress || 'unknown'
  if ((origin && !allowedOrigins.has(origin)) || !allowLiveConnection(remoteAddress)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
    socket.destroy()
    return
  }

  liveServer.handleUpgrade(request, socket, head, (client) => {
    liveServer.emit('connection', client, request)
  })
})

liveServer.on('connection', (client) => {
  const apiKey = process.env.DEEPGRAM_API_KEY
  if (!apiKey) {
    client.send(JSON.stringify({
      type: 'ProxyError',
      error: '서버에 Deepgram 키가 설정되지 않았습니다.',
    }))
    client.close(1011, 'Deepgram is not configured')
    return
  }

  const upstream = new WebSocket(
    `wss://api.deepgram.com/v1/listen?${deepgramParams.toString()}`,
    { headers: { Authorization: `Token ${apiKey}` } },
  )
  const pending: Array<{ data: RawData; isBinary: boolean }> = []
  let pendingBytes = 0
  let lastClientDataAt = Date.now()
  const keepAliveTimer = setInterval(() => {
    if (upstream.readyState === WebSocket.OPEN && Date.now() - lastClientDataAt >= 4_000) {
      upstream.send(JSON.stringify({ type: 'KeepAlive' }))
    }
  }, 4_000)
  const clearKeepAlive = () => clearInterval(keepAliveTimer)

  upstream.on('open', () => {
    if (client.readyState !== WebSocket.OPEN) {
      upstream.close()
      return
    }
    client.send(JSON.stringify({ type: 'ProxyReady' }))
    for (const message of pending) {
      upstream.send(message.data, { binary: message.isBinary })
    }
    pending.length = 0
    pendingBytes = 0
  })

  client.on('message', (data, isBinary) => {
    lastClientDataAt = Date.now()
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary })
      return
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return
    pendingBytes += rawDataByteLength(data)
    if (pendingBytes > 2_000_000) {
      client.close(1009, 'Audio buffer limit exceeded')
      upstream.close()
      return
    }
    pending.push({ data, isBinary })
  })

  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data, { binary: isBinary })
    }
  })

  upstream.on('error', (error) => {
    console.error(`[AIYK] Deepgram live connection failed: ${error.message}`)
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'ProxyError',
        error: 'Deepgram 실시간 채널을 열지 못했습니다.',
      }))
    }
  })

  upstream.on('close', (code) => {
    clearKeepAlive()
    if (client.readyState === WebSocket.OPEN) {
      client.close(code === 1000 ? 1000 : 1011, 'Deepgram connection closed')
    }
  })

  client.on('close', () => {
    clearKeepAlive()
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: 'CloseStream' }))
      upstream.close()
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.close()
    }
  })
})

server.on('close', () => {
  workspaceDatabase.close()
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[AIYK] API server listening on http://127.0.0.1:${port}`)
})
