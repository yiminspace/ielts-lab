import asyncio
import copy
import json
import sqlite3

import pytest
from agent_runtime.store import LeaseLost
from pydantic_ai.exceptions import UnexpectedModelBehavior

from ielts_learning.models import (
    BlindChecks,
    ExplanationChecks,
    ExpressionPlan,
    LessonInput,
    ReadingDraft,
    Repairs,
)
from ielts_learning.workflows import create_workflows, question_range, validate_reading

FACTS = [
    ("The community garden opens at nine.", "nine"),
    ("Visitors may book three places.", "three"),
    ("Workshops run on Monday.", "Monday"),
    ("Please enter through the east gate.", "east"),
    ("Residents register online.", "online"),
    ("The garden closes at six.", "six"),
    ("Volunteers wear green badges.", "green"),
]
SOURCE = " ".join(sentence for sentence, _ in FACTS)


def questions(count=7):
    return [
        {
            "id": f"q{index + 1}",
            "kind": "gap",
            "prompt": sentence.replace(answer, "___"),
            "answer": answer,
            "max_words": 1,
            "evidence": sentence,
            "explanation": "原文明确给出了这项信息。",
        }
        for index, (sentence, answer) in enumerate(FACTS[:count])
    ]


def expression_plan():
    return ExpressionPlan.model_validate(
        {
            "title": "A community garden visit",
            "conversation": {
                "topic": "Community gardens",
                "opening": "What would you grow in a community garden?",
                "opening_zh": "你想在社区花园种什么？",
                "starters": ["I would grow..."],
            },
            "writing": {
                "tasks": [
                    {
                        "level": level,
                        "instruction": "Write a message asking about available places.",
                        "goal": "Ask about availability.",
                        "hints": ["Are there any places..."],
                    }
                    for level in ("basic", "extension", "challenge")
                ]
            },
        }
    )


class Context:
    def __init__(self):
        self.checkpoints = {}

    async def step(self, name, callback):
        if name not in self.checkpoints:
            self.checkpoints[name] = json.loads(json.dumps(await callback()))
        return copy.deepcopy(self.checkpoints[name])


class Gateway:
    def __init__(self, draft=None, bad_ids=(), bad_rounds=None, repair_error=None):
        self.draft = copy.deepcopy(draft if draft is not None else questions())
        self.by_id = {question["id"]: question for question in self.draft}
        self.bad_ids = set(bad_ids)
        self.bad_rounds = bad_rounds
        self.repair_error = repair_error
        self.review_round = -1
        self.calls = []

    def current_bad(self):
        if self.bad_rounds is not None:
            return self.bad_rounds[self.review_round]
        return self.bad_ids

    async def generate(self, schema, instructions, payload, validate=None):
        self.calls.append((schema, copy.deepcopy(payload)))
        if schema is ReadingDraft:
            output = ReadingDraft(
                translation="社区花园参观信息。", questions=copy.deepcopy(self.draft)
            )
        elif schema is ExpressionPlan:
            output = expression_plan()
        elif schema is BlindChecks:
            self.review_round += 1
            output = BlindChecks(
                checks=[
                    {
                        "id": question["id"],
                        "answer": (
                            "unsupported"
                            if question["id"] in self.current_bad()
                            else self.by_id[question["id"]]["answer"]
                        ),
                        "evidence_sufficient": question["id"] not in self.current_bad(),
                        "reason": "Checked independently against the original source.",
                    }
                    for question in payload["questions"]
                ]
            )
        elif schema is ExplanationChecks:
            output = ExplanationChecks(
                checks=[
                    {
                        "id": question["id"],
                        "supported": question["id"] not in self.current_bad(),
                        "reason": "Checked answer and explanation against the source.",
                    }
                    for question in payload["questions"]
                ]
            )
        elif schema is Repairs:
            if self.repair_error == "model":
                raise UnexpectedModelBehavior("Original synthetic model failure")
            if self.repair_error == "cancel":
                raise asyncio.CancelledError
            output = Repairs(questions=copy.deepcopy(payload["questions"]))
            if self.repair_error == "validation":
                output.questions[0].evidence = "This sentence does not appear in the source."
        else:
            raise AssertionError(schema)
        if validate is not None:
            validate(output)
        return output


async def run(gateway, context=None, source=SOURCE):
    context = context or Context()
    value = LessonInput(
        source={
            "item_id": "original-community-garden-delivery",
            "title": "Community garden visit",
            "transcript": source,
            "part": 1,
        }
    )
    return await create_workflows(gateway)[0].execute(context, value)


@pytest.mark.asyncio
async def test_seven_questions_with_two_bad_questions_deliver_five_after_two_repairs():
    gateway, context = Gateway(bad_ids={"q6", "q7"}), Context()
    lesson = await run(gateway, context)
    assert [question.id for question in lesson.reading.questions] == [f"q{i}" for i in range(1, 6)]
    assert all(question.evidence in SOURCE for question in lesson.reading.questions)
    assert lesson.reading.passage == SOURCE
    assert "reading.repair.1" in context.checkpoints
    assert "reading.repair.2" in context.checkpoints
    assert len(context.checkpoints["reading.generate"]["questions"]) == 7
    for round_number in range(3):
        assert f"reading.blind.{round_number}" in context.checkpoints
        assert f"reading.explanation.{round_number}" in context.checkpoints


@pytest.mark.asyncio
async def test_fewer_than_five_reviewed_questions_fail_without_losing_checkpoints():
    gateway, context = Gateway(bad_ids={"q5", "q6", "q7"}), Context()
    with pytest.raises(ValueError, match="At least 5 independently verified"):
        await run(gateway, context)
    assert "expressions.generate" in context.checkpoints
    assert "reading.generate" in context.checkpoints
    assert "reading.repair.2" in context.checkpoints
    assert "reading.blind.2" in context.checkpoints
    assert "reading.explanation.2" in context.checkpoints


@pytest.mark.asyncio
async def test_five_single_type_questions_can_ship_below_the_requested_length_target():
    source = SOURCE + " The garden also has a quiet path for visitors." * 45
    assert question_range(source) == (8, 10)
    gateway = Gateway(draft=questions(5))
    lesson = await run(gateway, source=source)
    assert len(lesson.reading.questions) == 5
    assert {question.kind for question in lesson.reading.questions} == {"gap"}
    request = next(payload for schema, payload in gateway.calls if schema is ReadingDraft)
    assert request["question_count"] == (8, 10)
    assert all(
        len(payload["questions"]) == 5
        for schema, payload in gateway.calls
        if schema in (BlindChecks, ExplanationChecks)
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["quotation", "sentence_limit", "gap_answer"])
async def test_one_statically_bad_question_is_removed_before_checkpoint_and_review(invalid):
    draft = questions(6)
    if invalid == "quotation":
        draft[-1]["evidence"] = "This unsupported sentence is outside the source."
    elif invalid == "sentence_limit":
        draft[-1]["evidence"] = " ".join(sentence for sentence, _ in FACTS[:5])
    else:
        draft[-1]["answer"] = "twelve"
    gateway, context = Gateway(draft=draft), Context()
    lesson = await run(gateway, context)
    assert len(lesson.reading.questions) == 5
    assert len(context.checkpoints["reading.generate"]["questions"]) == 5
    assert all(
        {question["id"] for question in payload["questions"]} == {f"q{i}" for i in range(1, 6)}
        for schema, payload in gateway.calls
        if schema in (BlindChecks, ExplanationChecks)
    )
    assert not any(schema is Repairs for schema, _ in gateway.calls)


def test_static_rejection_below_five_explains_the_question_id_and_reason():
    draft = ReadingDraft(translation="原创测试。", questions=questions(5))
    draft.questions[-1].evidence = "A sentence not in this source."
    with pytest.raises(ValueError, match="At least 5 grounded.*q5: evidence must be an exact"):
        validate_reading(SOURCE, draft)


@pytest.mark.asyncio
async def test_delivery_uses_the_latest_double_review_not_the_first_passed_set():
    gateway = Gateway(bad_rounds=[{"q6", "q7"}, {"q1", "q7"}, {"q1", "q7"}])
    lesson = await run(gateway)
    assert {question.id for question in lesson.reading.questions} == {f"q{i}" for i in range(2, 7)}
    assert "q1" not in {question.id for question in lesson.reading.questions}
    assert "q6" in {question.id for question in lesson.reading.questions}


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["model", "validation"])
async def test_failed_model_or_invalid_repair_can_deliver_five_already_double_reviewed(failure):
    gateway, context = Gateway(bad_ids={"q6", "q7"}, repair_error=failure), Context()
    lesson = await run(gateway, context)
    assert {question.id for question in lesson.reading.questions} == {f"q{i}" for i in range(1, 6)}
    assert "reading.repair.1" not in context.checkpoints
    assert "reading.blind.0" in context.checkpoints
    assert "reading.explanation.0" in context.checkpoints


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["model", "validation"])
async def test_failed_repair_with_fewer_than_five_double_reviewed_questions_still_fails(failure):
    gateway, context = Gateway(bad_ids={"q5", "q6", "q7"}, repair_error=failure), Context()
    with pytest.raises(ValueError, match="At least 5 independently verified"):
        await run(gateway, context)
    assert "reading.generate" in context.checkpoints
    assert "reading.blind.0" in context.checkpoints
    assert "reading.explanation.0" in context.checkpoints
    assert "reading.repair.1" not in context.checkpoints


@pytest.mark.asyncio
@pytest.mark.parametrize("error_type", [ValueError, sqlite3.OperationalError, LeaseLost])
async def test_checkpoint_or_lease_failures_never_become_a_successful_partial_lesson(error_type):
    class BrokenPersistence(Context):
        async def step(self, name, callback):
            if name.startswith("reading.repair."):
                await callback()
                raise error_type("Original synthetic checkpoint failure")
            return await super().step(name, callback)

    with pytest.raises(error_type, match="Original synthetic checkpoint failure"):
        await run(Gateway(bad_ids={"q6", "q7"}), BrokenPersistence())


@pytest.mark.asyncio
async def test_repair_cancellation_never_becomes_a_successful_partial_lesson():
    with pytest.raises(asyncio.CancelledError):
        await run(Gateway(bad_ids={"q6", "q7"}, repair_error="cancel"))
