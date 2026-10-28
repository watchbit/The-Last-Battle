import json
import os
import struct

from ruse_mod_engine import dic

TR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "translations")
CHARSET = "__CHARSET__"


def load(name):
    with open(os.path.join(TR_DIR, name + ".json"), encoding="utf-8") as f:
        return json.load(f)


def build_dic(head, recs):
    recs = sorted(recs, key=lambda r: int.from_bytes(r[0], "little"))
    start = 8 + 16 * len(recs)
    table = bytearray(head + struct.pack("<I", len(recs)))
    blob = bytearray()
    for k, s in recs:
        table += k + struct.pack("<II", start + len(blob), len(s))
        blob += s.encode("utf-16-le")
    return bytes(table + blob)


def translate_dic(us_blob, target_blob, tr):
    us = dict(dic.read(us_blob))
    target = dic.read(target_blob)
    out = []
    used = set()
    for k, s in target:
        src = us.get(k, s)
        t = tr.get(src, src)
        out.append([k, t])
        if t != CHARSET:
            used.update(t)
    for r in out:
        if r[1] == CHARSET:
            r[1] = "".join(sorted(used | set(us.get(r[0], "")))).replace("\x00", "")
    return build_dic(target_blob[:4], [tuple(r) for r in out])
