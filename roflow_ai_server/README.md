# 📖 북잇업(Book-it-up) AI 서버 (C 파트)

일상 기록을 에세이로 완성해 주는 '북잇업' 서비스의 AI 파이프라인을 담당하는 독립 API 서버입니다. 
사용자의 기록에서 글감을 추출하고, 다정한 꼬리 질문을 던지며, 맞춤형 에세이 초안을 생성 및 교정하는 역할을 수행합니다.

## 🛠 Tech Stack
- **Language:** Python 3.14
- **Framework:** FastAPI
- **Package Manager:** uv
- **AI Model:** OpenAI API (gpt-4o-mini)

## ✨ 핵심 기능 (Core APIs)
프론트엔드 UI 화면 구성 및 백엔드 ERD 구조와의 완벽한 연동을 위해, **모든 AI 응답은 100% JSON 형태로 통제**되어 반환됩니다.

1. **소재 추출 API (`/api/material/extract`) - M120**
   - 일상 기록 텍스트를 분석하여 1줄 요약, 핵심 키워드 3개, 카테고리(일상/일/가족) 추출
2. **AI 후속 질문 생성 API (`/api/qna/next`) - W210**
   - 사용자와의 대화 문맥(`chat_history`)을 파악하여 글감을 풍성하게 해줄 다정한 꼬리 질문 1개 생성
3. **에세이 초안 생성 API (`/api/essay/draft`) - W330**
   - 추출된 소재와 사용자가 선택한 방향, 문체, 길이를 조합하여 맞춤형 에세이 초안 작성
4. **글 재생성(교정) API (`/api/essay/retouch`) - W340**
   - 기존 생성된 초안에 사용자의 피드백을 반영하여 어색함 없이 글 수정 및 재생성

## 🚀 시작하기 (Getting Started)

프론트엔드 및 백엔드 개발자는 아래 단계를 통해 로컬 환경에서 즉시 AI API를 띄우고 테스트할 수 있습니다.

### 1. 환경 설정 (.env)
프로젝트 최상단 폴더에 `.env` 파일을 생성하고 발급받은 OpenAI API 키를 입력합니다.
(API 키는 AI 파트 담당자에게 문의해 주세요.)
```env
OPENAI_API_KEY="sk-여기에_실제_발급받은_API_키를_넣으세요"