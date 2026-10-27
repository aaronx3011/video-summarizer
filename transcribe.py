import json
import sys

from faster_whisper import WhisperModel

video_path, output_path, duration_seconds = sys.argv[1:4]
duration_seconds = float(duration_seconds)


def emit(event):
    print(json.dumps(event), flush=True)

# int8 is the highest-quality practical configuration for this CPU-only machine.
emit({"type": "log", "message": "Loading Whisper large-v3 model..."})
model = WhisperModel("large-v3", device="cpu", compute_type="int8")
emit({"type": "log", "message": "Model ready. Transcribing audio..."})
segments, info = model.transcribe(video_path, beam_size=5, vad_filter=True)
result_segments = []
for segment in segments:
    result_segments.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": segment.text.strip()})
    progress = min(99, round(segment.end / duration_seconds * 100))
    emit({"type": "progress", "progress": progress})

with open(output_path, "w", encoding="utf-8") as file:
    json.dump(
        {
            "language": info.language,
            "languageProbability": round(info.language_probability, 3),
            "text": " ".join(segment["text"] for segment in result_segments),
            "segments": result_segments,
        },
        file,
        ensure_ascii=False,
    )
