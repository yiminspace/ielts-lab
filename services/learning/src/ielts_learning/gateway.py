from __future__ import annotations

import asyncio
import json
import os
from collections.abc import Callable
from typing import TypeVar

import httpx
from pydantic import BaseModel
from pydantic_ai import Agent, ModelRetry
from pydantic_ai.models import Model
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.openai_compatible import OpenAICompatibleProvider

T = TypeVar("T", bound=BaseModel)


class PydanticGateway:
    """One replaceable model adapter; teaching instructions stay in the domain."""

    def __init__(
        self,
        model: Model | str | None,
        model_settings: dict | None = None,
        client: httpx.AsyncClient | None = None,
    ):
        self.model = model
        self.model_settings = model_settings or {}
        self.client = client

    async def close(self):
        if self.client is not None:
            await self.client.aclose()

    async def generate(
        self,
        schema: type[T],
        instructions: str,
        payload: dict,
        validate: Callable[[T], None] | None = None,
    ) -> T:
        if self.model is None:
            raise RuntimeError("The learning model is not configured")
        budgets = {
            "ExpressionPlan": 2500,
            "ConversationReply": 1000,
            "ExpressionHelp": 1000,
            "WritingFeedback": 2500,
            "BlindChecks": 3500,
            "ExplanationChecks": 3500,
        }
        agent = Agent(
            self.model,
            output_type=schema,
            instructions=instructions,
            retries=2,
            model_settings={
                "max_tokens": budgets.get(schema.__name__, 14000),
                **self.model_settings,
            },
        )
        if validate is not None:

            @agent.output_validator
            def check(output: T) -> T:
                try:
                    validate(output)
                except ValueError as error:
                    raise ModelRetry(str(error)) from error
                return output

        async with asyncio.timeout(120):
            result = await agent.run(json.dumps(payload, ensure_ascii=False))
        return result.output


def gateway_from_env() -> PydanticGateway:
    name = os.getenv("IELTS_MODEL")
    base_url = os.getenv("IELTS_LLM_BASE_URL")
    api_key = os.getenv("IELTS_LLM_API_KEY")
    if not name or not base_url or not api_key:
        return PydanticGateway(None)
    settings = {"extra_headers": {"x-bf-vk": api_key}}
    if name.startswith("ark-agent-plan/deepseek-"):
        settings["extra_headers"]["x-bf-passthrough-extra-params"] = "true"
        settings["extra_body"] = {"thinking": {"type": "disabled"}}
    client = httpx.AsyncClient(timeout=httpx.Timeout(90, connect=10), follow_redirects=False)
    return PydanticGateway(
        OpenAIChatModel(
            name,
            provider=OpenAICompatibleProvider(
                "ielts-gateway", base_url=base_url, api_key=api_key, http_client=client
            ),
        ),
        settings,
        client,
    )
