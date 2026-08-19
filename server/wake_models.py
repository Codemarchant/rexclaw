# Copyright 2026 Codemarchant
"""Vosk wake-word model catalogue: language -> alphacephei model name.

Deliberately dependency-free: imported by the runtime download path
(routes/misc.py) AND by scripts/fetch_wake_model.py, which runs on bare CI
runners and during the Docker build where the server's dependencies may not
be importable side-effect-free."""

WAKE_MODELS = {
    "en": "vosk-model-small-en-us-0.15",
    "ja": "vosk-model-small-ja-0.22",
    "de": "vosk-model-small-de-0.15",
    "fr": "vosk-model-small-fr-0.22",
    "es": "vosk-model-small-es-0.42",
    "zh": "vosk-model-small-cn-0.22",
    "ru": "vosk-model-small-ru-0.22",
    "pt": "vosk-model-small-pt-0.3",
}
