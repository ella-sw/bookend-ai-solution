from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI
import os
import re
import json
import time
from dotenv import load_dotenv

load_dotenv()

# ==========================================
# 모델 라우팅 설정 (하이브리드 기본 / 단일 모델도 가능)
# - LOGIC (소재 추출, 후속 질문, 글쓰기 제안): GPT-5.4
# - ESSAY (에세이 생성, 에세이 재생성): Claude Sonnet 5
# ==========================================
LOGIC_MODEL = os.getenv("LOGIC_LLM_MODEL", os.getenv("LLM_MODEL"))
ESSAY_MODEL = os.getenv("ESSAY_LLM_MODEL", os.getenv("LLM_MODEL"))

logic_client = OpenAI(
    api_key=os.getenv("LOGIC_API_KEY", os.getenv("ELICE_API_KEY")),
    base_url=os.getenv("LOGIC_BASE_URL", os.getenv("LLM_BASE_URL")),
)

essay_client = OpenAI(
    api_key=os.getenv("ESSAY_API_KEY", os.getenv("ELICE_API_KEY")),
    base_url=os.getenv("ESSAY_BASE_URL", os.getenv("LLM_BASE_URL")),
)

app = FastAPI(title="Rowflow AI API Server", version="2.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _unwrap_target_key(data: object, target_key: str) -> dict | None:
    """중첩 dict 내에 target_key가 있으면 해당 dict를 복사해 반환"""
    if isinstance(data, dict):
        if target_key in data:
            return dict(data)
        for v in data.values():
            found = _unwrap_target_key(v, target_key)
            if isinstance(found, dict):
                return found
    elif isinstance(data, list):
        for item in data:
            found = _unwrap_target_key(item, target_key)
            if isinstance(found, dict):
                return found
    return None


def _promote_nested_field(result: dict, target_key: str, drop_key: str | None = None) -> dict:
    """중첩된 target_key가 포함된 객체를 최상위로 끌어올리고 불필요한 보조 키 제거"""
    unwrapped = _unwrap_target_key(result, target_key)
    if isinstance(unwrapped, dict):
        for k, v in result.items():
            if k not in unwrapped:
                unwrapped[k] = v
        merged = unwrapped
    else:
        merged = dict(result)

    if drop_key:
        merged.pop(drop_key, None)

    # ▼ 이 2줄 추가 (XML 태그 찌꺼기 제거)
    if target_key in ("essay_content", "retouched_content") and isinstance(merged.get(target_key), str):
        merged[target_key] = _clean_essay_text(merged[target_key])

    return merged


def call_llm_json(
    client: OpenAI,
    model: str | None,
    messages: list,
    temperature: float | None = None,
    max_completion_tokens: int = 2000,
    endpoint: str = "",
) -> dict:
    """안전한 JSON 파싱 + 응답 속도 및 토큰 사용량 로그 처리"""
    if not model:
        raise HTTPException(status_code=500, detail="모델명이 설정되지 않았습니다.")

    kwargs = {
        "model": model,
        "messages": messages,
        "response_format": {"type": "json_object"},
        "max_completion_tokens": max_completion_tokens,
    }
    if temperature is not None:
        kwargs["temperature"] = temperature

    start_perf = time.perf_counter()
    response = client.chat.completions.create(**kwargs)
    elapsed_sec = round(time.perf_counter() - start_perf, 3)

    raw = (response.choices[0].message.content or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)

    try:
        result = json.loads(cleaned, strict=False)
    except json.JSONDecodeError as e:
        raise HTTPException(status_code=502, detail=f"LLM JSON 파싱 실패: {e}")

    in_tokens = response.usage.prompt_tokens if response.usage else 0
    out_tokens = response.usage.completion_tokens if response.usage else 0

    result["input_tokens"] = in_tokens
    result["output_tokens"] = out_tokens
    result["latency_sec"] = elapsed_sec

    print(
        f"[{endpoint or model}] model={model} | latency={elapsed_sec}s | "
        f"input_tokens={in_tokens}, output_tokens={out_tokens}"
    )
    return result

def _clean_essay_text(text: str | None) -> str:
    """모델 응답 끝에 간혹 붙는 XML 찌꺼기 태그 제거"""
    if not text:
        return ""
    cleaned = re.sub(r"</?(?:essay_content|retouched_content|invoke)>\s*", "", text)
    return cleaned.strip()



@app.get("/")
def read_root():
    return {
        "message": "Rowflow AI 서버가 정상 작동 중입니다!",
        "logic_model": LOGIC_MODEL,
        "essay_model": ESSAY_MODEL,
    }


# ==========================================
# 1. 소재 추출 API (M120) -> LOGIC_MODEL
# ==========================================
class ExtractRequest(BaseModel):
    record_text: str

@app.post("/api/material/extract")
def extract_material(req: ExtractRequest):
    system_prompt = """
    당신은 사용자의 일상 기록에서 글감을 추출하는 전문 AI 편집자입니다.
    반드시 아래 JSON 형식으로만 응답하세요. 다른 말은 덧붙이지 마세요.
    {
        "title": "추출된 소재의 핵심을 담은 짧은 제목",
        "summary": "핵심 내용을 1문장으로 요약",
        "keywords": ["핵심단어1", "핵심단어2", "핵심단어3"],
        "topic_ids": ["선택된 주제1", "선택된 주제2"],
        "evidence": "소재 추출의 근거가 되는 원본 기록 내 문장 발췌"
    }
    [1차 평가 필수 개선 및 서버 검증 규칙]
1. 원문 충실성 (추론·과장·왜곡 절대 금지):
- 원문에 명시되지 않은 감정이나 의미를 임의로 덧붙이지 마세요. (예: 의자를 내주어 감사했다는 글에 '따뜻한 순간' 추가 금지 / 비뚤어진 접시에 귤을 올려놓아 내가 만든 접시임이 실감 났다는 글에 '비뚤어진 가장자리를 통해 성취감을 느꼈다'라고 감정과 계기를 왜곡 금지)
- 사건 발생 장소와 시간적 순서, 인과관계를 정확히 유지하세요. (예: '버스에서 내린 뒤 걸어가다가 목욕탕 간판을 봤다'를 '버스 정거장에서 간판을 봤다'로 왜곡 금지)
- 기록에 '과정 -> 발견 -> 앞으로의 다짐/생각 변화'(예: 수면 시간 기록 -> 평일 수면 부족 발견 -> 평일 수면부터 살펴보려는 다짐)가 있다면 요약에 그 핵심 흐름과 다짐까지 빠짐없이 반영하세요.
2. evidence (근거 문장):
- 반드시 사용자의 원본 기록에 존재하는 문장을 글자 하나 바꾸지 말고 100% 그대로 발췌하세요.
- 도입부의 사소한 문장이 아니라, 중심 사건과 생각/감정을 뒷받침하는 핵심 문장을 선택하세요.
3. topic_ids (주제 분류 엄격 기준):
- 반드시 다음 10개 중 내용에 정확히 부합하는 1~2개만 선택하세요.
      [가족, 관계, 나·성장, 일·직업, 일상, 여행·장소, 음식, 취향·취미, 몸·건강, 자연·계절]
- [주의] 단순히 타인(세탁소 주인, 버스 승객, 직원 등)이 등장하거나 일회성 인사를 나눴다는 이유만으로 '관계'를 선택하지 마세요. 기록의 핵심 주제가 인간관계나 교류 자체일 때만 '관계'를 선택하세요.
- [주의] 단순히 케이크나 음악, 소품이 등장했다고 해서 '취향·취미'나 '음식'을 선택하지 마세요. 하루를 보낸 방식이나 일상적 경험이 핵심이라면 '일상'이나 '나·성장'을 선택하세요.
4. keywords (추천 매칭용 핵심 명사):
- 조사 및 어미를 제거한 기본형 명사만 남기세요. (서술어가 포함된 구절 금지, '수면 부족'처럼 의미 보존에 필수적인 복합 명사는 허용)
- 중심 내용과 무관한 도입부 단어(예: 목소리 녹음이 핵심인 글에서 아침에 쏟은 '커피'), 원문에 없는 추상적 해석 단어('성취감', '자아', '무감정'), 핵심 의미가 없는 일반 시간 표현('평일', '오늘')은 키워드에서 절대 제외하세요.
    """

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": req.record_text},
    ]
    return call_llm_json(
        logic_client,
        LOGIC_MODEL,
        messages,
        temperature=0.3,
        max_completion_tokens=1024,
        endpoint="/api/material/extract",
    )


# ==========================================
# 2. AI 다음 질문 생성 API (W210) -> LOGIC_MODEL
# ==========================================
class QnARequest(BaseModel):
    chat_history: list

@app.post("/api/qna/next")
def get_next_question(req: QnARequest):
    system_prompt = """
    당신은 사용자의 일상과 기억을 자연스럽게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 글감을 구체화할 수 있는 '단 하나의 후속 질문'만 작성하세요.

    [1차 평가 필수 개선 및 절대 규칙]
1. 반드시 아래 JSON 형식으로만 응답할 것.
    {
        "next_question": "생성된 단일 질문 내용"
    }
2. 단일 초점 및 복합 질문 절대 금지 (가장 중요):
- 한 번에 오직 '한 가지'만 물어보세요. 물음표(?)는 문장 끝에 딱 1개만 사용하세요.
- 한 문장 안에 두 가지 질문을 접속사로 이어 붙이지 마세요. (나쁜 예: "물에 떠 있던 느낌이 어땠는지, 그리고 어떤 의미였는지 말해줄 수 있나요?" -> 좋은 예: "물에 처음 떠 있었던 짧은 순간, 몸에 전해지던 감각은 어땠나요?")
3. 사용자 답변 충실성 및 단정 금지:
- 사용자가 언급하지 않은 감정, 실패, 두려움, 피로, 자신감 부족 등을 임의로 단정하거나 전제하지 마세요.
- 사용자가 자세히 쓰고 싶지 않다고 한 이유는 다시 캐묻지 말고, 남기고 싶어 하는 장면이나 행동으로 질문을 전환하세요.
4. 감각 및 장면 구체화 유도:
- 사용자가 어떤 장면을 어떻게 설명할지 막막해한다면, 추상적인 '감정'이나 '생각/의미'를 묻지 말고 눈에 보인 모양, 빛, 크기, 소리, 행동 등 구체적인 감각 요소 중 딱 한 가지를 쉽게 떠올릴 수 있도록 질문하세요.
    """

    messages = [{"role": "system", "content": system_prompt}] + req.chat_history
    return call_llm_json(
        logic_client,
        LOGIC_MODEL,
        messages,
        max_completion_tokens=512,
        endpoint="/api/qna/next",
    )


# ==========================================
# 2-2. AI 다른 질문 보기 (재생성) API (W220) -> LOGIC_MODEL
# ==========================================
class QnAAltRequest(BaseModel):
    chat_history: list
    rejected_questions: list

@app.post("/api/qna/alternative")
def get_alternative_question(req: QnAAltRequest):
    system_prompt = f"""
    당신은 사용자의 일상과 기억을 자연스럽게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 기존에 거절된 질문과는 완전히 다른 측면의 '단 하나의 새로운 후속 질문'을 작성하세요.

    [1차 평가 필수 개선 및 절대 규칙]
1. 반드시 아래 JSON 형식으로만 응답할 것.
    {{
        "next_question": "생성된 단일 질문 내용"
    }}
2. 복합 질문 절대 금지:
- 한 번에 오직 '한 가지'만 물어보세요. 물음표(?)는 문장 끝에 딱 1개만 사용하세요. 두 가지 질문을 이어 붙이지 마세요.
3. 질문 관점의 완전한 전환 (가장 중요):
- 제외할 기존 질문 목록:
      {req.rejected_questions}
- 위 질문들과 표면적 단어만 바꾼 유사 질문을 절대 생성하지 마세요.
- 예를 들어 기존 질문이 '기분/감정/생각'을 물었다면, 다시 생각이나 감정을 묻지 말고 '구체적인 주변 상황이나 장면', '그 행동을 처음 결심한 계기', '이전이나 이후의 구체적 행동' 등 완전히 새로운 측면에서 질문하세요.
4. 사용자가 말하지 않은 보람, 두려움, 실패 등을 임의로 전제하지 마세요.
    """

    messages = [{"role": "system", "content": system_prompt}] + req.chat_history
    return call_llm_json(
        logic_client,
        LOGIC_MODEL,
        messages,
        max_completion_tokens=512,
        endpoint="/api/qna/alternative",
    )


# ==========================================
# 3. AI 에세이 초안 생성 API (W330) -> ESSAY_MODEL
# ==========================================
class DraftRequest(BaseModel):
    materials: list
    tone: str
    length: str
    user_request: str | None = ""

@app.post("/api/essay/draft")
def generate_draft(req: DraftRequest):
    length_guide = "300자에서 500자 사이" if ("단문" in req.length or "짧게" in req.length) else "1000자에서 1500자 사이"
    is_plain_tone = ("담백" in req.tone or "담담" in req.tone)

    style_guide = (
        "과도한 수사나 감정의 과장은 덜어내되, 소재에 담긴 행동과 생각의 흐름을 차분하고 자연스러운 에세이 문장으로 풀어내세요. 원문 문장을 그대로 이어 붙이기만 하지 마세요."
        if is_plain_tone
        else "소재에 담긴 상황과 생각, 감각의 여운을 살려 문장의 호흡과 연결을 부드럽게 다듬으세요. 단, 원문에 없는 새로운 사건, 인물, 장소, 날씨·조명 같은 외부 사실은 지어내지 마세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"

    system_prompt = f"""
    당신은 사용자의 실제 기록을 바탕으로 분량과 사실 관계를 정확히 지키는 에세이 작가입니다.
    가장 중요한 원칙은 '원문 사실 100% 보존'이며, 그 범위 안에서 반드시 목표 분량(공백 포함 {length_guide}, 제목 제외 본문 기준)에 맞춰 에세이를 작성하세요.

    [규칙 우선순위 — 충돌 시 상위 원칙이 절대 우선]
    1순위: 원문 사실·부정 표현·시점·순서 100% 보존 (창작·왜곡·임의 추론 절대 금지)
    2순위: 목표 분량(공백 포함 {length_guide}) 준수
    3순위: 사용자 추가 요청 및 요청 문체({req.tone}) 반영

    [작성 기준]
    1. 원문 왜곡·창작 절대 금지 (최우선):
       - 제공된 소재에 없는 사건, 인물, 장소, 소품, 날씨, 계절, 시간대, 조명, 주변 사람의 표정·반응을 절대 지어내지 마세요.
       - '하지 않았다', '못했다', '뻔했다', '~라기보다' 같은 부정·미완료·강도 표현을 긍정이나 다른 감정·의도로 바꾸지 마세요.
         (예: '빵을 사지는 않았다' → '빵을 샀다' 금지 / '짐을 다 풀지 못했다' → '일부러 풀지 않았다' 금지 / '부끄러웠다기보다 안도감이 들었다' → '부끄러웠다' 금지)
       - 서로 다른 날이나 시기의 소재를 같은 날 일어난 일처럼 합치지 말고, 원문에 없는 교훈·다짐·인생 깨달음으로 글을 마무리하지 마세요.

    2. 목표 분량({length_guide}) 달성 기준 (공백 포함, 본문 기준):
       - 임의 창작이나 같은 의미의 단순 반복 없이, 아래 방식으로 분량을 조절하세요:
         · 짧은 목표 구간(예: 300~500자): 핵심 상황과 생각 위주로 군더더기 없이 2~3문단으로 구성합니다.
         · 긴 목표 구간(예: 1,000~1,500자): 소재에 제시된 상황·행동 과정·생각의 흐름을 단계별로 세세히 풀어 4~5문단으로 구성합니다.
       - 분량이 모자랄 때는 원문에 있는 행동 과정과 생각의 맥락을 차분히 풀어서 채우고, 분량이 넘칠 때는 중복 표현과 장황한 수식을 줄여 목표 범위({length_guide}) 안에 맞추세요.
       - 단, 원문 정보량이 매우 적어 허구 없이 목표 분량에 닿기 어려운 경우에도 새 사실을 지어내지 말고, 허용된 사실 안에서 자연스럽게 완결하세요.

    3. 문체 및 사용자 추가 요청 반영:
       - 요청 문체({req.tone}): {style_guide}
       - 사용자 추가 요청({user_request_text})이 '없음'이 아니면 원문 사실관계를 해치지 않는 범위에서 반영하세요.

    4. 출력 형식 및 최종 점검:
       - 출력 전 본문의 공백 포함 글자 수가 목표 분량({length_guide})에 들어오는지, 원문 왜곡과 표현 반전이 없는지 확인하세요.
       - 제목, 마크다운 기호, 코드블록, 부연 설명 없이 반드시 아래 JSON 형식으로만 응답하세요.
         {{
             "essay_content": "에세이 초안 본문"
         }}
    """

    user_prompt = (
        f"- 요청 문체: {req.tone}\n"
        f"- 목표 분량: 공백 포함 {length_guide}\n"
        f"- 사용자 추가 요청: {user_request_text}\n"
        f"- 소재 목록:\n{req.materials}"
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    result = call_llm_json(
        essay_client,
        ESSAY_MODEL,
        messages,
        temperature=0.35,
        max_completion_tokens=2000,
        endpoint="/api/essay/draft",
    )
    return _promote_nested_field(result, target_key="essay_content")

# ==========================================
# 4. AI 글 다시 만들기 (재생성) API (W340) -> ESSAY_MODEL
# ==========================================
class RetouchRequest(BaseModel):
    current_draft: str
    selected_materials: str
    tone: str
    length: str
    user_request: str | None = ""

@app.post("/api/essay/retouch")
def retouch_draft(req: RetouchRequest):
    length_guide = "1000자에서 1500자 사이" if ("장문" in req.length or "길게" in req.length) else "300자에서 500자 사이"
    is_plain_tone = ("담백" in req.tone or "담담" in req.tone)

    style_guide = (
        "불필요한 과장이나 수사는 줄이되, 현재 초안과 소재의 흐름을 간결하고 차분한 문장으로 자연스럽게 다듬으세요."
        if is_plain_tone
        else "현재 초안과 소재에 담긴 생각과 감각의 여운을 살려 문장 호흡을 부드럽게 다듬되, 없는 사건·인물·장소·배경을 지어내지 마세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"

    system_prompt = f"""
    당신은 사용자가 수정한 현재 초안(current_draft)과 처음 고른 소재를 바탕으로, 분량과 사실관계를 정확히 지키며 에세이를 다시 다듬는 전문 편집자입니다.
    가장 중요한 원칙은 '사용자 수정 의도와 원문 사실 100% 보존'이며, 그 범위 안에서 반드시 목표 분량(공백 포함 {length_guide}, 제목 제외 본문 기준)에 맞춰 자연스러운 에세이로 재구성하세요.

    [규칙 우선순위 — 충돌 시 상위 원칙이 절대 우선]
    1순위: 사용자 수정본(current_draft) 및 원문 사실·부정 표현·시점 100% 보존 (창작·왜곡·임의 추론 절대 금지)
    2순위: 목표 분량(공백 포함 {length_guide}) 준수
    3순위: 사용자 추가 요청 및 적용 문체({req.tone}) 반영

    [작성 기준]
    1. 사용자 수정본 및 원문 사실·부정 표현 보존 (최우선):
       - 사용자가 현재 초안(current_draft)에서 수정하거나 덧붙인 문장, 생각, 의도를 누락하거나 원래 소재 내용으로 되돌리지 마세요.
       - '하지 않았다', '못했다', '뻔했다', '~라기보다' 같은 부정·미완료·강도 표현을 긍정이나 다른 감정·의도로 바꾸지 마세요.
         (예: '짐을 다 풀지 못했다' → '일부러 풀지 않았다' 금지 / '부끄러웠다기보다 안도감이 들었다' → '부끄러웠다' 금지)
       - 현재 초안과 처음 고른 소재에 없는 새로운 사건, 인물, 장소, 소품, 날씨, 배경 묘사, 거창한 교훈·인생 다짐을 절대 지어내지 마세요.

    2. 목표 분량({length_guide}) 달성 기준 (공백 포함, 본문 기준):
       - 현재 초안이 짧더라도 없는 사실을 지어내거나 같은 문장을 단순 반복하지 말고, 아래 방식으로 목표 분량({length_guide})을 안정적으로 채우세요:
         ① 초안과 소재의 맥락 결합: 현재 초안의 수정 방향을 최우선으로 유지하되, 처음 고른 소재에 이미 들어 있는 세부 행동·상황·생각의 흐름을 자연스럽게 녹여 호흡을 넓힙니다.
         ② 행동·생각의 순차 전개: 짧게 압축된 문장을 상황의 앞뒤 흐름과 명시된 생각의 결에 따라 한 호흡씩 차분히 풀어 서술합니다.
         ③ 문단 구성: 짧은 목표 구간(예: 300~500자)은 2~3문단, 긴 목표 구간(예: 1,000~1,500자)은 4~5문단으로 나누고 문단 사이는 줄바꿈(\\n\\n)으로 구분합니다.
       - 분량이 넘칠 때는 중복 표현과 장황한 수식을 덜어 목표 범위 안에 맞추세요.
       - 단, 현재 초안과 소재의 정보량이 매우 적어 허구 없이 목표 분량에 닿기 어려운 경우에도 창작하지 말고, 허용된 사실 안에서 자연스럽게 완결하세요.

    3. 문체 및 사용자 추가 요청 반영:
       - 적용할 문체({req.tone}): {style_guide}
       - 감성 문체라도 없는 배경·풍경·감정을 덧붙이지 말고, 기존 사실과 감각의 문장 호흡·여운만 부드럽게 다듬으세요.
       - 사용자 추가 요청({user_request_text})이 '없음'이 아니면 원문과 사용자 수정본의 사실관계를 해치지 않는 범위에서 충실히 반영하세요.

    4. 출력 형식 및 최종 점검:
       - 출력 전 본문의 공백 포함 글자 수가 목표 분량({length_guide})에 들어오는지, 사용자 수정 의도 누락이나 부정 표현 반전이 없는지 스스로 점검하세요.
       - 제목, XML 태그, 마크다운 기호, 코드블록, 부연 설명 없이 반드시 아래 JSON 형식으로만 응답하세요.
         {{
             "retouched_content": "다듬어진 에세이 본문"
         }}
    """

    user_prompt = f"""- 사용자가 수정한 현재 초안:
    {req.current_draft}

- 처음 고른 소재:
    {req.selected_materials}

- 적용할 문체: {req.tone}
- 목표 길이: 공백 포함 {length_guide} ({req.length})
- 사용자 추가 요청: {user_request_text}
    """

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    result = call_llm_json(
        essay_client,
        ESSAY_MODEL,
        messages,
        temperature=0.35,
        max_completion_tokens=2000,
        endpoint="/api/essay/retouch",
    )
    return _promote_nested_field(result, target_key="retouched_content")

# ==========================================
# 5. 글쓰기 제안 API (N130) -> LOGIC_MODEL
# ==========================================
class ProposalRequest(BaseModel):
    materials: list

@app.post("/api/proposal/recommend")
def recommend_proposal(req: ProposalRequest):
    system_prompt = """
    당신은 사용자의 일상 기록(소재)들을 분석하여 한 편의 글로 엮을 수 있을지 판단하고 기획안을 제안하는 전문 에디터입니다.

    [1차 평가 필수 개선 및 절대 규칙]
1. 억지 연결 절대 금지 및 제안 보류 판단 (가장 중요):
- 소재들이 단순히 같은 주제(예: 일상, 일·직업)에 속해 있다는 이유만으로 억지로 묶지 마세요.
- 소재들 사이에 공통된 대상/사물, 이어지는 행동이나 태도의 변화, 대조적인 경험 등 '실질적인 연결 근거'가 있을 때만 제안하세요.
- 만약 서로 무관한 단편적 사실들의 나열(예: 은행 비밀번호 변경 + 냉동 만두 먹음 + 충전선 주움 / 프린터 토너 교체 + 점심시간 변경 공지 + 비밀번호 변경 등)이고 추가적인 감정·인과관계가 없다면, 억지로 '삶의 정비', '일상의 변화와 적응', '성장' 같은 의미를 부여하지 말고 제안을 보류(`"can_suggest": false`, 나머지 항목은 반드시 `null`)하세요!
2. 소재 충실성 및 과도한 의미 부여 금지:
- 원문에 명시되지 않은 감정이나 거창한 심리적 의미를 단정하지 마세요. (예: 첫 월급으로 운동화를 산 것에 '목표 달성의 기쁨과 성취감' 추가 금지 / 휴대폰을 두고 나간 경험에 '디지털 디톡스의 가치와 깨달음' 강요 금지 / 우산 이야기에 '새로운 시작'이나 '비 오는 날의 감정' 추가 금지 / 취향 정리에 '가치관 변화' 단정 금지)
- 서로 다른 물건(예: 새 우산과 오래된 우산)을 하나의 물건으로 합치지 말고, 사건 간의 시간적 선후관계가 명시되지 않았다면 임의로 시간순 인과관계를 지어내지 마세요.
3. 전체 소재를 아우르는 정확한 제목(`title`):
- 모든 소재의 공통점을 정확히 포괄해야 합니다. (예: 음식 주문 실수 2건과 예약 날짜 변경 요청 1건을 묶으면서 제목을 '음식 주문의 작은 오해들'처럼 일부 소재에 한정하여 짓지 마세요.)
4. 구체적인 방향(`direction`) 및 추천 이유(`reason`):
- `direction`: 제목을 단순 반복하지 말고, 각 소재에 실제로 나타난 사실과 변화를 어떤 구조(나열, 대비, 흐름 연결 등)로 엮을지 명확한 한 문장으로 제시하세요.
- `reason`: 추상적인 교훈이 아니라, 제공된 소재들의 '실제 내용'을 직접 언급하며 왜 이 소재들을 함께 묶어 쓰면 좋은지 다정하게 설명하세요.
5. 반드시 아래 JSON 형식으로만 응답하세요.
    {
        "can_suggest": true 또는 false,
        "title": "글의 핵심 주제를 담은 짧은 제목 (보류 시 null)",
        "reason": "실제 소재 내용을 바탕으로 설명하는 추천 이유 (보류 시 null)",
        "direction": "글을 어떻게 엮을지 구조를 지시하는 명확한 한 문장 (보류 시 null)"
    }
    """
    user_prompt = f"- 선택된 소재 목록:\n{req.materials}"

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]
    return call_llm_json(
        logic_client,
        LOGIC_MODEL,
        messages,
        max_completion_tokens=1024,
        endpoint="/api/proposal/recommend",
    )