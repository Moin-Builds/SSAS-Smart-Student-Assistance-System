"""Server-side client for Gemini Developer API text generation."""

from typing import Any

import httpx

from backend.app.config import settings


class GeminiAPIError(Exception):
    """A provider error safe to translate into an API response."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code


def generate_text(
    messages: list[dict[str, str]],
    *,
    max_tokens: int,
    json_mode: bool = False,
) -> str:
    api_key = settings.GEMINI_API_KEY.strip()
    if not api_key or api_key == "your_gemini_api_key_here":
        raise GeminiAPIError(
            503,
            "Gemini is not configured. Add GEMINI_API_KEY from Google AI Studio to backend/.env, then restart the backend.",
        )

    system_instructions = [
        message["content"]
        for message in messages
        if message.get("role") == "system" and message.get("content")
    ]
    contents = [
        {
            "role": "model" if message.get("role") == "assistant" else "user",
            "parts": [{"text": message["content"]}],
        }
        for message in messages
        if message.get("role") in {"user", "assistant"} and message.get("content")
    ]
    if not contents:
        raise ValueError("Gemini requests require at least one user message.")

    body: dict[str, Any] = {
        "contents": contents,
        "generationConfig": {
            "temperature": 0.2,
            "maxOutputTokens": max_tokens,
        },
    }
    if system_instructions:
        body["systemInstruction"] = {
            "parts": [{"text": "\n\n".join(system_instructions)}],
        }
    if json_mode:
        body["generationConfig"]["responseMimeType"] = "application/json"

    url = (
        "https://generativelanguage.googleapis.com/v1beta/"
        f"models/{settings.GEMINI_MODEL}:generateContent"
    )
    try:
        response = httpx.post(
            url,
            headers={"x-goog-api-key": api_key},
            json=body,
            timeout=90.0,
        )
    except httpx.TimeoutException as exc:
        raise GeminiAPIError(504, "Gemini timed out. Please try again.") from exc
    except httpx.HTTPError as exc:
        raise GeminiAPIError(502, "Could not connect to Gemini. Please try again.") from exc

    if response.status_code in (401, 403):
        raise GeminiAPIError(
            503,
            "The Gemini API key was rejected. Check GEMINI_API_KEY in backend/.env.",
        )
    if response.status_code == 400:
        try:
            provider_message = response.json().get("error", {}).get("message", "").lower()
        except (AttributeError, TypeError, ValueError):
            provider_message = ""
        if "api key" in provider_message and any(
            phrase in provider_message for phrase in ("invalid", "not valid", "expired")
        ):
            raise GeminiAPIError(
                503,
                "The Gemini API key was rejected. Check GEMINI_API_KEY in backend/.env.",
            )
    if response.status_code == 429:
        raise GeminiAPIError(
            429,
            "Gemini's request or free-tier quota limit was reached. Wait and try again, or check your Google AI Studio usage limits.",
        )
    if response.status_code >= 500:
        raise GeminiAPIError(502, "Gemini is temporarily unavailable. Please try again.")
    if not response.is_success:
        raise GeminiAPIError(
            502,
            f"Gemini rejected the request (HTTP {response.status_code}). Check the configured model and request.",
        )

    try:
        payload = response.json()
        text = "".join(
            part["text"]
            for candidate in payload["candidates"]
            for part in candidate.get("content", {}).get("parts", [])
            if isinstance(part.get("text"), str)
        ).strip()
    except (KeyError, TypeError, ValueError) as exc:
        raise GeminiAPIError(502, "Gemini returned an unreadable response.") from exc

    if not text:
        raise GeminiAPIError(
            502,
            "Gemini returned no text. The response may have been blocked; try rephrasing the request.",
        )
    return text
