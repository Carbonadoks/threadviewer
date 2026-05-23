#!/usr/bin/env python3
"""Rich terminal analyzer for exported Bluesky repo threads."""

from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "deepseek/deepseek-v4-flash"
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"
APP_TITLE = "Threadviewer Thread Analyzer"
MAX_THREAD_CHARS = 120_000

try:
    from rich.console import Console, Group
    from rich.markdown import Markdown
    from rich.panel import Panel
    from rich.prompt import Confirm, IntPrompt, Prompt
    from rich.table import Table
    from rich.text import Text

    RICH_AVAILABLE = True
except ModuleNotFoundError:
    Console = None  # type: ignore[assignment]
    Group = None  # type: ignore[assignment]
    Markdown = None  # type: ignore[assignment]
    Panel = None  # type: ignore[assignment]
    Confirm = None  # type: ignore[assignment]
    IntPrompt = None  # type: ignore[assignment]
    Prompt = None  # type: ignore[assignment]
    Table = None  # type: ignore[assignment]
    Text = None  # type: ignore[assignment]
    RICH_AVAILABLE = False


@dataclass
class ThreadRecord:
    index: int
    root_uri: str
    depth: int
    post_count: int
    character_count: int
    title: str
    preview: str
    bluesky_url: str | None
    root_post: dict[str, Any]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Select exported repo threads, render them in a Rich terminal UI, and analyze them with OpenRouter."
    )
    parser.add_argument("json_path", nargs="?", help="Path to a repo thread JSON export")
    parser.add_argument("--model", default=DEFAULT_MODEL, help=f"OpenRouter model id (default: {DEFAULT_MODEL})")
    parser.add_argument("--output", help="Analysis JSON path. Defaults beside the input JSON")
    parser.add_argument("--max-thread-chars", type=int, default=MAX_THREAD_CHARS, help="Maximum thread text chars sent per analysis")
    parser.add_argument("--plain", action="store_true", help="Use plain terminal output even if Rich is installed")
    parser.add_argument("--all", action="store_true", help="Analyze every thread in the file without the selection menu")
    parser.add_argument("--force", action="store_true", help="Re-analyze threads that already have saved analysis")
    parser.add_argument("--api-key", help="OpenRouter API key. If omitted, the script prompts securely")
    return parser.parse_args()


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict) or not isinstance(payload.get("threads"), list):
        raise ValueError("Input file does not look like a repo thread JSON export.")
    return payload


def default_analysis_path(input_path: Path) -> Path:
    if input_path.name.endswith(".json"):
        return input_path.with_name(f"{input_path.stem}.analyses.json")
    return input_path.with_suffix(".analyses.json")


def load_existing_analyses(path: Path) -> dict[str, Any]:
    now = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    if not path.exists():
        return {
            "schemaVersion": 1,
            "kind": "bsky-thread-openrouter-analyses",
            "generatedAt": now,
            "updatedAt": now,
            "model": DEFAULT_MODEL,
            "analyses": {},
        }
    with path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError("Existing analysis file is not a JSON object.")
    if not isinstance(payload.get("analyses"), dict):
        payload["analyses"] = {}
    return payload


def save_analyses(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    temp_path = path.with_suffix(path.suffix + ".tmp")
    with temp_path.open("w", encoding="utf-8") as file:
        json.dump(payload, file, indent=2, ensure_ascii=False)
        file.write("\n")
    temp_path.replace(path)


def as_text(value: Any) -> str:
    return value if isinstance(value, str) else ""


def iter_posts(root_post: dict[str, Any], depth: int = 0) -> Iterable[tuple[int, dict[str, Any]]]:
    yield depth, root_post
    children = root_post.get("children")
    if not isinstance(children, list):
        return
    for child in children:
        if isinstance(child, dict):
            yield from iter_posts(child, depth + 1)


def thread_from_raw(index: int, raw: dict[str, Any]) -> ThreadRecord:
    root_post = raw.get("rootPost") if isinstance(raw.get("rootPost"), dict) else {}
    return ThreadRecord(
        index=index,
        root_uri=as_text(raw.get("rootUri")),
        depth=int(raw.get("depth") or 0),
        post_count=int(raw.get("postCount") or 0),
        character_count=int(raw.get("characterCount") or 0),
        title=as_text(raw.get("title")) or as_text(raw.get("preview"))[:84] or "Untitled thread",
        preview=as_text(raw.get("preview")),
        bluesky_url=as_text(raw.get("blueskyUrl")) or None,
        root_post=root_post,
    )


def normalize_search(value: str) -> str:
    return re.sub(r"\s+", " ", value.lower()).strip()


def matches_query(thread: ThreadRecord, query: str) -> bool:
    normalized_query = normalize_search(query)
    if not normalized_query:
        return True
    haystack_parts = [thread.title, thread.preview, thread.root_uri]
    for _, post in iter_posts(thread.root_post):
        haystack_parts.append(as_text(post.get("text")))
        author = post.get("author") if isinstance(post.get("author"), dict) else {}
        haystack_parts.append(as_text(author.get("handle")))
        haystack_parts.append(as_text(author.get("displayName")))
    return normalized_query in normalize_search("\n".join(haystack_parts))


def flatten_thread_text(thread: ThreadRecord, max_chars: int) -> str:
    lines: list[str] = [
        f"Root URI: {thread.root_uri}",
        f"Bluesky URL: {thread.bluesky_url or 'unavailable'}",
        f"Depth: {thread.depth}",
        f"Posts: {thread.post_count}",
        "",
    ]
    for depth, post in iter_posts(thread.root_post):
        author = post.get("author") if isinstance(post.get("author"), dict) else {}
        handle = as_text(author.get("handle")) or "unknown"
        created_at = as_text(post.get("createdAt"))
        text = as_text(post.get("text")).strip()
        indent = "  " * depth
        lines.append(f"{indent}- @{handle} - {created_at} - {as_text(post.get('uri'))}")
        if text:
            for paragraph in text.splitlines():
                lines.append(f"{indent}  {paragraph}")
        lines.append("")
    rendered = "\n".join(lines).strip()
    if len(rendered) <= max_chars:
        return rendered
    return rendered[: max(0, max_chars - 120)].rstrip() + "\n\n[Thread truncated for analysis input length.]"


def compact_preview(text: str, width: int = 96) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= width:
        return compact
    return compact[: width - 1].rstrip() + "..."


def request_api_key(args: argparse.Namespace) -> str:
    if args.api_key:
        return args.api_key.strip()
    env_value = os.environ.get("OPENROUTER_API_KEY", "").strip()
    if env_value:
        use_env = input("Use OPENROUTER_API_KEY from the environment? [Y/n]: ").strip().lower()
        if use_env in {"", "y", "yes"}:
            return env_value
    return getpass.getpass("OpenRouter API key: ").strip()


def analysis_exists(thread: ThreadRecord, analyses_payload: dict[str, Any], force: bool) -> bool:
    analyses = analyses_payload.get("analyses")
    return isinstance(analyses, dict) and thread.root_uri in analyses and not force


def build_analysis_prompt(thread: ThreadRecord, thread_text: str) -> str:
    return f"""Analyze this Bluesky self-reply thread.

Return only a JSON object with this exact shape:
{{
  "headline": "short editorial headline, max 14 words",
  "summary": "2-4 sentence compact summary",
  "tags": ["3-8 lowercase topical tags"],
  "tone": "short tone label",
  "themes": ["2-5 recurring themes"],
  "interestingness": 0.0,
  "notes": "one sentence about why this thread may be worth revisiting"
}}

Use values between 0 and 1 for interestingness. Do not quote more than a short phrase from the thread.

Thread title: {thread.title}
Thread metadata:
- rootUri: {thread.root_uri}
- blueskyUrl: {thread.bluesky_url or "unavailable"}
- depth: {thread.depth}
- posts: {thread.post_count}

Thread transcript:
{thread_text}
"""


def extract_json_object(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    try:
        parsed = json.loads(stripped)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    start = stripped.find("{")
    end = stripped.rfind("}")
    if start >= 0 and end > start:
        parsed = json.loads(stripped[start : end + 1])
        if isinstance(parsed, dict):
            return parsed
    raise ValueError("Model response did not contain a JSON object.")


def call_openrouter(api_key: str, model: str, thread: ThreadRecord, thread_text: str) -> dict[str, Any]:
    body = {
        "model": model,
        "messages": [
            {
                "role": "system",
                "content": (
                    "You are a careful thread analyst. You classify personal writing and conversation threads "
                    "without overclaiming. Return only valid JSON."
                ),
            },
            {"role": "user", "content": build_analysis_prompt(thread, thread_text)},
        ],
        "temperature": 0.2,
        "max_tokens": 900,
    }
    request = urllib.request.Request(
        OPENROUTER_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "HTTP-Referer": "https://github.com/",
            "X-Title": APP_TITLE,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"OpenRouter request failed ({error.code}): {detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"OpenRouter request failed: {error.reason}") from error

    content = payload.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(f"OpenRouter response did not include message content: {payload}")

    analysis = extract_json_object(content)
    return {
        "rootUri": thread.root_uri,
        "threadTitle": thread.title,
        "threadUrl": thread.bluesky_url,
        "model": model,
        "analyzedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "analysis": analysis,
        "usage": payload.get("usage"),
        "rawContent": content,
    }


def print_plain_thread(thread: ThreadRecord) -> None:
    print()
    print(f"{thread.index}. {thread.title}")
    print(f"depth={thread.depth} posts={thread.post_count} chars={thread.character_count}")
    if thread.bluesky_url:
        print(thread.bluesky_url)
    print("-" * 80)
    for depth, post in iter_posts(thread.root_post):
        author = post.get("author") if isinstance(post.get("author"), dict) else {}
        print(f"{'  ' * depth}@{as_text(author.get('handle'))} {as_text(post.get('createdAt'))}")
        print(f"{'  ' * depth}{as_text(post.get('text')).strip()}")
        print()


def render_rich_thread(console: Any, thread: ThreadRecord) -> None:
    assert Panel is not None and Table is not None and Text is not None and Group is not None
    meta = Table.grid(padding=(0, 2))
    meta.add_column(style="cyan", no_wrap=True)
    meta.add_column()
    meta.add_row("Root", thread.root_uri)
    meta.add_row("Depth", str(thread.depth))
    meta.add_row("Posts", f"{thread.post_count:,}")
    meta.add_row("Characters", f"{thread.character_count:,}")
    if thread.bluesky_url:
        meta.add_row("URL", thread.bluesky_url)

    post_lines: list[Text] = []
    for depth, post in iter_posts(thread.root_post):
        author = post.get("author") if isinstance(post.get("author"), dict) else {}
        handle = as_text(author.get("handle")) or "unknown"
        created_at = as_text(post.get("createdAt"))
        text = as_text(post.get("text")).strip()
        prefix = "  " * depth
        header = Text(f"{prefix}@{handle}", style="bold magenta")
        if created_at:
            header.append(f" - {created_at}", style="dim")
        post_lines.append(header)
        for paragraph in text.splitlines() or [""]:
            post_lines.append(Text(f"{prefix}{paragraph}", style="white"))
        post_lines.append(Text(""))

    console.print(Panel(Group(meta, Text(""), *post_lines), title=thread.title, border_style="cyan"))


def render_rich_analysis(console: Any, result: dict[str, Any]) -> None:
    assert Panel is not None and Table is not None and Markdown is not None
    analysis = result.get("analysis") if isinstance(result.get("analysis"), dict) else {}

    def string_list(value: Any) -> list[str]:
        if not isinstance(value, list):
            return []
        return [item for item in (as_text(item) for item in value) if item]

    table = Table.grid(padding=(0, 2))
    table.add_column(style="cyan", no_wrap=True)
    table.add_column()
    table.add_row("Headline", as_text(analysis.get("headline")))
    table.add_row("Tone", as_text(analysis.get("tone")))
    table.add_row("Tags", ", ".join(string_list(analysis.get("tags"))))
    table.add_row("Themes", ", ".join(string_list(analysis.get("themes"))))
    interestingness = analysis.get("interestingness")
    if isinstance(interestingness, (int, float)):
        table.add_row("Interestingness", f"{interestingness:.2f}")
    console.print(Panel(table, title="Analysis", border_style="green"))
    summary = as_text(analysis.get("summary"))
    notes = as_text(analysis.get("notes"))
    if summary:
        console.print(Panel(Markdown(summary), title="Summary", border_style="green"))
    if notes:
        console.print(Panel(notes, title="Notes", border_style="green"))


def choose_json_path(args: argparse.Namespace) -> Path:
    if args.json_path:
        return Path(args.json_path).expanduser().resolve()
    default_dir = REPO_ROOT / "output" / "repo-thread-json"
    candidates = sorted(default_dir.glob("*.repo-threads.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not candidates:
        raise SystemExit("Pass a repo thread JSON path. No default exports were found under output/repo-thread-json.")
    if RICH_AVAILABLE and not args.plain and Prompt is not None:
        print("Available exports:")
        for index, path in enumerate(candidates[:20], start=1):
            print(f"{index}. {path}")
        selection = IntPrompt.ask("Select export", default=1)
    else:
        for index, path in enumerate(candidates[:20], start=1):
            print(f"{index}. {path}")
        selection = int(input("Select export [1]: ").strip() or "1")
    return candidates[max(0, min(selection, len(candidates)) - 1)].resolve()


def choose_thread_plain(threads: list[ThreadRecord]) -> ThreadRecord | None:
    query = input("Filter threads by text/title [blank for all]: ").strip()
    filtered = [thread for thread in threads if matches_query(thread, query)]
    if not filtered:
        print("No threads match that filter.")
        return None
    for thread in filtered[:30]:
        print(f"{thread.index}. depth={thread.depth:<3} posts={thread.post_count:<4} {compact_preview(thread.title)}")
    selection = input("Thread number, or q to quit: ").strip()
    if selection.lower() == "q":
        return None
    selected_index = int(selection)
    return next((thread for thread in threads if thread.index == selected_index), None)


def choose_thread_rich(console: Any, threads: list[ThreadRecord]) -> ThreadRecord | None:
    assert Prompt is not None and Table is not None
    query = Prompt.ask("[bold]Filter threads by text/title[/bold]", default="")
    filtered = [thread for thread in threads if matches_query(thread, query)]
    if not filtered:
        console.print("[yellow]No threads match that filter.[/yellow]")
        return None

    page = 0
    page_size = 18
    while True:
        start = page * page_size
        shown = filtered[start : start + page_size]
        table = Table(title=f"Threads {start + 1}-{start + len(shown)} of {len(filtered)}")
        table.add_column("#", style="cyan", justify="right")
        table.add_column("Depth", justify="right")
        table.add_column("Posts", justify="right")
        table.add_column("Title")
        for thread in shown:
            table.add_row(str(thread.index), str(thread.depth), str(thread.post_count), compact_preview(thread.title, 110))
        console.print(table)
        choice = Prompt.ask("[bold]Thread #, n next, p previous, q quit[/bold]", default="")
        if choice.lower() == "q":
            return None
        if choice.lower() == "n":
            if start + page_size < len(filtered):
                page += 1
            continue
        if choice.lower() == "p":
            page = max(0, page - 1)
            continue
        if not choice:
            continue
        try:
            selected_index = int(choice)
        except ValueError:
            console.print("[yellow]Enter a thread number.[/yellow]")
            continue
        selected = next((thread for thread in threads if thread.index == selected_index), None)
        if selected:
            return selected
        console.print("[yellow]No thread has that number.[/yellow]")


def analyze_one(
    thread: ThreadRecord,
    api_key: str,
    model: str,
    max_thread_chars: int,
    analyses_payload: dict[str, Any],
    output_path: Path,
    force: bool,
    use_rich: bool,
) -> dict[str, Any] | None:
    analyses = analyses_payload.setdefault("analyses", {})
    if thread.root_uri in analyses and not force:
        existing = analyses[thread.root_uri]
        if use_rich:
            assert Console is not None
            render_rich_analysis(Console(), existing)
        else:
            print(json.dumps(existing.get("analysis", {}), indent=2, ensure_ascii=False))
        return existing
    thread_text = flatten_thread_text(thread, max_thread_chars)
    result = call_openrouter(api_key, model, thread, thread_text)
    analyses[thread.root_uri] = result
    analyses_payload["model"] = model
    save_analyses(output_path, analyses_payload)
    if use_rich:
        assert Console is not None
        render_rich_analysis(Console(), result)
    else:
        print(json.dumps(result.get("analysis", {}), indent=2, ensure_ascii=False))
    return result


def run_all(
    threads: list[ThreadRecord],
    api_key: str,
    args: argparse.Namespace,
    analyses_payload: dict[str, Any],
    output_path: Path,
    use_rich: bool,
) -> None:
    for position, thread in enumerate(threads, start=1):
        if thread.root_uri in analyses_payload.get("analyses", {}) and not args.force:
            continue
        print(f"Analyzing {position}/{len(threads)}: {thread.title}")
        analyze_one(
            thread,
            api_key,
            args.model,
            args.max_thread_chars,
            analyses_payload,
            output_path,
            args.force,
            use_rich=False,
        )
        time.sleep(0.2)


def run_menu(
    threads: list[ThreadRecord],
    api_key: str,
    args: argparse.Namespace,
    analyses_payload: dict[str, Any],
    output_path: Path,
    use_rich: bool,
) -> None:
    if use_rich:
        assert Console is not None and Prompt is not None and Confirm is not None
        console = Console()
        console.print(
            Panel(
                f"[bold cyan]Thread Analyzer[/bold cyan]\nModel: {args.model}\nAnalysis output: {output_path}",
                border_style="cyan",
            )
        )
        while True:
            selected = choose_thread_rich(console, threads)
            if selected is None:
                return
            render_rich_thread(console, selected)
            if Confirm.ask("[bold green]Go analyze this thread?[/bold green]", default=True):
                try:
                    if not api_key and not analysis_exists(selected, analyses_payload, args.force):
                        api_key = request_api_key(args)
                        if not api_key:
                            console.print("[yellow]An OpenRouter API key is required to analyze a new thread.[/yellow]")
                            continue
                    analyze_one(
                        selected,
                        api_key,
                        args.model,
                        args.max_thread_chars,
                        analyses_payload,
                        output_path,
                        args.force,
                        use_rich=True,
                    )
                except Exception as error:  # noqa: BLE001 - surface API failures cleanly in the UI.
                    console.print(Panel(str(error), title="Analysis Failed", border_style="red"))
            if not Confirm.ask("Pick another thread?", default=False):
                return

    while True:
        selected = choose_thread_plain(threads)
        if selected is None:
            return
        print_plain_thread(selected)
        if input("Go analyze this thread? [Y/n]: ").strip().lower() in {"", "y", "yes"}:
            try:
                if not api_key and not analysis_exists(selected, analyses_payload, args.force):
                    api_key = request_api_key(args)
                    if not api_key:
                        print("An OpenRouter API key is required to analyze a new thread.", file=sys.stderr)
                        continue
                analyze_one(
                    selected,
                    api_key,
                    args.model,
                    args.max_thread_chars,
                    analyses_payload,
                    output_path,
                    args.force,
                    use_rich=False,
                )
            except Exception as error:  # noqa: BLE001
                print(f"Analysis failed: {error}", file=sys.stderr)
        if input("Pick another thread? [y/N]: ").strip().lower() not in {"y", "yes"}:
            return


def main() -> int:
    args = parse_args()
    use_rich = RICH_AVAILABLE and not args.plain
    if not RICH_AVAILABLE and not args.plain:
        print("Rich is not installed, using plain output. Install it with: python3 -m pip install rich")

    input_path = choose_json_path(args)
    payload = load_json(input_path)
    threads = [
        thread_from_raw(index, raw)
        for index, raw in enumerate(payload.get("threads", []), start=1)
        if isinstance(raw, dict)
    ]
    if not threads:
        raise SystemExit("The input JSON has no threads.")

    output_path = Path(args.output).expanduser().resolve() if args.output else default_analysis_path(input_path)
    analyses_payload = load_existing_analyses(output_path)

    if args.all:
        api_key = request_api_key(args)
        if not api_key:
            raise SystemExit("An OpenRouter API key is required.")
        run_all(threads, api_key, args, analyses_payload, output_path, use_rich)
    else:
        api_key = args.api_key.strip() if args.api_key else ""
        run_menu(threads, api_key, args, analyses_payload, output_path, use_rich)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
