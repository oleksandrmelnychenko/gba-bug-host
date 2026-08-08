#!/usr/bin/env python3
import json
import os
import sys


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: transcribe-local.py <audio-file>")

    from faster_whisper import WhisperModel

    model_name = os.environ.get("VOICE_TRANSCRIBE_MODEL", "base")
    device = os.environ.get("VOICE_TRANSCRIBE_DEVICE", "cpu")
    compute_type = os.environ.get("VOICE_TRANSCRIBE_COMPUTE_TYPE", "int8")
    cache_directory = os.environ.get("WHISPER_CACHE_DIR")
    model_options = {
        "device": device,
        "compute_type": compute_type,
    }
    if cache_directory:
        model_options["download_root"] = cache_directory

    model = WhisperModel(model_name, **model_options)
    segments, info = model.transcribe(
        sys.argv[1],
        language="uk",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=True,
        initial_prompt=(
            "Український QA баг-репорт для GBA Console. "
            "Технічні терміни: URL, HTTP, API, request, response, payload."
        ),
    )
    text = "".join(segment.text for segment in segments).strip()
    print(json.dumps({"text": text, "language": info.language}, ensure_ascii=False))


if __name__ == "__main__":
    main()
