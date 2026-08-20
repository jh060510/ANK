# AIYK 아키텍처

이 문서는 구현의 현재 상태와 기능 불변 리팩터링 경계를 설명한다. 기준은 소스 코드이며, UI 문구나 과거 기획보다 이 문서와 테스트가 우선한다.

## 1. 설계 목표

1. 영어 원문은 가능한 빨리 표시한다.
2. 확정되지 않은 STT 가설을 번역 결과로 고정하지 않는다.
3. 번역 공급자 장애가 인터뷰 전체를 중단시키지 않게 한다.
4. 늦게 도착한 비동기 응답이 다른 컨텍스트나 삭제된 블록을 되살리지 못하게 한다.
5. 저장 충돌은 감지 없이 덮어쓰지 않는다.
6. API 키와 음성 원본을 브라우저 영속 데이터에 저장하지 않는다.

## 2. 런타임 구성

```text
React client :5173
  ├─ workspace/session UI
  ├─ MediaStream + Web Audio + MediaRecorder
  ├─ /api/* HTTP
  └─ /api/deepgram WebSocket
            │
Express server :8787
  ├─ origin and payload validation
  ├─ Deepgram WebSocket relay
  ├─ translation provider router
  ├─ Q Translate/refinement providers
  └─ SQLite workspace snapshot
```

개발 환경에서는 Vite가 `/api` HTTP와 WebSocket을 8787 포트로 프록시한다. 브라우저는 장기 공급자 키를 받지 않는다.

## 3. 실시간 음성·번역 흐름

### 3.1 캡처

- 브라우저 제약: mono, echo cancellation, noise suppression, auto gain control
- Web Audio: 저역 제거, presence 보정, preamp, 완만한 compressor
- 전송: WebM/Opus, 80ms 청크
- 서버: 4초 KeepAlive, Deepgram Nova-3 relay

80ms는 네트워크 전송 간격이며 발화 분할 간격이 아니다. 이 값을 늘리면 첫 전사 지연과 연결 복구 손실이 커진다.

### 3.2 STT 상태

`src/lib/transcript.ts`가 Deepgram 이벤트를 순수 상태 전이로 처리한다.

- interim: 교체 가능한 tail이며 텍스트로 고정하지 않는다.
- `is_final`: 발화 buffer에 누적한다.
- 문장 종결, 18단어, 5초: 안전한 phrase flush.
- `speech_final`: 누적된 확정 발화를 닫는다.
- `UtteranceEnd`: 확정된 부분만 닫고 interim 추측은 버린다.
- `from_finalize`: 일시 정지 직전 마지막 결과를 보존한다.

### 3.3 번역 요청

`useLiveInterpreter`가 확정 phrase마다 immutable `TranscriptItem`을 먼저 만들고 번역을 요청한다.

```text
pending
  ├─ success → ready
  ├─ timeout/provider failure → error
  ├─ provider not configured → waiting
  └─ block delete/session switch → aborted and discarded
```

모든 응답은 `segment id + controller identity + session epoch`가 일치할 때만 적용된다. 실시간 문맥은 실제 공급자가 소비하는 최대치인 마지막 600자로 제한된다.

## 4. 번역 라우팅과 지연 제어

라우팅 순서는 다음과 같다.

1. Groq: 지연 우선
2. Cerebras: 무료 티어 장애 전환
3. Apps Script: 단순 번역 장애 전환
4. Gemini: 최종 장애 전환

공급자별 timeout과 circuit 상태는 서버가 소유한다. 429 `Retry-After`, 인증 오류, 연속 실패에 따라 해당 공급자를 잠시 건너뛴다. 클라이언트에서 공급자별 재시도를 겹치지 않으므로 한 블록이 요청 폭주를 만들지 않는다.

캐시는 두 단계다.

- provider cache: 공급자·모델·유효 문맥·원문별 응답
- route cache: 최종 성공 공급자와 번역을 동일 유효 문맥·원문에 재사용

둘 다 프로세스 메모리 LRU 성격의 최대 250개 캐시다. 서버 재시작 시 비워진다. route cache는 명시적 재번역과 중복 final이 이미 검증된 같은 결과를 즉시 받도록 해 RPM과 지연을 줄인다.

## 5. 상태 소유권

| 상태 | 소유자 | 영속 여부 |
|---|---|---|
| mic/socket/interim/controller | `useLiveInterpreter` refs | 아니요 |
| 현재 loaded session의 segments와 legacy questions | `useLiveInterpreter` state + refs | App으로 병합 |
| contexts, titles, Q storage | `App` workspace state | 예 |
| export checkpoint/progress | `App` refs/state | 아니요 |
| provider circuit/cache | server process | 아니요 |
| workspace snapshot | localStorage + SQLite | 예 |

컨텍스트 전환 전에는 interpreter snapshot을 기존 소유 컨텍스트에 병합하고, `loadSession` 성공 뒤 활성 ID를 바꾼다. 이 순서를 바꾸면 이전 컨텍스트의 늦은 상태가 새 컨텍스트를 덮는다.

## 6. 자동 정리

녹음 시작 시각을 기준으로 10분마다 다음 대상만 정리한다.

자동 정리는 무료 티어 provider를 순서대로 전환한다. Text 내보내기는 전체 정리를 호출하지 않고 한국어가 비어 있는 블록에만 실시간 번역 라우터를 사용한다.

- 마지막 질문 이후의 transcript
- 30초 안전 cutoff보다 오래된 블록
- pending이 아닌 블록
- 아직 `refinedAt`이 없거나 번역 복구가 필요한 블록

요청은 source IDs를 포함한다. 응답은 ID를 한 번씩, 원래 순서대로 모두 반환해야 한다. 적용 직전 현재 블록의 ID, 영어, 한국어, 화자, 상태, revision을 다시 확인한다. 새 tail은 유지하고 정확히 일치하는 prefix만 원자적으로 교체한다. 원문은 `rawEnglish`, `rawKorean`, `sourceIds`에 보존한다.

## 7. Chat Text 내보내기

`src/lib/chatTextExport.ts`가 UI와 독립적으로 다음 불변식을 보장한다.

- `kind === transcript`만 전송
- 질문, 제목, 시간, Q storage, 사람 호환 데이터 제외
- 기존 영어와 한국어는 수정하지 않음
- 한국어가 비어 있는 블록만 Groq → Cerebras → Script → Gemini 번역 라우팅으로 복구
- 언어와 신뢰 가능한 화자 구분은 로컬 코드로 출력
- JSON UTF-8 payload 48KB 이하
- batch당 최대 60블록
- legacy oversized block도 field와 payload 한도 내 분할

내보내기는 batch checkpoint를 보유해 실패한 batch부터 재개한다. 누락 번역 복구가 실패해도 기존 영어와 한국어는 그대로 출력되며 workspace 원본은 변경하지 않는다. 이미 모든 한국어가 있으면 외부 AI 호출은 0회다.

## 8. 저장

workspace는 schema-normalized JSON snapshot이다.

- localStorage: 빠른 탭 복원
- SQLite WAL: 브라우저 저장소 손실 시 로컬 복구
- hydration: SQLite와 브라우저 snapshot을 context ID별로 병합해 한쪽에만 있는 context 보존
- history: 5분 주기 및 context/segment/Q Storage 축소 직전에 이전 SQLite snapshot 보관
- debounce: 입력 정지 후 약 220ms
- `pagehide`: 최신 interpreter snapshot을 병합해 flush
- DB CAS: `expectedSavedAt`이 현재 DB와 다르면 409

CAS는 무음 데이터 손실을 막지만 자동 merge는 아니다. 충돌한 탭은 최신 데이터를 다시 불러와야 한다.

## 9. 기능 불변 변경 규칙

다음은 반드시 테스트로 고정한다.

1. interim을 확정 Chat으로 저장하지 않는다.
2. 삭제·세션 전환 뒤 늦은 응답을 적용하지 않는다.
3. 번역 라우팅 순서와 API 응답 shape을 바꾸지 않는다.
4. Text에는 영어·한국어 Chat만 포함한다.
5. Q storage는 화면에 6개이며 질문을 Chat에 자동 추가하지 않는다.
6. 제목 수정, 컨텍스트 전환, 삭제의 저장 소유권을 유지한다.
7. UI 스타일 변경은 마이크·키보드·스크롤 hit target을 침범하지 않는다.

새 기능은 먼저 순수 selector/reducer/provider 계약에 추가한 뒤 App과 hook에 연결한다. 비동기 action은 항상 context/session/revision 소유권을 함께 전달한다.
