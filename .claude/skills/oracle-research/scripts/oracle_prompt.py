#!/usr/bin/env python3
"""
oracle_prompt - Compose oracle prompts with file references for ChatGPT Pro.

Shared utility for oracle-research and oracle-blindspot skills.
Takes a prompt text and a list of file paths, composes the final prompt
with file contents properly formatted, and copies to clipboard via pbcopy.
"""

import argparse
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path

WARN_THRESHOLD = 200_000  # characters
CHARS_PER_TOKEN_ESTIMATE = 4


def read_file_with_metadata(filepath: str) -> dict | None:
    """Read file and return content with metadata, or None if not found."""
    path = Path(filepath)
    if not path.exists():
        print(f"WARNING: File not found: {filepath}", file=sys.stderr)
        return None

    stat = path.stat()
    content = path.read_text(encoding="utf-8")
    modified = datetime.fromtimestamp(stat.st_mtime).strftime("%Y-%m-%d")

    return {
        "relative_path": os.path.relpath(path),
        "content": content,
        "size_bytes": stat.st_size,
        "modified": modified,
    }


def compose_prompt(prompt_text: str, files_data: list[dict]) -> str:
    """Compose the final prompt with file contents in XML tags."""
    parts = [prompt_text.strip()]

    if files_data:
        parts.append("\n\n---\n\n# Reference Materials\n")

        for f in files_data:
            parts.append(
                f'\n<reference-file path="{f["relative_path"]}" '
                f'bytes="{f["size_bytes"]}" modified="{f["modified"]}">\n'
                f'{f["content"]}\n'
                f"</reference-file>\n"
            )

    return "".join(parts)


def copy_to_clipboard(text: str) -> None:
    """Copy text to macOS clipboard via pbcopy."""
    subprocess.run(
        ["pbcopy"],
        input=text.encode("utf-8"),
        check=True,
    )


def save_prompt(text: str, save_dir: str, files_data: list[dict]) -> Path:
    """Save composed prompt to file for audit trail."""
    timestamp = datetime.now().strftime("%Y-%m-%d-%H%M")
    filename = f"{timestamp}-oracle-prompt.md"
    save_path = Path(save_dir) / filename

    header_lines = [
        f"<!-- Oracle Prompt composed at {datetime.now().isoformat()} -->",
        "<!-- Files included: -->",
    ]
    for f in files_data:
        header_lines.append(
            f'<!--   {f["relative_path"]} ({f["size_bytes"]} bytes, {f["modified"]}) -->'
        )
    header_lines.append("")

    save_path.write_text("\n".join(header_lines) + text, encoding="utf-8")
    return save_path


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Compose oracle prompts with file references for ChatGPT Pro",
    )
    parser.add_argument(
        "--files",
        nargs="+",
        required=True,
        help="File paths to include as reference material",
    )
    parser.add_argument(
        "--prompt",
        default=None,
        help="Prompt text (reads from stdin if omitted)",
    )
    parser.add_argument(
        "--save",
        default=None,
        metavar="DIR",
        help="Save composed prompt to DIR/YYYY-MM-DD-HHMM-oracle-prompt.md",
    )
    parser.add_argument(
        "--no-copy",
        action="store_true",
        help="Print to stdout instead of copying to clipboard",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show file list and sizes without composing",
    )

    args = parser.parse_args()

    # Read files
    files_data = []
    for filepath in args.files:
        data = read_file_with_metadata(filepath)
        if data:
            files_data.append(data)

    if not files_data:
        print("ERROR: No valid files found.", file=sys.stderr)
        sys.exit(1)

    # Print file summary to stderr
    total_file_bytes = sum(f["size_bytes"] for f in files_data)
    print(f"\nIncluded files ({len(files_data)}):", file=sys.stderr)
    for f in files_data:
        print(
            f'  {f["relative_path"]:50s} {f["size_bytes"]:>8,} bytes  ({f["modified"]})',
            file=sys.stderr,
        )
    print(f"  {'Total:':50s} {total_file_bytes:>8,} bytes", file=sys.stderr)

    if args.dry_run:
        return

    # Get prompt text
    if args.prompt:
        prompt_text = args.prompt
    elif not sys.stdin.isatty():
        prompt_text = sys.stdin.read()
    else:
        print(
            "ERROR: No prompt text. Use --prompt or pipe via stdin.", file=sys.stderr
        )
        sys.exit(1)

    # Compose
    composed = compose_prompt(prompt_text, files_data)
    total_chars = len(composed)
    est_tokens = total_chars // CHARS_PER_TOKEN_ESTIMATE

    print(
        f"\nComposed prompt: {total_chars:,} chars (~{est_tokens:,} tokens)",
        file=sys.stderr,
    )
    if total_chars > WARN_THRESHOLD:
        print(
            f"  WARNING: Prompt exceeds {WARN_THRESHOLD:,} chars. Consider reducing files.",
            file=sys.stderr,
        )

    # Output
    if args.no_copy:
        print(composed)
    else:
        copy_to_clipboard(composed)
        print("  Copied to clipboard. ✓", file=sys.stderr)

    # Save audit trail
    if args.save:
        save_path = save_prompt(composed, args.save, files_data)
        print(f"  Saved to: {save_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
