import hashlib
import json
import os
import shutil
import sys

SKIP_DIRS = {"_tlb"}
SKIP_FILES = {"OnlineFix.ini", "OnlineFix.url", "OnlineFix64.dll", "Www.PirateGames.iR.url", "PirateGames.iR.txt", "Fix Repair.rar", "dlllist.txt"}


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main(game, out, version):
    files = []
    dest = os.path.join(out, "files")
    for root, dirs, names in os.walk(game):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for n in sorted(names):
            if n in SKIP_FILES:
                continue
            full = os.path.join(root, n)
            rel = os.path.relpath(full, game).replace(os.sep, "/")
            files.append({"path": rel, "size": os.path.getsize(full), "sha256": sha256(full)})
            target = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if not os.path.exists(target) or os.path.getsize(target) != os.path.getsize(full):
                shutil.copy2(full, target)
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"version": version, "files": files}, f, indent=1)
    print(len(files), sum(x["size"] for x in files))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "1")
