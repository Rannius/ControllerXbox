"""Build the separate Ubuntu release asset; never change Decky's fixed ZIP."""
import hashlib
import io
import json
from pathlib import Path
import sys
import tarfile

root = Path(__file__).resolve().parents[1]
version = json.loads((root / "package.json").read_text())["version"]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root / "out"
output.mkdir(parents=True, exist_ok=True)
files = {name: (root / "price-server" / name).read_bytes() for name in
         ("server.py", "configure.py", "install.sh", "README.md", "home-assistant.yaml", "home-assistant-card.yaml")}
files.update({name: (root / name).read_bytes() for name in ("main.py", "package.json", "LICENSE")})
# Install shell files must use LF, even when packaged from a Windows checkout.
files = {name: content.replace(b"\r\n", b"\n") for name, content in files.items()}
files["SHA256SUMS"] = "".join(hashlib.sha256(data).hexdigest() + "  " + name + "\n" for name, data in files.items()).encode()
target = output / ("DeckPriceServer-v" + version + ".tar.gz")
with tarfile.open(target, "w:gz") as archive:
    for name, data in files.items():
        info = tarfile.TarInfo("DeckPriceServer/" + name)
        info.size = len(data)
        info.mode = 0o755 if name == "install.sh" else 0o644
        archive.addfile(info, io.BytesIO(data))
print(target)
