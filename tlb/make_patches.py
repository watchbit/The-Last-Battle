import os
import sys

from patcher import DATA_DIR, build_patch, write_index
from ruse_mod_engine import dic, edata

LANG_DIR = "genlocalisation\\ww2\\localisation\\"
LANG_KEY = bytes.fromhex("6403000000000000")


def visual(text):
    import arabic_reshaper
    from bidi.algorithm import get_display
    return get_display(arabic_reshaper.reshape(text))


def lang_dic_ops(ed, name):
    ops = []
    for p in ed.list():
        if p.lower().endswith("\\lang.dic") and p.lower().startswith(LANG_DIR):
            ops.append(("ZZ_Win.dat", p, dic.set_entry(ed.get(p), LANG_KEY, name)))
    return ops


def main(game, out):
    ed = edata.open_dat(os.path.join(game, DATA_DIR, "ZZ_Win.dat"))
    entries = []
    entries.append(build_patch(out, 1, "Language name: Persian (plain Unicode)", lang_dic_ops(ed, "فارسی"), []))
    entries.append(build_patch(out, 2, "Language name: Persian (shaped, visual order)", lang_dic_ops(ed, visual("فارسی")), []))
    write_index(out, entries)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
