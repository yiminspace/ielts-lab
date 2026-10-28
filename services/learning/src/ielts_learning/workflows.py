from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, field

from agent_runtime import Workflow, WorkflowContext
from pydantic_graph import BaseNode, End, GraphBuilder, GraphRunContext

from .gateway import PydanticGateway
from .models import (
    BlindChecks,
    ConversationReply,
    ExplanationChecks,
    ExpressionHelp,
    ExpressionPlan,
    Lesson,
    LessonInput,
    Reading,
    ReadingDraft,
    Repairs,
    TurnInput,
    WritingFeedback,
)
from .profiles import profile

WORKFLOW_VERSION = "1"
PROMPT_VERSION = "2026-10-28.1"


async def parallel(*coroutines):
    """A failed stage must cancel and drain its siblings before releasing the run lease."""
    tasks = [asyncio.create_task(coroutine) for coroutine in coroutines]
    try:
        return await asyncio.gather(*tasks)
    except BaseException:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        raise


READING = """Generate a complete reading exercise from the supplied transcript. Preserve the
whole source as the passage (the program inserts it); provide a faithful complete Chinese translation.
Use the requested question count and at least two of choice, true_false, gap. IDs must be stable
distinct strings. For each question, evidence must be an exact contiguous quotation from the
transcript, at most four adjacent sentences. Explain the answer in Chinese using that evidence.
Choice: 3-5 distinct English options; answer is the option text, not its index. true_false: exactly
[True, False, Not Given]; answer is one of those labels. For Not Given distinguish a missing fact
from an irrelevant passage; include the relevant surrounding context as evidence. Gap: no options,
one unambiguous answer copied exactly from the source, respect max_words, no alternative spellings
or slash-separated answers. Avoid outside knowledge, ambiguous questions and invented details.
"""

EXPRESSIONS = """Create an English-language conversation opening and three optional writing
tasks grounded in the transcript's topic. Conversation is free exchange: one approachable question,
its Chinese meaning and 1-3 optional English starters. Do not script future replies or require a
specific answer. Writing tasks each have level basic, extension, challenge; use the SAME topic but
a DIFFERENT purpose or information need from the conversation. Basic asks for 1-2 sentences,
extension 2-3, challenge 3-5; no essay or spoken-answer transcription. Each has instruction, meaning
goal and useful optional hints; accept equivalent wording. Title should describe the topic.
"""


def question_range(source: str) -> tuple[int, int]:
    count = len(source.split())
    return (5, 7) if count < 400 else (8, 10) if count < 700 else (13, 14)


def validate_reading(source: str, draft: ReadingDraft) -> None:
    low, high = question_range(source)
    if not low <= len(draft.questions) <= high:
        raise ValueError(f"Use {low}-{high} questions for this source length")
    ids = [question.id for question in draft.questions]
    if len(set(ids)) != len(ids):
        raise ValueError("Question IDs must be unique")
    if len({question.kind for question in draft.questions}) < 2:
        raise ValueError("Use at least two question types")
    for question in draft.questions:
        if question.evidence not in source:
            raise ValueError(f"{question.id}: evidence must be an exact source quotation")
        sentences = re.split(r"(?<=[.!?])\s+", question.evidence)
        if len(sentences) > 4:
            raise ValueError(f"{question.id}: evidence must have at most four adjacent sentences")
        if question.kind == "gap" and question.answer not in question.evidence:
            raise ValueError(f"{question.id}: gap answer must occur exactly in its evidence")


@dataclass
class LessonState:
    input: LessonInput
    runtime: WorkflowContext
    gateway: PydanticGateway
    reading: ReadingDraft | None = None
    expressions: ExpressionPlan | None = None
    failed: dict[str, str] = field(default_factory=dict)
    repair: int = 0


@dataclass
class Generate(BaseNode[LessonState, None, Lesson]):
    async def run(self, ctx: GraphRunContext[LessonState]) -> Verify:
        state = ctx.state
        source = state.input.source
        instructions = profile(source.part)
        payload = {
            "source": source.model_dump(),
            "question_count": question_range(source.transcript),
            "prompt_version": PROMPT_VERSION,
        }

        async def reading():
            result = await state.gateway.generate(
                ReadingDraft,
                instructions + READING,
                payload,
                lambda output: validate_reading(source.transcript, output),
            )
            return result.model_dump(mode="json")

        async def expressions():
            result = await state.gateway.generate(
                ExpressionPlan, instructions + EXPRESSIONS, payload
            )
            return result.model_dump(mode="json")

        draft, plan = await parallel(
            state.runtime.step("reading.generate", reading),
            state.runtime.step("expressions.generate", expressions),
        )
        state.reading = ReadingDraft.model_validate(draft)
        state.expressions = ExpressionPlan.model_validate(plan)
        return Verify()


@dataclass
class Verify(BaseNode[LessonState, None, Lesson]):
    async def run(self, ctx: GraphRunContext[LessonState]) -> Repair | End[Lesson]:
        state = ctx.state
        assert state.reading is not None and state.expressions is not None
        source = state.input.source
        validate_reading(source.transcript, state.reading)
        blind_questions = [
            question.model_dump(exclude={"answer", "explanation"})
            for question in state.reading.questions
        ]
        payload = {"source": source.transcript, "questions": blind_questions}

        def complete_review(output):
            expected = {question.id for question in state.reading.questions}
            if (
                len(output.checks) != len(expected)
                or {check.id for check in output.checks} != expected
            ):
                raise ValueError("Check every supplied question ID exactly once")

        async def blind():
            result = await state.gateway.generate(
                BlindChecks,
                "Independently answer every question from the source. You have no answer key. "
                "Return each supplied id exactly once, your answer as option text or exact gap words, "
                "whether evidence is sufficient, and your reasoning. A Not Given answer requires "
                "absence of the asked fact in the full passage, not just the quoted context.",
                payload,
                complete_review,
            )
            return result.model_dump(mode="json")

        async def explanation():
            result = await state.gateway.generate(
                ExplanationChecks,
                "Independently check EVERY supplied answer and Chinese explanation against the "
                "full source and cited evidence. Return each supplied id exactly once. Mark supported "
                "only when the answer is uniquely justified and the explanation faithfully explains it.",
                {
                    "source": source.transcript,
                    "questions": [question.model_dump() for question in state.reading.questions],
                },
                complete_review,
            )
            return result.model_dump(mode="json")

        blind_raw, explanations_raw = await parallel(
            state.runtime.step(f"reading.blind.{state.repair}", blind),
            state.runtime.step(f"reading.explanation.{state.repair}", explanation),
        )
        checks = BlindChecks.model_validate(blind_raw).checks
        explanations = ExplanationChecks.model_validate(explanations_raw).checks
        expected_ids = {question.id for question in state.reading.questions}
        if (
            len(checks) != len(expected_ids)
            or {check.id for check in checks} != expected_ids
            or len(explanations) != len(expected_ids)
            or {check.id for check in explanations} != expected_ids
        ):
            raise ValueError("Independent reviewers did not check every question exactly once")
        by_id = {check.id: check for check in checks}
        reasons = {check.id: check for check in explanations}
        normalize = lambda text: " ".join(text.casefold().replace("’", "'").split())
        state.failed = {}
        for question in state.reading.questions:
            check, reason = by_id[question.id], reasons[question.id]
            if (
                normalize(check.answer) != normalize(question.answer)
                or not check.evidence_sufficient
                or not reason.supported
            ):
                state.failed[question.id] = check.reason + "; " + reason.reason
        if state.failed:
            if state.repair >= 2:
                raise ValueError("The reading exercise failed independent verification")
            return Repair()
        return End(
            Lesson(
                **state.expressions.model_dump(),
                reading=Reading(passage=source.transcript, **state.reading.model_dump()),
            )
        )


@dataclass
class Repair(BaseNode[LessonState, None, Lesson]):
    async def run(self, ctx: GraphRunContext[LessonState]) -> Verify:
        state = ctx.state
        assert state.reading is not None
        state.repair += 1

        def valid_repairs(output: Repairs):
            if {question.id for question in output.questions} != set(state.failed) or len(
                output.questions
            ) != len(state.failed):
                raise ValueError("Repair must replace exactly the failed question IDs")
            replacements = {question.id: question for question in output.questions}
            candidate = ReadingDraft(
                translation=state.reading.translation,
                questions=[
                    replacements.get(question.id, question) for question in state.reading.questions
                ],
            )
            validate_reading(state.input.source.transcript, candidate)

        async def repair():
            output = await state.gateway.generate(
                Repairs,
                profile(state.input.source.part)
                + READING
                + "Repair ONLY the failed question IDs. Keep their IDs; all other questions are frozen.",
                {
                    "source": state.input.source.transcript,
                    "failures": state.failed,
                    "questions": [
                        question.model_dump()
                        for question in state.reading.questions
                        if question.id in state.failed
                    ],
                },
                valid_repairs,
            )
            valid_repairs(output)
            return output.model_dump(mode="json")

        raw = await state.runtime.step(f"reading.repair.{state.repair}", repair)
        repaired = {question.id: question for question in Repairs.model_validate(raw).questions}
        state.reading.questions = [
            repaired.get(question.id, question) for question in state.reading.questions
        ]
        return Verify()


builder = GraphBuilder(state_type=LessonState, input_type=Generate, output_type=Lesson)
builder.add(
    builder.edge_from(builder.start_node).to(Generate),
    builder.node(Generate),
    builder.node(Verify),
    builder.node(Repair),
)
lesson_graph = builder.build()


def create_workflows(gateway: PydanticGateway) -> list[Workflow]:
    async def lesson(ctx: WorkflowContext, value: LessonInput) -> Lesson:
        async with asyncio.timeout(270):
            return await lesson_graph.run(inputs=Generate(), state=LessonState(value, ctx, gateway))

    def payload(value: TurnInput) -> dict:
        return {
            "source": value.source.model_dump(),
            "lesson": value.lesson.model_dump(),
            "answer": value.text,
            "previous_turns": value.history[-12:],
            "received_help": value.received_help,
            "prompt_version": PROMPT_VERSION,
        }

    async def conversation(ctx: WorkflowContext, value: TurnInput) -> ConversationReply:
        async def generate():
            result = await gateway.generate(
                ConversationReply,
                profile(value.source.part)
                + """
You are the learner's English conversation partner. Continue previous_turns and respond to the
latest answer or question, following topic changes naturally. First turn uses the lesson opening;
later turns follow the most recent follow_up. reply_en is YOUR direct response in 1-3 natural
English sentences, never a rewrite of the student's answer. follow_up is ONE natural question
that invites continuation; avoid asking already answered questions. feedback_zh briefly helps
understanding and, only when useful, explains at most ONE concrete expression improvement.
Allow mixed Chinese/English help and clarify ambiguous meaning. Use outcome expressed when
meaning was communicated in English, needs_support for language help, unclear for ambiguity.
Outcome does not finish the conversation. Do not invent either person's real experiences.
""",
                payload(value),
            )
            return result.model_dump(mode="json")

        return ConversationReply.model_validate(await ctx.step("conversation.reply", generate))

    async def expression(ctx: WorkflowContext, value: TurnInput) -> ExpressionHelp:
        async def generate():
            result = await gateway.generate(
                ExpressionHelp,
                profile(value.source.part)
                + """
Help the learner express THEIR intended meaning in natural spoken English. Use history for
references. Preserve first person, facts, quantities, attitude and reasons. Add no invented details.
Return only english when meaning is clear; otherwise only clarification_zh asking for missing
information. This is a faithful restatement, not the partner's answer or a new question.
""",
                payload(value),
            )
            return result.model_dump(mode="json")

        return ExpressionHelp.model_validate(await ctx.step("expression.help", generate))

    async def writing(ctx: WorkflowContext, value: TurnInput) -> WritingFeedback:
        async def generate():
            task = next(task for task in value.lesson.writing.tasks if task.level == value.level)

            def validate(output: WritingFeedback):
                if any(correction.original not in value.text for correction in output.corrections):
                    raise ValueError("Each correction must quote the learner's actual text")

            result = await gateway.generate(
                WritingFeedback,
                profile(value.source.part)
                + """
Review the learner's actual writing against the selected task's meaning goal. Explain language
issues concretely in Chinese; quote actual text in corrections, preserve facts and intention.
Distinguish errors from optional stylistic suggestions. Accept natural equivalent wording.
Do not require a template or a specific vocabulary item, or assign an official IELTS score.
For action=question, directly answer the learner's grammar/expression question using history,
with corrections empty and a useful optional example. Never invent missing learner sentences.
""",
                {**payload(value), "task": task.model_dump(), "action": value.action},
                validate,
            )
            return result.model_dump(mode="json")

        return WritingFeedback.model_validate(await ctx.step("writing.feedback", generate))

    return [
        Workflow(
            name="ielts.lesson",
            version=WORKFLOW_VERSION,
            input_type=LessonInput,
            output_type=Lesson,
            execute=lesson,
        ),
        Workflow(
            name="ielts.conversation",
            version=WORKFLOW_VERSION,
            input_type=TurnInput,
            output_type=ConversationReply,
            execute=conversation,
        ),
        Workflow(
            name="ielts.expression",
            version=WORKFLOW_VERSION,
            input_type=TurnInput,
            output_type=ExpressionHelp,
            execute=expression,
        ),
        Workflow(
            name="ielts.writing",
            version=WORKFLOW_VERSION,
            input_type=TurnInput,
            output_type=WritingFeedback,
            execute=writing,
        ),
    ]
