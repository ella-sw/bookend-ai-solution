# Rowflow AI API Server & Prompt Evaluation Pipeline

일상 기록에서 글감(소재)을 추출하고, 후속 질문과 글쓰기 제안을 거쳐 사용자의 실제 경험만을 바탕으로 에세이를 작성·재생성하는 **AI 백엔드 서버 및 프롬프트 자동/정성 평가 파이프라인**입니다.

## 핵심 설계 포인트

### 1. 역할 기반 하이브리드 LLM 라우팅

호출 빈도, 구조화 출력 안정성, 문장 서술 품질, 응답 속도 및 비용을 고려하여 작업 특성에 따라 모델을 분리했습니다.

| 라우팅 그룹 | 기본 모델 | 담당 기능 | 선정 이유 |
| ----- | ----- | ----- | ----- |
| **LOGIC** | `GPT-5.4` | 소재 추출, 후속 질문 생성/재생성, 글쓰기 제안 | 호출이 잦고 JSON 스키마 준수·분류 정확도가 핵심인 구간을 빠르고 저비용으로 처리 |
| **ESSAY** | `Claude Sonnet 5` | 에세이 초안 생성, 글 다시 만들기(재생성) | 사용자가 직접 읽는 본문의 문장 호흡과 서술 품질이 핵심인 구간에 집중 배치 |

### 2. LLM 응답 후처리 및 안정화 (`main.py`)

* **JSON 래퍼 언래핑:** 모델이 응답을 불필요한 중첩 객체로 감싸 반환하더라도 핵심 키(`essay_content`, `retouched_content` 등)를 최상위로 자동 추출합니다.
* **잔여 태그 정제:** 마크다운 코드블록(```` ```json ````) 및 간헐적으로 섞여 나오는 XML 잔여 태그(`</essay_content>`, `</retouched_content>`, `</invoke>`)를 정규식으로 제거합니다.
* **관측성 로그:** 모든 API 응답에 `input_tokens`, `output_tokens`, `latency_sec`를 포함해 응답 속도 및 비용 추적이 가능하도록 구성했습니다.

### 3. 정량 + 정성(루브릭) 통합 평가 파이프라인 (`test/`)

프롬프트 수정 전후의 품질 변화를 객관적으로 검증하기 위해 테스트셋 빌더와 자동·수동 병합 분석기를 구축했습니다.

* **자동 규칙 검증:** JSON 스키마 준수율, 단일 질문 여부(물음표 개수), 에세이 목표 분량(`300~500자` / `1,000~1,500자`) 준수율, 원문 유사도(단순 복사 감지), 문장 고유율(반복 감지), 응답 지연 및 추정 비용(USD)
* **정성 루브릭 평가:** 핵심 케이스에 대해 CLI 대화형으로 원문 왜곡 없음 여부(PASS/FAIL)와 문장 자연스러움(1~5점)을 기록하고, 버전별 결과를 나란히 비교합니다.

## 디렉토리 및 파일 구성

```text
.
├── main.py                              # FastAPI 기반 AI 추론 서버 (하이브리드 라우팅 & 응답 정제)
├── pyproject.toml                       # 프로젝트 메타데이터 및 의존성 정의
├── .python-version                      # 사용 Python 버전 명시
├── .env.example                         # 환경변수 템플릿 (.env는 로컬 전용, Git 제외)
├── .gitignore
├── README.md
└── test/                                # 프롬프트 평가 케이스 및 분석 파이프라인
    ├── build_cases_from_uploads.py      # 기능별 테스트 JSON 파일을 통합 cases.jsonl로 변환
    ├── analyze_prompts_with_rubric.py   # 자동 규칙 검증 + 대화형 루브릭 병합 및 버전 비교 리포트 생성
    ├── material_cases.json              # 소재 추출 테스트 케이스
    ├── question_cases.json              # 후속 질문 / 다른 질문 테스트 케이스
    ├── essay_cases.json                 # 에세이 초안 생성 테스트 케이스
    ├── retouch_cases.json               # 에세이 다시 만들기 테스트 케이스
    ├── proposal_cases.json              # 글쓰기 제안 테스트 케이스
    ├── cases.jsonl                      # 전체 기능 통합 테스트셋 (생성 파일)
    ├── essay_only_cases.jsonl           # 에세이 생성/재생성 전용 테스트셋
    └── eval_analysis/                   # 평가 결과 저장 폴더 (JSONL, CSV, rubric_scores.jsonl)
```

## API 엔드포인트

| Method | Endpoint | 모델 그룹 | 설명 |
| ----- | ----- | ----- | ----- |
| `GET` | `/` | - | 서버 상태 및 현재 적용된 `logic_model` / `essay_model` 확인 |
| `POST` | `/api/material/extract` | LOGIC | 일상 기록에서 제목, 1문장 요약, 키워드, 주제(1~2개), 원문 근거 문장 추출 |
| `POST` | `/api/qna/next` | LOGIC | 이전 대화 기록 기반 단일 후속 질문 생성 |
| `POST` | `/api/qna/alternative` | LOGIC | 거절된 질문 목록(`rejected_questions`)과 다른 관점의 새 질문 생성 |
| `POST` | `/api/essay/draft` | ESSAY | 선택된 소재·문체·분량·추가 요청 기반 에세이 초안 생성 |
| `POST` | `/api/essay/retouch` | ESSAY | 사용자 수정본(`current_draft`)과 원문 사실을 보존하며 문체·분량 재구성 |
| `POST` | `/api/proposal/recommend` | LOGIC | 소재 간 실질적 연결성 판단 및 글쓰기 기획안 제안 (억지 연결 시 보류) |

## 실행 방법

### 1. 환경 및 패키지 설치

`pyproject.toml` 기반으로 의존성을 설치합니다.

```bash
# uv 사용 시
uv sync

# pip 사용 시
pip install fastapi uvicorn openai pydantic python-dotenv
```

### 2. 환경변수 설정

`.env.example`을 복사해 `.env` 파일을 생성하고 API 키와 엔드포인트를 입력합니다.

```bash
cp .env.example .env
```

```dotenv
# LOGIC Model (소재 추출, 후속 질문, 글쓰기 제안)
LOGIC_API_KEY="your-logic-api-key"
LOGIC_BASE_URL="https://your-endpoint/v1"
LOGIC_LLM_MODEL=gpt-5.4

# ESSAY Model (에세이 초안 생성, 다시 만들기)
ESSAY_API_KEY="your-essay-api-key"
ESSAY_BASE_URL="https://your-endpoint/v1"
ESSAY_LLM_MODEL=claude-sonnet-5
```

### 3. API 서버 실행

프로젝트 루트 디렉토리에서 서버를 실행합니다.

```bash
uvicorn main:app --reload
```

* 서버 상태 확인: `http://127.0.0.1:8000/`
* Swagger UI 테스트: `http://127.0.0.1:8000/docs`

## 프롬프트 평가 파이프라인 실행

API 서버가 실행 중인 상태에서 `test/` 디렉토리로 이동해 스크립트를 실행합니다.

```bash
cd test
```

### 1. 통합 테스트셋(`cases.jsonl`) 생성

```bash
python build_cases_from_uploads.py
```

### 2. 자동 지표 측정 및 정성 루브릭 입력

```bash
# 전체 케이스 자동 지표 측정
python analyze_prompts_with_rubric.py --tag v2_prompt --cases cases.jsonl

# 에세이 전용 케이스만 빠르게 평가
python analyze_prompts_with_rubric.py --tag v2_essay --cases essay_only_cases.jsonl

# 핵심 케이스 정성 루브릭(원문 왜곡 여부 / 자연스러움) 대화형 입력 포함
python analyze_prompts_with_rubric.py --tag v2_prompt --cases cases.jsonl --rubric-interactive
```

### 3. 이전 버전과 나란히 비교

```bash
python analyze_prompts_with_rubric.py \
  --tag v2_prompt \
  --cases cases.jsonl \
  --compare-records eval_analysis/merged_v1_prompt_20260101_120000.jsonl
```

실행이 완료되면 콘솔에 케이스별·버전별 요약 리포트가 출력되며, `test/eval_analysis/` 폴더에 JSONL과 CSV 파일이 저장됩니다.

## 향후 개선 계획

* **문체별 표현력 고도화:** 원문 사실 보존 규칙을 유지하면서 '감성적'과 '담백함' 문체의 문장 길이·호흡·어미 기준을 더욱 뚜렷하게 분리
* **에세이 분량 준수율 개선:** 목표 글자 수 범위 이탈 시 자동 재요청 조건 및 프롬프트 가이드 정교화
* **체감 응답 속도 최적화:** 에세이 생성/재생성 구간에 SSE 스트리밍 응답 도입 검토