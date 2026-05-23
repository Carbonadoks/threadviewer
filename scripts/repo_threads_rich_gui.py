#!/usr/bin/env python3
"""Rich terminal GUI for exporting Bluesky repo self-reply threads to JSON."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
EXPORT_SCRIPT = REPO_ROOT / "scripts" / "export-repo-threads-json.ts"

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.progress import BarColumn, Progress, SpinnerColumn, TextColumn, TimeElapsedColumn
    from rich.prompt import Confirm, IntPrompt, Prompt
    from rich.table import Table

    RICH_AVAILABLE = True
except ModuleNotFoundError:
    Console = None  # type: ignore[assignment]
    Panel = None  # type: ignore[assignment]
    Progress = None  # type: ignore[assignment]
    SpinnerColumn = None  # type: ignore[assignment]
    TextColumn = None  # type: ignore[assignment]
    BarColumn = None  # type: ignore[assignment]
    TimeElapsedColumn = None  # type: ignore[assignment]
    Prompt = None  # type: ignore[assignment]
    IntPrompt = None  # type: ignore[assignment]
    Confirm = None  # type: ignore[assignment]
    Table = None  # type: ignore[assignment]
    RICH_AVAILABLE = False


@dataclass
class ExportConfig:
    handle: str
    output: Path
    min_depth: int
    search: str
    date_from: str
    date_to: str
    limit: int | None
    export_scope: str
    pretty: bool
    force: bool


def sanitize_handle_for_filename(handle: str) -> str:
    cleaned = handle.replace("@", "").strip() or "repo"
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", cleaned)


def default_output_path(handle: str) -> Path:
    return REPO_ROOT / "output" / "repo-thread-json" / f"{sanitize_handle_for_filename(handle)}.repo-threads.json"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Open a Rich terminal GUI that downloads a Bluesky repo CAR and saves self-reply threads as JSON."
    )
    parser.add_argument("--handle", help="Bluesky handle to export, for example alice.bsky.social")
    parser.add_argument("--output", help="Output JSON path")
    parser.add_argument("--min-depth", type=int, help="Minimum thread depth threshold")
    parser.add_argument("--search", help="Literal/fuzzy search text or /pattern/flags regex")
    parser.add_argument("--date-from", help="Root post date lower bound, YYYY-MM-DD")
    parser.add_argument("--date-to", help="Root post date upper bound, YYYY-MM-DD")
    parser.add_argument("--limit", type=int, help="Limit saved threads after sorting/filtering")
    parser.add_argument("--export-scope", choices=["filtered", "all"], help="Save filtered threads or all discovered threads")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print the output JSON")
    parser.add_argument("--force", action="store_true", help="Overwrite the output file if it already exists")
    parser.add_argument("--plain", action="store_true", help="Use plain terminal prompts even if Rich is installed")
    parser.add_argument(
        "--non-interactive",
        action="store_true",
        help="Use provided flags and defaults without prompting. Requires --handle.",
    )
    return parser.parse_args()


def ask_plain(prompt: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    value = input(f"{prompt}{suffix}: ").strip()
    return value or default


def ask_plain_confirm(prompt: str, default: bool = False) -> bool:
    label = "Y/n" if default else "y/N"
    value = input(f"{prompt} [{label}]: ").strip().lower()
    if not value:
        return default
    return value in {"y", "yes", "true", "1"}


def collect_config_plain(args: argparse.Namespace) -> ExportConfig:
    if args.non_interactive and not args.handle:
        raise SystemExit("--non-interactive requires --handle.")

    handle = (args.handle or ask_plain("Bluesky handle")).replace("@", "").strip()
    if not handle:
        raise SystemExit("A Bluesky handle is required.")

    default_output = default_output_path(handle)
    output = Path(args.output or (str(default_output) if args.non_interactive else ask_plain("Output JSON", str(default_output))))
    min_depth = args.min_depth if args.min_depth is not None else (2 if args.non_interactive else int(ask_plain("Minimum depth", "2")))
    search = args.search if args.search is not None else ("" if args.non_interactive else ask_plain("Search filter", ""))
    date_from = args.date_from if args.date_from is not None else ("" if args.non_interactive else ask_plain("Date from", ""))
    date_to = args.date_to if args.date_to is not None else ("" if args.non_interactive else ask_plain("Date to", ""))
    limit = args.limit
    if limit is None and not args.non_interactive:
        limit_text = ask_plain("Limit saved threads", "")
        limit = int(limit_text) if limit_text else None
    export_scope = args.export_scope or ("filtered" if args.non_interactive else ask_plain("Export scope filtered/all", "filtered"))
    pretty = args.pretty or (False if args.non_interactive else ask_plain_confirm("Pretty-print JSON", True))
    force = args.force
    if output.exists() and not force and not args.non_interactive:
        force = ask_plain_confirm(f"{output} exists. Overwrite", False)

    return ExportConfig(
        handle=handle,
        output=output,
        min_depth=max(1, min_depth),
        search=search,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        export_scope=export_scope if export_scope in {"filtered", "all"} else "filtered",
        pretty=pretty,
        force=force,
    )


def collect_config_rich(args: argparse.Namespace) -> ExportConfig:
    assert Console is not None and Prompt is not None and IntPrompt is not None and Confirm is not None
    console = Console()

    if args.non_interactive:
        return collect_config_plain(args)

    console.print(
        Panel.fit(
            "[bold cyan]Repo Thread JSON Exporter[/bold cyan]\n"
            "Downloads the same AT Protocol CAR repository used by Repo Viewer, builds self-reply threads, "
            "applies viewer-style filters, and writes a local JSON file.",
            border_style="cyan",
        )
    )

    handle = (args.handle or Prompt.ask("[bold]Bluesky handle[/bold]")).replace("@", "").strip()
    if not handle:
        raise SystemExit("A Bluesky handle is required.")

    default_output = default_output_path(handle)
    output = Path(args.output or Prompt.ask("[bold]Output JSON[/bold]", default=str(default_output)))
    min_depth = args.min_depth if args.min_depth is not None else IntPrompt.ask("[bold]Minimum depth[/bold]", default=2)
    search = args.search if args.search is not None else Prompt.ask("[bold]Search filter[/bold]", default="")
    date_from = args.date_from if args.date_from is not None else Prompt.ask("[bold]Date from[/bold]", default="")
    date_to = args.date_to if args.date_to is not None else Prompt.ask("[bold]Date to[/bold]", default="")

    limit = args.limit
    if limit is None:
        limit_text = Prompt.ask("[bold]Limit saved threads[/bold]", default="")
        limit = int(limit_text) if limit_text else None

    export_scope = args.export_scope or Prompt.ask(
        "[bold]Export scope[/bold]",
        choices=["filtered", "all"],
        default="filtered",
    )
    pretty = args.pretty or Confirm.ask("[bold]Pretty-print JSON[/bold]", default=True)
    force = args.force
    if output.exists() and not force:
        force = Confirm.ask(f"[yellow]{output} exists. Overwrite[/yellow]", default=False)

    return ExportConfig(
        handle=handle,
        output=output,
        min_depth=max(1, min_depth),
        search=search,
        date_from=date_from,
        date_to=date_to,
        limit=limit,
        export_scope=export_scope,
        pretty=pretty,
        force=force,
    )


def build_export_command(config: ExportConfig) -> list[str]:
    command = [
        "node",
        "--import",
        "tsx",
        str(EXPORT_SCRIPT),
        config.handle,
        "--output",
        str(config.output),
        "--min-depth",
        str(config.min_depth),
        "--export-scope",
        config.export_scope,
        "--progress-jsonl",
    ]
    if config.search:
        command.extend(["--search", config.search])
    if config.date_from:
        command.extend(["--date-from", config.date_from])
    if config.date_to:
        command.extend(["--date-to", config.date_to])
    if config.limit is not None:
        command.extend(["--limit", str(config.limit)])
    if config.pretty:
        command.append("--pretty")
    if config.force:
        command.append("--force")
    return command


def stream_reader(stream: Any, name: str, queue: Queue[tuple[str, str]]) -> None:
    try:
        for line in iter(stream.readline, ""):
            if not line:
                break
            queue.put((name, line.rstrip("\n")))
    finally:
        stream.close()


def run_export_plain(config: ExportConfig) -> int:
    command = build_export_command(config)
    print(f"Running export for @{config.handle}")
    process = subprocess.Popen(
        command,
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    queue: Queue[tuple[str, str]] = Queue()
    assert process.stdout is not None and process.stderr is not None
    threading.Thread(target=stream_reader, args=(process.stdout, "stdout", queue), daemon=True).start()
    threading.Thread(target=stream_reader, args=(process.stderr, "stderr", queue), daemon=True).start()

    last_done: dict[str, Any] | None = None
    while process.poll() is None or not queue.empty():
        try:
            name, line = queue.get(timeout=0.1)
        except Empty:
            continue
        if name == "stderr":
            print(line, file=sys.stderr)
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print(line)
            continue
        event_type = event.get("type")
        if event_type == "download":
            received = int(event.get("receivedBytes") or 0)
            total = int(event.get("totalBytes") or 0)
            total_text = f" / {total:,}" if total else ""
            print(f"Downloading: {received:,}{total_text} bytes")
        elif event_type == "parse":
            print(f"Parsing posts: {int(event.get('parsedPosts') or 0):,}")
        elif event_type == "build":
            print(f"{event.get('phase', 'Building')}: {int(event.get('current') or 0):,} / {int(event.get('total') or 0):,}")
        elif event_type == "done":
            last_done = event
            print(event.get("message", "Done."))
        elif event.get("message"):
            print(event["message"])

    code = process.returncode or 0
    if code == 0 and last_done:
        stats = last_done.get("stats") or {}
        print(f"Saved {stats.get('exportedThreads', 0):,} threads to {last_done.get('outputPath')}")
    return code


def run_export_rich(config: ExportConfig) -> int:
    assert Console is not None and Progress is not None and SpinnerColumn is not None
    assert TextColumn is not None and BarColumn is not None and TimeElapsedColumn is not None and Table is not None and Panel is not None

    console = Console()
    command = build_export_command(config)

    table = Table.grid(padding=(0, 2))
    table.add_column(style="cyan", no_wrap=True)
    table.add_column()
    table.add_row("Handle", f"@{config.handle}")
    table.add_row("Min depth", str(config.min_depth))
    table.add_row("Search", config.search or "none")
    table.add_row("Date range", f"{config.date_from or 'any'} to {config.date_to or 'now'}")
    table.add_row("Export scope", config.export_scope)
    table.add_row("Output", str(config.output))
    console.print(Panel(table, title="Export Settings", border_style="magenta"))

    process = subprocess.Popen(
        command,
        cwd=REPO_ROOT,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )

    queue: Queue[tuple[str, str]] = Queue()
    assert process.stdout is not None and process.stderr is not None
    threading.Thread(target=stream_reader, args=(process.stdout, "stdout", queue), daemon=True).start()
    threading.Thread(target=stream_reader, args=(process.stderr, "stderr", queue), daemon=True).start()

    stderr_lines: list[str] = []
    done_event: dict[str, Any] | None = None

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%", justify="right"),
        TextColumn("{task.completed:>9.0f}/{task.total:>9.0f}"),
        TimeElapsedColumn(),
        console=console,
        transient=False,
    ) as progress:
        profile_task = progress.add_task("Resolving profile", total=1)
        download_task = progress.add_task("Downloading repository", total=1)
        parse_task = progress.add_task("Parsing posts", total=1)
        build_task = progress.add_task("Building threads", total=1)
        write_task = progress.add_task("Writing JSON", total=1)

        while process.poll() is None or not queue.empty():
            try:
                name, line = queue.get(timeout=0.1)
            except Empty:
                continue

            if name == "stderr":
                stderr_lines.append(line)
                continue

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                stderr_lines.append(line)
                continue

            event_type = event.get("type")
            if event_type == "profile":
                progress.update(profile_task, completed=1)
            elif event_type == "download":
                total = int(event.get("totalBytes") or 0) or 1
                completed = int(event.get("receivedBytes") or 0)
                progress.update(download_task, total=total, completed=min(completed, total))
            elif event_type == "downloaded":
                total = int(event.get("totalBytes") or event.get("downloadedBytes") or 1)
                progress.update(download_task, total=total, completed=total)
            elif event_type == "parse":
                parsed = int(event.get("parsedPosts") or 0)
                progress.update(parse_task, total=max(parsed, 1), completed=parsed)
            elif event_type == "parsed":
                parsed = int(event.get("parsedPosts") or 1)
                progress.update(parse_task, total=max(parsed, 1), completed=max(parsed, 1))
            elif event_type == "build":
                total = int(event.get("total") or 0) or 1
                current = int(event.get("current") or 0)
                phase = str(event.get("phase") or "Building threads")
                progress.update(build_task, description=phase, total=total, completed=min(current, total))
            elif event_type == "write":
                progress.update(build_task, completed=progress.tasks[build_task].total or 1)
                progress.update(write_task, completed=0)
            elif event_type == "done":
                done_event = event
                progress.update(write_task, completed=1)
            elif event_type == "empty":
                console.print(f"[yellow]{event.get('message', 'No threads matched.')}[/yellow]")

    code = process.returncode or 0
    if code != 0:
        console.print(Panel("\n".join(stderr_lines[-20:]) or "Export failed.", title="Error", border_style="red"))
        return code

    if done_event:
        stats = done_event.get("stats") or {}
        repo = done_event.get("repo") or {}
        summary = Table.grid(padding=(0, 2))
        summary.add_column(style="cyan", no_wrap=True)
        summary.add_column()
        summary.add_row("Threads saved", f"{int(stats.get('exportedThreads') or 0):,}")
        summary.add_row("Posts saved", f"{int(stats.get('exportedPosts') or 0):,}")
        summary.add_row("Characters", f"{int(stats.get('exportedCharacters') or 0):,}")
        summary.add_row("Repo source", str(repo.get("source", "unknown")).upper())
        summary.add_row("Output", str(done_event.get("outputPath", config.output)))
        console.print(Panel(summary, title="JSON Export Complete", border_style="green"))
    return code


def main() -> int:
    args = parse_args()
    use_rich = RICH_AVAILABLE and not args.plain

    if use_rich:
        config = collect_config_rich(args)
        return run_export_rich(config)

    if not RICH_AVAILABLE and not args.plain:
        print("Rich is not installed, so this run is using the plain fallback.")
        print("Install it with: python3 -m pip install rich")
        print()
    config = collect_config_plain(args)
    return run_export_plain(config)


if __name__ == "__main__":
    raise SystemExit(main())
