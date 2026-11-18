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
"""

import re
from dataclasses import dataclass, field
from datetime import date
from functools import lru_cache
from typing import Protocol

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


@lru_cache
def get_question_ai() -> QuestionAI:
    """FastAPI dependency. Tests override it to simulate failures."""
    provider = get_settings().ai_provider
    if provider == "stub":
        return StubQuestionAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


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


@lru_cache
def get_material_ai() -> MaterialAI:
    """FastAPI dependency. Tests override it to simulate failures."""
    provider = get_settings().ai_provider
    if provider == "stub":
        return StubMaterialAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")


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


@lru_cache
def get_essay_ai() -> EssayAI:
    """FastAPI dependency. Tests override it to simulate failures."""
    provider = get_settings().ai_provider
    if provider == "stub":
        return StubEssayAI()
    raise RuntimeError(f"unknown AI_PROVIDER: {provider}")
