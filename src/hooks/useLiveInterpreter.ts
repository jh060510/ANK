import { useCallback, useEffect, useRef, useState } from 'react'

import {
  getAppConfig,
  refineContext,
  retryFailedTranslation,
  translate,
} from '../lib/api'
import { applyRefinedGroups, selectRefinementCandidates } from '../lib/contextRefinement'
import {
  liveActivityLength,
  ownsLiveSession,
  safeDiarizationSpeaker,
} from '../lib/liveSession'
import {
  closeFinalizedTranscriptBuffer,
  closeTranscriptBuffer,
  consumeDeepgramResult,
  emptyTranscriptBuffer,
  type TranscriptBuffer,
} from '../lib/transcript'
import type {
  AppConfig,
  ConnectionState,
  DeepgramResult,
  FollowupQuestion,
  LiveTranscript,
  TranscriptItem,
} from '../types'

const MAX_RECONNECT_ATTEMPTS = 4
const FINALIZE_FALLBACK_MS = 3_000
const TRANSLATION_TIMEOUT_MS = 12_000
const RETRY_TRANSLATION_TIMEOUT_MS = 20_000
const PROXY_READY_TIMEOUT_MS = 8_000
const AUDIO_RESUME_TIMEOUT_MS = 1_500
const QUIET_SPEECH_GAIN = 2.8
const SPEECH_PRESENCE_FREQUENCY_HZ = 2_600
const LOW_RUMBLE_CUTOFF_HZ = 65
const PREFERRED_CAPTURE_SAMPLE_RATE_HZ = 48_000
const MICROPHONE_MUTED_MESSAGE = '마이크 입력이 일시 중단됐습니다. Windows 마이크 음소거를 확인해 주세요.'

const initialConfig: AppConfig = {
  deepgramConfigured: false,
  translationConfigured: false,
}

type SessionSeed = {
  segments?: TranscriptItem[]
  questions?: FollowupQuestion[]
  lastQuestionGeneratedAt?: number
}

type InterpreterOptions = {
  initialSession?: SessionSeed
  onRecordingStarted?: () => void
}

function chooseMimeType(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm']
  return candidates.find((type) => MediaRecorder.isTypeSupported(type))
}

function preferredAudioConstraints(): MediaTrackConstraints {
  const supported = navigator.mediaDevices.getSupportedConstraints()
  return {
    ...(supported.channelCount ? { channelCount: { ideal: 1 } } : {}),
    ...(supported.echoCancellation ? { echoCancellation: { ideal: true } } : {}),
    ...(supported.noiseSuppression ? { noiseSuppression: { ideal: true } } : {}),
    ...(supported.autoGainControl ? { autoGainControl: { ideal: true } } : {}),
    ...(supported.sampleRate
      ? { sampleRate: { ideal: PREFERRED_CAPTURE_SAMPLE_RATE_HZ } }
      : {}),
    ...(supported.sampleSize ? { sampleSize: { ideal: 16 } } : {}),
  }
}

function preferContentHint(track: MediaStreamTrack, hints: readonly string[]): void {
  if (!('contentHint' in track)) return
  for (const hint of hints) {
    try {
      track.contentHint = hint
      if (track.contentHint === hint) return
    } catch {
      // Try the next conservative hint before leaving the browser default in place.
    }
  }
}

function mediaErrorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'NotAllowedError') {
    return '마이크 권한이 필요합니다. 브라우저 주소창에서 마이크를 허용해 주세요.'
  }
  if (error instanceof DOMException && error.name === 'NotFoundError') {
    return '사용할 수 있는 마이크를 찾지 못했습니다.'
  }
  return error instanceof Error ? error.message : '마이크 연결 중 오류가 발생했습니다.'
}

function closeAudioContext(audioContext: AudioContext | null): void {
  if (audioContext && audioContext.state !== 'closed') {
    try {
      void audioContext.close().catch(() => undefined)
    } catch {
      // Some engines throw synchronously when the context is already closing.
    }
  }
}

function resumeAudioContext(audioContext: AudioContext): Promise<void> {
  if (audioContext.state !== 'suspended') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(
      () => reject(new Error('AudioContext resume timed out')),
      AUDIO_RESUME_TIMEOUT_MS,
    )
    void audioContext.resume().then(
      () => {
        window.clearTimeout(timer)
        resolve()
      },
      (error: unknown) => {
        window.clearTimeout(timer)
        reject(error)
      },
    )
  })
}

export function useLiveInterpreter(options: InterpreterOptions = {}) {
  const initialSegments = options.initialSession?.segments ?? []
  const initialQuestions = options.initialSession?.questions ?? []
  const [status, setStatus] = useState<ConnectionState>('idle')
  const [segments, setSegments] = useState<TranscriptItem[]>(initialSegments)
  const [live, setLive] = useState<LiveTranscript | null>(null)
  const [questions, setQuestions] = useState<FollowupQuestion[]>(initialQuestions)
  const [contextRefining, setContextRefining] = useState(false)
  const [lastQuestionGeneratedAt, setLastQuestionGeneratedAt] = useState<number | undefined>(
    options.initialSession?.lastQuestionGeneratedAt,
  )
  const [error, setError] = useState('')
  const [isSpeaking, setIsSpeaking] = useState(false)
  const [config, setConfig] = useState<AppConfig>(initialConfig)

  const activeRef = useRef(false)
  const startingRef = useRef(false)
  const stoppingRef = useRef(false)
  const mountedRef = useRef(true)
  const stopCompletedRef = useRef(false)
  const streamRef = useRef<MediaStream | null>(null)
  const inputStreamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const reconnectTimerRef = useRef<number | null>(null)
  const finalizeTimerRef = useRef<number | null>(null)
  const bufferRef = useRef<TranscriptBuffer>(emptyTranscriptBuffer())
  const configRef = useRef<AppConfig>(initialConfig)
  const segmentsRef = useRef<TranscriptItem[]>(initialSegments)
  const segmentControllersRef = useRef(new Map<string, AbortController>())
  const sessionEpochRef = useRef(0)
  const refinementAbortRef = useRef<AbortController | null>(null)
  const refinementRevisionRef = useRef(0)
  const seenFinalKeysRef = useRef(new Set<string>())
  const connectionSerialRef = useRef(0)
  const speakerAttributionTrustedRef = useRef(true)
  const idRef = useRef(0)
  const completeStopRef = useRef<() => void>(() => undefined)
  const stopRef = useRef<() => void>(() => undefined)
  const startAttemptRef = useRef(0)
  const sessionSerialRef = useRef(0)
  const stopGenerationRef = useRef(0)
  const onRecordingStartedRef = useRef(options.onRecordingStarted)
  onRecordingStartedRef.current = options.onRecordingStarted

  const updateSegments = useCallback(
    (updater: (current: TranscriptItem[]) => TranscriptItem[]) => {
      const next = updater(segmentsRef.current)
      segmentsRef.current = next
      setSegments(next)
    },
    [],
  )

  const updateSegment = useCallback((
    id: string,
    updater: (segment: TranscriptItem) => TranscriptItem,
  ) => {
    updateSegments((current) => {
      const index = current.findIndex((segment) => segment.id === id)
      if (index < 0) return current
      const nextSegment = updater(current[index])
      if (nextSegment === current[index]) return current
      const next = current.slice()
      next[index] = nextSegment
      return next
    })
  }, [updateSegments])

  const showLiveActivity = useCallback((text: string) => {
    const activityLength = liveActivityLength(text)
    if (activityLength === null) {
      setLive(null)
      return
    }
    setLive((current) => current?.activityLength === activityLength
      ? current
      : { activityLength })
  }, [])

  const releaseAudioResources = useCallback(() => {
    const processedStream = streamRef.current
    const inputStream = inputStreamRef.current
    streamRef.current = null
    inputStreamRef.current = null
    processedStream?.getTracks().forEach((track) => track.stop())
    if (inputStream !== processedStream) {
      inputStream?.getTracks().forEach((track) => track.stop())
    }
    const audioContext = audioContextRef.current
    audioContextRef.current = null
    closeAudioContext(audioContext)
  }, [])

  useEffect(() => {
    let cancelled = false
    getAppConfig()
      .then((nextConfig) => {
        if (cancelled) return
        configRef.current = nextConfig
        setConfig(nextConfig)
      })
      .catch(() => {
        if (!cancelled) setError('앱 서버에 연결하지 못했습니다.')
      })
    return () => {
      cancelled = true
    }
  }, [])

  const requestSegmentTranslation = useCallback(async (input: {
    id: string
    english: string
    context: string
    epoch: number
    timeoutMs: number
    retry?: boolean
  }): Promise<boolean> => {
    segmentControllersRef.current.get(input.id)?.abort()
    const controller = new AbortController()
    segmentControllersRef.current.set(input.id, controller)
    const timeout = window.setTimeout(() => {
      controller.abort()
      if (
        input.epoch === sessionEpochRef.current
        && segmentControllersRef.current.get(input.id) === controller
      ) {
        updateSegment(input.id, (segment) => ({ ...segment, translationState: 'error' }))
      }
    }, input.timeoutMs)
    try {
      const korean = await (input.retry ? retryFailedTranslation : translate)(
        input.english,
        input.context,
        controller.signal,
      )
      if (
        controller.signal.aborted
        || input.epoch !== sessionEpochRef.current
        || segmentControllersRef.current.get(input.id) !== controller
      ) return false
      updateSegment(input.id, (segment) => ({ ...segment, korean, translationState: 'ready' }))
      return true
    } catch {
      if (
        !controller.signal.aborted
        && input.epoch === sessionEpochRef.current
        && segmentControllersRef.current.get(input.id) === controller
      ) {
        updateSegment(input.id, (segment) => ({ ...segment, translationState: 'error' }))
      }
      return false
    } finally {
      window.clearTimeout(timeout)
      if (segmentControllersRef.current.get(input.id) === controller) {
        segmentControllersRef.current.delete(input.id)
      }
    }
  }, [updateSegment])

  const commitStableBlock = useCallback((
    english: string,
    stableKey?: string,
    ownerConnection = connectionSerialRef.current,
    speakerNumber?: number,
  ) => {
    if (!mountedRef.current) return
    const clean = english.replace(/\s+/g, ' ').trim()
    if (!clean || !/[\p{L}\p{N}]/u.test(clean)) return

    const connectionKey = stableKey
      ? `${ownerConnection}:${stableKey}`
      : undefined
    if (connectionKey && seenFinalKeysRef.current.has(connectionKey)) return
    if (connectionKey) seenFinalKeysRef.current.add(connectionKey)

    setLive(null)
    const epoch = sessionEpochRef.current
    const id = `utterance-${Date.now()}-${++idRef.current}`
    const previousContext = segmentsRef.current
      .filter((segment) => segment.kind === 'transcript')
      .map((segment) => segment.english.trim())
      .filter(Boolean)
      .join('\n')
      .slice(-600)
    const item: TranscriptItem = {
      id,
      kind: 'transcript',
      english: clean,
      korean: '',
      translationState: configRef.current.translationConfigured ? 'pending' : 'waiting',
      createdAt: Date.now(),
      ...(speakerNumber !== undefined ? { speaker: `Speaker ${speakerNumber + 1}` } : {}),
    }
    updateSegments((current) => [...current, item])

    if (!configRef.current.translationConfigured) return
    void requestSegmentTranslation({
      id,
      english: clean,
      // No live provider consumes more than the final 600 characters. Keeping
      // the client payload at the effective limit reduces request work without
      // changing the translation context seen by any configured provider.
      context: previousContext.slice(-600),
      epoch,
      timeoutMs: TRANSLATION_TIMEOUT_MS,
    })
  }, [requestSegmentTranslation, updateSegments])

  const completeStop = useCallback(() => {
    if (stopCompletedRef.current) return
    stopCompletedRef.current = true
    startingRef.current = false
    if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current)
    finalizeTimerRef.current = null

    const pending = closeTranscriptBuffer(bufferRef.current)
    bufferRef.current = pending.buffer
    if (pending.commitBlocks?.length) {
      pending.commitBlocks.forEach((block) => commitStableBlock(
        block.text,
        undefined,
        connectionSerialRef.current,
        safeDiarizationSpeaker(block.speaker, speakerAttributionTrustedRef.current),
      ))
    } else if (pending.commitText) {
      commitStableBlock(pending.commitText, undefined, connectionSerialRef.current)
    }

    setLive(null)
    setIsSpeaking(false)

    const socket = socketRef.current
    socketRef.current = null
    try {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'CloseStream' }))
      }
      socket?.close()
    } catch {
      // Resource release below must still complete if the socket races closed.
    }
    recorderRef.current = null
    releaseAudioResources()
    stoppingRef.current = false
    setStatus('stopped')
  }, [commitStableBlock, releaseAudioResources])
  completeStopRef.current = completeStop

  const handleDeepgramMessage = useCallback((
    raw: string,
    ownerConnection: number,
    speakerAttributionTrusted: boolean,
  ) => {
    let payload: Record<string, unknown>
    try {
      payload = JSON.parse(raw) as Record<string, unknown>
    } catch {
      return
    }

    if (payload.type === 'SpeechStarted') {
      if (!stoppingRef.current) setIsSpeaking(true)
      return
    }
    if (payload.type === 'UtteranceEnd') {
      setIsSpeaking(false)
      setLive(null)
      // UtteranceEnd is a gap notification, not proof that the current interim
      // hypothesis is correct. Commit only model-finalized words here.
      const pending = closeFinalizedTranscriptBuffer(bufferRef.current)
      bufferRef.current = pending.buffer
      if (pending.commitBlocks?.length) {
        pending.commitBlocks.forEach((block) => commitStableBlock(
          block.text,
          undefined,
          ownerConnection,
          safeDiarizationSpeaker(block.speaker, speakerAttributionTrusted),
        ))
      } else if (pending.commitText) {
        commitStableBlock(pending.commitText, undefined, ownerConnection)
      }
      return
    }
    if (payload.type !== 'Results') return

    const result = payload as unknown as DeepgramResult
    const update = consumeDeepgramResult(bufferRef.current, result)
    bufferRef.current = update.buffer
    if (update.stableBlocks?.length) {
      update.stableBlocks.forEach((block) => commitStableBlock(
        block.text,
        block.stableKey,
        ownerConnection,
        safeDiarizationSpeaker(block.speaker, speakerAttributionTrusted),
      ))
    } else if (update.stableText) {
      commitStableBlock(update.stableText, update.stableKey, ownerConnection)
    } else if (!stoppingRef.current && !result.speech_final) {
      showLiveActivity(update.liveText)
    }
    if (result.speech_final) {
      setIsSpeaking(false)
      setLive(null)
    }
    if (result.from_finalize && stoppingRef.current) completeStopRef.current()
  }, [commitStableBlock, showLiveActivity])

  const connect = useCallback(async (
    stream: MediaStream,
    attempt = 0,
    ownerSession = sessionSerialRef.current,
    hasReconnected = false,
  ) => {
    const ownsSession = () => ownsLiveSession(
      { session: ownerSession, stream },
      { session: sessionSerialRef.current, stream: streamRef.current },
    )
    if (!activeRef.current || !ownsSession()) return
    setStatus(attempt ? 'reconnecting' : 'connecting')
    const connectionSerial = ++connectionSerialRef.current
    // Deepgram diarization numbers are scoped to one WebSocket. A replacement
    // connection can call a different real person Speaker 0, so after any
    // reconnect we keep word-run boundaries but intentionally omit labels.
    speakerAttributionTrustedRef.current = !hasReconnected
    seenFinalKeysRef.current.clear()
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/deepgram/live`)
      let readyAt = 0
      let connectionRecorder: MediaRecorder | null = null
      socketRef.current = socket

      const ownsConnection = () => ownsLiveSession(
        { session: ownerSession, connection: connectionSerial, stream, socket },
        {
          session: sessionSerialRef.current,
          connection: connectionSerialRef.current,
          stream: streamRef.current,
          socket: socketRef.current,
        },
      )
      let proxyReadyTimer: number | null = window.setTimeout(() => {
        proxyReadyTimer = null
        if (!activeRef.current || stoppingRef.current || !ownsConnection()) return
        setError('Deepgram 연결 준비가 지연되어 다시 연결하고 있습니다…')
        socket.close(4000, 'Proxy ready timeout')
      }, PROXY_READY_TIMEOUT_MS)
      const clearProxyReadyTimer = () => {
        if (proxyReadyTimer !== null) window.clearTimeout(proxyReadyTimer)
        proxyReadyTimer = null
      }

      const failRecorder = (recorderError: unknown) => {
        if (!ownsConnection()) return
        clearProxyReadyTimer()
        activeRef.current = false
        if (recorderRef.current === connectionRecorder) recorderRef.current = null
        connectionRecorder = null
        if (socketRef.current === socket) socketRef.current = null
        try {
          socket.close(4001, 'MediaRecorder failed')
        } catch {
          // The socket may already be closing.
        }
        releaseAudioResources()
        setIsSpeaking(false)
        setLive(null)
        setStatus('error')
        setError(mediaErrorMessage(recorderError))
      }

      const startRecorder = () => {
        if (!activeRef.current || recorderRef.current || !ownsConnection()) return
        clearProxyReadyTimer()
        try {
          const mimeType = chooseMimeType()
            const recorder = new MediaRecorder(stream, {
              ...(mimeType ? { mimeType } : {}),
              audioBitsPerSecond: 96_000,
            })
          connectionRecorder = recorder
          recorderRef.current = recorder
          recorder.addEventListener('dataavailable', (event) => {
            if (event.data.size && ownsConnection() && socket.readyState === WebSocket.OPEN) {
              socket.send(event.data)
            }
          })
          recorder.addEventListener('error', (event) => failRecorder(event), { once: true })
          recorder.start(80)
          readyAt = Date.now()
          onRecordingStartedRef.current?.()
          setError('')
          setStatus('listening')
        } catch (recorderError) {
          failRecorder(recorderError)
        }
      }

      socket.addEventListener('message', (event) => {
        if (!ownsConnection()) return
        if (typeof event.data !== 'string') return
        try {
          const message = JSON.parse(event.data) as { type?: string; error?: string }
          if (message.type === 'ProxyReady') {
            clearProxyReadyTimer()
            startRecorder()
            return
          }
          if (message.type === 'ProxyError') {
            clearProxyReadyTimer()
            setError(message.error || 'Deepgram 연결에 실패했습니다.')
            socket.close(4002, 'Deepgram proxy error')
            return
          }
        } catch {
          // Deepgram events continue to the transcript handler.
        }
        handleDeepgramMessage(event.data, connectionSerial, !hasReconnected)
      })

      socket.addEventListener('close', () => {
        clearProxyReadyTimer()
        if (!ownsSession() || connectionSerial !== connectionSerialRef.current) return
        if (socketRef.current === socket) socketRef.current = null
        if (connectionRecorder && connectionRecorder.state !== 'inactive') {
          try {
            connectionRecorder.stop()
          } catch {
            // Stopping a recorder whose track ended can throw in some browsers.
          }
        }
        if (recorderRef.current === connectionRecorder) recorderRef.current = null
        connectionRecorder = null

        if (stoppingRef.current) {
          completeStopRef.current()
          return
        }
        if (!activeRef.current || connectionSerial !== connectionSerialRef.current) return

        // A transient network failure must not silently discard speech Deepgram
        // had already finalized. Commit the accumulated phrase before reconnecting.
        const interrupted = closeFinalizedTranscriptBuffer(bufferRef.current)
        bufferRef.current = interrupted.buffer
        if (interrupted.commitBlocks?.length) {
          interrupted.commitBlocks.forEach((block) => commitStableBlock(
            block.text,
            undefined,
            connectionSerial,
            safeDiarizationSpeaker(block.speaker, !hasReconnected),
          ))
        } else if (interrupted.commitText) {
          commitStableBlock(interrupted.commitText, undefined, connectionSerial)
        }
        setLive(null)
        setIsSpeaking(false)

        const nextAttempt = readyAt && Date.now() - readyAt > 5_000 ? 0 : attempt + 1
        if (nextAttempt > MAX_RECONNECT_ATTEMPTS) {
          activeRef.current = false
          releaseAudioResources()
          setLive(null)
          setIsSpeaking(false)
          setStatus('error')
          setError('실시간 연결이 반복해서 끊겼습니다. 마이크를 다시 눌러 주세요.')
          return
        }

        setStatus('reconnecting')
        const delay = Math.min(600 * 2 ** Math.max(0, nextAttempt - 1), 4_000)
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          if (!activeRef.current || !ownsSession()) return
          void connect(stream, nextAttempt, ownerSession, true)
        }, delay)
      })

      socket.addEventListener('error', () => {
        if (!ownsConnection()) return
        if (activeRef.current) setError('Deepgram 연결을 복구하고 있습니다…')
      })
    } catch (connectionError) {
      if (!activeRef.current || !ownsSession()) return
      activeRef.current = false
      releaseAudioResources()
      setLive(null)
      setStatus('error')
      setError(mediaErrorMessage(connectionError))
    }
  }, [commitStableBlock, handleDeepgramMessage, releaseAudioResources])

  const start = useCallback(async () => {
    if (!mountedRef.current || activeRef.current || startingRef.current || stoppingRef.current) return
    startingRef.current = true
    setError('')
    stopGenerationRef.current += 1
    stopCompletedRef.current = false
    stoppingRef.current = false
    bufferRef.current = emptyTranscriptBuffer()
    speakerAttributionTrustedRef.current = true
    setLive(null)
    setStatus('requesting-permission')
    const startAttempt = ++startAttemptRef.current
    const sessionSerial = ++sessionSerialRef.current
    try {
      const inputStream = await navigator.mediaDevices.getUserMedia({
        audio: preferredAudioConstraints(),
      })
      if (
        !mountedRef.current
        || startAttempt !== startAttemptRef.current
        || stoppingRef.current
      ) {
        inputStream.getTracks().forEach((track) => track.stop())
        return
      }

      // `speech` keeps the capture-side WebRTC AEC/NS/AGC intent intact.
      inputStream.getAudioTracks().forEach((track) => preferContentHint(track, ['speech']))

      let stream = inputStream
      let audioContext: AudioContext | null = null
      let processedStream: MediaStream | null = null
      try {
        audioContext = new AudioContext({ latencyHint: 'interactive' })
        const source = audioContext.createMediaStreamSource(inputStream)
        const highPass = audioContext.createBiquadFilter()
        const presence = audioContext.createBiquadFilter()
        const gain = audioContext.createGain()
        const compressor = audioContext.createDynamicsCompressor()
        const destination = audioContext.createMediaStreamDestination()
        processedStream = destination.stream

        // Remove low room/desk rumble without a gate. A lower cutoff preserves the
        // fundamental of quiet, low-pitched far-field speakers.
        highPass.type = 'highpass'
        highPass.frequency.value = LOW_RUMBLE_CUTOFF_HZ
        highPass.Q.value = 0.7

        // A restrained presence lift improves consonant intelligibility for far-field voices.
        presence.type = 'peaking'
        presence.frequency.value = SPEECH_PRESENCE_FREQUENCY_HZ
        presence.Q.value = 0.85
        presence.gain.value = 2.5

        gain.gain.value = QUIET_SPEECH_GAIN
        // Gentle peak control keeps the extra quiet-speech gain from clipping.
        // The faster recovery and softer ratio avoid swallowing following syllables
        // in rapid speech, which sounded like words were being chopped apart.
        compressor.threshold.value = -18
        compressor.knee.value = 18
        compressor.ratio.value = 3.5
        compressor.attack.value = 0.006
        compressor.release.value = 0.09
        source.connect(highPass)
        highPass.connect(presence)
        presence.connect(gain)
        gain.connect(compressor)
        compressor.connect(destination)
        await resumeAudioContext(audioContext)
        // The processed destination has no microphone constraints to override, so
        // ask MediaRecorder for its machine-transcription optimization when available.
        processedStream.getAudioTracks().forEach((track) => (
          preferContentHint(track, ['speech-recognition', 'speech'])
        ))
        stream = processedStream
      } catch {
        processedStream?.getTracks().forEach((track) => track.stop())
        closeAudioContext(audioContext)
        audioContext = null
      }
      if (
        !mountedRef.current
        || startAttempt !== startAttemptRef.current
        || stoppingRef.current
      ) {
        stream.getTracks().forEach((track) => track.stop())
        if (stream !== inputStream) inputStream.getTracks().forEach((track) => track.stop())
        closeAudioContext(audioContext)
        return
      }
      inputStreamRef.current = inputStream
      audioContextRef.current = audioContext
      streamRef.current = stream
      startingRef.current = false
      activeRef.current = true
      inputStream.getAudioTracks().forEach((track) => {
        track.addEventListener('mute', () => {
          if (
            mountedRef.current
            && activeRef.current
            && sessionSerial === sessionSerialRef.current
            && inputStreamRef.current === inputStream
          ) {
            setIsSpeaking(false)
            setLive(null)
            setError(MICROPHONE_MUTED_MESSAGE)
          }
        })
        track.addEventListener('unmute', () => {
          if (sessionSerial === sessionSerialRef.current) {
            setError((current) => current === MICROPHONE_MUTED_MESSAGE ? '' : current)
          }
        })
        track.addEventListener('ended', () => {
          if (
            mountedRef.current
            && sessionSerial === sessionSerialRef.current
            && inputStreamRef.current === inputStream
          ) {
            setError('마이크 장치 연결이 끊겼습니다. 장치를 확인한 뒤 다시 시작해 주세요.')
            stopRef.current()
          }
        }, { once: true })
      })
      if (audioContext) {
        audioContext.addEventListener('statechange', () => {
          if (
            audioContext.state === 'suspended'
            && activeRef.current
            && sessionSerial === sessionSerialRef.current
            && audioContextRef.current === audioContext
          ) {
            void resumeAudioContext(audioContext).catch(() => {
              if (activeRef.current && sessionSerial === sessionSerialRef.current) {
                setError('브라우저가 마이크 처리를 중단했습니다. 화면을 활성화하거나 마이크를 다시 시작해 주세요.')
              }
            })
          }
        })
      }
      await connect(stream, 0, sessionSerial)
    } catch (mediaError) {
      if (startAttempt !== startAttemptRef.current) return
      startingRef.current = false
      setStatus('error')
      setError(mediaErrorMessage(mediaError))
    }
  }, [connect])

  const stop = useCallback(() => {
    if (
      !activeRef.current
      && !startingRef.current
      && !socketRef.current
      && !recorderRef.current
      && reconnectTimerRef.current === null
    ) return
    startAttemptRef.current += 1
    const stopGeneration = ++stopGenerationRef.current
    const ownerSession = sessionSerialRef.current
    const ownerConnection = connectionSerialRef.current
    const ownerStream = streamRef.current
    const ownerSocket = socketRef.current
    startingRef.current = false
    activeRef.current = false
    stoppingRef.current = true
    stopCompletedRef.current = false
    setIsSpeaking(false)
    setLive(null)
    setStatus('stopping')
    if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
    reconnectTimerRef.current = null

    finalizeTimerRef.current = window.setTimeout(() => {
      if (
        stoppingRef.current
        && stopGeneration === stopGenerationRef.current
        && ownerSession === sessionSerialRef.current
        && ownerConnection === connectionSerialRef.current
        && ownerStream === streamRef.current
        && ownerSocket === socketRef.current
      ) completeStopRef.current()
    }, FINALIZE_FALLBACK_MS)

    const recorder = recorderRef.current
    const finalize = () => {
      if (
        !stoppingRef.current
        || stopGeneration !== stopGenerationRef.current
        || ownerSession !== sessionSerialRef.current
        || ownerConnection !== connectionSerialRef.current
        || ownerStream !== streamRef.current
        || recorderRef.current !== recorder
        || socketRef.current !== ownerSocket
      ) return
      recorderRef.current = null
      const socket = ownerSocket
      if (socket?.readyState === WebSocket.OPEN) {
        try {
          socket.send(JSON.stringify({ type: 'Finalize' }))
        } catch {
          completeStopRef.current()
          return
        }
      } else {
        completeStopRef.current()
      }
    }

    if (recorder && recorder.state !== 'inactive') {
      recorder.addEventListener('stop', finalize, { once: true })
      try {
        recorder.requestData()
      } catch {
        // A track-ended event can make requestData race with recorder shutdown.
      }
      try {
        recorder.stop()
      } catch {
        finalize()
      }
    } else {
      finalize()
    }
  }, [])
  stopRef.current = stop

  const retryTranslation = useCallback(async (id: string): Promise<boolean> => {
    const index = segmentsRef.current.findIndex((segment) => segment.id === id)
    const segment = index >= 0 ? segmentsRef.current[index] : undefined
    if (
      !segment
      || segment.kind !== 'transcript'
      || (segment.translationState !== 'error' && segment.translationState !== 'waiting')
      || !segment.english.trim()
      || segmentControllersRef.current.has(id)
    ) return false

    const context = segmentsRef.current
      .slice(0, index)
      .filter((candidate) => candidate.kind === 'transcript')
      .map((candidate) => candidate.english.trim())
      .filter(Boolean)
      .join('\n')
      .slice(-600)
    const epoch = sessionEpochRef.current
    updateSegment(id, (current) => ({ ...current, translationState: 'pending' }))
    return requestSegmentTranslation({
      id,
      english: segment.english.trim(),
      context,
      epoch,
      timeoutMs: RETRY_TRANSLATION_TIMEOUT_MS,
      retry: true,
    })
  }, [requestSegmentTranslation, updateSegment])

  const deleteSegment = useCallback((id: string) => {
    segmentControllersRef.current.get(id)?.abort()
    segmentControllersRef.current.delete(id)
    refinementAbortRef.current?.abort()
    refinementAbortRef.current = null
    refinementRevisionRef.current += 1
    setContextRefining(false)
    updateSegments((current) => current.filter((segment) => segment.id !== id))
  }, [updateSegments])

  const loadSession = useCallback((seed: SessionSeed): boolean => {
    if (activeRef.current || startingRef.current || stoppingRef.current) return false
    sessionEpochRef.current += 1
    segmentControllersRef.current.forEach((controller) => controller.abort())
    segmentControllersRef.current.clear()
    refinementAbortRef.current?.abort()
    refinementAbortRef.current = null
    refinementRevisionRef.current += 1
    bufferRef.current = emptyTranscriptBuffer()
    seenFinalKeysRef.current.clear()
    updateSegments(() => seed.segments ?? [])
    setQuestions(seed.questions ?? [])
    setLastQuestionGeneratedAt(seed.lastQuestionGeneratedAt)
    setContextRefining(false)
    setLive(null)
    setError('')
    return true
  }, [updateSegments])

  const refineContextNow = useCallback(async (): Promise<boolean> => {
    if (refinementAbortRef.current) return false
    const source = selectRefinementCandidates(
      segmentsRef.current,
      Date.now() - 30_000,
    )
    const needsRecovery = source.some((segment) => (
      segment.translationState === 'error'
      || segment.translationState === 'waiting'
      || !segment.korean.trim()
    ))
    if (source.length < 2 && !needsRecovery) return false

    const controller = new AbortController()
    refinementAbortRef.current = controller
    const revision = ++refinementRevisionRef.current
    const epoch = sessionEpochRef.current
    setContextRefining(true)
    try {
      const groups = await refineContext(source.map((segment) => ({
        id: segment.id,
        english: segment.english,
        korean: segment.korean,
        ...(segment.speaker ? { speaker: segment.speaker } : {}),
      })), controller.signal)
      if (
        controller.signal.aborted
        || revision !== refinementRevisionRef.current
        || epoch !== sessionEpochRef.current
      ) return false
      let applied = false
      updateSegments((current) => {
        const result = applyRefinedGroups(current, source, groups)
        applied = result.applied
        if (applied) {
          source.forEach((segment) => {
            segmentControllersRef.current.get(segment.id)?.abort()
            segmentControllersRef.current.delete(segment.id)
          })
        }
        return result.segments
      })
      return applied
    } catch {
      return false
    } finally {
      if (refinementAbortRef.current === controller) refinementAbortRef.current = null
      if (revision === refinementRevisionRef.current) {
        setContextRefining(false)
      }
    }
  }, [updateSegments])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      activeRef.current = false
      startingRef.current = false
      stoppingRef.current = false
      stopCompletedRef.current = true
      startAttemptRef.current += 1
      sessionSerialRef.current += 1
      connectionSerialRef.current += 1
      stopGenerationRef.current += 1
      sessionEpochRef.current += 1
      if (reconnectTimerRef.current) window.clearTimeout(reconnectTimerRef.current)
      if (finalizeTimerRef.current) window.clearTimeout(finalizeTimerRef.current)
      reconnectTimerRef.current = null
      finalizeTimerRef.current = null
      segmentControllersRef.current.forEach((controller) => controller.abort())
      segmentControllersRef.current.clear()
      refinementAbortRef.current?.abort()
      const recorder = recorderRef.current
      const socket = socketRef.current
      recorderRef.current = null
      socketRef.current = null
      if (recorder?.state !== 'inactive') {
        try {
          recorder?.stop()
        } catch {
          // Its stream may already have ended.
        }
      }
      try {
        socket?.close()
      } catch {
        // Ignore teardown errors from an already-closed socket.
      }
      releaseAudioResources()
    }
  }, [releaseAudioResources])

  const isActive = ['requesting-permission', 'connecting', 'listening', 'reconnecting'].includes(status)
  return {
    status,
    segments,
    live,
    questions,
    contextRefining,
    lastQuestionGeneratedAt,
    error,
    isSpeaking,
    isActive,
    config,
    start,
    stop,
    loadSession,
    retryTranslation,
    deleteSegment,
    refineContextNow,
  }
}
