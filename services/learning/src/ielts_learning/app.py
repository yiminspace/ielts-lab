from __future__ import annotations

import hmac
import os
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from agent_runtime import create_app
from fastapi import HTTPException, Request, Response
from pydantic import BaseModel, Field

from .gateway import PydanticGateway, gateway_from_env
from .workflows import create_workflows

MAX_AUDIO = 32 * 1024 * 1024
AUDIO_TYPES = {
    "audio/webm": "webm",
    "audio/ogg": "ogg",
    "audio/mp4": "m4a",
    "audio/m4a": "m4a",
    "audio/x-m4a": "m4a",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/mpeg": "mp3",
}


class SpeechText(BaseModel):
    text: str = Field(min_length=1, max_length=6000)


def build_app(
    *,
    gateway: PydanticGateway | None = None,
    database_path: str | Path | None = None,
    token: str | None = None,
    speech_transport: httpx.AsyncBaseTransport | None = None,
):
    gateway = gateway or gateway_from_env()
    token = token or os.getenv("IELTS_RUNTIME_TOKEN", "")
    if len(token) < 32:
        raise ValueError("IELTS_RUNTIME_TOKEN must contain at least 32 characters")
    app = create_app(
        workflows=create_workflows(gateway),
        database_path=str(database_path or os.getenv("RUNTIME_DATABASE", ".local/runtime.sqlite")),
        token=token,
        request_body_limits={"/speech/transcribe": MAX_AUDIO},
    )
    runtime_lifespan = app.router.lifespan_context

    @asynccontextmanager
    async def lifespan(application):
        try:
            async with runtime_lifespan(application):
                yield
        finally:
            await gateway.close()

    app.router.lifespan_context = lifespan

    def authorize(request: Request):
        supplied = request.headers.get("authorization", "")
        if not hmac.compare_digest(supplied, "Bearer " + token):
            raise HTTPException(401, "Internal service authentication required")

    @app.get("/capabilities")
    async def capabilities(request: Request):
        authorize(request)
        configured = bool(os.getenv("IELTS_LLM_BASE_URL") and os.getenv("IELTS_LLM_API_KEY"))
        return {
            "model": gateway.model is not None,
            "asr": configured and bool(os.getenv("IELTS_ASR_MODEL")),
            "tts": configured and bool(os.getenv("IELTS_TTS_MODEL")),
        }

    async def speech_request(endpoint: str, **kwargs) -> httpx.Response:
        base = os.getenv("IELTS_LLM_BASE_URL", "").rstrip("/")
        key = os.getenv("IELTS_LLM_API_KEY", "")
        if not base or not key:
            raise HTTPException(503, "Speech service is not configured")
        try:
            async with (
                httpx.AsyncClient(
                    timeout=httpx.Timeout(90, connect=10),
                    transport=speech_transport,
                    follow_redirects=False,
                ) as client,
                client.stream(
                    "POST",
                    base + "/" + endpoint,
                    headers={"Authorization": "Bearer " + key, "x-bf-vk": key},
                    **kwargs,
                ) as response,
            ):
                response.raise_for_status()
                chunks, size = [], 0
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_AUDIO:
                        raise HTTPException(502, "Speech service response is too large")
                    chunks.append(chunk)
                return httpx.Response(
                    response.status_code,
                    # aiter_bytes has already decompressed the upstream payload.
                    headers={
                        key: value
                        for key, value in response.headers.items()
                        if key.lower()
                        not in {"content-encoding", "content-length", "transfer-encoding"}
                    },
                    content=b"".join(chunks),
                    request=response.request,
                )
        except httpx.HTTPError:
            # Gateway errors can contain keys, prompts or transcripts. Do not echo them.
            raise HTTPException(502, "Speech service temporarily unavailable") from None

    @app.post("/speech/transcribe")
    async def transcribe(request: Request):
        authorize(request)
        model = os.getenv("IELTS_ASR_MODEL")
        if not model:
            raise HTTPException(503, "Speech recognition is not configured")
        content_type = request.headers.get("content-type", "").split(";", 1)[0].lower()
        if content_type not in AUDIO_TYPES:
            raise HTTPException(415, "Unsupported audio content type")
        chunks, size = [], 0
        async for chunk in request.stream():
            size += len(chunk)
            if size > MAX_AUDIO:
                raise HTTPException(413, "Audio exceeds 32 MiB")
            chunks.append(chunk)
        if not size:
            raise HTTPException(400, "Audio is empty")
        response = await speech_request(
            "audio/transcriptions",
            data={"model": model},
            files={
                "file": ("recording." + AUDIO_TYPES[content_type], b"".join(chunks), content_type)
            },
        )
        try:
            text = response.json()["text"]
            if not isinstance(text, str) or not text.strip() or len(text) > 12000:
                raise ValueError
        except (ValueError, KeyError):
            raise HTTPException(502, "Speech recognition returned no usable text") from None
        return {"text": text.strip()}

    @app.post("/speech/synthesize")
    async def synthesize(request: Request, value: SpeechText):
        authorize(request)
        model = os.getenv("IELTS_TTS_MODEL")
        if not model:
            raise HTTPException(503, "Speech synthesis is not configured")
        response = await speech_request(
            "audio/speech",
            json={
                "model": model,
                "input": value.text,
                "voice": os.getenv("IELTS_TTS_VOICE", "alloy"),
                "response_format": "mp3",
            },
        )
        content_type = response.headers.get("content-type", "").split(";", 1)[0]
        if content_type not in AUDIO_TYPES or not response.content:
            raise HTTPException(502, "Speech synthesis returned invalid audio")
        return Response(
            response.content,
            media_type=content_type,
            headers={"Cache-Control": "private, no-store"},
        )

    return app
