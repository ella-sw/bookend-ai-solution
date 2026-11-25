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


def _clean_essay_text(text: str | None) -> str:
    """모델 응답 끝에 간혹 붙는 XML 찌꺼기 태그 제거"""
    if not text:
        return ""
    cleaned = re.sub(r"</?(?:essay_content|retouched_content|invoke)>\s*", "", text)
    return cleaned.strip()


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

    if target_key in ("essay_content", "retouched_content") and isinstance(merged.get(target_key), str):
        merged[target_key] = _clean_essay_text(merged[target_key])
    if isinstance(merged.get("title"), str):
        merged["title"] = _clean_essay_text(merged["title"])

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
    topics_str = "가족, 관계, 나·성장, 일·직업, 일상, 여행·장소, 음식, 취향·취미, 몸·건강, 자연·계절"
    system_prompt = f"""
    당신은 사용자의 일상 기록에서 글감을 추출하는 전문 AI 편집자입니다.
    반드시 아래 JSON 형식으로만 응답하세요. 다른 말은 덧붙이지 마세요.
    {{
        "title": "추출된 소재의 핵심을 담은 짧은 제목",
        "summary": "핵심 내용을 1문장으로 요약",
        "keywords": ["핵심단어1", "핵심단어2", "핵심단어3"],
        "topic_ids": ["선택된 주제1", "선택된 주제2"],
        "evidence": "소재 추출의 근거가 되는 원본 기록 내 문장 발췌"
    }}
    [1차 평가 필수 개선 및 서버 검증 규칙]
    1. 원문 충실성 (추론·과장·왜곡 절대 금지):
       - 원문에 명시되지 않은 감정이나 의미를 임의로 덧붙이지 마세요. (예: 의자를 내주어 감사했다는 글에 '따뜻한 순간' 추가 금지 / 비뚤어진 접시에 귤을 올려놓아 내가 만든 접시임이 실감 났다는 글에 '비뚤어진 가장자리를 통해 성취감을 느꼈다'라고 감정과 계기를 왜곡 금지)
       - 사건 발생 장소와 시간적 순서, 인과관계를 정확히 유지하세요. (예: '버스에서 내린 뒤 걸어가다가 목욕탕 간판을 봤다'를 '버스 정거장에서 간판을 봤다'로 왜곡 금지)
       - 기록에 '과정 -> 발견 -> 앞으로의 다짐/생각 변화'(예: 수면 시간 기록 -> 평일 수면 부족 발견 -> 평일 수면부터 살펴보려는 다짐)가 있다면 요약에 그 핵심 흐름과 다짐까지 빠짐없이 반영하세요.
    2. evidence (근거 문장):
       - 반드시 사용자의 원본 기록에 존재하는 문장을 글자 하나 바꾸지 말고 100% 그대로 발췌하세요.
       - 도입부의 사소한 문장이 아니라, 중심 사건과 생각/감정을 뒷받침하는 핵심 문장을 선택하세요.
    3. topic_ids (주제 분류 엄격 기준):
       - 반드시 다음 제공된 목록 중 내용에 정확히 부합하는 1~2개만 선택하세요: [{topics_str}]
       - 단순히 타인이나 소품이 등장했다는 이유만으로 주제나 키워드를 과도하게 확장하지 마세요.
    4. keywords (추천 매칭용 핵심 명사):
       - 조사 및 어미를 제거한 기본형 명사만 남기세요. (서술어가 포함된 구절 금지, '수면 부족'처럼 의미 보존에 필수적인 복합 명사는 허용)
       - 중심 내용과 무관한 도입부 단어, 원문에 없는 추상적 해석 단어, 핵심 의미가 없는 일반 시간 표현은 키워드에서 절대 제외하세요.
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
    avoid_str = "없음"
    system_prompt = f"""
    당신은 사용자의 일상과 기억을 자연스럽게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 글감을 구체화할 수 있는 '단 하나의 후속 질문'만 작성하세요.

    [1차 평가 필수 개선 및 절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
       {{"next_question": "생성된 단일 질문 내용"}}
    2. 단일 초점 및 복합 질문 절대 금지 (가장 중요):
       - 한 번에 오직 '한 가지'만 물어보세요. 물음표(?)는 문장 끝에 딱 1개만 사용하세요.
       - 한 문장 안에 두 가지 질문을 접속사로 이어 붙이지 마세요. (나쁜 예: "물에 떠 있던 느낌이 어땠는지, 그리고 어떤 의미였는지 말해줄 수 있나요?" -> 좋은 예: "물에 처음 떠 있었던 짧은 순간, 몸에 전해지던 감각은 어땠나요?")
    3. 아래 거절된 질문과 표면적 단어만 바꾼 유사 질문을 생성하지 말고 완전히 새로운 측면에서 질문하세요:
       - {avoid_str}
    4. 사용자 답변 충실성 및 단정 금지:
       - 사용자가 언급하지 않은 감정, 실패, 두려움, 피로, 자신감 부족 등을 임의로 단정하거나 전제하지 마세요.
       - 사용자가 자세히 쓰고 싶지 않다고 한 이유는 다시 캐묻지 말고, 남기고 싶어 하는 장면이나 행동으로 질문을 전환하세요.
    5. 감각 및 장면 구체화 유도:
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
    avoid_str = "\n       - ".join(map(str, req.rejected_questions)) if req.rejected_questions else "없음"
    system_prompt = f"""
    당신은 사용자의 일상과 기억을 자연스럽게 이끌어내는 전문 인터뷰어입니다.
    사용자의 이전 대화 기록을 분석하여, 글감을 구체화할 수 있는 '단 하나의 후속 질문'만 작성하세요.

    [1차 평가 필수 개선 및 절대 규칙]
    1. 반드시 아래 JSON 형식으로만 응답할 것.
       {{"next_question": "생성된 단일 질문 내용"}}
    2. 단일 초점 및 복합 질문 절대 금지 (가장 중요):
       - 한 번에 오직 '한 가지'만 물어보세요. 물음표(?)는 문장 끝에 딱 1개만 사용하세요.
       - 한 문장 안에 두 가지 질문을 접속사로 이어 붙이지 마세요. (나쁜 예: "물에 떠 있던 느낌이 어땠는지, 그리고 어떤 의미였는지 말해줄 수 있나요?" -> 좋은 예: "물에 처음 떠 있었던 짧은 순간, 몸에 전해지던 감각은 어땠나요?")
    3. 아래 거절된 질문과 표면적 단어만 바꾼 유사 질문을 생성하지 말고 완전히 새로운 측면에서 질문하세요:
       - {avoid_str}
    4. 사용자 답변 충실성 및 단정 금지:
       - 사용자가 언급하지 않은 감정, 실패, 두려움, 피로, 자신감 부족 등을 임의로 단정하거나 전제하지 마세요.
       - 사용자가 자세히 쓰고 싶지 않다고 한 이유는 다시 캐묻지 말고, 남기고 싶어 하는 장면이나 행동으로 질문을 전환하세요.
    5. 감각 및 장면 구체화 유도:
       - 사용자가 어떤 장면을 어떻게 설명할지 막막해한다면, 추상적인 '감정'이나 '생각/의미'를 묻지 말고 눈에 보인 모양, 빛, 크기, 소리, 행동 등 구체적인 감각 요소 중 딱 한 가지를 쉽게 떠올릴 수 있도록 질문하세요.
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
    direction: str | None = ""


@app.post("/api/essay/draft")
def generate_draft(req: DraftRequest):
    length_guide = "300자에서 500자 사이" if ("단문" in req.length or "짧게" in req.length) else "1000자에서 1500자 사이"
    is_plain_tone = any(k in (req.tone or "").lower() for k in ("담백", "담담", "plain", "calm"))

    style_guide = (
        "문장을 짧고 간결하게 끊어 쓰세요. 여운을 남기는 감상 문장이나 부연 설명은 줄이고, 일어난 일과 행동, 생각의 핵심만 사실 위주로 건조하고 깔끔하게 적으세요. (예: '~했다. ~이었다.' 위주의 담백한 호흡)"
        if is_plain_tone
        else "원문에 이미 등장한 감각·상황·생각의 결을 길고 부드러운 호흡으로 풀어내세요. 사건·인물·배경은 새로 지어내지 않되, 그 순간의 분위기와 마음의 여운이 천천히 스며들도록 서정적이고 이어지는 문장으로 다듬으세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"
    direction_text = (req.direction or "").strip() or "없음"

    system_prompt = f"""
    당신은 사용자의 실제 기록만을 바탕으로 에세이를 작성하는 전문 작가입니다.

    [1차 평가 필수 개선 및 절대 규칙]
    1. 원문 충실성 및 창작(환각) 절대 금지 (가장 중요):
       - 제공된 '소재'에 없는 새로운 사건, 배경, 인물, 사물의 외관이나 조명, 주변 사람들을 절대 지어내지 마세요. (예: 대학 시절 구매 목적, 친구와의 연주, 캔버스와 특정 물감 색상, 빵집의 나무 문과 조명 등 창작 금지)
       - 사용자가 언급하지 않은 감정(두려움, 긴장, 포기하고 싶은 유혹, 후회, 성취감, 자유 등)이나 사건 간의 임의적 인과관계(예: 쉬었기 때문에 봄에 산책할 수 있었다 등)를 추가하지 마세요.
       - 글 마지막에 원문에 없는 교훈, 인생에 대한 깨달음, 거창한 다짐이나 향후 계획을 덧붙여 마무리하지 마세요. 오직 사용자가 기록한 마지막 생각이나 행동에서 글을 맺으세요.
    2. 소재 연결 및 글의 방향:
       - 사용자가 제시한 '글의 방향'을 중심으로 전개하되, 서로 다른 시기나 날의 일을 같은 날 일어난 일처럼 합치지 마세요.
    3. 문체 조건 ({req.tone}):
       - {style_guide}
    4. 분량 조건 (공백 포함 **{length_guide}** 엄격 준수):
       - 본문 글자 수가 공백을 포함하여 반드시 **{length_guide}** 안에 들어와야 합니다. (500자 초과 또는 300자/1000자 미달 금지)
       - 분량을 채울 때는 새로운 사실을 창작하지 말고, 원문에 제시된 상황의 맥락과 행동의 흐름, 명시된 생각의 결을 차분하고 밀도 있게 풀어서 서술하세요.
    5. 반드시 아래 JSON 형식으로만 응답하세요.
       {{
           "title": "에세이 제목",
           "essay_content": "작성된 에세이 초안 본문"
       }}
    """

    user_prompt = (
        f"- 글의 방향: {direction_text}\n"
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
        temperature=0.5,
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
    current_title: str | None = ""
    direction: str | None = ""


@app.post("/api/essay/retouch")
def retouch_draft(req: RetouchRequest):
    length_guide = "1000자에서 1500자 사이" if ("장문" in req.length or "길게" in req.length) else "300자에서 500자 사이"
    is_plain_tone = any(k in (req.tone or "").lower() for k in ("담백", "담담", "plain", "calm"))

    style_guide = (
        "문장을 짧고 간결하게 끊어 쓰세요. 여운을 남기는 감상 문장이나 부연 설명은 줄이고, 일어난 일과 행동, 생각의 핵심만 사실 위주로 건조하고 깔끔하게 적으세요. (예: '~했다. ~이었다.' 위주의 담백한 호흡)"
        if is_plain_tone
        else "원문에 이미 등장한 감각·상황·생각의 결을 길고 부드러운 호흡으로 풀어내세요. 사건·인물·배경은 새로 지어내지 않되, 그 순간의 분위기와 마음의 여운이 천천히 스며들도록 서정적이고 이어지는 문장으로 다듬으세요."
    )
    user_request_text = (req.user_request or "").strip() or "없음"
    direction_line = (
        f"\n- 글의 방향: {req.direction.strip()}"
        if (req.direction and req.direction.strip())
        else ""
    )

    system_prompt = f"""
    당신은 사용자의 수정 의도와 원문 사실관계를 완벽히 존중하는 에세이 전문 교정 편집자입니다.
    사용자가 '직접 수정한 현재 초안(current_draft)'을 바탕으로 요청한 문체와 목표 분량에 맞게 에세이를 다시 작성해 주세요.

    [1차 평가 필수 개선 및 절대 규칙]
    1. 사용자 수정본(current_draft)의 사실관계·의도·부정 표현 완벽 보존 (가장 중요):
       - 사용자가 직접 수정하거나 추가한 문장, 행동, 생각(예: '서두르고 싶지 않았다', '다음 근무에도 이 메모를 가져가기로 했다', '부끄러웠다기보다 끝까지 읽었다는 안도감이 들었다')을 절대 누락하거나 다른 감정으로 바꾸지 마세요.
       - 의미가 달라질 수 있는 부정 표현이나 상태 표현을 임의로 변경하지 마세요.
         - 나쁜 예 1: '짐을 다 풀지는 못했지만(미완료 상태)' -> '짐을 모두 풀지는 않았지만(의도적 미수행)'으로 변경 금지!
         - 나쁜 예 2: 원래 소재가 '포장 순서를 헷갈렸지만 메모를 보며 마쳤다'인데 -> '포장 순서를 헷갈리지 않고 마쳤다'처럼 사실관계를 반대로 서술 금지!
         - 나쁜 예 3: '부끄러웠다기보다 끝까지 읽었다는 안도감이 들었다'에 원문에 없는 '두려움이 밀려왔지만'을 추가하거나 감정의 초점을 변경 금지!
    2. 목표 분량 충족 (공백 포함 **{length_guide}**):
       - 단순히 현재 초안의 조사나 어미만 살짝 바꿔서 100자 내외로 짧게 끝내지 마세요!
       - 반드시 공백 포함 **{length_guide}**의 완결된 에세이 분량으로 자연스럽게 확장하여 작성해야 합니다.
       - 분량을 확장할 때는 새로운 사건·인물·배경·칭찬·교훈을 절대 지어내지 말고, 현재 초안과 처음 고른 소재에 들어 있는 사실, 행동의 구체적 과정, 그 순간의 감각과 명시된 생각의 흐름을 문맥에 맞게 차분히 풀어서 서술하세요. (동일한 문장을 기계적으로 반복하는 것은 피하세요.)
    3. 문체 조건 ({req.tone}):
       - {style_guide}
       - 중요: 보존해야 할 대상은 '사실관계·부정 표현·사용자의 의도'이지, 기존 문장 표현 자체가 아닙니다. 현재 초안(current_draft)과 제목을 그대로 복사해 반환하지 말고, 요청된 문체({req.tone})가 분명히 드러나도록 문장 구조와 어조를 새롭게 다듬어 작성하세요.
    4. 반드시 아래 JSON 형식으로만 응답하세요.
       {{
           "title": "수정된 에세이 제목",
           "retouched_content": "수정된 에세이 본문 (공백 포함 {length_guide})"
       }}
    """

    user_prompt = f"""- 사용자가 수정한 현재 초안 (최우선 보존 기준):
    {req.current_draft}

- 현재 제목: {(req.current_title or "").strip() or "없음"}

- 처음 고른 소재:
    {req.selected_materials}

- 적용할 문체: {req.tone}
- 목표 길이: 공백 포함 {length_guide} ({req.length}){direction_line}
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
        temperature=0.6,
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
       - 서로 무관한 단편적 사실들의 나열(예: 은행 비밀번호 변경 + 냉동 만두 먹음 + 충전선 주움 / 프린터 토너 교체 + 점심시간 변경 공지 + 비밀번호 변경 등)이고 추가적인 감정·인과관계가 없다면 제안을 보류(`"can_suggest": false`, 나머지 항목은 반드시 `null`)하세요.
    2. 소재 충실성 및 과도한 의미 부여 금지:
       - 원문에 명시되지 않은 감정이나 거창한 심리적 의미를 단정하지 마세요.
       - 서로 다른 물건을 하나로 합치지 말고, 명시되지 않은 시간순 인과관계를 지어내지 마세요.
    3. 전체 소재를 아우르는 정확한 제목(`title`), 구조 방향(`direction`), 실제 소재 기반 추천 이유(`reason`)를 작성하세요.
    4. 반드시 아래 JSON 형식으로만 응답하세요.
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