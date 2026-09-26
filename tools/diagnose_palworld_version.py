#!/usr/bin/env python3
"""Read-only diagnosis using the installed plugin's actual version parser.

No game/config/cache writes, network calls, or full archive extraction. Only
the scanner and library discovery are loaded, never the Decky backend itself.
Output excludes full paths, INI contents, account data, and plugin settings.
"""
import argparse
import ast
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import sys
from typing import Any, Dict, List, Optional, Set, Tuple
import zipfile


def load_scanner(source):
    tree = ast.parse(source)
    scanner = next(node for node in tree.body
                   if isinstance(node, ast.ClassDef) and node.name == "InstalledGameVersionScanner")
    plugin = next(node for node in tree.body
                  if isinstance(node, ast.ClassDef) and node.name == "Plugin")
    plugin.body = [node for node in plugin.body
                   if isinstance(node, ast.FunctionDef) and node.name == "_steam_library_paths"]
    if not plugin.body:
        raise ValueError("Missing library discovery")
    module = ast.Module(body=[scanner, plugin], type_ignores=[])
    namespace = dict(globals())
    exec(compile(ast.fix_missing_locations(module), "installed-version-scanner", "exec"), namespace)
    return namespace["InstalledGameVersionScanner"], namespace["Plugin"]


def find_plugin():
    roots = [Path.home() / "homebrew/plugins", Path("/home/deck/homebrew/plugins")]
    for root in roots:
        for manifest in sorted(root.glob("*/plugin.json")):
            try:
                if json.loads(manifest.read_text(encoding="utf-8")).get("name") == "Deck Play Badges":
                    return manifest.parent / "main.py"
            except (OSError, ValueError):
                continue
    raise ValueError("Nem található a Deck Play Badges. Használd: --plugin /útvonal/main.py")


def find_game(plugin):
    for library in plugin._steam_library_paths():
        manifest = library / "steamapps/appmanifest_1623730.acf"
        try:
            if manifest.stat().st_size > 128 * 1024:
                continue
            contents = manifest.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        installed = re.search(r'"installdir"\s*"([^"\\/]{1,160})"', contents)
        if not installed or installed.group(1) in (".", ".."):
            continue
        for name in ("buildid", "StateFlags"):
            match = re.search(r'"' + name + r'"\s*"(\d+)"', contents, re.IGNORECASE)
            print(name + ": " + (match.group(1) if match else "ismeretlen"))
        return library / "steamapps/common" / installed.group(1)
    raise ValueError("Nem található a telepített Palworld. Használd: --game /útvonal/Palworld")


def diagnose(scanner, root, source):
    lines = source.splitlines()
    print("PAK-fájlok:")
    packs = sorted((root / "Pal/Content/Paks").glob("*.pak"))
    for path in packs[:32]:
        print("  " + path.name)
    if not packs:
        print("  Nincs PAK-fájl.")

    return_lines = {}

    def trace(frame, event, value):
        if frame.f_code.co_filename != "installed-version-scanner":
            return None
        if frame.f_code.co_name != "_pak_config":
            return None
        if event == "line" and lines[frame.f_lineno - 1].lstrip().startswith("return "):
            return_lines[id(frame)] = frame.f_lineno
        elif event == "return":
            data = frame.f_locals
            print("PAK: " + Path(data["path"]).name)
            for key in ("file_size", "version", "index_size", "directory_size", "count",
                        "directory_count", "location", "expected_size", "compression", "method"):
                if isinstance(data.get(key), int):
                    print("  {}: {}".format(key, data[key]))
            footer = data.get("footer", b"")
            if len(footer) == 221:
                print("  Titkosított index: " + str(bool(footer[16])))
                names = [footer[61 + i * 32:93 + i * 32].split(b"\0")[0]
                         .decode("ascii", errors="replace") for i in range(5)]
                print("  Tömörítések: " + json.dumps(names, ensure_ascii=False))
            print("  Eredmény: " + ("nem olvasható" if value is None else
                                       "nincs benne a konfiguráció" if not value else "konfiguráció kiolvasva"))
            line = return_lines.pop(id(frame), frame.f_lineno)
            print("  Parser sora: {}: {}".format(line, lines[line - 1].strip()))
        elif event == "exception":
            # Exception messages may contain local paths; only report the type.
            print("  Parser kivétel: " + value[0].__name__)
        return trace

    previous = sys.gettrace()
    try:
        sys.settrace(trace)
        version, _ = scanner.scan(root, "Palworld", "1623730")
    finally:
        sys.settrace(previous)
    print("Játékverzió: " + (version or "nem sikerült kiolvasni"))
    return version


def main():
    args = argparse.ArgumentParser(description=__doc__)
    args.add_argument("--plugin", type=Path, help="A telepített plugin main.py fájlja")
    args.add_argument("--game", type=Path, help="Palworld telepítési könyvtára")
    options = args.parse_args()
    try:
        path = options.plugin or find_plugin()
        source = path.read_text(encoding="utf-8-sig")
        print("Palworld verziódiagnosztika (gyorsítótár nélkül)")
        print("Parser SHA256: " + hashlib.sha256(source.encode("utf-8")).hexdigest()[:16])
        scanner, plugin = load_scanner(source)
        root = options.game or find_game(plugin)
        if not root.is_dir():
            raise ValueError("A játék könyvtára nem elérhető.")
        diagnose(scanner, root, source)
    except (OSError, ValueError, StopIteration, SyntaxError) as error:
        if isinstance(error, ValueError):
            print(str(error))
        else:
            print("Diagnosztika nem indítható: " + type(error).__name__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
