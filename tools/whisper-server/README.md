# Local transcription for meeting notes (Apple Silicon)

`server.py` is a minimal OpenAI-compatible `/v1/audio/transcriptions` server on
top of [mlx-whisper](https://github.com/ml-explore/mlx-examples). Run it on the
Mac, then in Docmore's Settings > AI set up the **OpenAI-compatible** provider
with base URL `http://host.docker.internal:8791/v1` (from Docker) and pick it as
the transcription model (`mlx-community/whisper-large-v3-turbo`).

```bash
python3 -m venv .venv && .venv/bin/pip install mlx-whisper fastapi uvicorn python-multipart
HF_HUB_DISABLE_XET=1 .venv/bin/python server.py --port 8791
```

The first run downloads the model. Any other server that speaks the same
endpoint (faster-whisper-server, speaches, LocalAI, Groq, OpenAI) works too.
