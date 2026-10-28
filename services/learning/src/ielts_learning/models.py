from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class Model(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Source(Model):
    item_id: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=1000)
    transcript: str = Field(min_length=80, max_length=40000)
    part: Literal[1, 2, 3, 4]
    paper_run_id: str | None = Field(default=None, max_length=500)


class LessonInput(Model):
    source: Source
    target_band: Literal[6.5] = 6.5


class Question(Model):
    id: str = Field(min_length=1, max_length=80)
    kind: Literal["choice", "true_false", "gap"]
    prompt: str = Field(min_length=1, max_length=2000)
    options: list[str] = Field(default_factory=list, max_length=5)
    answer: str = Field(min_length=1, max_length=200)
    max_words: int = Field(default=3, ge=1, le=5)
    evidence: str = Field(min_length=1, max_length=2500)
    explanation: str = Field(min_length=1, max_length=2000)

    @model_validator(mode="after")
    def valid_answer(self):
        # These labels are fixed UI choices; only the answer needs model judgment.
        if self.kind == "true_false" and not self.options:
            self.options = ["True", "False", "Not Given"]
        if self.kind == "gap":
            if self.options or len(self.answer.split()) > self.max_words:
                raise ValueError("A gap answer must respect max_words and have no options")
        else:
            if len(set(self.options)) != len(self.options) or self.answer not in self.options:
                raise ValueError("The answer must equal one distinct option")
            if self.kind == "choice" and not 3 <= len(self.options) <= 5:
                raise ValueError("Choice questions require 3 to 5 distinct options")
            if self.kind == "true_false" and self.options != ["True", "False", "Not Given"]:
                raise ValueError("Use the three canonical true/false labels")
        return self


class ReadingDraft(Model):
    translation: str = Field(min_length=1, max_length=40000)
    questions: list[Question] = Field(min_length=5, max_length=14)

    @model_validator(mode="before")
    @classmethod
    def retain_parseable_questions(cls, value):
        if isinstance(value, dict) and isinstance(value.get("questions"), list):
            valid = []
            for question in value["questions"]:
                try:
                    valid.append(Question.model_validate(question))
                except ValidationError:
                    continue
            if len(valid) >= 5 and len(valid) < len(value["questions"]):
                return {**value, "questions": valid}
        return value


class Reading(ReadingDraft):
    passage: str = Field(min_length=80, max_length=40000)


class ConversationPlan(Model):
    topic: str = Field(min_length=1, max_length=300)
    opening: str = Field(min_length=1, max_length=1200)
    opening_zh: str = Field(min_length=1, max_length=1200)
    starters: list[str] = Field(min_length=1, max_length=3)


class WritingTask(Model):
    level: Literal["basic", "extension", "challenge"]
    instruction: str = Field(min_length=1, max_length=1500)
    goal: str = Field(min_length=1, max_length=1000)
    hints: list[str] = Field(min_length=1, max_length=3)


class WritingPlan(Model):
    tasks: list[WritingTask] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def all_levels(self):
        if {task.level for task in self.tasks} != {"basic", "extension", "challenge"}:
            raise ValueError("Writing needs one task at each optional level")
        return self


class ExpressionPlan(Model):
    title: str = Field(min_length=1, max_length=200)
    conversation: ConversationPlan
    writing: WritingPlan


class Lesson(ExpressionPlan):
    reading: Reading


class TurnInput(LessonInput):
    lesson: Lesson
    text: str = Field(min_length=1, max_length=12000)
    history: list[dict[str, Any]] = Field(default_factory=list, max_length=100)
    received_help: bool = False
    level: Literal["basic", "extension", "challenge"] = "basic"
    action: Literal["answer", "question"] = "answer"


def english(value: str) -> bool:
    return not re.search(r"[\u3400-\u9fff]", value)


class ConversationReply(Model):
    reply_en: str = Field(min_length=1, max_length=2500)
    follow_up: str = Field(min_length=1, max_length=1200)
    feedback_zh: str = Field(min_length=1, max_length=1500)
    outcome: Literal["expressed", "needs_support", "unclear"]

    @model_validator(mode="after")
    def spoken_english(self):
        if not english(self.reply_en + self.follow_up):
            raise ValueError("Only English belongs in the spoken response")
        return self


class ExpressionHelp(Model):
    english: str = Field(default="", max_length=3000)
    clarification_zh: str = Field(default="", max_length=1500)

    @model_validator(mode="after")
    def one_result(self):
        if bool(self.english) == bool(self.clarification_zh) or not english(self.english):
            raise ValueError("Return either faithful English or a clarification question")
        return self


class Correction(Model):
    original: str = Field(min_length=1, max_length=1500)
    corrected: str = Field(min_length=1, max_length=1500)
    reason_zh: str = Field(min_length=1, max_length=1500)


class WritingFeedback(Model):
    feedback_zh: str = Field(min_length=1, max_length=3000)
    corrections: list[Correction] = Field(default_factory=list, max_length=20)
    suggestion_en: str = Field(default="", max_length=5000)
    task_complete: bool
    follow_up_zh: str = Field(default="", max_length=1500)


class BlindCheck(Model):
    id: str
    answer: str
    evidence_sufficient: bool
    reason: str


class BlindChecks(Model):
    checks: list[BlindCheck] = Field(min_length=1, max_length=14)


class ExplanationCheck(Model):
    id: str
    supported: bool
    reason: str


class ExplanationChecks(Model):
    checks: list[ExplanationCheck] = Field(min_length=1, max_length=14)


class Repairs(Model):
    questions: list[Question] = Field(min_length=1, max_length=14)
