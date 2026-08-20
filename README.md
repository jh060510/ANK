# AIYK

AIYK는 영어 인터뷰를 실시간으로 듣고 한국어로 번역하며, 한국어 질문을 정중한 영어와 한국어식 참고 발음으로 바꿔 주는 로컬 우선 웹 앱입니다.

## 핵심 기능

- Deepgram Nova-3 실시간 영어 STT와 화자 분리 정보 수집
- 확정 발화만 고정 블록으로 만들고, 미확정 발화는 타이핑 상태로 표시
- Groq → Cerebras → Apps Script → Gemini 자동 번역 장애 전환
- 동일 원문·동일 문맥 번역의 메모리 캐시 재사용
- AI 기업명, 제품명, 모델명과 전문 용어를 보존하는 번역 프롬프트
- 오류 블록 개별 재번역
- Q Translate: 한국어 질문을 정중한 영어와 한국어식 참고 발음으로 변환
- 컨텍스트별 Q storage 6개
- 10분 단위 확정 대화 정리와 실패 번역 복구
- Text 내보내기: 질문·시간·메타데이터를 제외하고 영어/한국어를 분리하며 누락 번역만 복구
- 브라우저 저장소와 로컬 SQLite 이중 자동 저장, 소스 병합 및 충돌 시 덮어쓰기 차단
- SQLite 5분 주기·삭제/축소 직전 복구 이력 자동 보존
- 컨텍스트 생성·선택·제목 수정·삭제

## 실행

Node.js 20 이상이 필요합니다.

```bash
npm install
copy .env.example .env
npm run dev
```

브라우저에서 `http://127.0.0.1:5173`을 엽니다. `npm run dev`는 웹과 API 서버를 함께 실행합니다.

```bash
npm test
npm run build
npm start
```

## 환경변수

```dotenv
DEEPGRAM_API_KEY=
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
CEREBRAS_API_KEY=
CEREBRAS_MODEL=gemma-4-31b
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.1-flash-lite
TRANSLATION_SCRIPT_URL=
DEEPGRAM_KEYTERMS=
APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
PORT=8787
AIYK_DATABASE_PATH=
```

키는 서버의 `.env`에만 둡니다. `VITE_*`, 브라우저 저장소, 소스 코드에는 넣지 않습니다. 대화에 한 번이라도 노출된 키는 폐기하고 재발급하는 것이 안전합니다.

## 데이터 흐름

```text
Microphone
  → Web Audio preprocessing
  → MediaRecorder (80 ms WebM/Opus)
  → local WebSocket relay
  → Deepgram Nova-3
       ├─ interim → typing state only
       └─ final phrase → Chat English
                         → Groq
                         → Cerebras
                         → Apps Script
                         → Gemini
                         → fixed Korean translation
```

발화는 문장 종결 또는 안전 상한인 18단어·5초에서 분리됩니다. Deepgram의 `endpointing=800ms`, `utterance_end_ms=2000ms`와 별개로 MediaRecorder 전송 간격은 80ms를 유지합니다.

## API 연결

| 경로 | 역할 | 주요 공급자 |
|---|---|---|
| `WS /api/deepgram/live` | 실시간 STT relay·화자 메타데이터 | Deepgram Nova-3 |
| `POST /api/translate` | Chat 실시간 번역·장애 전환 | Groq → Cerebras → Apps Script → Gemini |
| `POST /api/polish-question` | Q Translate 영어·참고 발음 | Cerebras → Gemini |
| `POST /api/refine-context` | 확정 대화 정리·누락 번역 복구 | 무료 구성 LLM |
| `POST /api/export-text` | 영어/한국어 Chat Text 생성 | 누락 번역만 API 사용 |
| `GET/PUT /api/workspace` | 로컬 workspace 읽기·CAS 저장 | SQLite |

브라우저에는 어떤 장기 API 키도 전달하지 않습니다. 모든 외부 호출은 로컬 서버를 통과합니다.

## 저장

- 브라우저: `localStorage`
- 로컬 DB: 기본 `data/aiyk.sqlite`
- 저장 단위: 전체 workspace snapshot
- 복구 이력: 5분 주기 및 컨텍스트·대화·Q Storage가 줄어들기 직전 자동 보관
- 동시 수정: DB의 `savedAt` 비교로 오래된 탭의 덮어쓰기를 거부
- 음성 원본: 저장하지 않음

DB 위치는 `AIYK_DATABASE_PATH`로 바꿀 수 있습니다. 현재 방식은 충돌을 안전하게 거부하지만 자동 병합하지는 않습니다. 여러 탭에서 동시에 편집하지 않는 것이 좋습니다.

## 문서

- [아키텍처와 변경 규칙](docs/ARCHITECTURE.md)
- [기술 검토와 한계](docs/TECHNICAL_REVIEW.md)

## 주요 파일

- `src/App.tsx`: 화면 조립, workspace 전환, 내보내기 진행 상태
- `src/hooks/useLiveInterpreter.ts`: 마이크, STT 소켓, 번역 lifecycle
- `src/lib/transcript.ts`: Deepgram 결과 누적·분할
- `src/lib/contexts.ts`: 컨텍스트 모델·저장 정규화
- `src/lib/chatTextExport.ts`: Text 원문·UTF-8 안전 배칭
- `src/lib/contextRefinement.ts`: 10분 정리 후보와 원자적 적용
- `server/providers.ts`: 번역 라우팅, 질문 번역, Chat 정리
- `server/index.ts`: HTTP API와 Deepgram WebSocket relay
- `server/localDatabase.ts`: SQLite snapshot 저장

과거 DB 호환을 위한 일부 읽기 전용 필드는 유지하지만, 제거된 자동 추천 질문·인물 관리 UI와 관련 실행 코드는 포함하지 않습니다.

## Apps Script 선택 도구

`apps-script/Code.gs`를 Google Apps Script 웹 앱으로 배포한 뒤 `/exec` URL을 `TRANSLATION_SCRIPT_URL`에 넣으면 번역 장애 전환 경로로 사용됩니다.
