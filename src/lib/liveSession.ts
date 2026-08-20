export type LiveSessionOwner = {
  session: number
  stream: object
  connection?: number
  socket?: object
}

export type LiveSessionSnapshot = {
  session: number
  stream: object | null
  connection?: number
  socket?: object | null
}

/**
 * Rejects callbacks that belong to an earlier microphone session, reconnect,
 * stream, or socket. Optional fields let the same guard cover startup and the
 * fully connected path without weakening identity checks.
 */
export function ownsLiveSession(
  owner: LiveSessionOwner,
  current: LiveSessionSnapshot,
): boolean {
  return owner.session === current.session
    && owner.stream === current.stream
    && (owner.connection === undefined || owner.connection === current.connection)
    && (owner.socket === undefined || owner.socket === current.socket)
}

export function liveActivityLength(text: string): number | null {
  return text ? Math.min(100, Math.max(18, text.length)) : null
}

/**
 * Deepgram speaker numbers are local to one WebSocket. After reconnecting we
 * can still split text at speaker changes, but persisting the reused number
 * would risk assigning a new real person to an earlier speaker.
 */
export function safeDiarizationSpeaker(
  speaker: number | undefined,
  speakerAttributionTrusted: boolean,
): number | undefined {
  return speakerAttributionTrusted ? speaker : undefined
}
