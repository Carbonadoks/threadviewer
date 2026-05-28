# Local Image Generation Backend

Standalone FastAPI server for low-latency local image generation on a single NVIDIA GPU.

Default choice: `black-forest-labs/FLUX.2-klein-4B` with `black-forest-labs/FLUX.2-small-decoder`.

Why this default:

- BFL describes FLUX.2 Klein as its fastest image model family, with end-to-end inference as low as under a second.
- The 4B model is Apache-2.0 and fits consumer GPUs at about 13GB VRAM.
- The small decoder is a drop-in FLUX.2 decoder replacement that BFL says is about 1.4x faster at decode time.

If absolute latency matters more than using BFL, try SANA-Sprint:

```bash
IMAGEGEN_BACKEND=sana-sprint \
IMAGEGEN_MODEL=Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers \
uv run uvicorn server:app --host 127.0.0.1 --port 8008
```

NVIDIA's SANA-Sprint docs publish 1024x1024 latency around 0.24-0.25s for the 0.6B/1.6B Sprint models on their benchmark setup. Actual 4090 latency depends on drivers, torch build, resolution, warmup, and whether compile is enabled.

## Install

Use Python 3.12+ and an NVIDIA driver with CUDA support.

```bash
cd imagegen
uv sync --locked
```

The first server start downloads model weights from Hugging Face. Set `HF_TOKEN` if you switch to a gated model such as FLUX.2 Klein 9B.

If you change dependencies and need to refresh `uv.lock`, keep the PyTorch CUDA index first:

```bash
uv lock --index-url https://download.pytorch.org/whl/cu126 --extra-index-url https://pypi.org/simple
```

## Run

```bash
cd imagegen
uv run uvicorn server:app --host 127.0.0.1 --port 8008
```

Open `http://127.0.0.1:8008` for the browser UI.

For best repeated-call latency after startup:

```bash
IMAGEGEN_PRELOAD=1 IMAGEGEN_WARMUP=1 IMAGEGEN_COMPILE_VAE=1 \
uv run uvicorn server:app --host 127.0.0.1 --port 8008
```

## Generate

Fast draft:

```bash
curl -s http://127.0.0.1:8008/generate \
  -H 'content-type: application/json' \
  -d '{"prompt":"a product photo of a translucent blue glass cube on a steel table","width":768,"height":768,"steps":2}' \
  | jq -r .image_base64 | base64 -d > draft.png
```

Better quality:

```bash
curl -s http://127.0.0.1:8008/generate/file \
  -H 'content-type: application/json' \
  -d '{"prompt":"a cinematic macro photo of a translucent blue glass cube on a steel table","width":1024,"height":1024,"steps":4}' \
  > final.png
```

Benchmark:

```bash
uv run python benchmark.py --count 5 --width 768 --height 768 --steps 2
```

## API

- `GET /health`: model, CUDA, and load state.
- `POST /generate`: JSON response with base64 image and timing.
- `POST /generate/file`: raw image response.
- `GET /docs`: FastAPI docs.

Request shape:

```json
{
  "prompt": "a small glass robot on a desk",
  "width": 768,
  "height": 768,
  "steps": 2,
  "guidance_scale": 1.0,
  "seed": 123,
  "format": "png"
}
```

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `IMAGEGEN_BACKEND` | `flux2-klein` | `flux2-klein` or `sana-sprint` |
| `IMAGEGEN_MODEL` | backend default | Override Hugging Face model id |
| `IMAGEGEN_VAE` | backend default | Set empty to disable replacement decoder/VAE |
| `IMAGEGEN_DEVICE` | `cuda` | Use `cuda`, `cuda:0`, or `cpu` |
| `IMAGEGEN_DTYPE` | `bf16` | `bf16`, `fp16`, or `fp32` |
| `IMAGEGEN_PRELOAD` | `1` | Load weights at server startup |
| `IMAGEGEN_WARMUP` | `0` | Run one warmup generation after load |
| `IMAGEGEN_COMPILE_VAE` | `0` | Compile decoder; slower startup, faster repeated decode |
| `IMAGEGEN_CPU_OFFLOAD` | `0` | Saves VRAM but hurts latency |
| `IMAGEGEN_MAX_PIXELS` | `1048576` | Default max is 1024x1024 |
| `IMAGEGEN_CORS_ORIGINS` | localhost dev origins | Comma-separated origins or `*` |

## Latency Notes

- Keep `IMAGEGEN_CPU_OFFLOAD=0` on a 24GB 4090 for speed.
- Use 512-768px drafts with 1-2 steps when latency is the only target.
- Use 1024px and 4 steps when quality matters.
- Use `/generate/file` if the caller does not need base64 JSON.
- Send one request at a time per GPU. The server serializes generation to avoid concurrent CUDA memory spikes.
