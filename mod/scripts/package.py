#!/usr/bin/env python3
"""Build a minimal, local Airlock plugin ZIP for review or installation."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
TOP_LEVEL_FILES = (
    Path(".claude-plugin/plugin.json"),
    Path("README.md"),
    Path("SECURITY.md"),
    Path("LICENSE"),
)
RUNTIME_SUFFIXES = {".ts", ".tsx", ".jsx", ".js", ".mjs", ".cjs", ".mts", ".cts", ".json"}


def payload_files() -> list[Path]:
    files: list[Path] = []
    for relative in TOP_LEVEL_FILES:
        source = PLUGIN_ROOT / relative
        if source.is_symlink():
            raise ValueError(f"refusing symlink payload input: {relative}")
        if not source.is_file():
            raise ValueError(f"required payload file is missing: {relative}")
        files.append(relative)

    hooks = PLUGIN_ROOT / "hooks"
    if hooks.is_symlink() or not hooks.is_dir():
        raise ValueError("required hooks directory is missing or is a symlink")
    for source in sorted(hooks.rglob("*")):
        relative = source.relative_to(PLUGIN_ROOT)
        if source.is_symlink():
            raise ValueError(f"refusing symlink payload input: {relative}")
        if source.is_file() and source.suffix in RUNTIME_SUFFIXES:
            files.append(relative)

    if not any(path == Path("hooks/hooks.json") for path in files):
        raise ValueError("hooks/hooks.json is missing from the runtime payload")
    return sorted(files, key=lambda path: path.as_posix())


def archive_name() -> str:
    manifest_path = PLUGIN_ROOT / ".claude-plugin/plugin.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    version = manifest.get("version")
    if not isinstance(version, str) or not version.strip():
        raise ValueError("plugin manifest must contain a nonempty string version")
    safe_version = re.sub(r"[^A-Za-z0-9._-]+", "-", version.strip()).strip(".-")
    if not safe_version:
        raise ValueError("plugin manifest version cannot produce a safe archive name")
    return f"airlock-{safe_version}.zip"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        help="archive path (default: mod/dist/airlock-<manifest-version>.zip)",
    )
    args = parser.parse_args()

    try:
        files = payload_files()
        default_path = PLUGIN_ROOT / "dist" / archive_name()
        output = (args.output or default_path).expanduser()
        resolved_output = output.resolve()
        payload_paths = {(PLUGIN_ROOT / path).resolve() for path in files}
        if resolved_output in payload_paths:
            raise ValueError(f"archive output would overwrite a payload input: {output}")
        if output.is_symlink():
            raise ValueError(f"refusing symlink archive output: {output}")

        # Read every input before opening the destination, so a mistaken output
        # path cannot truncate a payload source while the archive is assembled.
        contents = [(path, (PLUGIN_ROOT / path).read_bytes()) for path in files]
        output.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            for relative, data in contents:
                archive.writestr(f"airlock/{relative.as_posix()}", data)

        digest = hashlib.sha256(output.read_bytes()).hexdigest()
        print(f"Archive: {output.resolve()}")
        print(f"SHA-256: {digest}")
        print(f"Files: {len(contents)}")
        return 0
    except (OSError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
        print(f"package.py: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
