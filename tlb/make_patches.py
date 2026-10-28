import io
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


def renamed_font(path, family, style, full, ps):
    from fontTools.ttLib import TTFont
    f = TTFont(path)
    for rec in list(f["name"].names):
        if rec.nameID in (1, 2, 3, 4, 6, 16, 17, 21, 22):
            f["name"].removeNames(nameID=rec.nameID)
    for pid, eid, lid in ((3, 1, 0x409), (1, 0, 0)):
        f["name"].setName(family, 1, pid, eid, lid)
        f["name"].setName(style, 2, pid, eid, lid)
        f["name"].setName(ps, 3, pid, eid, lid)
        f["name"].setName(full, 4, pid, eid, lid)
        f["name"].setName(ps, 6, pid, eid, lid)
    out = io.BytesIO()
    f.save(out)
    return out.getvalue()


def font_ops(fonts):
    base = "ww2\\res2d\\fonts\\"
    return [
        ("Data_Common.dat", base + "ubigame text l reg v11.ttf",
         renamed_font(os.path.join(fonts, "Vazir-Regular.ttf"), "UbiGame Text TMP3", "Regular", "UbiGameTextTMP3", "UbiGameTextTMP3")),
        ("Data_Common.dat", base + "ubigame text l bold v07.ttf",
         renamed_font(os.path.join(fonts, "Vazir-Bold.ttf"), "UbiGame Text TMP3", "Bold", "UbiGameTextTMP3-Bold", "UbiGameTextTMP3-Bold")),
    ]


def main(game, out, fonts):
    ed = edata.open_dat(os.path.join(game, DATA_DIR, "ZZ_Win.dat"))
    entries = []
    entries.append(build_patch(out, 1, "Language name: Persian (plain Unicode)", lang_dic_ops(ed, "فارسی"), []))
    entries.append(build_patch(out, 2, "Language name: Persian (shaped, visual order)", lang_dic_ops(ed, visual("فارسی")), []))
    entries.append(build_patch(out, 3, "Font: Vazir replaces UbiGame Text (regular, bold)", font_ops(fonts), []))
    write_index(out, entries)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
