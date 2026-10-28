import io
import os
import sys

from patcher import DATA_DIR, build_patch, write_index
import fa
from ruse_mod_engine import dic, edata

LANG_DIR = "genlocalisation\\ww2\\localisation\\"
UI_FILES = ["interface_options.dic", "interface_in_game.dic", "loadsave.dic", "network.dic", "trophies.dic",
            "trophysystem.dic", "xlast.dic", "ai-descriptors.dic", "flash_txt.dic"]
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


def dic_ops(ed, name, files):
    tr = fa.load(name)
    base = LANG_DIR + "translations\\%s\\"
    ops = []
    for f in files:
        us, cz = ed.get(base % "us" + f), ed.get(base % "cz" + f)
        ops.append(("ZZ_Win.dat", base % "cz" + f, fa.translate_dic(us, cz, tr)))
    return ops


def campaign_files(ed):
    base = (LANG_DIR + "translations\\us\\").lower()
    return [p[len(base):] for p in ed.list() if p.lower().startswith(base) and "\\" in p[len(base):]]


BRAND = os.path.join(os.path.dirname(os.path.abspath(__file__)), "brand")
LOGO_TEXTURES = ["gen\\ww2\\resflash\\escape_menu\\escape_menu_ib1.tgv",
                 "gen\\ww2\\resflash\\interface_outgame\\interface_outgame_i182.tgv",
                 "gen\\ww2\\resflash\\interface_outgame\\interface_outgame_i242.tgv"]


def logo_tgv(w, h, scale):
    from PIL import Image
    from rusemod.tmst import make_tgv, zipo_pack
    logo = Image.open(os.path.join(BRAND, "logo.png")).convert("RGBA")
    k = min(w * scale / logo.width, h * scale / logo.height)
    logo = logo.resize((max(1, round(logo.width * k)), max(1, round(logo.height * k))), Image.LANCZOS)
    canvas = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    canvas.alpha_composite(logo, ((w - logo.width) // 2, (h - logo.height) // 2))
    r, g, b, a = canvas.split()
    raw = Image.merge("RGBA", (b, g, r, a)).tobytes()
    return make_tgv(w, h, "A8R8G8B8_LIN", [zipo_pack(raw)], 1)


def logo_ops(ed):
    from ruse_mod_engine import tgv
    ops = []
    for p in LOGO_TEXTURES:
        w, h, _, _ = tgv._parse(ed.get(p))
        ops.append(("ZZ_Win.dat", p, logo_tgv(w, h, 1.0 if h < 100 else 0.6)))
    return ops


def icon_ops(game):
    import io
    import struct
    import pefile
    from PIL import Image
    exe = os.path.join(game, "RUSE.exe")
    pe = pefile.PE(exe, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_RESOURCE"]])
    src = Image.open(os.path.join(BRAND, "icon.png")).convert("RGBA")
    icons, group = {}, None
    for t in pe.DIRECTORY_ENTRY_RESOURCE.entries:
        for n in t.directory.entries:
            for leaf in n.directory.entries:
                if t.id == 3:
                    icons[n.id] = leaf
                elif t.id == 14 and group is None:
                    group = leaf
    data = pe.__data__
    ops = []
    goff = pe.get_offset_from_rva(group.data.struct.OffsetToData)
    count = struct.unpack_from("<H", data, goff + 4)[0]
    for i in range(count):
        e = goff + 6 + 14 * i
        size_in_res, icon_id = struct.unpack_from("<IH", data, e + 8)
        leaf = icons[icon_id]
        off = pe.get_offset_from_rva(leaf.data.struct.OffsetToData)
        old = bytes(data[off:off + size_in_res])
        if old[:8] == b"\x89PNG\r\n\x1a\n":
            w = struct.unpack_from(">I", old, 16)[0]
            img = src.resize((w, w), Image.LANCZOS)
            new = None
            for colors in (256, 192, 128, 96, 64, 56, 48, 32, 16):
                b = io.BytesIO()
                img.quantize(colors=colors, method=Image.Quantize.FASTOCTREE).save(b, "PNG", optimize=True)
                if len(b.getvalue()) <= size_in_res:
                    new = b.getvalue()
                    break
        else:
            hsize, w, h2, planes, bpp = struct.unpack_from("<IiiHH", old, 0)
            if bpp != 32:
                continue
            img = src.resize((w, w), Image.LANCZOS).transpose(Image.FLIP_TOP_BOTTOM)
            r, g, b_, a = img.split()
            xor = Image.merge("RGBA", (b_, g, r, a)).tobytes()
            new = old[:hsize] + xor + old[hsize + len(xor):]
        if new is None or len(new) > size_in_res:
            continue
        ops.append(("RUSE.exe", off, new))
        ops.append(("RUSE.exe", leaf.data.struct.get_file_offset() + 4, struct.pack("<I", len(new))))
        ops.append(("RUSE.exe", e + 8, struct.pack("<I", len(new))))
    return ops


def main(game, out, fonts):
    ed = edata.open_dat(os.path.join(game, DATA_DIR, "ZZ_Win.dat"))
    entries = []
    entries.append(build_patch(out, 1, "Language name: Persian (plain Unicode)", lang_dic_ops(ed, "فارسی"), []))
    entries.append(build_patch(out, 2, "Language name: Persian (shaped, visual order)", lang_dic_ops(ed, visual("فارسی")), []))
    entries.append(build_patch(out, 3, "Font: Vazir replaces UbiGame Text (regular, bold)", font_ops(fonts), []))
    entries.append(build_patch(out, 4, "Persian UI: menus, options, in-game interface", dic_ops(ed, "ui", UI_FILES), []))
    entries.append(build_patch(out, 5, "Persian units, buildings and city names", dic_ops(ed, "units", ["baseunite.dic", "ville_multi.dic"]), []))
    entries.append(build_patch(out, 6, "Persian unit descriptions (encyclopedia)", dic_ops(ed, "descriptions", ["long_description_unite.dic"]), []))
    entries.append(build_patch(out, 7, "Persian campaign, operations and tutorial texts", dic_ops(ed, "campaign", campaign_files(ed)), []))
    entries.append(build_patch(out, 8, "Brand: The Last Battle logo replaces the R.U.S.E. logo in menus", logo_ops(ed), []))
    entries.append(build_patch(out, 9, "Brand: The Last Battle icon in RUSE.exe", [], [], icon_ops(game)))
    write_index(out, entries)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
