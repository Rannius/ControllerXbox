"""Embed the Linux helper and license notices, preserving Decky's ZIP layout.

Run only in release CI after cargo build. Git keeps auditable source; the
release main.py contains the compressed executable and its SHA256.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import zlib

root = Path(__file__).resolve().parents[1]
manifest = root / "native/version-helper/Cargo.toml"
binary = (manifest.parent / "target/x86_64-unknown-linux-musl/release/deck-version-helper").read_bytes()
if binary[:4] != b"\x7fELF" or len(binary) > 4 * 1024 * 1024:
    raise ValueError("Expected a small Linux ELF executable")
path = root / "main.py"
source = path.read_text(encoding="utf-8")
for name, value in (("OODLE_HELPER_SHA256", hashlib.sha256(binary).hexdigest()),
                    ("OODLE_HELPER_ZLIB_HEX", zlib.compress(binary, 9).hex())):
    placeholder = '    {} = ""'.format(name)
    if source.count(placeholder) != 1:
        raise ValueError("Missing or duplicate helper placeholder: " + name)
    source = source.replace(placeholder, '    {} = "{}"'.format(name, value))
path.write_text(source, encoding="utf-8")

metadata = json.loads(subprocess.check_output([
    "cargo", "metadata", "--manifest-path", str(manifest), "--format-version", "1",
    "--filter-platform", "x86_64-unknown-linux-musl", "--locked",
]))
mit = "Permission is hereby" + (root / "LICENSE").read_text(encoding="utf-8").split("Permission is hereby", 1)[1]
notices = ["\n\nBundled SteamOS version decoder — third-party notices\n"]
for package in sorted(metadata["packages"], key=lambda item: item["name"]):
    if package["name"] == "deck-version-helper":
        continue
    directory = Path(package["manifest_path"]).parent
    notices.append("\n{} {} ({})\n{}\n".format(
        package["name"], package["version"], package.get("license", ""), package.get("repository", "")))
    licenses = [item for item in directory.iterdir()
                if item.is_file() and item.name.lower().startswith(("license", "copying", "notice"))]
    for item in sorted(licenses):
        notices.append(item.read_text(encoding="utf-8", errors="replace") + "\n")
    if not licenses:
        if package["license"] != "MIT":
            raise ValueError("License notice missing for " + package["name"])
        # oozextract declares MIT in its published crate but ships no LICENSE.
        notices.append("Copyright: {} contributors\n{}\n".format(package["name"], mit))
with (root / "LICENSE").open("a", encoding="utf-8") as output:
    output.write("".join(notices))
print("Embedded SteamOS helper: {} bytes, SHA256 {}".format(len(binary), hashlib.sha256(binary).hexdigest()))
