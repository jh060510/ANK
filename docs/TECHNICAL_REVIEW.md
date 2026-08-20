# AIYK 기술 검토

검토 기준은 기능 정확성, 인터뷰 중 장애 복구, 번역 지연, 데이터 보존, 유지보수성이다.

## 종합 평가

현재 구현은 로컬 인터뷰 도구로서 중요한 안전장치를 갖췄다. STT final 누적, stale 응답 차단, 번역 다중 공급자 장애 전환, 삭제 후 문맥 재계산, Text UTF-8 배칭, SQLite CAS가 핵심 강점이다. 반면 `App.tsx`와 `useLiveInterpreter.ts`에 책임이 집중되어 있어 기능 추가 비용과 UI 통합 회귀 위험이 높다. 외부 API와 물리 마이크 품질은 단위 테스트만으로 보장할 수 없다.

## 잘 된 점

### 실시간 번역

- 영어 final 블록을 번역보다 먼저 표시한다.
- 공급자 timeout을 짧게 두고 다음 공급자로 자동 전환한다.
- 429/인증/연속 실패를 circuit으로 격리한다.
- 동일 원문·동일 유효 문맥의 성공 결과를 route cache로 즉시 재사용한다.
- AI 고유명사와 숫자를 보존하도록 번역 prompt를 제한한다.
- 재번역은 동일 블록 ID에만 적용하고 삭제·전환 후 결과를 폐기한다.

### 데이터 안전

- async 결과에 epoch/revision/controller identity 검사가 있다.
- 자동 정리는 source ID 전부와 현재 snapshot 일치를 확인한 뒤 적용한다.
- raw English/Korean을 정리 결과에 보존한다.
- DB의 compare-and-swap이 다른 탭의 snapshot을 조용히 덮지 않게 한다.
- 내보내기 실패가 workspace 원본을 변경하지 않는다.

### 테스트 가능성

- STT buffer, context normalization, refinement 적용, Q storage, session ownership은 순수 모듈이다.
- Chat Text 배칭도 UI에서 분리되어 한국어 UTF-8 경계를 직접 검증한다.

## 비판과 위험

### P1: 두 개의 God object

`src/App.tsx`는 UI 조립 외에 workspace hydration, DB queue, export checkpoint, composer, presentation, sidebar, resize를 함께 담당한다. `src/hooks/useLiveInterpreter.ts`는 오디오 DSP, 권한, recorder, WebSocket, Deepgram parsing 연결, 번역, 질문, 자동 정리를 함께 담당한다.

영향:

- 작은 변경도 넓은 dependency array와 lifecycle을 건드린다.
- component-level race 테스트가 어렵다.
- 코드 리뷰에서 상태 소유권을 놓치기 쉽다.

권장 순서:

1. `useWorkspacePersistence`: hydration, debounce, CAS, pagehide
2. `useChatTextExport`: checkpoint, cancel, progress, fallback
3. `ContextSidebar`, `QTranslatePanel`, `PresentationDialog`
4. `useDeepgramTransport`: media/socket/reconnect
5. `useTranslationPipeline`: segment controller와 상태 전이

이 분리는 한 번에 하지 말고 각 단계에서 DOM snapshot과 async race 테스트를 먼저 추가해야 한다.

### P1: 실제 브라우저 통합 테스트 부족

현재 테스트는 순수 로직과 provider 계약에 강하지만 실제 `MediaRecorder`, `WebSocket`, 브라우저 permission, 장치 mute/unmute를 통과하는 자동 E2E가 없다.

필수 보강:

- fake MediaRecorder/WebSocket으로 stop→start, stale close, reconnect timer 테스트
- 실제 Chrome에서 30분 soak test
- 0.5m/1m/1.5m 거리와 빠른 말, 침묵, 네트워크 단절 시나리오

### P1: snapshot 저장의 확장성

SQLite에 workspace 전체를 한 행으로 저장한다. CAS가 손실은 막지만 컨텍스트 단위 merge와 증분 저장은 지원하지 않는다. 장시간 인터뷰가 많아지면 직렬화 비용과 4.5MB 브라우저 제한이 먼저 문제가 된다.

장기 개선은 `contexts`, `segments`, `prepared_questions` 테이블 분리와 context revision이다. 현재 데이터를 자동 삭제하거나 조용히 merge해서는 안 된다.

### P1: 외부 API 의존성

무료 티어의 RPM, 모델 교체, 일시 장애는 앱이 통제할 수 없다. 장애 전환은 가용성을 높이지만 공급자마다 번역 어조가 조금 다를 수 있다. 서버 재시작 시 circuit과 cache도 초기화된다.

운영 보강:

- provider별 latency/success/429 카운터
- 최근 사용 provider를 키 없이 health 화면에 표시
- 모델 availability 시작 점검
- API 키 정기 교체

### P2: STT 분할의 속도·문맥 절충

18단어·5초 상한은 번역 첫 결과를 빠르게 하지만 긴 인터뷰 답변이 여러 블록으로 보일 수 있다. 반대로 상한을 늘리면 문맥은 좋아져도 첫 번역이 늦어진다. 현재 값은 반응성을 우선한 제품 선택이다.

변경할 때는 느낌이 아니라 다음을 함께 측정해야 한다.

- final English까지 p50/p95
- Korean ready까지 p50/p95
- 분당 블록 수와 provider 호출 수
- 숫자·고유명사 WER
- 사용자 평가 기준의 과분할 비율

### P2: 화자 정보의 한계

Deepgram word speaker를 연속 화자 run 단위로 분리해 저장한다. 메타데이터가 일부라도 누락된 구간은 오귀속을 피하려고 unknown으로 남기며, WebSocket 재연결 뒤 초기화될 수 있는 화자 번호도 기존 인물과 합치지 않는다. 따라서 현재 구현은 잘못된 동일인 병합보다 보수적인 미상 표시를 우선한다.

### P2: legacy 대형 bilingual block

일반 실시간 블록은 작지만, 과거/import 데이터의 단일 블록이 매우 크면 요청 한도를 맞추기 위해 영어와 한국어를 독립 chunk로 나눈다. 양쪽 길이가 크게 다르면 chunk 단위 의미 정렬이 약해질 수 있다. 장기적으로 sentence alignment가 있는 import pipeline이 필요하다.

### P2: 호환 필드와 죽은 스타일

이전 버전 데이터 손실을 막기 위해 `people`, `preparedSlotCount`, legacy `questions` 같은 호환 필드는 파서에 남겨 둔다. 제거된 UI와 네트워크 실행 경로, 미사용 CSS는 정리했으며, 호환 필드는 schema migration과 backup 없이 삭제하지 않는다.

## 이번 최적화가 바꾸지 않은 것

- 화면 구조와 문구
- STT 분할 기준
- 번역 공급자 순서와 timeout
- 저장 schema와 DB 파일
- Q Translate/Q storage 동작
- Text 출력 형식
- 자동 정리 주기와 적용 규칙

변경된 것은 책임 위치와 중복 요청 비용이다.

- Text 순수 로직을 `src/lib/chatTextExport.ts`로 이동
- UTF-8 payload/field/batch 불변 테스트 추가
- 번역 route cache 추가
- 유효하지 않은 초과 문맥 전송을 1200자에서 실제 최대 600자로 축소

## 검증 체크리스트

```bash
npm test
npm run build
```

릴리스 전 수동 확인:

1. 서버와 웹 health 200
2. 마이크 시작→영어 final→한국어 ready
3. 일시 정지 직전 마지막 단어 1회만 표시
4. 실패 블록 다시 번역
5. 컨텍스트 전환 후 이전 응답 미유입
6. Q Translate 발음과 크게 보기
7. Q storage 6개 등록·수정·삭제
8. Text 정리 성공, 실패 재개, raw fallback
9. 새로고침 후 localStorage/SQLite 복원
10. 다른 탭 충돌 시 409 안내와 무손실

## 성능 측정 기준

번역 체감은 평균보다 p95가 중요하다.

| 구간 | 측정 시작 | 측정 종료 |
|---|---|---|
| STT 확정 지연 | 해당 음성 청크 전송 | final phrase 수신 |
| 번역 네트워크 지연 | `/api/translate` 요청 | HTTP 응답 |
| 화면 준비 지연 | final phrase 수신 | Korean `ready` render |
| 장애 전환 지연 | 첫 provider 요청 | fallback 성공 |

개발 중에는 uncached와 cached 요청을 분리해 측정한다. cached 결과가 빠르다는 사실로 외부 공급자 지연이 개선됐다고 판단하면 안 된다.
