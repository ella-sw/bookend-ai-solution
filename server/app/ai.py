"""AI connection point (C's part).

The API code only calls the interfaces below (`QuestionAI`, `MaterialAI`). To use a
real model, C adds classes with the same methods (e.g. `OpenAIQuestionAI`) and returns
them from `get_question_ai()` / `get_material_ai()` when `AI_PROVIDER` says so.
Nothing else changes.

Rules the real implementation must keep:
R05 QuestionAI
- next_question: one question at a time, based on the conversation so far.
  Never invent experiences or feelings that are not in the answers.
  Do not repeat the direction of questions in `avoid` (replaced questions).
- daily_questions: exactly 30 questions shared by all users for that date.
R28 MaterialAI
- extract_material: 0 or 1 material from what the user wrote (`source.user_text()`).
  No writing material → return `material=None` (소재 없음); never an empty material.
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

import re
import os
import json
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Protocol

from openai import OpenAI
from app.config import get_settings

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
    async def suggest(self, topic: str, materials: list[SuggestMaterial],
                      min_materials: int) -> AISuggest:
        """R30: one writing suggestion for a topic, or None."""

# ==========================================
# [C 작업 영역] 실제 OpenAI API 구현 클래스
# ==========================================
class OpenAIQuestionAI:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    async def next_question(self, turns: list[Turn], avoid: list[str]) -> AIText:
        avoid_str = "\n- ".join(avoid) if avoid else "없음"
        
        system_prompt = f"""
        당신은 사용자의 감정을 깊이 있게 이끌어내는 전문 인터뷰어입니다.
        이전 대화 기록을 분석하여 '단 하나의 꼬리 질문'을 작성하세요.
        
        [절대 규칙]
        1. 아래 JSON으로 응답할 것: {{"next_question": "생성된 질문"}}
        2. 복합 질문 절대 금지 (물음표 1개만 사용)
        3. 아래 피해야 할 질문과 겹치지 않게 완전히 새로운 방향으로 작성하세요:
        - {avoid_str}
        4. 사용자의 답변에 없는 경험이나 감정을 지어내지 마세요.
        """
        
        chat_history = []
        for t in turns:
            chat_history.append({"role": "assistant", "content": t.question})
            if t.answer:
                chat_history.append({"role": "user", "content": t.answer})
                
        messages = [{"role": "system", "content": system_prompt}] + chat_history
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=messages,
                response_format={"type": "json_object"},
            )
            result = json.loads(response.choices[0].message.content)
            return AIText(
                text=result.get("next_question", "질문을 생성하지 못했습니다."),
                input_tokens=response.usage.prompt_tokens,
                output_tokens=response.usage.completion_tokens
            )
        except Exception as e:
            raise AIError(f"OpenAI API 실패: {str(e)}")

    async def daily_questions(self, for_date: date) -> AIQuestions:
        # 실제 운영 시 매일 공통 질문을 동적으로 생성하거나 DB에서 가져올 수 있음
        # 현재는 Stub의 공통 질문 방식을 차용
        shift = for_date.toordinal() % len(_STUB_DAILY)
        questions = _STUB_DAILY[shift:] + _STUB_DAILY[:shift]
        return AIQuestions(questions=questions, input_tokens=0, output_tokens=0)


class OpenAIMaterialAI:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    async def extract_material(self, source: ExtractSource, topics: list[str]) -> AIExtract:
        user_text = source.user_text().strip()
        if not user_text:
            return AIExtract(material=None, input_tokens=0, output_tokens=0)
            
        topics_str = ", ".join(topics)
        
        system_prompt = f"""
        당신은 사용자의 일상 기록에서 글감을 추출하는 전문 AI 편집자입니다.
        반드시 아래 JSON 형식으로만 응답하세요.
        {{
            "title": "추출된 소재의 핵심을 담은 짧은 제목",
            "summary": "핵심 내용을 1문장으로 요약 (절대 비워두지 말 것)",
            "keywords": ["핵심단어1", "핵심단어2"],
            "topic": "선택된 주제",
            "evidence": "소재 추출의 근거가 되는 원본 기록 내 문장 발췌"
        }}
        
        [서버 검증 필수 통과 규칙]
        1. evidence (근거 문장): 사용자의 원본 기록에서 글자 하나 틀리지 않고 100% 동일하게 발췌해야 합니다. AI가 임의로 다듬거나 지어내면 실패 처리됩니다.
        2. topic (주제): 반드시 다음 제공된 목록 중 1개만 선택하세요. [{topics_str}]
        3. keywords (키워드 추천용): 
           - 조사 및 어미 제거: 명사형 단어만 남기세요. (예: "엄마랑" -> "엄마")
           - 구절 금지 및 복합 명사 허용: "엄마의 반찬을 먹었다" 같은 서술어가 포함된 구절은 금지. 단, "수면 부족"처럼 의미 보존을 위해 꼭 필요한 '복합 명사'는 허용.
           - 엄격한 동의어 통일: "어머니"와 "엄마"처럼 완벽히 동일한 대상을 지칭할 때만 대표 명사로 통일.
        """
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_text}
                ],
                response_format={"type": "json_object"},
                temperature=0.2 
            )
            result = json.loads(response.choices[0].message.content)
            
            # 서버 검증(빈 값) 1차 방어
            if not result.get("summary") or not result.get("evidence"):
                return AIExtract(material=None, input_tokens=response.usage.prompt_tokens, output_tokens=response.usage.completion_tokens)
                
            material = ExtractedMaterial(
                title=result.get("title", ""),
                summary=result.get("summary", ""),
                evidence=result.get("evidence", ""),
                keywords=result.get("keywords", []),
                topics=[result.get("topic", "")]
            )
            return AIExtract(
                material=material,
                input_tokens=response.usage.prompt_tokens,
                output_tokens=response.usage.completion_tokens
            )
        except Exception as e:
            raise AIError(f"Material 추출 실패: {str(e)}")


class OpenAIEssayAI:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    async def write_essay(self, inp: DraftInput) -> AIEssay:
        # 다시 만들기(재생성)인 경우, 기존 텍스트를 기반으로 교정(retouch) 모드 수행
        if inp.base_body:
            return await self._retouch_essay(inp)
            
        # 초안 생성 모드
        system_prompt = f"""
        당신은 사용자의 기록을 바탕으로 에세이를 작성하는 전문 작가입니다.
        
        [절대 규칙]
        1. 사용자가 제공한 '소재'에 없는 새로운 사건이나 인물을 절대 지어내지 마세요.
        2. 사용자가 제시한 '글의 방향'을 글의 핵심 주제와 흐름으로 삼아 자연스럽게 전개하세요.
        3. 사용자가 요청한 문체({inp.style})로 작성하고, 분량은 공백 포함 {inp.min_chars}자에서 {inp.max_chars}자 사이로 엄격히 맞춰 작성하세요.
        4. 반드시 아래 JSON 형식으로만 응답하세요.
        {{
            "title": "에세이 제목",
            "body": "작성된 에세이 초안 본문"
        }}
        """
        
        materials_info = []
        for m in inp.materials:
            materials_info.append(f"- 제목: {m.title}\n  요약: {m.summary}\n  원본: {m.original}")
        materials_text = "\n".join(materials_info)
        
        user_prompt = f"- 글의 방향: {inp.direction or '없음'}\n[소재 목록]\n{materials_text}"
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"},
            )
            result = json.loads(response.choices[0].message.content)
            return AIEssay(
                title=result.get("title", "오늘의 글"),
                body=result.get("body", ""),
                input_tokens=response.usage.prompt_tokens,
                output_tokens=response.usage.completion_tokens
            )
        except Exception as e:
            raise AIError(f"Essay 초안 생성 실패: {str(e)}")
            
    async def _retouch_essay(self, inp: DraftInput) -> AIEssay:
        system_prompt = f"""
        당신은 에세이 전문 교정 편집자입니다.
        사용자가 '직접 수정한 초안'을 바탕으로 글을 자연스럽게 다듬고 다시 작성해 주세요.
        
        [수정 지침]
        1. 사용자가 수정한 문장과 흐름, 의도를 최대한 보존하세요.
        2. 사용자가 요청한 '문체({inp.style})'에 맞춰 교정하세요.
        3. 분량은 공백 포함 {inp.min_chars}자에서 {inp.max_chars}자 사이로 엄격히 맞추세요.
        4. 제공된 소재에 없는 새로운 사실을 임의로 지어내지 마세요.

        [절대 규칙]
        반드시 아래 JSON 형식으로 응답하세요.
        {{
            "title": "수정된 제목",
            "body": "수정된 에세이 본문"
        }}
        """
        
        materials_info = []
        for m in inp.materials:
            materials_info.append(f"- 제목: {m.title}\n  요약: {m.summary}\n  원본: {m.original}")
        materials_text = "\n".join(materials_info)
        
        user_prompt = f"- 현재 제목: {inp.base_title}\n- 현재 초안 본문:\n{inp.base_body}\n\n- 남은 소재 목록:\n{materials_text}"
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"},
            )
            result = json.loads(response.choices[0].message.content)
            return AIEssay(
                title=result.get("title", inp.base_title),
                body=result.get("body", ""),
                input_tokens=response.usage.prompt_tokens,
                output_tokens=response.usage.completion_tokens
            )
        except Exception as e:
            raise AIError(f"Essay 다시 만들기 실패: {str(e)}")


class OpenAISuggestAI:
    def __init__(self):
        self.client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

    async def suggest(self, topic: str, materials: list[SuggestMaterial], min_materials: int) -> AISuggest:
        valid_ids = [m.id for m in materials]
        materials_info = [f"- ID: {m.id} | 제목: {m.title} | 요약: {m.summary}" for m in materials]
        materials_text = "\n".join(materials_info)
        valid_ids_str = ", ".join(map(str, valid_ids))
        
        system_prompt = f"""
        당신은 사용자의 기록을 엮어서 '{topic}' 주제의 완성된 글을 쓰도록 기획안을 제안하는 전문 에디터입니다.
        
        [서버 검증 필수 통과 규칙]
        1. 반드시 아래 JSON 형식으로만 응답하세요.
        {{
            "title": "글의 핵심 주제를 담은 짧은 제목",
            "direction": "글을 어떻게 엮을지 구조를 지시하는 명확한 한 문장",
            "reason": "왜 이 소재들이 묶였는지 '실제 소재 내용'을 바탕으로 설명하는 추천 이유",
            "material_ids": [선택한 소재 ID 배열]
        }}
        2. title, direction, reason 중 하나라도 비어있으면 안 됩니다.
        3. material_ids: 반드시 제공된 소재 ID 목록 [{valid_ids_str}] 안에서만 선택해야 하며, 최소 {min_materials}개 이상을 사용할 순서대로 나열해야 합니다.
        """
        
        user_prompt = f"주제: {topic}\n최소 선택 개수: {min_materials}개\n\n[소재 목록]\n{materials_text}"
        
        try:
            response = self.client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt}
                ],
                response_format={"type": "json_object"},
            )
            result = json.loads(response.choices[0].message.content)
            
            # 서버 검증(개수 미달) 방어 로직: 부적합 시 None 반환 (제안 숨김)
            selected_ids = result.get("material_ids", [])
            if not isinstance(selected_ids, list) or len(selected_ids) < min_materials:
                return AISuggest(suggestion=None, input_tokens=response.usage.prompt_tokens, output_tokens=response.usage.completion_tokens)
                
            suggestion = AISuggestion(
                title=result.get("title", ""),
                direction=result.get("direction", ""),
                reason=result.get("reason", ""),
                material_ids=selected_ids
            )
            return AISuggest(
                suggestion=suggestion,
                input_tokens=response.usage.prompt_tokens,
                output_tokens=response.usage.completion_tokens
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
        shift = for_date.toordinal() % len(_STUB_DAILY)  # rotate so days differ
        return AIQuestions(_STUB_DAILY[shift:] + _STUB_DAILY[:shift], 0, 0)


# @lru_cache
# def get_question_ai() -> QuestionAI:
#     """FastAPI dependency. Tests override it to simulate failures."""
#     provider = get_settings().ai_provider
#     if provider == "stub":
#         return StubQuestionAI()
#     raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


# ---------------------------------------------------------------------------
# Stub material extraction: simple rules, no external calls.
# Short text → 소재 없음; otherwise the first sentence becomes the evidence.
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
        found = [t for t, keys in _STUB_TOPIC_WORDS.items()
                 if t in topics and any(k in text for k in keys)]
        material = ExtractedMaterial(
            title=evidence[:20],
            summary=evidence[:60],
            evidence=evidence,
            keywords=words[:3],
            topics=found or ["일상"],
        )
        return AIExtract(material, 0, 0)


# @lru_cache
# def get_material_ai() -> MaterialAI:
#     """FastAPI dependency. Tests override it to simulate failures."""
#     provider = get_settings().ai_provider
#     if provider == "stub":
#         return StubMaterialAI()
#     raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


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
        title = inp.base_title or (inp.materials[0].title if inp.materials else None) or "오늘의 글"
        return AIEssay(title=title, body=body, input_tokens=0, output_tokens=0)


# @lru_cache
# def get_essay_ai() -> EssayAI:
#     """FastAPI dependency. Tests override it to simulate failures."""
#     provider = get_settings().ai_provider
#     if provider == "stub":
#         return StubEssayAI()
#     raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


# ---------------------------------------------------------------------------
# Stub suggestion: the newest materials of the topic, fixed sentences.
# ---------------------------------------------------------------------------
class StubSuggestAI:
    async def suggest(self, topic: str, materials: list[SuggestMaterial],
                      min_materials: int) -> AISuggest:
        if len(materials) < min_materials:
            return AISuggest(None, 0, 0)
        chosen = materials[:min_materials]
        names = ", ".join(m.title or m.summary or "소재" for m in chosen)
        return AISuggest(AISuggestion(
            title=f"{topic}에 관한 나의 이야기",
            direction=f"{names}을(를) 차례로 엮어, {topic}에 대해 느낀 점을 써 봐요.",
            reason=f"모두 '{topic}' 주제로 모은 소재예요.",
            material_ids=[m.id for m in chosen],
        ), 0, 0)


# @lru_cache
# def get_suggest_ai() -> SuggestAI:
#     """FastAPI dependency. Tests override it to simulate failures."""
#     provider = get_settings().ai_provider
#     if provider == "stub":
#         return StubSuggestAI()
#     raise RuntimeError(f"unknown AI_PROVIDER: {provider}")

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
