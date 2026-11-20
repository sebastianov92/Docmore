"""A tiny OpenAI-compatible transcription server backed by mlx-whisper (Apple
Silicon). Docmore's meeting notes talk to it as an "OpenAI-compatible"
provider: POST /v1/audio/transcriptions with a multipart "file".

    python server.py --model mlx-community/whisper-large-v3-turbo --port 8791

Returns {"text", "language", "duration", "segments": [{start, end, text}]}
whatever response_format is asked for, which is what Docmore reads.
"""
import argparse
import os
import tempfile

import mlx_whisper
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse

app = FastAPI()
MODEL = os.environ.get("WHISPER_MODEL", "mlx-community/whisper-large-v3-turbo")


@app.get("/v1/models")
def models():
    return {"data": [{"id": MODEL, "object": "model"}]}


@app.post("/v1/audio/transcriptions")
async def transcribe(file: UploadFile = File(...), model: str = Form(None), response_format: str = Form("json"), language: str = Form(None)):
    suffix = os.path.splitext(file.filename or "audio")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(await file.read())
        path = tmp.name
    try:
        result = mlx_whisper.transcribe(path, path_or_hf_repo=MODEL, language=language, verbose=False)
    finally:
        os.unlink(path)
    segments = [{"start": float(s["start"]), "end": float(s["end"]), "text": s["text"].strip()} for s in result.get("segments", [])]
    return JSONResponse(
        {
            "text": result.get("text", "").strip(),
            "language": result.get("language"),
            "duration": segments[-1]["end"] if segments else None,
            "segments": segments,
        }
    )


if __name__ == "__main__":
    import uvicorn

    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8791)
    parser.add_argument("--model", default=MODEL)
    args = parser.parse_args()
    MODEL = args.model
    uvicorn.run(app, host="0.0.0.0", port=args.port, log_level="warning")
