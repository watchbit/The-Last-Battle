import os
import sys

from patcher import DATA_DIR, build_patch
from ruse_mod_engine import edata

SKIP = {"_tlb"}


def diff(clean, modded):
    dat_ops, loose_ops = [], []
    data = os.path.join(modded, DATA_DIR)
    for name in sorted(os.listdir(data)):
        if not name.lower().endswith(".dat"):
            continue
        a = os.path.join(clean, DATA_DIR, name)
        b = os.path.join(data, name)
        if os.path.exists(a) and os.path.getsize(a) == os.path.getsize(b) and open(a, "rb").read() == open(b, "rb").read():
            continue
        old = edata.open_dat(a) if os.path.exists(a) else None
        new = edata.open_dat(b)
        for p in new.list():
            blob = new.get(p)
            if old is None or old.get(p) != blob:
                dat_ops.append((name, p, blob))
    for root, dirs, files in os.walk(modded):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, modded)
            if rel.lower().endswith(".dat") and os.path.dirname(rel) == DATA_DIR:
                continue
            ref = os.path.join(clean, rel)
            blob = open(full, "rb").read()
            if not os.path.exists(ref) or open(ref, "rb").read() != blob:
                loose_ops.append((rel.replace(os.sep, "/"), blob))
    return dat_ops, loose_ops


if __name__ == "__main__":
    clean, modded, pid, name, out = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4], sys.argv[5]
    dat_ops, loose_ops = diff(clean, modded)
    print(build_patch(out, pid, name, dat_ops, loose_ops))
