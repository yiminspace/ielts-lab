import asyncio
import json

import pytest
from pydantic import ValidationError
from pydantic_ai.models.test import TestModel

from ielts_learning.gateway import PydanticGateway
from ielts_learning.models import (
    BlindChecks,
    ConversationReply,
    ExplanationChecks,
    ExpressionHelp,
    ExpressionPlan,
    Lesson,
    LessonInput,
    ReadingDraft,
    Repairs,
    TurnInput,
    WritingFeedback,
)
from ielts_learning.profiles import PROFILES
from ielts_learning.workflows import create_workflows, parallel, source_quotation, validate_reading

SOURCE = (
    "The Riverside library opens at nine. Visitors can borrow three books. "
    "A reading club meets on Monday. The club is free for local residents. "
    "Students can reserve a quiet room online. The library closes at six."
)


def reading():
    return ReadingDraft.model_validate(
        {
            "translation": "河畔图书馆九点开门。访客可以借三本书。读书会周一举行。当地居民免费参加。学生可以在线预约安静的房间。图书馆六点关门。",
            "questions": [
                {
                    "id": "q1",
                    "kind": "choice",
                    "prompt": "When does the library open?",
                    "options": ["At nine", "At six", "At ten"],
                    "answer": "At nine",
                    "evidence": "The Riverside library opens at nine.",
                    "explanation": "原文说明九点开门。",
                },
                {
                    "id": "q2",
                    "kind": "gap",
                    "prompt": "Visitors may borrow ___ books.",
                    "answer": "three",
                    "max_words": 1,
                    "evidence": "Visitors can borrow three books.",
                    "explanation": "原文说明可以借三本。",
                },
                {
                    "id": "q3",
                    "kind": "gap",
                    "prompt": "The club meets on ___.",
                    "answer": "Monday",
                    "max_words": 1,
                    "evidence": "A reading club meets on Monday.",
                    "explanation": "活动在周一。",
                },
                {
                    "id": "q4",
                    "kind": "true_false",
                    "prompt": "Local residents pay to join the club.",
                    "options": ["True", "False", "Not Given"],
                    "answer": "False",
                    "evidence": "The club is free for local residents.",
                    "explanation": "当地居民免费。",
                },
                {
                    "id": "q5",
                    "kind": "gap",
                    "prompt": "Students reserve rooms ___.",
                    "answer": "online",
                    "max_words": 1,
                    "evidence": "Students can reserve a quiet room online.",
                    "explanation": "预约方式是在线。",
                },
            ],
        }
    )


def expressions():
    return ExpressionPlan.model_validate(
        {
            "title": "A visit to the library",
            "conversation": {
                "topic": "Libraries",
                "opening": "What do you like about libraries?",
                "opening_zh": "你喜欢图书馆的什么？",
                "starters": ["I like..."],
            },
            "writing": {
                "tasks": [
                    {
                        "level": level,
                        "instruction": "Write a message asking to reserve a room.",
                        "goal": "Ask about availability.",
                        "hints": ["Could I reserve..."],
                    }
                    for level in ["basic", "extension", "challenge"]
                ]
            },
        }
    )


def source(part=1):
    return {
        "item_id": "original-library",
        "title": "Library visit",
        "part": part,
        "transcript": SOURCE,
    }


def lesson():
    return Lesson(
        **expressions().model_dump(), reading={**reading().model_dump(), "passage": SOURCE}
    )


class Context:
    def __init__(self):
        self.checkpoints = {}

    async def step(self, name, callback):
        if name not in self.checkpoints:
            self.checkpoints[name] = await callback()
        return self.checkpoints[name]


class Gateway:
    model = "original-test-only"

    def __init__(self, fail_once=False, always_fail=False):
        self.calls = []
        self.fail_once = fail_once
        self.always_fail = always_fail
        self.round = 0

    async def generate(self, schema, instructions, payload, validate=None):
        self.calls.append((schema, instructions, payload))
        if schema is ReadingDraft:
            output = reading()
        elif schema is ExpressionPlan:
            output = expressions()
        elif schema is BlindChecks:
            self.round += 1
            output = BlindChecks(
                checks=[
                    {
                        "id": q.id,
                        "answer": (
                            "At six"
                            if q.id == "q1"
                            and (self.always_fail or self.fail_once and self.round == 1)
                            else q.answer
                        ),
                        "evidence_sufficient": True,
                        "reason": "Checked against original source.",
                    }
                    for q in reading().questions
                ]
            )
        elif schema is ExplanationChecks:
            output = ExplanationChecks(
                checks=[
                    {"id": q.id, "supported": True, "reason": "Evidence supports explanation."}
                    for q in reading().questions
                ]
            )
        elif schema is Repairs:
            output = Repairs(questions=[reading().questions[0]])
        elif schema is ConversationReply:
            output = ConversationReply(
                reply_en="A quiet place can help you concentrate.",
                follow_up="What would you read there?",
                feedback_zh="可以补充一个具体例子。",
                outcome="expressed",
            )
        elif schema is ExpressionHelp:
            output = ExpressionHelp(english="I prefer reading in a quiet room.")
        elif schema is WritingFeedback:
            output = WritingFeedback(
                feedback_zh="意思清楚，可以补充日期。",
                corrections=[],
                suggestion_en="Could I reserve a room on Monday?",
                task_complete=True,
            )
        else:
            raise AssertionError(schema)
        if validate:
            validate(output)
        return output


@pytest.mark.asyncio
async def test_graph_preserves_source_and_checkpoints_independent_verification():
    gateway, context = Gateway(), Context()
    workflow = create_workflows(gateway)[0]
    result = await workflow.execute(context, LessonInput(source=source()))
    assert result.reading.passage == SOURCE
    blind = next(payload for schema, _, payload in gateway.calls if schema is BlindChecks)
    assert all("answer" not in q and "explanation" not in q for q in blind["questions"])
    assert "reading.blind.0" in context.checkpoints
    assert "reading.explanation.0" in context.checkpoints
    calls = len(gateway.calls)
    again = await workflow.execute(context, LessonInput(source=source()))
    assert again == result
    assert len(gateway.calls) == calls


@pytest.mark.asyncio
async def test_graph_repairs_only_failed_questions_and_reverifies_complete_set():
    gateway, context = Gateway(fail_once=True), Context()
    result = await create_workflows(gateway)[0].execute(context, LessonInput(source=source(3)))
    repair_payload = next(p for s, _, p in gateway.calls if s is Repairs)
    assert list(repair_payload["failures"]) == ["q1"]
    assert [q["id"] for q in repair_payload["questions"]] == ["q1"]
    assert result.reading.questions[1:] == reading().questions[1:]
    assert "reading.blind.1" in context.checkpoints


@pytest.mark.asyncio
async def test_failed_review_never_returns_partial_course():
    with pytest.raises(ValueError, match="failed independent verification"):
        await create_workflows(Gateway(always_fail=True))[0].execute(
            Context(), LessonInput(source=source())
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("stage", ["review", "repair"])
async def test_semantically_invalid_model_results_never_poison_checkpoints(stage):
    class InvalidOnce(Gateway):
        invalid = True

        async def generate(self, schema, instructions, payload, validate=None):
            output = await super().generate(schema, instructions, payload)
            if self.invalid and stage == "review" and schema is BlindChecks:
                output.checks.pop()
            if self.invalid and stage == "repair" and schema is Repairs:
                output.questions[0].evidence = "This sentence is not in the source."
            if validate:
                validate(output)
            return output

    gateway, context = InvalidOnce(fail_once=stage == "repair"), Context()
    workflow = create_workflows(gateway)[0]
    with pytest.raises(ValueError):
        await workflow.execute(context, LessonInput(source=source()))
    checkpoint = "reading.blind.0" if stage == "review" else "reading.repair.1"
    assert checkpoint not in context.checkpoints
    assert "reading.generate" in context.checkpoints
    gateway.invalid = False
    result = await workflow.execute(context, LessonInput(source=source()))
    assert result.reading.passage == SOURCE
    assert checkpoint in context.checkpoints


def test_grounding_unique_ids_and_source_part_are_enforced():
    draft = reading()
    draft.questions[0].evidence = "Invented quotation."
    with pytest.raises(ValueError, match="exact source quotation"):
        validate_reading(SOURCE, draft)
    draft = reading()
    draft.questions[0].id = draft.questions[1].id
    with pytest.raises(ValueError, match="unique"):
        validate_reading(SOURCE, draft)
    with pytest.raises(ValidationError):
        LessonInput(source=source(0))
    with pytest.raises(ValidationError):
        LessonInput(source=source(), target_band=7)
    assert len(set(PROFILES.values())) == 4


@pytest.mark.parametrize("separator", ["\n", "\r\n", "\t", "  ", "\u00a0"])
def test_reading_restores_contiguous_evidence_to_original_whitespace(separator):
    transcript = SOURCE.replace(". ", "." + separator)
    draft = reading()
    draft.questions[
        0
    ].evidence = "The Riverside library opens at nine. Visitors can borrow three books."
    validate_reading(transcript, draft)
    assert draft.questions[0].evidence == (
        "The Riverside library opens at nine." + separator + "Visitors can borrow three books."
    )
    assert all(question.evidence in transcript for question in draft.questions)
    assert draft.questions[1].answer == "three"


@pytest.mark.parametrize(
    "evidence",
    [
        "The Riverside library opens at ten.",
        "The Riverside library opens at nine. A reading club meets on Monday.",
        "The library opens at nine.",
        "The Riverside library opens at nine!",
    ],
)
def test_reading_still_rejects_changed_or_noncontiguous_quotations(evidence):
    transcript = SOURCE.replace(". ", ".\n")
    draft = reading()
    draft.questions[0].evidence = evidence
    with pytest.raises(ValueError, match="exact source quotation"):
        validate_reading(transcript, draft)


def test_source_quotation_does_not_mutate_passage_or_collapse_words():
    transcript = "A new library.\r\nOne quiet room."
    assert source_quotation(transcript, "A new library. One quiet room.") == transcript
    assert source_quotation(transcript, "Anew library.") == "Anew library."
    assert source_quotation(transcript, " ") == " "
    assert transcript == "A new library.\r\nOne quiet room."


@pytest.mark.asyncio
async def test_graph_checkpoints_original_multiline_quotation():
    class FlattenedEvidence(Gateway):
        async def generate(self, schema, instructions, payload, validate=None):
            output = await super().generate(schema, instructions, payload)
            if schema is ReadingDraft:
                output.questions[0].evidence += " " + output.questions[1].evidence
            if validate:
                validate(output)
            return output

    transcript = SOURCE.replace(". ", ".\n")
    context = Context()
    result = await create_workflows(FlattenedEvidence())[0].execute(
        context, LessonInput(source={**source(), "transcript": transcript})
    )
    assert result.reading.passage == transcript
    evidence = result.reading.questions[0].evidence
    assert "\n" in evidence and evidence in transcript
    assert context.checkpoints["reading.generate"]["questions"][0]["evidence"] == evidence
    assert "reading.blind.0" in context.checkpoints
    assert "reading.explanation.0" in context.checkpoints


@pytest.mark.asyncio
async def test_conversation_uses_latest_history_and_part_profile_for_every_turn():
    gateway = Gateway()
    value = TurnInput(
        source=source(4),
        lesson=lesson(),
        text="Why is it helpful?",
        history=[
            {
                "role": "assistant",
                "text": "A place to read.",
                "feedback": {"follow_up": "Would you go there?"},
            }
        ],
    )
    await create_workflows(gateway)[1].execute(Context(), value)
    _, instructions, payload = gateway.calls[-1]
    assert PROFILES[4] in instructions
    assert payload["previous_turns"][-1]["feedback"]["follow_up"] == "Would you go there?"
    assert payload["answer"] == "Why is it helpful?"


@pytest.mark.asyncio
async def test_real_pydantic_agent_structured_output_without_network():
    gateway = PydanticGateway(
        TestModel(custom_output_args={"english": "I enjoy reading.", "clarification_zh": ""})
    )
    result = await gateway.generate(
        ExpressionHelp, "Preserve the user's meaning.", {"text": "我喜欢阅读"}
    )
    assert result.english == "I enjoy reading."
    assert not result.clarification_zh


def test_expression_help_cannot_invent_both_answer_and_clarification():
    with pytest.raises(ValidationError):
        ExpressionHelp(english="I like books.", clarification_zh="你指什么？")


@pytest.mark.asyncio
async def test_writing_uses_selected_task_and_question_action():
    gateway = Gateway()
    value = TurnInput(
        source=source(),
        lesson=lesson(),
        text="Why use could?",
        level="challenge",
        action="question",
    )
    await create_workflows(gateway)[3].execute(Context(), value)
    payload = gateway.calls[-1][2]
    assert payload["task"]["level"] == "challenge"
    assert payload["action"] == "question"


def test_fixture_is_serializable_without_machine_paths():
    assert json.loads(lesson().model_dump_json())["reading"]["passage"] == SOURCE


@pytest.mark.asyncio
async def test_parallel_stage_drains_siblings_when_one_branch_fails():
    started, cancelled = asyncio.Event(), asyncio.Event()

    async def slow():
        started.set()
        try:
            await asyncio.Event().wait()
        finally:
            cancelled.set()

    async def fail():
        await started.wait()
        raise ValueError("Original fixture failure")

    with pytest.raises(ValueError, match="Original fixture failure"):
        await parallel(slow(), fail())
    assert cancelled.is_set()
