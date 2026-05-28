from __future__ import annotations

import asyncio
import base64
import io
import os
import secrets
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, model_validator


BackendName = Literal["flux2-klein", "sana-sprint"]
ImageFormat = Literal["png", "jpeg", "webp"]


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def env_optional(name: str, default: str | None) -> str | None:
    if name not in os.environ:
        return default
    value = os.environ[name].strip()
    return value or None


def default_model_id(backend: str) -> str:
    if backend == "flux2-klein":
        return "black-forest-labs/FLUX.2-klein-4B"
    if backend == "sana-sprint":
        return "Efficient-Large-Model/Sana_Sprint_0.6B_1024px_diffusers"
    raise ValueError(f"Unsupported IMAGEGEN_BACKEND={backend!r}")


def default_vae_id(backend: str) -> str | None:
    if backend == "flux2-klein":
        return "black-forest-labs/FLUX.2-small-decoder"
    if backend == "sana-sprint":
        return "mit-han-lab/dc-ae-lite-f32c32-sana-1.1-diffusers"
    raise ValueError(f"Unsupported IMAGEGEN_BACKEND={backend!r}")


@dataclass(frozen=True)
class Settings:
    backend: str
    model_id: str
    vae_id: str | None
    device: str
    dtype: str
    preload: bool
    warmup: bool
    compile_vae: bool
    cpu_offload: bool
    max_pixels: int
    cors_origins: tuple[str, ...]


def load_settings() -> Settings:
    backend = os.getenv("IMAGEGEN_BACKEND", "flux2-klein").strip()
    return Settings(
        backend=backend,
        model_id=os.getenv("IMAGEGEN_MODEL", default_model_id(backend)).strip(),
        vae_id=env_optional("IMAGEGEN_VAE", default_vae_id(backend)),
        device=os.getenv("IMAGEGEN_DEVICE", "cuda").strip(),
        dtype=os.getenv("IMAGEGEN_DTYPE", "bf16").strip().lower(),
        preload=env_bool("IMAGEGEN_PRELOAD", True),
        warmup=env_bool("IMAGEGEN_WARMUP", False),
        compile_vae=env_bool("IMAGEGEN_COMPILE_VAE", False),
        cpu_offload=env_bool("IMAGEGEN_CPU_OFFLOAD", False),
        max_pixels=int(os.getenv("IMAGEGEN_MAX_PIXELS", str(1024 * 1024))),
        cors_origins=tuple(
            origin.strip()
            for origin in os.getenv(
                "IMAGEGEN_CORS_ORIGINS",
                "http://localhost:5173,http://127.0.0.1:5173",
            ).split(",")
            if origin.strip()
        ),
    )


settings = load_settings()
STATIC_DIR = Path(__file__).resolve().parent / "static"


class GenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)
    width: int = Field(default=768, ge=256, le=2048, multiple_of=16)
    height: int = Field(default=768, ge=256, le=2048, multiple_of=16)
    steps: int = Field(default=2, ge=1, le=12)
    guidance_scale: float = Field(default=1.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    format: ImageFormat = "png"
    quality: int = Field(default=95, ge=1, le=100)

    @model_validator(mode="after")
    def validate_size(self) -> "GenerateRequest":
        if not self.prompt.strip():
            raise ValueError("prompt must contain non-whitespace text")
        pixels = self.width * self.height
        if pixels > settings.max_pixels:
            raise ValueError(
                f"requested image has {pixels} pixels, above IMAGEGEN_MAX_PIXELS={settings.max_pixels}"
            )
        return self


class TimingResponse(BaseModel):
    load_seconds: float | None
    generation_seconds: float
    encode_seconds: float
    total_seconds: float


class GenerateResponse(BaseModel):
    image_base64: str
    format: ImageFormat
    seed: int
    backend: str
    model_id: str
    width: int
    height: int
    steps: int
    timings: TimingResponse


@dataclass
class GeneratedImage:
    data: bytes
    media_type: str
    seed: int
    generation_seconds: float
    encode_seconds: float
    total_seconds: float


class ModelState:
    def __init__(self) -> None:
        self.pipe: Any | None = None
        self.loaded_at: float | None = None
        self.load_seconds: float | None = None
        self.load_lock = asyncio.Lock()
        self.generate_lock = asyncio.Lock()


state = ModelState()


def torch_dtype(torch: Any) -> Any:
    if settings.dtype in {"bf16", "bfloat16"}:
        return torch.bfloat16
    if settings.dtype in {"fp16", "float16"}:
        return torch.float16
    if settings.dtype in {"fp32", "float32"}:
        return torch.float32
    raise ValueError("IMAGEGEN_DTYPE must be bf16, fp16, or fp32")


def configure_torch(torch: Any) -> None:
    torch.set_float32_matmul_precision("high")
    if hasattr(torch.backends, "cuda"):
        torch.backends.cuda.matmul.allow_tf32 = True
    if hasattr(torch.backends, "cudnn"):
        torch.backends.cudnn.allow_tf32 = True


def token_kwargs() -> dict[str, str]:
    token = os.getenv("HF_TOKEN")
    return {"token": token} if token else {}


def load_pipeline_sync() -> Any:
    import torch

    configure_torch(torch)
    dtype = torch_dtype(torch)

    if settings.device.startswith("cuda") and not torch.cuda.is_available():
        raise RuntimeError("CUDA is not available. Check NVIDIA driver, CUDA runtime, and torch install.")

    kwargs = {"torch_dtype": dtype, **token_kwargs()}

    if settings.backend == "flux2-klein":
        from diffusers import AutoencoderKLFlux2, Flux2KleinPipeline

        vae = None
        if settings.vae_id:
            vae = AutoencoderKLFlux2.from_pretrained(settings.vae_id, **kwargs)
        pipe = Flux2KleinPipeline.from_pretrained(settings.model_id, vae=vae, **kwargs)
    elif settings.backend == "sana-sprint":
        from diffusers import AutoencoderDC, SanaSprintPipeline

        pipe = SanaSprintPipeline.from_pretrained(settings.model_id, **kwargs)
        if settings.vae_id:
            pipe.vae = AutoencoderDC.from_pretrained(settings.vae_id, **kwargs)
    else:
        raise RuntimeError(f"Unsupported backend: {settings.backend}")

    pipe.set_progress_bar_config(disable=True)

    if settings.cpu_offload:
        pipe.enable_model_cpu_offload()
    else:
        pipe.to(settings.device)

    if settings.compile_vae and hasattr(pipe, "vae"):
        pipe.vae.decode = torch.compile(pipe.vae.decode, dynamic=True)

    if settings.warmup:
        generator = make_generator(torch, 0)
        with torch.inference_mode():
            pipe(
                prompt="a small blue cube on a gray table",
                width=512,
                height=512,
                num_inference_steps=1,
                guidance_scale=1.0,
                generator=generator,
            )
        synchronize(torch)

    return pipe


def make_generator(torch: Any, seed: int) -> Any:
    if settings.device.startswith("cuda") and torch.cuda.is_available():
        return torch.Generator(device=settings.device).manual_seed(seed)
    return torch.Generator().manual_seed(seed)


def synchronize(torch: Any) -> None:
    if settings.device.startswith("cuda") and torch.cuda.is_available():
        torch.cuda.synchronize()


async def ensure_pipeline_loaded() -> None:
    if state.pipe is not None:
        return

    async with state.load_lock:
        if state.pipe is not None:
            return
        started = time.perf_counter()
        try:
            state.pipe = await asyncio.to_thread(load_pipeline_sync)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Failed to load image model: {exc}") from exc
        state.load_seconds = time.perf_counter() - started
        state.loaded_at = time.time()


def encode_image(image: Any, image_format: ImageFormat, quality: int) -> tuple[bytes, float, str]:
    started = time.perf_counter()
    buffer = io.BytesIO()
    save_format = image_format.upper()
    media_type = f"image/{image_format}"

    if image_format in {"jpeg", "webp"} and image.mode != "RGB":
        image = image.convert("RGB")

    save_kwargs: dict[str, Any] = {}
    if image_format in {"jpeg", "webp"}:
        save_kwargs["quality"] = quality
        save_kwargs["optimize"] = True

    image.save(buffer, format=save_format, **save_kwargs)
    return buffer.getvalue(), time.perf_counter() - started, media_type


def generate_sync(request: GenerateRequest) -> GeneratedImage:
    import torch

    if state.pipe is None:
        raise RuntimeError("Model is not loaded")

    seed = request.seed if request.seed is not None else secrets.randbelow(2**63 - 1)
    generator = make_generator(torch, seed)

    started = time.perf_counter()
    synchronize(torch)
    generation_started = time.perf_counter()
    try:
        with torch.inference_mode():
            result = state.pipe(
                prompt=request.prompt.strip(),
                width=request.width,
                height=request.height,
                num_inference_steps=request.steps,
                guidance_scale=request.guidance_scale,
                generator=generator,
            )
        synchronize(torch)
    except RuntimeError as exc:
        if "out of memory" in str(exc).lower() and torch.cuda.is_available():
            torch.cuda.empty_cache()
            raise HTTPException(status_code=507, detail=f"CUDA out of memory: {exc}") from exc
        raise

    generation_seconds = time.perf_counter() - generation_started
    image = result.images[0]
    data, encode_seconds, media_type = encode_image(image, request.format, request.quality)
    return GeneratedImage(
        data=data,
        media_type=media_type,
        seed=seed,
        generation_seconds=generation_seconds,
        encode_seconds=encode_seconds,
        total_seconds=time.perf_counter() - started,
    )


async def generate_image(request: GenerateRequest) -> GeneratedImage:
    await ensure_pipeline_loaded()
    async with state.generate_lock:
        try:
            return await asyncio.to_thread(generate_sync, request)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=500, detail=f"Generation failed: {exc}") from exc


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.preload:
        await ensure_pipeline_loaded()
    yield


app = FastAPI(title="Local ImageGen", version="0.1.0", lifespan=lifespan)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )


@app.get("/", response_class=FileResponse)
async def root() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api")
async def api_info() -> dict[str, str]:
    return {
        "service": "imagegen",
        "health": "/health",
        "generate_json": "POST /generate",
        "generate_file": "POST /generate/file",
        "docs": "/docs",
    }


@app.get("/health")
async def health() -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": True,
        "backend": settings.backend,
        "model_id": settings.model_id,
        "vae_id": settings.vae_id,
        "device": settings.device,
        "dtype": settings.dtype,
        "loaded": state.pipe is not None,
        "load_seconds": state.load_seconds,
        "loaded_at": state.loaded_at,
    }

    try:
        import torch

        payload["cuda_available"] = torch.cuda.is_available()
        if torch.cuda.is_available():
            payload["gpu"] = torch.cuda.get_device_name(0)
            payload["cuda_memory_allocated_bytes"] = torch.cuda.memory_allocated(0)
            payload["cuda_memory_reserved_bytes"] = torch.cuda.memory_reserved(0)
    except Exception as exc:  # noqa: BLE001
        payload["torch_error"] = str(exc)

    return payload


@app.post("/generate", response_model=GenerateResponse)
async def generate(request: GenerateRequest) -> GenerateResponse:
    generated = await generate_image(request)
    return GenerateResponse(
        image_base64=base64.b64encode(generated.data).decode("ascii"),
        format=request.format,
        seed=generated.seed,
        backend=settings.backend,
        model_id=settings.model_id,
        width=request.width,
        height=request.height,
        steps=request.steps,
        timings=TimingResponse(
            load_seconds=state.load_seconds,
            generation_seconds=generated.generation_seconds,
            encode_seconds=generated.encode_seconds,
            total_seconds=generated.total_seconds,
        ),
    )


@app.post("/generate/file")
async def generate_file(request: GenerateRequest) -> Response:
    generated = await generate_image(request)
    return Response(
        content=generated.data,
        media_type=generated.media_type,
        headers={
            "x-imagegen-seed": str(generated.seed),
            "x-imagegen-generation-seconds": f"{generated.generation_seconds:.6f}",
            "x-imagegen-total-seconds": f"{generated.total_seconds:.6f}",
        },
    )
