import gzip
import time

import httpx
from fastapi.testclient import TestClient
from pydantic_ai.models.test import TestModel

from ielts_learning.app import build_app
from ielts_learning.gateway import PydanticGateway

TOKEN = "original-internal-test-token-32-characters"
AUTH = {"Authorization": "Bearer " + TOKEN}


def test_capabilities_and_speech_require_internal_auth_and_explicit_configuration(tmp_path):
    app = build_app(
        gateway=PydanticGateway(None), database_path=tmp_path / "runs.sqlite", token=TOKEN
    )
    with TestClient(app) as client:
        assert client.get("/capabilities").status_code == 401
        assert client.get("/health").status_code == 401
        version = client.get("/health", headers=AUTH)
        assert version.status_code == 200
        assert version.json()["service"] == "ielts-learning"
        assert version.json()["version"]
        assert client.get("/capabilities", headers=AUTH).json() == {
            "model": False,
            "asr": False,
            "tts": False,
        }
        assert client.post("/speech/transcribe", headers=AUTH, content=b"test").status_code == 503
        assert (
            client.post("/speech/synthesize", headers=AUTH, json={"text": "Hello"}).status_code
            == 503
        )


def test_speech_passes_bytes_to_configured_gateway_without_url_fetch(tmp_path, monkeypatch):
    monkeypatch.setenv("IELTS_LLM_BASE_URL", "https://gateway.example.invalid/v1")
    monkeypatch.setenv("IELTS_LLM_API_KEY", "original-synthetic-secret")
    monkeypatch.setenv("IELTS_ASR_MODEL", "original-asr")
    monkeypatch.setenv("IELTS_TTS_MODEL", "original-tts")
    calls = []

    def handler(request):
        calls.append(request)
        if request.url.path.endswith("transcriptions"):
            return httpx.Response(
                200,
                content=gzip.compress(b'{"text":"I enjoy the library."}'),
                headers={"Content-Encoding": "gzip", "Content-Type": "application/json"},
            )
        return httpx.Response(
            200, content=b"original-synthetic-audio", headers={"Content-Type": "audio/mpeg"}
        )

    app = build_app(
        gateway=PydanticGateway(None),
        database_path=tmp_path / "runs.sqlite",
        token=TOKEN,
        speech_transport=httpx.MockTransport(handler),
    )
    with TestClient(app) as client:
        assert (
            client.post(
                "/speech/transcribe", headers={**AUTH, "Content-Type": "text/html"}, content=b"data"
            ).status_code
            == 415
        )
        response = client.post(
            "/speech/transcribe",
            headers={**AUTH, "Content-Type": "audio/wav"},
            content=b"original-synthetic-audio",
        )
        assert response.json() == {"text": "I enjoy the library."}
        response = client.post("/speech/synthesize", headers=AUTH, json={"text": "Hello there."})
        assert response.headers["content-type"] == "audio/mpeg"
        assert response.content == b"original-synthetic-audio"
        assert len(calls) == 2


def test_speech_gateway_errors_do_not_disclose_transcripts_or_keys(tmp_path, monkeypatch):
    monkeypatch.setenv("IELTS_LLM_BASE_URL", "https://gateway.example.invalid/v1")
    monkeypatch.setenv("IELTS_LLM_API_KEY", "original-synthetic-secret")
    monkeypatch.setenv("IELTS_ASR_MODEL", "original-asr")
    app = build_app(
        gateway=PydanticGateway(None),
        database_path=tmp_path / "runs.sqlite",
        token=TOKEN,
        speech_transport=httpx.MockTransport(
            lambda request: httpx.Response(500, text="private transcript and secret")
        ),
    )
    with TestClient(app) as client:
        response = client.post(
            "/speech/transcribe",
            headers={**AUTH, "Content-Type": "audio/wav"},
            content=b"original-synthetic-audio",
        )
        assert response.status_code == 502
        assert "private transcript" not in response.text
        assert "synthetic-secret" not in response.text


def test_dictation_run_uses_authenticated_runtime_and_offline_model(tmp_path):
    gateway = PydanticGateway(
        TestModel(
            custom_output_args={
                "feedback_zh": "漏写了 a。",
                "practice_zh": "重听 bring a notebook。",
            }
        )
    )
    app = build_app(gateway=gateway, database_path=tmp_path / "runs.sqlite", token=TOKEN)
    body = {
        "owner_id": "original-owner",
        "workflow": "ielts.dictation",
        "version": "1",
        "idempotency_key": "original-dictation-1",
        "input": {"reference": "Please bring a notebook.", "text": "Please bring notebook."},
    }
    with TestClient(app) as client:
        assert client.post("/runs", json=body).status_code == 401
        response = client.post("/runs", headers=AUTH, json=body)
        assert response.status_code == 200
        run = response.json()
        deadline = time.monotonic() + 5
        while run["status"] not in {"succeeded", "failed"} and time.monotonic() < deadline:
            time.sleep(0.02)
            run = client.get(
                f"/runs/{run['id']}", headers={**AUTH, "X-Owner-Id": "original-owner"}
            ).json()
        assert run["status"] == "succeeded", run
        assert run["output"]["feedback_zh"] == "漏写了 a。"
        assert client.post("/runs", headers=AUTH, json=body).json()["id"] == run["id"]
        assert (
            client.get(
                f"/runs/{run['id']}", headers={**AUTH, "X-Owner-Id": "other-owner"}
            ).status_code
            == 404
        )
