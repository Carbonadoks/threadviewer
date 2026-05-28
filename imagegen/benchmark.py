#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import statistics
import time
import urllib.request


def post_json(url: str, payload: dict, timeout: float) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> None:
    parser = argparse.ArgumentParser(description="Benchmark the local imagegen server.")
    parser.add_argument("--url", default="http://127.0.0.1:8008/generate")
    parser.add_argument("--prompt", default="a small glass robot on a clean desk, product photo")
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--height", type=int, default=768)
    parser.add_argument("--steps", type=int, default=2)
    parser.add_argument("--count", type=int, default=5)
    parser.add_argument("--warmup", type=int, default=1)
    parser.add_argument("--timeout", type=float, default=300.0)
    args = parser.parse_args()

    payload = {
        "prompt": args.prompt,
        "width": args.width,
        "height": args.height,
        "steps": args.steps,
        "guidance_scale": 1.0,
        "format": "png",
    }

    for index in range(args.warmup):
        started = time.perf_counter()
        post_json(args.url, payload | {"seed": index}, args.timeout)
        print(f"warmup {index + 1}: {time.perf_counter() - started:.3f}s")

    latencies: list[float] = []
    model_latencies: list[float] = []
    for index in range(args.count):
        started = time.perf_counter()
        response = post_json(args.url, payload | {"seed": 10_000 + index}, args.timeout)
        wall_seconds = time.perf_counter() - started
        latencies.append(wall_seconds)
        model_latencies.append(float(response["timings"]["generation_seconds"]))
        print(
            f"run {index + 1}: wall={wall_seconds:.3f}s "
            f"model={response['timings']['generation_seconds']:.3f}s "
            f"seed={response['seed']}"
        )

    print("")
    print(f"wall mean: {statistics.mean(latencies):.3f}s")
    print(f"wall p50:  {statistics.median(latencies):.3f}s")
    print(f"model mean: {statistics.mean(model_latencies):.3f}s")
    print(f"model p50:  {statistics.median(model_latencies):.3f}s")


if __name__ == "__main__":
    main()

