"""Persistent local speech-to-text worker for the JARVIS bridge.

Loads a faster-whisper model once and keeps it warm, then transcribes one audio
file per line read from stdin, writing one JSON object per line to stdout. Kept
warm on purpose: reloading the model per request is what makes local Whisper
feel slow, so the bridge spawns this once and streams paths to it.

Protocol:
  stdin  : one absolute audio-file path per line
  stdout : {"ready": true}            once, when the model is loaded
           {"text": "..."}            per transcribed path (text may be "")
           {"error": "..."}           if a single transcription failed

Model and compute type come from the environment so the bridge can tune them:
  JARVIS_WHISPER_MODEL   default "base.en"  (tiny.en is faster, small.en sharper)
  JARVIS_WHISPER_COMPUTE default "int8"     (int8 is fast on Apple Silicon CPU)
"""

import json
import os
import sys


def main() -> int:
    try:
        from faster_whisper import WhisperModel
    except Exception as exc:  # noqa: BLE001 - report and exit, the bridge falls back
        sys.stdout.write(json.dumps({"error": f"faster-whisper not available: {exc}"}) + "\n")
        sys.stdout.flush()
        return 1

    model_name = os.environ.get("JARVIS_WHISPER_MODEL", "base.en")
    compute = os.environ.get("JARVIS_WHISPER_COMPUTE", "int8")
    try:
        model = WhisperModel(model_name, device="cpu", compute_type=compute)
    except Exception as exc:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": f"could not load model {model_name}: {exc}"}) + "\n")
        sys.stdout.flush()
        return 1

    sys.stdout.write(json.dumps({"ready": True, "model": model_name}) + "\n")
    sys.stdout.flush()

    for line in sys.stdin:
        path = line.strip()
        if not path:
            continue
        try:
            # The browser's VAD already trimmed silence around the utterance, so
            # no vad_filter here (it would add an onnxruntime dependency for no
            # gain). English is pinned; JARVIS is spoken to in English.
            segments, _info = model.transcribe(path, language="en", beam_size=1)
            text = "".join(seg.text for seg in segments).strip()
            sys.stdout.write(json.dumps({"text": text}) + "\n")
        except Exception as exc:  # noqa: BLE001 - one bad clip must not kill the worker
            sys.stdout.write(json.dumps({"error": str(exc)}) + "\n")
        finally:
            sys.stdout.flush()
            try:
                os.unlink(path)
            except OSError:
                pass

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
