import hashlib
import json
import os
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from ruse_mod_engine import edata

DATA_DIR = os.path.join("Data", "PC", "190852")
STATE_DIR = "_tlb"


def build_patch(out_dir, patch_id, name, dat_ops, loose_ops):
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "patch_%03d.zip" % patch_id)
    ops = []
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        n = 0
        for dat, vpath, blob in dat_ops:
            n += 1
            z.writestr("payload/%d.bin" % n, blob)
            ops.append({"type": "dat", "dat": dat, "path": vpath, "payload": "payload/%d.bin" % n})
        for rel, blob in loose_ops:
            n += 1
            z.writestr("payload/%d.bin" % n, blob)
            ops.append({"type": "file", "path": rel, "payload": "payload/%d.bin" % n})
        z.writestr("manifest.json", json.dumps({"id": patch_id, "name": name, "ops": ops}, ensure_ascii=False, indent=1))
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return {"id": patch_id, "name": name, "file": os.path.basename(path), "size": os.path.getsize(path), "sha256": digest}


def write_index(out_dir, entries):
    entries = sorted(entries, key=lambda e: e["id"])
    with open(os.path.join(out_dir, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"patches": entries}, f, ensure_ascii=False, indent=1)


def _state(game):
    d = os.path.join(game, STATE_DIR)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, "applied.json")
    if os.path.exists(p):
        return p, json.load(open(p, encoding="utf-8"))
    return p, {"applied": []}


def apply_patch(game, patch_zip):
    with zipfile.ZipFile(patch_zip) as z:
        man = json.loads(z.read("manifest.json").decode("utf-8"))
        sp, st = _state(game)
        if man["id"] in st["applied"]:
            return "already applied"
        undo = zipfile.ZipFile(os.path.join(game, STATE_DIR, "undo_%03d.zip" % man["id"]), "w", zipfile.ZIP_DEFLATED)
        undo_ops = []
        by_dat = {}
        for op in man["ops"]:
            if op["type"] == "dat":
                by_dat.setdefault(op["dat"], []).append(op)
        for dat, ops in by_dat.items():
            ed = edata.open_dat(os.path.join(game, DATA_DIR, dat))
            rep, add = {}, {}
            for op in ops:
                blob = z.read(op["payload"])
                old = ed.get(op["path"])
                if old is None:
                    add[op["path"]] = blob
                    undo_ops.append({"type": "dat", "dat": dat, "path": op["path"], "original": None})
                else:
                    rep[op["path"]] = blob
                    k = "undo/%d.bin" % len(undo_ops)
                    undo.writestr(k, old)
                    undo_ops.append({"type": "dat", "dat": dat, "path": op["path"], "original": k})
            ed.batch_update(rep, add)
        for op in man["ops"]:
            if op["type"] == "file":
                target = os.path.join(game, op["path"])
                if os.path.exists(target):
                    k = "undo/%d.bin" % len(undo_ops)
                    undo.write(target, k)
                    undo_ops.append({"type": "file", "path": op["path"], "original": k})
                else:
                    undo_ops.append({"type": "file", "path": op["path"], "original": None})
                os.makedirs(os.path.dirname(target), exist_ok=True)
                with open(target, "wb") as f:
                    f.write(z.read(op["payload"]))
        undo.writestr("undo.json", json.dumps(undo_ops))
        undo.close()
        st["applied"].append(man["id"])
        json.dump(st, open(sp, "w", encoding="utf-8"))
    return "applied %d" % man["id"]


def revert_patch(game, patch_id):
    sp, st = _state(game)
    if patch_id not in st["applied"]:
        return "not applied"
    with zipfile.ZipFile(os.path.join(game, STATE_DIR, "undo_%03d.zip" % patch_id)) as z:
        ops = json.loads(z.read("undo.json").decode("utf-8"))
        by_dat = {}
        for op in ops:
            if op["type"] == "dat" and op["original"] is not None:
                by_dat.setdefault(op["dat"], {})[op["path"]] = z.read(op["original"])
        for dat, rep in by_dat.items():
            edata.open_dat(os.path.join(game, DATA_DIR, dat)).batch_update(rep, {})
        for op in ops:
            if op["type"] == "file":
                target = os.path.join(game, op["path"])
                if op["original"] is None:
                    if os.path.exists(target):
                        os.remove(target)
                else:
                    with open(target, "wb") as f:
                        f.write(z.read(op["original"]))
    st["applied"].remove(patch_id)
    json.dump(st, open(sp, "w", encoding="utf-8"))
    return "reverted %d" % patch_id


if __name__ == "__main__":
    if sys.argv[1] == "apply":
        print(apply_patch(sys.argv[2], sys.argv[3]))
    elif sys.argv[1] == "revert":
        print(revert_patch(sys.argv[2], int(sys.argv[3])))
