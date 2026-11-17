"""AI connection point (C's part).

The API code only calls the `QuestionAI` interface below. To use a real model,
C adds a class with the same two methods (e.g. `OpenAIQuestionAI`) and returns it
from `get_question_ai()` when `AI_PROVIDER` says so. Nothing else changes.

Rules the real implementation must keep (requirements R05):
- next_question: one question at a time, based on the conversation so far.
  Never invent experiences or feelings that are not in the answers.
  Do not repeat the direction of questions in `avoid` (replaced questions).
- daily_questions: exactly 30 questions shared by all users for that date.
"""

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


class AIError(Exception):
    """The AI call failed or returned something unusable."""


class QuestionAI(Protocol):
    async def next_question(self, turns: list[Turn], avoid: list[str]) -> AIText:
        """Next follow-up question. `turns` are answered Q&A pairs in order."""

    async def daily_questions(self, for_date: date) -> AIQuestions:
        """The 30 shared first questions for `for_date`."""


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
