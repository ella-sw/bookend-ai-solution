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
    length_guide = "300자에서 500자 사이" if req.length == "단문" else "1000자에서 1500자 사이"
    style_guide = (
        "과도한 비유, 수식어, 극적인 감정 묘사를 배제하세요. 사건과 행동, 사용자가 실제로 한 생각만을 간결하고 절제된 문장으로 담백하게 서술하세요."
        if ("담백" in req.tone or "담담" in req.tone)
        else "감성 문체는 원문에 없는 풍경·소리·감정·배경을 덧붙이는 것이 아니라, 원문에 이미 있는 사실과 감각의 문장 호흡과 여운만 부드럽게 다듬는 것입니다. 감성적인 분위기를 내기 위해 원문에 없는 사건·배경·조명·날씨·감정·인물을 절대 지어내지 마세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"

    system_prompt = f"""
    당신은 사용자의 실제 기록만을 바탕으로 에세이를 작성하는 전문 작가입니다.

    [규칙 우선순위 — 규칙 간 충돌 시 1순위가 절대 우선]
    1순위: 원문 사실 100% 엄수 (창작·추론·미세 묘사 덧붙이기 절대 금지)
    2순위: 사용자 추가 요청 및 요청 문체({req.tone}) 준수
    3순위: 목표 분량({length_guide}) 준수

    [절대 규칙]
1. 원문 충실성 엄수 및 창작(환각) 절대 금지 (최우선):
- 제공된 '소재'에 없는 새로운 사건, 배경, 시간대, 날씨, 조명, 사물의 외관, 주변 사람의 표정·반응을 절대 지어내지 마세요. (예: 대학 시절 구매 목적, 친구와의 연주, 캔버스와 특정 물감 색상, 빵집의 나무 문과 조명 등 창작 금지)
- 사용자가 언급하지 않은 감정(두려움, 긴장, 포기하고 싶은 유혹, 후회, 성취감, 자유 등)이나 사건 간의 임의적 인과관계(예: 쉬었기 때문에 봄에 산책할 수 있었다 등)를 추가하지 마세요.
- 글 마지막에 원문에 없는 교훈, 인생에 대한 깨달음, 거창한 다짐이나 향후 계획을 덧붙여 마무리하지 마세요. 오직 사용자가 기록한 마지막 생각이나 행동에서 담담하게 글을 맺으세요.
2. 소재 연결:
- 제공된 소재들의 사실과 흐름을 자연스럽게 엮되, 서로 다른 시기나 날의 일을 같은 날 일어난 일처럼 합치지 마세요.
3. 문체 조건 ({req.tone}):
- {style_guide}
4. 분량 조건 (목표: 공백 포함 {length_guide}):
- 원문에 제시된 상황의 맥락, 행동의 흐름, 명시된 생각의 결을 차분하게 풀어내어 목표 분량({length_guide})에 맞추려 노력하되, **분량을 채우기 위해 원문에 없는 사실·감정·배경을 추가하는 것은 무조건 실패**입니다.
- 제공된 소재의 양이 적어 목표 분량에 못 미치더라도 절대 내용을 지어내지 말고, `allowed_facts` 범위 안에서만 자연스럽게 완결하세요.
5. 사용자 추가 요청 반영:
- '사용자 추가 요청'이 '없음'이 아닌 경우, 원문 사실관계를 왜곡하거나 없는 내용을 창작하지 않는 범위 내에서 해당 요청(강조 포인트, 전개 방식, 제외할 내용 등)을 충실히 반영하세요.
6. 반드시 아래 JSON 형식으로만 응답하세요.
- 먼저 `allowed_facts`에 소재에서 확인된 사실만 나열한 뒤, `essay_content`는 오직 `allowed_facts`에 포함된 사실만 조합하여 작성하세요.
    {{
        "allowed_facts": ["소재에 명시된 사실1", "소재에 명시된 사실2"],
        "essay_content": "allowed_facts의 사실만을 사용해 작성한 에세이 초안 본문"
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
        temperature=0.3,
        max_completion_tokens=2000,
        endpoint="/api/essay/draft",
    )
    return _promote_nested_field(result, target_key="essay_content", drop_key="allowed_facts")


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
    style_guide = (
        "비유와 감정 과장을 덜어내고, 사건과 행동을 중심으로 간결하고 절제된 담백한 문체로 다듬으세요."
        if ("담백" in req.tone or "담담" in req.tone)
        else "감성 문체는 원문에 없는 풍경·감정·배경을 덧붙이는 것이 아니라, 원문과 사용자 수정본에 이미 있는 사실·감정의 문장 호흡과 여운만 부드럽게 다듬는 것입니다. 감성적인 분위기를 위해 새로운 묘사를 창작하지 마세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"

    system_prompt = f"""
    당신은 사용자의 수정 의도와 원문 사실관계를 완벽히 존중하는 에세이 전문 교정 편집자입니다.
    사용자가 '직접 수정한 현재 초안(current_draft)'을 바탕으로 요청한 문체, 목표 분량, 사용자 추가 요청에 맞게 에세이를 다시 작성해 주세요.

    [규칙 우선순위 — 규칙 간 충돌 시 1순위가 절대 우선]
    1순위: 사용자 수정본(current_draft) 및 원문 사실·부정 표현 100% 보존 (창작 절대 금지)
    2순위: 사용자 추가 요청 및 요청 문체({req.tone}) 준수
    3순위: 목표 분량({length_guide}) 준수

    [절대 규칙]
1. 사용자 수정본(current_draft)의 사실관계·의도·부정 표현 완벽 보존 (최우선):
- 사용자가 직접 수정하거나 추가한 문장, 행동, 생각(예: '서두르고 싶지 않았다', '다음 근무에도 이 메모를 가져가기로 했다', '부끄러웠다기보다 끝까지 읽었다는 안도감이 들었다')을 절대 누락하거나 다른 감정으로 바꾸지 마세요.
- 의미가 달라질 수 있는 부정 표현이나 상태 표현을 임의로 변경하지 마세요.
      · 나쁜 예 1: '짐을 다 풀지는 못했지만(미완료 상태)' -> '짐을 모두 풀지는 않았지만(의도적 미수행)'으로 변경 금지!
      · 나쁜 예 2: 원래 소재가 '포장 순서를 헷갈렸지만 메모를 보며 마쳤다'인데 -> '포장 순서를 헷갈리지 않고 마쳤다'처럼 사실관계를 반대로 서술 금지!
      · 나쁜 예 3: '부끄러웠다기보다 끝까지 읽었다는 안도감이 들었다'에 원문에 없는 '두려움이 밀려왔지만'을 추가하거나 감정의 초점을 변경 금지!
2. 목표 분량 충족 (목표: 공백 포함 {length_guide}):
- 현재 초안과 처음 고른 소재에 이미 들어 있는 사실, 행동의 과정, 명시된 생각의 흐름을 차분히 풀어내어 목표 분량({length_guide})에 맞추려 노력하세요. (동일한 문장의 기계적 반복 금지)
- 단, **분량을 채우기 위해 현재 초안과 소재에 없는 새로운 사건·인물·배경·감각·칭찬·교훈을 추가하는 것은 무조건 실패**입니다.
- 제공된 초안과 소재의 양이 적어 목표 분량에 못 미치더라도 절대 창작하지 말고, `preserved_facts` 범위 안에서만 자연스럽게 완결하세요.
3. 문체 조건 ({req.tone}):
- {style_guide}
4. 사용자 추가 요청 반영:
- '사용자 추가 요청'이 '없음'이 아닌 경우, 원문과 사용자 수정본의 사실관계를 왜곡하거나 새 사실을 창작하지 않는 선에서 해당 요청(수정 방향, 강조·삭제 요청, 어조 조정 등)을 충실히 반영하세요.
5. 반드시 아래 JSON 형식으로만 응답하세요.
- 먼저 `preserved_facts`에 반드시 지켜야 할 사용자 수정본·소재의 사실을 나열한 뒤, `retouched_content`는 오직 `preserved_facts`의 범위 안에서만 작성하세요.
    {{
        "preserved_facts": ["반드시 보존할 사용자 수정본 및 소재의 사실1", "사실2"],
        "retouched_content": "preserved_facts 범위 안에서만 수정한 에세이 본문"
    }}
    """

    user_prompt = f"""- 사용자가 수정한 현재 초안 (최우선 보존 기준):
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
        temperature=0.3,
        max_completion_tokens=2000,
        endpoint="/api/essay/retouch",
    )
    return _promote_nested_field(result, target_key="retouched_content", drop_key="preserved_facts")


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