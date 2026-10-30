import httpx
import pytest

from backend.app import gemini_service


def _configure_key(monkeypatch):
    monkeypatch.setattr(gemini_service.settings, "GEMINI_API_KEY", "unit-test-key")
    monkeypatch.setattr(gemini_service.settings, "GEMINI_MODEL", "gemini-test-model")


def test_generate_text_builds_gemini_request(monkeypatch):
    _configure_key(monkeypatch)
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update(url=url, headers=headers, body=json, timeout=timeout)
        return httpx.Response(
            200,
            json={
                "candidates": [
                    {"content": {"parts": [{"text": '{"title":"Study set"}'}]}}
                ]
            },
        )

    monkeypatch.setattr(gemini_service.httpx, "post", fake_post)
    result = gemini_service.generate_text(
        [
            {"role": "system", "content": "Use only supplied notes."},
            {"role": "user", "content": "Return a JSON object."},
        ],
        max_tokens=300,
        json_mode=True,
    )

    assert result == '{"title":"Study set"}'
    assert captured["url"].endswith("/models/gemini-test-model:generateContent")
    assert captured["headers"] == {"x-goog-api-key": "unit-test-key"}
    assert captured["body"]["systemInstruction"]["parts"][0]["text"] == "Use only supplied notes."
    assert captured["body"]["contents"] == [
        {"role": "user", "parts": [{"text": "Return a JSON object."}]}
    ]
    assert captured["body"]["generationConfig"]["responseMimeType"] == "application/json"
    assert captured["body"]["generationConfig"]["maxOutputTokens"] == 300


@pytest.mark.parametrize(
    ("provider_status", "expected_status", "message"),
    [
        (401, 503, "API key was rejected"),
        (403, 503, "API key was rejected"),
        (429, 429, "quota limit was reached"),
        (500, 502, "temporarily unavailable"),
    ],
)
def test_provider_errors_are_actionable(
    monkeypatch, provider_status, expected_status, message
):
    _configure_key(monkeypatch)
    monkeypatch.setattr(
        gemini_service.httpx,
        "post",
        lambda *_args, **_kwargs: httpx.Response(provider_status, text="provider detail"),
    )

    with pytest.raises(gemini_service.GeminiAPIError) as error:
        gemini_service.generate_text(
            [{"role": "user", "content": "Question"}],
            max_tokens=100,
        )

    assert error.value.status_code == expected_status
    assert message in str(error.value)
    assert "provider detail" not in str(error.value)


def test_invalid_key_message_in_bad_request_is_actionable(monkeypatch):
    _configure_key(monkeypatch)
    monkeypatch.setattr(
        gemini_service.httpx,
        "post",
        lambda *_args, **_kwargs: httpx.Response(
            400,
            json={"error": {"message": "API key not valid. Please pass a valid API key."}},
        ),
    )

    with pytest.raises(gemini_service.GeminiAPIError) as error:
        gemini_service.generate_text(
            [{"role": "user", "content": "Question"}],
            max_tokens=100,
        )

    assert error.value.status_code == 503
    assert "API key was rejected" in str(error.value)


def test_missing_api_key_fails_before_network_request(monkeypatch):
    monkeypatch.setattr(gemini_service.settings, "GEMINI_API_KEY", "")
    monkeypatch.setattr(
        gemini_service.httpx,
        "post",
        lambda *_args, **_kwargs: pytest.fail("request must not be sent without a key"),
    )

    with pytest.raises(gemini_service.GeminiAPIError) as error:
        gemini_service.generate_text(
            [{"role": "user", "content": "Question"}],
            max_tokens=100,
        )

    assert error.value.status_code == 503
    assert "GEMINI_API_KEY" in str(error.value)


def test_invalid_response_shape_is_reported(monkeypatch):
    _configure_key(monkeypatch)
    monkeypatch.setattr(
        gemini_service.httpx,
        "post",
        lambda *_args, **_kwargs: httpx.Response(200, json={"candidates": []}),
    )

    with pytest.raises(gemini_service.GeminiAPIError, match="returned no text"):
        gemini_service.generate_text(
            [{"role": "user", "content": "Question"}],
            max_tokens=100,
        )
