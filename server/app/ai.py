"""AI connection point (C's part).

The API code only calls the interfaces below (`QuestionAI`, `MaterialAI`, `EssayAI`, `SuggestAI`).
To use a real model, C implements classes with the same methods and returns
them from `get_*_ai()` when `AI_PROVIDER=openai`.
Nothing else changes.

Rules the real implementation must keep:
R05 QuestionAI
- next_question: one question at a time, based on the conversation so far.
  Never invent experiences or feelings that are not in the answers.
  Do not repeat the direction of questions in `avoid` (replaced questions).
- daily_questions: 30 questions generated once per date and shared across requests.
R28 MaterialAI
- extract_material: 0 or 1 material from what the user wrote (`source.user_text()`).
  No writing material -> return `material=None` (소재 없음); never an empty material.
- Never add experiences or feelings that are not in the text.
- `evidence` must be a sentence copied from `source.user_text()` (the server checks).
- `topics` are names from the given list (one or more).
- Only the user's writing is analysed: for Q&A the answers, not the AI's questions.
R07 EssayAI
- write_essay: one essay (title + body) from the chosen materials, in order, with the
  direction, style (감성적 / 담백함) and length. Never add experiences that are not in
  the materials (or, for 다시 만들기, in `base_body`).
- Body length = characters of the body only, spaces included, title excluded; aim for
  `min_chars`–`max_chars`. If `last_char_count` is set, the previous try was out of range.
- 다시 만들기: rewrite `base_title` / `base_body` (the text the user was looking at), keeping
  what is already in it; materials are the essay's remaining (not deleted) materials.
R30 SuggestAI
- suggest: from one topic's confirmed materials, a writing suggestion (title, direction,
  reason) and the materials to use (ids from the given list, at least `min_materials`).
  If they don't fit together well, return `suggestion=None` (제안하지 않음).
- The reason explains the grouping with the materials' actual content.
"""

import asyncio
import json
import os
import re
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Protocol

from dotenv import load_dotenv
from openai import OpenAI

from app.config import get_settings

load_dotenv()


@dataclass
class Turn:
    question: str
    answer: str | None


@dataclass
class AIText:
    text: str
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class AIQuestions:
    questions: list[str] = field(default_factory=list)
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class ExtractSource:
    """A saved record to analyse (R28)."""
    type: str  # free / qna
    title: str | None
    body: str | None  # free writing only
    turns: list[Turn] = field(default_factory=list)  # Q&A only: answered pairs in order

    def user_text(self) -> str:
        """What the user wrote. `evidence` must come from here."""
        if self.type == "qna":
            return "\n".join(t.answer for t in self.turns if t.answer)
        return self.body or ""


@dataclass
class ExtractedMaterial:
    summary: str  # 요약 한 줄
    evidence: str  # 근거 문장 (원문에 있는 문장)
    keywords: list[str]
    topics: list[str]  # names from the topic list
    title: str | None = None


@dataclass
class AIExtract:
    material: ExtractedMaterial | None  # None = 소재 없음
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class MaterialInput:
    """One chosen material for an essay (ERD rule 11)."""
    title: str | None
    summary: str | None
    evidence: str | None
    original: str  # 원본 기록, up to 1,500 characters


@dataclass
class DraftInput:
    materials: list[MaterialInput]  # in the chosen order
    direction: str | None
    style: str  # 감성적 / 담백함
    length: str  # short / long
    min_chars: int
    max_chars: int
    base_title: str | None = None  # 다시 만들기: the text being rewritten
    base_body: str | None = None
    last_char_count: int | None = None  # set on the automatic retry (out of range)
    user_request: str | None = None  # 사용자 요청 (essays.request, 선택·200자)


@dataclass
class AIEssay:
    title: str
    body: str
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class SuggestMaterial:
    id: str
    title: str | None
    summary: str | None
    evidence: str | None
    keywords: list[str]


@dataclass
class AISuggestion:
    title: str  # 글 제목 제안
    direction: str  # 소재들을 어떻게 엮을지 한두 문장
    reason: str  # 왜 이 소재들이 묶였는지
    material_ids: list[str]  # 사용할 소재 (주어진 목록에서, 쓸 순서대로)


@dataclass
class AISuggest:
    suggestion: AISuggestion | None  # None = 제안하지 않음
    input_tokens: int | None = None
    output_tokens: int | None = None


class AIError(Exception):
    """The AI call failed or returned something unusable."""


class QuestionAI(Protocol):
    async def next_question(self, turns: list[Turn], avoid: list[str]) -> AIText:
        """Next follow-up question. `turns` are answered Q&A pairs in order."""

    async def daily_questions(self, for_date: date) -> AIQuestions:
        """The 30 shared first questions for `for_date`."""


class MaterialAI(Protocol):
    async def extract_material(self, source: ExtractSource, topics: list[str]) -> AIExtract:
        """R28: 0 or 1 material from a saved record. `topics` = the 10 topic names."""


class EssayAI(Protocol):
    async def write_essay(self, inp: DraftInput) -> AIEssay:
        """R07: one essay (초안 or 다시 만들기)."""


class SuggestAI(Protocol):
    async def suggest(
        self, topic: str, materials: list[SuggestMaterial], min_materials: int
    ) -> AISuggest:
        """R30: one writing suggestion for a topic, or None."""


# ==========================================
# 모델 라우팅 및 JSON/텍스트 파싱 헬퍼 (main.py 최종 로직 반영)
# ==========================================
_LOGIC_MODEL = os.getenv("LOGIC_LLM_MODEL", os.getenv("LLM_MODEL", "gpt-5.4"))
_ESSAY_MODEL = os.getenv("ESSAY_LLM_MODEL", os.getenv("LLM_MODEL", "claude-sonnet-5"))


def _build_logic_client() -> OpenAI:
    api_key = (
        os.getenv("LOGIC_API_KEY")
        or os.getenv("ELICE_API_KEY")
        or os.getenv("OPENAI_API_KEY")
    )
    base_url = os.getenv("LOGIC_BASE_URL") or os.getenv("LLM_BASE_URL")
    return OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)


def _build_essay_client() -> OpenAI:
    api_key = (
        os.getenv("ESSAY_API_KEY")
        or os.getenv("ELICE_API_KEY")
        or os.getenv("OPENAI_API_KEY")
    )
    base_url = os.getenv("ESSAY_BASE_URL") or os.getenv("LLM_BASE_URL")
    return OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)


def _unwrap_target_key(data: object, target_key: str) -> dict | None:
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


def _parse_json_response(
    raw_content: str | None,
    target_key: str | None = None,
    drop_key: str | None = None,
) -> dict:
    raw = (raw_content or "").strip()
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw)
    data = json.loads(cleaned, strict=False)
    if not isinstance(data, dict):
        return {}
    if target_key:
        unwrapped = _unwrap_target_key(data, target_key)
        if isinstance(unwrapped, dict):
            for k, v in data.items():
                if k not in unwrapped:
                    unwrapped[k] = v
            data = unwrapped
    if drop_key:
        data.pop(drop_key, None)
    if target_key in ("essay_content", "retouched_content") and isinstance(data.get(target_key), str):
        data[target_key] = _clean_essay_text(data[target_key])
    return data


# ==========================================
# [C 작업 영역] 실제 AI 구현 클래스
# ==========================================
class OpenAIQuestionAI:
    def __init__(self):
        self.client = _build_logic_client()
        self.logic_model = _LOGIC_MODEL
        self._daily_cache: dict[date, list[str]] = {}
        self._daily_lock = asyncio.Lock()

    async def next_question(self, turns: list[Turn], avoid: list[str]) -> AIText:
        avoid_str = "\n- ".join(avoid) if avoid else "없음"
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

        chat_history = []
        for t in turns:
            chat_history.append({"role": "assistant", "content": t.question})
            if t.answer:
                chat_history.append({"role": "user", "content": t.answer})

        messages = [{"role": "system", "content": system_prompt}] + chat_history

        try:
            response = await asyncio.to_thread(
                self.client.chat.completions.create,
                model=self.logic_model,
                messages=messages,
                response_format={"type": "json_object"},
                max_completion_tokens=512,
            )
            result = _parse_json_response(
                response.choices[0].message.content, target_key="next_question"
            )
            return AIText(
                text=result.get("next_question", "질문을 생성하지 못했습니다."),
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            )
        except Exception as e:
            raise AIError(f"OpenAI API 실패: {str(e)}")

    async def daily_questions(self, for_date: date) -> AIQuestions:
        if for_date in self._daily_cache:
            return AIQuestions(
                questions=list(self._daily_cache[for_date]),
                input_tokens=0,
                output_tokens=0,
            )

        async with self._daily_lock:
            if for_date in self._daily_cache:
                return AIQuestions(
                    questions=list(self._daily_cache[for_date]),
                    input_tokens=0,
                    output_tokens=0,
                )

            system_prompt = """
            당신은 사용자의 일상 기록과 에세이 글감을 끌어내는 전문 인터뷰어입니다.
            오늘 사용자가 부담 없이 첫 문장을 시작할 수 있도록 '서로 다른 주제의 첫 질문 30개'를 생성하세요.

            [절대 규칙]
            1. 반드시 아래 JSON 형식으로만 응답하세요.
               {"questions": ["질문1", "질문2", ..., "질문30"]}
            2. `questions` 배열에는 중복 없이 정확히 30개의 한국어 질문만 담으세요.
            3. 모든 질문은 한 번에 한 가지만 묻는 단일 질문이어야 합니다. (문장 끝 물음표(?) 1개만 사용, 접속사로 두 질문 이어 붙이기 금지)
            4. 가족, 관계, 나·성장, 일·직업, 일상, 여행·장소, 음식, 취향·취미, 몸·건강, 자연·계절 등 다양한 주제를 골고루 섞으세요.
            5. 사용자가 겪지 않았을 부정적 경험이나 과도한 감정을 전제하지 말고, 누구나 떠올릴 수 있는 구체적 장면·감각·순간을 따뜻하고 담백하게 물어보세요.
            """

            user_prompt = (
                f"기준 날짜: {for_date.isoformat()}\n"
                "이 날짜에 모든 사용자에게 공통으로 제공할 서로 다른 첫 질문 30개를 생성해 주세요."
            )

            try:
                response = await asyncio.to_thread(
                    self.client.chat.completions.create,
                    model=self.logic_model,
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": user_prompt},
                    ],
                    response_format={"type": "json_object"},
                    temperature=0.7,
                )
                raw = _parse_json_response(
                    response.choices[0].message.content, target_key="questions"
                )
                questions = [
                    str(q).strip()
                    for q in raw.get("questions", [])
                    if isinstance(q, str) and str(q).strip()
                ]

                deduped = list(dict.fromkeys(questions))
                if len(deduped) < 30:
                    for fallback_q in _STUB_DAILY:
                        if fallback_q not in deduped:
                            deduped.append(fallback_q)
                        if len(deduped) == 30:
                            break
                final_questions = deduped[:30]

                self._daily_cache.clear()
                self._daily_cache[for_date] = final_questions

                return AIQuestions(
                    questions=list(final_questions),
                    input_tokens=response.usage.prompt_tokens if response.usage else 0,
                    output_tokens=response.usage.completion_tokens if response.usage else 0,
                )
            except Exception:
                shift = for_date.toordinal() % len(_STUB_DAILY)
                fallback = _STUB_DAILY[shift:] + _STUB_DAILY[:shift]
                return AIQuestions(questions=fallback, input_tokens=0, output_tokens=0)


class OpenAIMaterialAI:
    def __init__(self):
        self.client = _build_logic_client()
        self.logic_model = _LOGIC_MODEL

    async def extract_material(self, source: ExtractSource, topics: list[str]) -> AIExtract:
        user_text = source.user_text().strip()
        if not user_text:
            return AIExtract(material=None, input_tokens=0, output_tokens=0)

        topics_str = ", ".join(topics) if topics else "가족, 관계, 나·성장, 일·직업, 일상, 여행·장소, 음식, 취향·취미, 몸·건강, 자연·계절"
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

        try:
            response = await asyncio.to_thread(
                self.client.chat.completions.create,
                model=self.logic_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_text},
                ],
                response_format={"type": "json_object"},
                temperature=0.3,
                max_completion_tokens=1024,
            )
            result = _parse_json_response(
                response.choices[0].message.content, target_key="evidence"
            )
            if not result.get("summary") or not result.get("evidence"):
                return AIExtract(
                    material=None,
                    input_tokens=response.usage.prompt_tokens if response.usage else 0,
                    output_tokens=response.usage.completion_tokens if response.usage else 0,
                )

            raw_topics = result.get("topic_ids")
            if isinstance(raw_topics, list):
                parsed_topics = [str(t).strip() for t in raw_topics if str(t).strip()]
            elif result.get("topic"):
                parsed_topics = [str(result.get("topic")).strip()]
            else:
                parsed_topics = []

            material = ExtractedMaterial(
                title=result.get("title", ""),
                summary=result.get("summary", ""),
                evidence=result.get("evidence", ""),
                keywords=result.get("keywords", []) if isinstance(result.get("keywords"), list) else [],
                topics=parsed_topics,
            )
            return AIExtract(
                material=material,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            )
        except Exception as e:
            raise AIError(f"Material 추출 실패: {str(e)}")


class OpenAIEssayAI:
    def __init__(self):
        self.client = _build_essay_client()
        self.essay_model = _ESSAY_MODEL

    async def write_essay(self, inp: DraftInput) -> AIEssay:
        if inp.base_body:
            return await self._retouch_essay(inp)

        length_guide = f"{inp.min_chars}자에서 {inp.max_chars}자 사이"
        is_plain_tone = "담백" in inp.style or "담담" in inp.style
        style_guide = (
            "과도한 수사나 감정의 과장은 덜어내되, 소재에 담긴 행동과 생각의 흐름을 차분하고 자연스러운 에세이 문장으로 풀어내세요. 원문 문장을 그대로 이어 붙이기만 하지 마세요."
            if is_plain_tone
            else "소재에 담긴 상황과 생각, 감각의 여운을 살려 문장의 호흡과 연결을 부드럽게 다듬으세요. 단, 원문에 없는 새로운 사건, 인물, 장소, 날씨·조명 같은 외부 사실은 지어내지 마세요."
        )
        user_request_text = (inp.user_request or "").strip() or "없음"
        direction_text = (inp.direction or "").strip() or "없음"
        retry_note = (
            f"\n- 직전 생성 글자 수: {inp.last_char_count}자 (목표 범위 {length_guide}에 맞춰 조절하세요)"
            if inp.last_char_count is not None
            else ""
        )

        system_prompt = f"""
        당신은 사용자의 실제 기록을 바탕으로 분량과 사실 관계를 정확히 지키는 에세이 작가입니다.
        가장 중요한 원칙은 '원문 사실 100% 보존'이며, 그 범위 안에서 반드시 목표 분량(공백 포함 {length_guide}, 제목 제외 본문 기준)에 맞춰 에세이를 작성하세요.

        [규칙 우선순위 — 충돌 시 상위 원칙이 절대 우선]
        1순위: 원문 사실·부정 표현·시점·순서 100% 보존 (창작·왜곡·임의 추론 절대 금지)
        2순위: 목표 분량(공백 포함 {length_guide}) 준수
        3순위: 사용자 추가 요청, 글 방향 및 요청 문체({inp.style}) 반영

        [작성 기준]
        1. 원문 왜곡·창작 절대 금지 (최우선):
           - 제공된 소재에 없는 사건, 인물, 장소, 소품, 날씨, 계절, 시간대, 조명, 주변 사람의 표정·반응을 절대 지어내지 마세요.
           - '하지 않았다', '못했다', '뻔했다', '~라기보다' 같은 부정·미완료·강도 표현을 긍정이나 다른 감정·의도로 바꾸지 마세요.
             (예: '빵을 사지는 않았다' -> '빵을 샀다' 금지 / '짐을 다 풀지 못했다' -> '일부러 풀지 않았다' 금지 / '부끄러웠다기보다 안도감이 들었다' -> '부끄러웠다' 금지)
           - 서로 다른 날이나 시기의 소재를 같은 날 일어난 일처럼 합치지 말고, 원문에 없는 교훈·다짐·인생 깨달음으로 글을 마무리하지 마세요.

        2. 목표 분량({length_guide}) 달성 기준 (공백 포함, 본문 기준):
           - 임의 창작이나 같은 의미의 단순 반복 없이, 아래 방식으로 분량을 조절하세요:
             · 짧은 목표 구간(예: 300~500자): 핵심 상황과 생각 위주로 군더더기 없이 2~3문단으로 구성합니다.
             · 긴 목표 구간(예: 1,000~1,500자): 소재에 제시된 상황·행동 과정·생각의 흐름을 단계별로 세세히 풀어 4~5문단으로 구성합니다.
           - 분량이 모자랄 때는 원문에 있는 행동 과정과 생각의 맥락을 차분히 풀어서 채우고, 분량이 넘칠 때는 중복 표현과 장황한 수식을 줄여 목표 범위({length_guide}) 안에 맞추세요.
           - 단, 원문 정보량이 매우 적어 허구 없이 목표 분량에 닿기 어려운 경우에도 새 사실을 지어내지 말고, 허용된 사실 안에서 자연스럽게 완결하세요.

        3. 문체, 글 방향 및 사용자 추가 요청 반영:
           - 요청 문체({inp.style}): {style_guide}
           - 글 방향({direction_text})이 '없음'이 아니면 원문 사실관계를 해치지 않는 범위에서 반영하세요.
           - 사용자 추가 요청({user_request_text})이 '없음'이 아니면 원문 사실관계를 해치지 않는 범위에서 반영하세요.

        4. 출력 형식 및 최종 점검:
           - 출력 전 본문의 공백 포함 글자 수가 목표 분량({length_guide})에 들어오는지, 원문 왜곡과 표현 반전이 없는지 확인하세요.
           - 제목, XML 태그, 마크다운 기호, 코드블록, 부연 설명 없이 반드시 아래 JSON 형식으로만 응답하세요.
             {{
                 "title": "에세이 제목",
                 "essay_content": "에세이 초안 본문"
             }}
        """

        materials_info = []
        for m in inp.materials:
            materials_info.append(
                f"- 제목: {m.title}\n  요약: {m.summary}\n  근거: {m.evidence}\n  원본: {m.original}"
            )
        user_prompt = (
            f"- 요청 문체: {inp.style}\n"
            f"- 목표 분량: 공백 포함 {length_guide}\n"
            f"- 사용자 추가 요청: {user_request_text}{retry_note}\n"
            f"- 소재 목록:\n" + "\n".join(materials_info)
        )

        try:
            response = await asyncio.to_thread(
                self.client.chat.completions.create,
                model=self.essay_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.35,
                max_completion_tokens=2000,
            )
            result = _parse_json_response(
                response.choices[0].message.content,
                target_key="essay_content",
            )
            body = _clean_essay_text(result.get("essay_content") or result.get("body") or "")
            title = _clean_essay_text(
                result.get("title")
                or (inp.materials[0].title if inp.materials else None)
                or "오늘의 글"
            ) or "오늘의 글"
            return AIEssay(
                title=title,
                body=body,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            )
        except Exception as e:
            raise AIError(f"Essay 초안 생성 실패: {str(e)}")

    async def _retouch_essay(self, inp: DraftInput) -> AIEssay:
        length_guide = f"{inp.min_chars}자에서 {inp.max_chars}자 사이"
        is_plain_tone = "담백" in inp.style or "담담" in inp.style
        style_guide = (
            "불필요한 과장이나 수사는 줄이되, 현재 초안과 소재의 흐름을 간결하고 차분한 문장으로 자연스럽게 다듬으세요."
            if is_plain_tone
            else "현재 초안과 소재에 담긴 생각과 감각의 여운을 살려 문장 호흡을 부드럽게 다듬되, 없는 사건·인물·장소·배경을 지어내지 마세요."
        )
        user_request_text = (inp.user_request or "").strip() or "없음"
        direction_text = (inp.direction or "").strip() or "없음"
        retry_note = (
            f"\n- 직전 생성 글자 수: {inp.last_char_count}자 (목표 범위 {length_guide}에 맞춰 조절하세요)"
            if inp.last_char_count is not None
            else ""
        )

        system_prompt = f"""
        당신은 사용자가 수정한 현재 초안(current_draft)과 처음 고른 소재를 바탕으로, 분량과 사실관계를 정확히 지키며 에세이를 다시 다듬는 전문 편집자입니다.
        가장 중요한 원칙은 '사용자 수정 의도와 원문 사실 100% 보존'이며, 그 범위 안에서 반드시 목표 분량(공백 포함 {length_guide}, 제목 제외 본문 기준)에 맞춰 자연스러운 에세이로 재구성하세요.

        [규칙 우선순위 — 충돌 시 상위 원칙이 절대 우선]
        1순위: 사용자 수정본(current_draft) 및 원문 사실·부정 표현·시점 100% 보존 (창작·왜곡·임의 추론 절대 금지)
        2순위: 목표 분량(공백 포함 {length_guide}) 준수
        3순위: 사용자 추가 요청, 글 방향 및 적용 문체({inp.style}) 반영

        [작성 기준]
        1. 사용자 수정본 및 원문 사실·부정 표현 보존 (최우선):
           - 사용자가 현재 초안(current_draft)에서 수정하거나 덧붙인 문장, 생각, 의도를 누락하거나 원래 소재 내용으로 되돌리지 마세요.
           - '하지 않았다', '못했다', '뻔했다', '~라기보다' 같은 부정·미완료·강도 표현을 긍정이나 다른 감정·의도로 바꾸지 마세요.
             (예: '짐을 다 풀지 못했다' -> '일부러 풀지 않았다' 금지 / '부끄러웠다기보다 안도감이 들었다' -> '부끄러웠다' 금지)
           - 현재 초안과 처음 고른 소재에 없는 새로운 사건, 인물, 장소, 소품, 날씨, 배경 묘사, 거창한 교훈·인생 다짐을 절대 지어내지 마세요.

        2. 목표 분량({length_guide}) 달성 기준 (공백 포함, 본문 기준):
           - 현재 초안이 짧더라도 없는 사실을 지어내거나 같은 문장을 단순 반복하지 말고, 아래 방식으로 목표 분량({length_guide})을 안정적으로 채우세요:
             ① 초안과 소재의 맥락 결합: 현재 초안의 수정 방향을 최우선으로 유지하되, 처음 고른 소재에 이미 들어 있는 세부 행동·상황·생각의 흐름을 자연스럽게 녹여 호흡을 넓힙니다.
             ② 행동·생각의 순차 전개: 짧게 압축된 문장을 상황의 앞뒤 흐름과 명시된 생각의 결에 따라 한 호흡씩 차분히 풀어 서술합니다.
             ③ 문단 구성: 짧은 목표 구간(예: 300~500자)은 2~3문단, 긴 목표 구간(예: 1,000~1,500자)은 4~5문단으로 나누고 문단 사이는 줄바꿈(\n\n)으로 구분합니다.
           - 분량이 넘칠 때는 중복 표현과 장황한 수식을 덜어 목표 범위 안에 맞추세요.
           - 단, 현재 초안과 소재의 정보량이 매우 적어 허구 없이 목표 분량에 닿기 어려운 경우에도 창작하지 말고, 허용된 사실 안에서 자연스럽게 완결하세요.

        3. 문체, 글 방향 및 사용자 추가 요청 반영:
           - 적용할 문체({inp.style}): {style_guide}
           - 감성 문체라도 없는 배경·풍경·감정을 덧붙이지 말고, 기존 사실과 감각의 문장 호흡·여운만 부드럽게 다듬으세요.
           - 글 방향({direction_text})이 '없음'이 아니면 사실관계를 해치지 않는 범위에서 반영하세요.
           - 사용자 추가 요청({user_request_text})이 '없음'이 아니면 원문과 사용자 수정본의 사실관계를 해치지 않는 범위에서 충실히 반영하세요.

        4. 출력 형식 및 최종 점검:
           - 출력 전 본문의 공백 포함 글자 수가 목표 분량({length_guide})에 들어오는지, 사용자 수정 의도 누락이나 부정 표현 반전이 없는지 스스로 점검하세요.
           - 제목, XML 태그, 마크다운 기호, 코드블록, 부연 설명 없이 반드시 아래 JSON 형식으로만 응답하세요.
             {{
                 "title": "다듬어진 에세이 제목",
                 "retouched_content": "다듬어진 에세이 본문"
             }}
        """

        materials_info = []
        for m in inp.materials:
            materials_info.append(
                f"- 제목: {m.title}\n  요약: {m.summary}\n  근거: {m.evidence}\n  원본: {m.original}"
            )
        user_prompt = f"""- 사용자가 수정한 현재 초안:
    {inp.base_body}

- 현재 제목: {inp.base_title or '없음'}

- 처음 고른 소재:
    {chr(10).join(materials_info)}

- 적용할 문체: {inp.style}
- 목표 길이: 공백 포함 {length_guide} ({inp.length}){retry_note}
- 사용자 추가 요청: {user_request_text}
    """

        try:
            response = await asyncio.to_thread(
                self.client.chat.completions.create,
                model=self.essay_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                temperature=0.35,
                max_completion_tokens=2000,
            )
            result = _parse_json_response(
                response.choices[0].message.content,
                target_key="retouched_content",
            )
            body = _clean_essay_text(result.get("retouched_content") or result.get("body") or "")
            title = _clean_essay_text(result.get("title") or inp.base_title or "오늘의 글") or "오늘의 글"
            return AIEssay(
                title=title,
                body=body,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            )
        except Exception as e:
            raise AIError(f"Essay 다시 만들기 실패: {str(e)}")


class OpenAISuggestAI:
    def __init__(self):
        self.client = _build_logic_client()
        self.logic_model = _LOGIC_MODEL

    async def suggest(
        self, topic: str, materials: list[SuggestMaterial], min_materials: int
    ) -> AISuggest:
        valid_ids = [m.id for m in materials]
        materials_info = [
            f"- ID: {m.id} | 제목: {m.title} | 요약: {m.summary}" for m in materials
        ]
        materials_text = "\n".join(materials_info)
        valid_ids_str = ", ".join(map(str, valid_ids))

        system_prompt = f"""
        당신은 사용자의 일상 기록(소재)들을 분석하여 한 편의 글로 엮을 수 있을지 판단하고 기획안을 제안하는 전문 에디터입니다.

        [1차 평가 필수 개선 및 절대 규칙]
        1. 억지 연결 절대 금지 및 제안 보류 판단 (가장 중요):
           - 소재들이 단순히 같은 주제(예: 일상, 일·직업)에 속해 있다는 이유만으로 억지로 묶지 마세요.
           - 소재들 사이에 공통된 대상/사물, 이어지는 행동이나 태도의 변화, 대조적인 경험 등 '실질적인 연결 근거'가 있을 때만 제안하세요.
           - 서로 무관한 단편적 사실들의 나열(예: 은행 비밀번호 변경 + 냉동 만두 먹음 + 충전선 주움 / 프린터 토너 교체 + 점심시간 변경 공지 + 비밀번호 변경 등)이고 추가적인 감정·인과관계가 없다면 제안을 보류(`"can_suggest": false`)하세요.
        2. 소재 충실성 및 과도한 의미 부여 금지:
           - 원문에 명시되지 않은 감정이나 거창한 심리적 의미를 단정하지 마세요.
           - 서로 다른 물건을 하나로 합치지 말고, 명시되지 않은 시간순 인과관계를 지어내지 마세요.
        3. 전체 소재를 아우르는 정확한 제목(`title`), 구조 방향(`direction`), 실제 소재 기반 추천 이유(`reason`), 그리고 사용할 소재 ID 목록(`material_ids`, [{valid_ids_str}] 안에서 최소 {min_materials}개 이상)을 작성하세요.
        4. 반드시 아래 JSON 형식으로만 응답하세요.
           {{
               "can_suggest": true 또는 false,
               "title": "글의 핵심 주제를 담은 짧은 제목 (보류 시 null)",
               "reason": "실제 소재 내용을 바탕으로 설명하는 추천 이유 (보류 시 null)",
               "direction": "글을 어떻게 엮을지 구조를 지시하는 명확한 한 문장 (보류 시 null)",
               "material_ids": [선택한 소재 ID 배열]
           }}
        """

        user_prompt = (
            f"주제: {topic}\n최소 선택 개수: {min_materials}개\n\n[소재 목록]\n{materials_text}"
        )

        try:
            response = await asyncio.to_thread(
                self.client.chat.completions.create,
                model=self.logic_model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                response_format={"type": "json_object"},
                max_completion_tokens=1024,
            )
            result = _parse_json_response(
                response.choices[0].message.content, target_key="material_ids"
            )
            if result.get("can_suggest") is False:
                return AISuggest(
                    suggestion=None,
                    input_tokens=response.usage.prompt_tokens if response.usage else 0,
                    output_tokens=response.usage.completion_tokens if response.usage else 0,
                )

            selected_ids = result.get("material_ids", [])
            if not isinstance(selected_ids, list) or len(selected_ids) < min_materials:
                return AISuggest(
                    suggestion=None,
                    input_tokens=response.usage.prompt_tokens if response.usage else 0,
                    output_tokens=response.usage.completion_tokens if response.usage else 0,
                )

            suggestion = AISuggestion(
                title=result.get("title") or "",
                direction=result.get("direction") or "",
                reason=result.get("reason") or "",
                material_ids=selected_ids,
            )
            return AISuggest(
                suggestion=suggestion,
                input_tokens=response.usage.prompt_tokens if response.usage else 0,
                output_tokens=response.usage.completion_tokens if response.usage else 0,
            )
        except Exception as e:
            raise AIError(f"Suggest 제안 실패: {str(e)}")


# ---------------------------------------------------------------------------
# Stub: fixed sample questions so A can build screens before C's model is in.
# ---------------------------------------------------------------------------
_STUB_FOLLOWUPS = [
    "그때 어디에 있었고, 누구와 함께였나요?",
    "그 순간 가장 먼저 떠오른 감정은 무엇이었나요?",
    "그 일이 있기 전과 후에 달라진 것이 있나요?",
    "그때 했던 말이나 들었던 말 중에 기억에 남는 것이 있나요?",
    "그 장면에서 보였던 것, 들렸던 것을 하나만 떠올려 볼까요?",
    "지금 돌아보면 그 일이 어떤 의미로 남아 있나요?",
    "그 이야기를 누군가에게 전한다면 누구에게 하고 싶나요?",
    "비슷한 일이 또 있었다면 언제였나요?",
    "그때의 나에게 한마디 해 준다면 뭐라고 하고 싶나요?",
    "그 일을 떠올리면 몸에서 느껴지는 감각이 있나요?",
    "그 일에서 가장 고마웠던 사람은 누구였나요?",
    "그 일을 겪고 새로 알게 된 것이 있나요?",
    "그 날의 날씨나 계절은 어땠나요?",
]

_STUB_DAILY = [
    "요즘 가장 자주 떠오르는 사람은 누구인가요?",
    "최근에 웃음이 났던 순간이 있었나요?",
    "오늘 하루 중 가장 기억에 남는 장면은 무엇인가요?",
    "어릴 적 자주 가던 장소가 있나요?",
    "최근에 누군가에게 고마웠던 일이 있었나요?",
    "요즘 나를 지치게 하는 것은 무엇인가요?",
    "가장 좋아하는 음식에 얽힌 기억이 있나요?",
    "최근에 새로 시작한 일이 있나요?",
    "가족과 함께한 순간 중 떠오르는 장면이 있나요?",
    "요즘 듣는 노래나 보는 것이 있나요?",
    "최근에 혼자 있는 시간에 무엇을 했나요?",
    "잊고 지내다 문득 떠오른 기억이 있나요?",
    "요즘 마음을 편하게 해 주는 것은 무엇인가요?",
    "누군가에게 하지 못한 말이 있나요?",
    "최근에 계절이 바뀌는 걸 느낀 순간이 있었나요?",
    "일하거나 공부하다 뿌듯했던 순간이 있었나요?",
    "오래된 친구와 나눈 대화가 떠오르나요?",
    "최근에 실수했던 일이 있었나요?",
    "요즘 자주 가는 장소는 어디인가요?",
    "몸이 보내는 신호를 느낀 적이 있나요?",
    "최근에 들은 말 중 마음에 남은 말이 있나요?",
    "여행지에서 기억에 남는 순간이 있나요?",
    "요즘 기다리고 있는 것이 있나요?",
    "어떤 냄새를 맡으면 떠오르는 기억이 있나요?",
    "최근에 용기를 냈던 일이 있었나요?",
    "나를 잘 아는 사람이 나를 어떻게 말할 것 같나요?",
    "요즘 미루고 있는 일이 있나요?",
    "최근에 누군가를 도와준 적이 있나요?",
    "하루 중 가장 좋아하는 시간은 언제인가요?",
    "올해 가장 달라진 나의 모습은 무엇인가요?",
]


class StubQuestionAI:
    async def next_question(self, turns: list[Turn], avoid: list[str]) -> AIText:
        asked = {t.question for t in turns} | set(avoid)
        for q in _STUB_FOLLOWUPS:
            if q not in asked:
                return AIText(q, input_tokens=0, output_tokens=0)
        raise AIError("no stub question left")

    async def daily_questions(self, for_date: date) -> AIQuestions:
        shift = for_date.toordinal() % len(_STUB_DAILY)
        return AIQuestions(_STUB_DAILY[shift:] + _STUB_DAILY[:shift], 0, 0)


# ---------------------------------------------------------------------------
# Stub material extraction: simple rules, no external calls.
# ---------------------------------------------------------------------------
_STUB_TOPIC_WORDS = {
    "가족": ["엄마", "아빠", "가족", "동생", "언니", "누나", "형", "오빠", "할머니", "할아버지"],
    "관계": ["친구", "동료", "연인", "선배", "후배"],
    "일·직업": ["회사", "업무", "출근", "퇴근", "회의", "직장"],
    "여행·장소": ["여행", "바다", "공항", "기차"],
    "음식": ["밥", "커피", "음식", "요리", "먹"],
    "몸·건강": ["운동", "병원", "아프", "잠"],
    "자연·계절": ["봄", "여름", "가을", "겨울", "꽃", "눈이", "비가"],
    "취향·취미": ["노래", "영화", "책", "그림", "취미"],
}
_STUB_MIN_CHARS = 15


class StubMaterialAI:
    async def extract_material(self, source: ExtractSource, topics: list[str]) -> AIExtract:
        text = source.user_text().strip()
        if len(text) < _STUB_MIN_CHARS:
            return AIExtract(None, 0, 0)
        sentences = [s.strip() for s in re.split(r"(?<=[.!?。])\s+|\n+", text) if s.strip()]
        evidence = sentences[0]
        words = []
        for w in re.findall(r"[가-힣A-Za-z]{2,}", text):
            if w not in words:
                words.append(w)
        found = [
            t
            for t, keys in _STUB_TOPIC_WORDS.items()
            if t in topics and any(k in text for k in keys)
        ]
        material = ExtractedMaterial(
            title=evidence[:20],
            summary=evidence[:60],
            evidence=evidence,
            keywords=words[:3],
            topics=found or ["일상"],
        )
        return AIExtract(material, 0, 0)


# ---------------------------------------------------------------------------
# Stub essay: stitches the materials' sentences together to the requested length.
# ---------------------------------------------------------------------------
class StubEssayAI:
    async def write_essay(self, inp: DraftInput) -> AIEssay:
        parts = [p for m in inp.materials for p in (m.summary, m.evidence) if p]
        if inp.base_body:
            parts.insert(0, inp.base_body.strip())
        if not parts:
            raise AIError("nothing to write from")
        target = (inp.min_chars + inp.max_chars) // 2
        body = ""
        i = 0
        while len(body) < target:
            body += ("" if not body else " ") + parts[i % len(parts)]
            i += 1
        body = body[:target]
        title = (
            inp.base_title
            or (inp.materials[0].title if inp.materials else None)
            or "오늘의 글"
        )
        return AIEssay(title=title, body=body, input_tokens=0, output_tokens=0)


# ---------------------------------------------------------------------------
# Stub suggestion: the newest materials of the topic, fixed sentences.
# ---------------------------------------------------------------------------
class StubSuggestAI:
    async def suggest(
        self, topic: str, materials: list[SuggestMaterial], min_materials: int
    ) -> AISuggest:
        if len(materials) < min_materials:
            return AISuggest(None, 0, 0)
        chosen = materials[:min_materials]
        names = ", ".join(m.title or m.summary or "소재" for m in chosen)
        return AISuggest(
            AISuggestion(
                title=f"{topic}에 관한 나의 이야기",
                direction=f"{names}을(를) 차례로 엮어, {topic}에 대해 느낀 점을 써 봐요.",
                reason=f"모두 '{topic}' 주제로 모은 소재예요.",
                material_ids=[m.id for m in chosen],
            ),
            0,
            0,
        )


@lru_cache
def get_question_ai() -> QuestionAI:
    provider = get_settings().ai_provider
    if provider == "openai":
        return OpenAIQuestionAI()
    if provider == "stub":
        return StubQuestionAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


@lru_cache
def get_material_ai() -> MaterialAI:
    provider = get_settings().ai_provider
    if provider == "openai":
        return OpenAIMaterialAI()
    if provider == "stub":
        return StubMaterialAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


@lru_cache
def get_essay_ai() -> EssayAI:
    provider = get_settings().ai_provider
    if provider == "openai":
        return OpenAIEssayAI()
    if provider == "stub":
        return StubEssayAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


@lru_cache
def get_suggest_ai() -> SuggestAI:
    provider = get_settings().ai_provider
    if provider == "openai":
        return OpenAISuggestAI()
    if provider == "stub":
        return StubSuggestAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")