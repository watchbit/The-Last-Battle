import hashlib
import json
import os
import socket
import ssl
import subprocess
import sys
import threading
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))

import patcher

DEFAULT_SERVER = "2.144.24.35"
HTTP_PORT = 8080
GATEWAY_PORT = 8081
CONTROL_PORT = 8082
LANG_CODES = {"fa": "cs-CZ", "en": "en-US"}


def config_dir():
    base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), ".config")
    d = os.path.join(base, "TheLastBattle")
    os.makedirs(d, exist_ok=True)
    return d


class Control:
    def __init__(self, cfg, save):
        self.cfg, self.save = cfg, save
        self.sock = None
        self.file = None
        self.seq = 0
        self.lock = threading.Lock()

    def connect(self):
        raw = socket.create_connection((self.cfg["server"], CONTROL_PORT), timeout=10)
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        s = ctx.wrap_socket(raw)
        fp = hashlib.sha256(s.getpeercert(binary_form=True)).hexdigest()
        pinned = self.cfg.get("pins", {}).get(self.cfg["server"])
        if pinned and pinned != fp:
            s.close()
            raise ConnectionError("گواهی سرور تغییر کرده است؛ اتصال برای امنیت قطع شد")
        if not pinned:
            self.cfg.setdefault("pins", {})[self.cfg["server"]] = fp
            self.save()
        self.sock, self.file = s, s.makefile("rw", encoding="utf-8", newline="\n")
        if self.cfg.get("session"):
            r = self._send({"cmd": "resume", "token": self.cfg["session"]})
            if not r.get("ok"):
                self.cfg["session"] = ""
                self.save()

    def _send(self, msg):
        self.seq += 1
        msg["id"] = self.seq
        self.file.write(json.dumps(msg, ensure_ascii=False) + "\n")
        self.file.flush()
        while True:
            line = self.file.readline()
            if not line:
                raise ConnectionError("اتصال به سرور قطع شد")
            r = json.loads(line)
            if r.get("id") == msg["id"]:
                return r

    def call(self, cmd, **kw):
        with self.lock:
            for attempt in (0, 1):
                try:
                    if self.sock is None:
                        self.connect()
                    return self._send({"cmd": cmd, **kw})
                except (OSError, ConnectionError, ValueError) as e:
                    self.close()
                    if attempt:
                        return {"ok": False, "error": "سرور در دسترس نیست: %s" % e}

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass
        self.sock = self.file = None


class Api:
    def __init__(self):
        self._path = os.path.join(config_dir(), "config.json")
        try:
            with open(self._path, encoding="utf-8") as f:
                self._cfg = json.load(f)
        except (OSError, ValueError):
            self._cfg = {}
        self._cfg.setdefault("server", DEFAULT_SERVER)
        self._cfg.setdefault("game_dir", "")
        self._cfg.setdefault("language", "fa")
        self._cfg.setdefault("session", "")
        self._ctl = Control(self._cfg, self._save)
        self._job = {"kind": "", "running": False, "done": 0, "total": 0, "message": "", "error": ""}
        self._window = None

    def _save(self):
        tmp = self._path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(self._cfg, f, ensure_ascii=False, indent=1)
        os.replace(tmp, self._path)

    def _url(self, path):
        return "http://%s:%d%s" % (self._cfg["server"], HTTP_PORT, path)

    def _get_json(self, path):
        with urllib.request.urlopen(self._url(path), timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))

    def _game(self):
        return self._cfg.get("game_dir") or ""

    def _exe(self):
        return os.path.join(self._game(), "RUSE.exe")

    def settings(self):
        return {"server": self._cfg["server"], "game_dir": self._game(), "language": self._cfg["language"],
                "installed": os.path.isfile(self._exe()), "logged_in": bool(self._cfg.get("session"))}

    def set_server(self, host):
        host = str(host).strip()
        if host:
            self._cfg["server"] = host
            self._save()
            self._ctl.close()
        return self.settings()

    def set_language(self, lang):
        if lang in LANG_CODES:
            self._cfg["language"] = lang
            self._save()
            self._write_lang()
        return self.settings()

    def _write_lang(self):
        if os.path.isdir(os.path.join(self._game(), "Data")):
            with open(os.path.join(self._game(), "Data", "lang.ini"), "w", encoding="ascii") as f:
                f.write(LANG_CODES[self._cfg["language"]])

    def pick_game_folder(self):
        import webview
        kind = webview.FileDialog.FOLDER if hasattr(webview, "FileDialog") else webview.FOLDER_DIALOG
        chosen = self._window.create_file_dialog(kind)
        if chosen:
            self._cfg["game_dir"] = chosen[0]
            self._save()
        return self.settings()

    def register(self, username, password, display):
        r = self._ctl.call("register", username=username, password=password, display=display)
        return self._session(r)

    def login(self, username, password):
        return self._session(self._ctl.call("login", username=username, password=password))

    def _session(self, r):
        if r.get("ok"):
            self._cfg["session"] = r["token"]
            self._save()
        return r

    def logout(self):
        self._ctl.call("logout", token=self._cfg.get("session", ""))
        self._cfg["session"] = ""
        self._save()
        return {"ok": True}

    def me(self):
        if not self._cfg.get("session"):
            return {"ok": False}
        r = self._ctl.call("me")
        if not r.get("ok"):
            self._cfg["session"] = ""
            self._save()
        return r

    def set_display(self, display):
        return self._ctl.call("setDisplay", display=display)

    def change_password(self, old, new):
        return self._ctl.call("changePassword", oldPassword=old, newPassword=new)

    def friends(self):
        return self._ctl.call("friends")

    def friend_request(self, username):
        return self._ctl.call("friendRequest", username=username)

    def friend_accept(self, username):
        return self._ctl.call("friendAccept", username=username)

    def friend_decline(self, username):
        return self._ctl.call("friendDecline", username=username)

    def friend_remove(self, username):
        return self._ctl.call("friendRemove", username=username)

    def search_users(self, query):
        return self._ctl.call("searchUsers", query=query)

    def leaderboard(self, by="xp"):
        return self._ctl.call("leaderboard", by=by, limit=100)

    def user_profile(self, username):
        return self._ctl.call("userProfile", username=username)

    def lobbies(self):
        return self._ctl.call("lobbies")

    def server_ping(self):
        return self._ctl.call("ping")

    def progress(self):
        return dict(self._job)

    def _start(self, kind, fn):
        if self._job["running"]:
            return {"ok": False, "error": "یک کار دیگر در حال انجام است"}
        self._job = {"kind": kind, "running": True, "done": 0, "total": 0, "message": "", "error": ""}

        def run():
            try:
                fn()
            except Exception as e:
                self._job["error"] = str(e)
            self._job["running"] = False
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True}

    def _applied(self):
        p = os.path.join(self._game(), patcher.STATE_DIR, "applied.json")
        try:
            with open(p, encoding="utf-8") as f:
                return set(json.load(f)["applied"])
        except (OSError, ValueError, KeyError):
            return set()

    def updates(self):
        try:
            idx = self._get_json("/updates/index.json")
        except Exception as e:
            return {"ok": False, "error": "دریافت فهرست آپدیت ممکن نشد: %s" % e}
        applied = self._applied()
        pending = [p for p in idx["patches"] if p["id"] not in applied]
        return {"ok": True, "news": idx.get("news", ""), "pending": pending, "applied": sorted(applied),
                "installed": os.path.isfile(self._exe())}

    def apply_updates(self):
        def run():
            if not os.path.isfile(self._exe()):
                raise RuntimeError("ابتدا بازی را نصب یا پوشه آن را انتخاب کنید")
            pending = self.updates()
            if not pending.get("ok"):
                raise RuntimeError(pending["error"])
            items = pending["pending"]
            self._job["total"] = len(items)
            cache = os.path.join(config_dir(), "patches")
            os.makedirs(cache, exist_ok=True)
            for p in items:
                self._job["message"] = "دانلود پچ %d: %s" % (p["id"], p["name"])
                dest = os.path.join(cache, p["file"])
                if not (os.path.exists(dest) and self._sha(dest) == p["sha256"]):
                    self._download(self._url("/updates/" + p["file"]), dest)
                    if self._sha(dest) != p["sha256"]:
                        raise RuntimeError("پچ %d سالم دانلود نشد" % p["id"])
                self._job["message"] = "اعمال پچ %d: %s" % (p["id"], p["name"])
                patcher.apply_patch(self._game(), dest)
                self._job["done"] += 1
            self._job["message"] = "همه آپدیت‌ها اعمال شد"
        return self._start("updates", run)

    def install_game(self):
        def run():
            if not self._game():
                raise RuntimeError("ابتدا پوشه نصب را انتخاب کنید")
            man = self._get_json("/game/manifest.json")
            todo = [f for f in man["files"] if not self._same(os.path.join(self._game(), f["path"]), f)]
            if any(f["path"].lower().endswith(".dat") for f in todo):
                state = os.path.join(self._game(), patcher.STATE_DIR, "applied.json")
                if os.path.exists(state):
                    os.remove(state)
            self._job["total"] = sum(f["size"] for f in todo)
            for f in todo:
                self._job["message"] = "دانلود " + f["path"]
                target = os.path.join(self._game(), f["path"])
                os.makedirs(os.path.dirname(target), exist_ok=True)
                self._download(self._url("/game/files/" + urllib.request.quote(f["path"])), target, count=True)
                if self._sha(target) != f["sha256"]:
                    raise RuntimeError("فایل %s سالم دانلود نشد" % f["path"])
            self._write_lang()
            self._job["message"] = "بازی نصب شد"
        return self._start("install", run)

    def verify_game(self):
        def run():
            man = self._get_json("/game/manifest.json")
            self._job["total"] = len(man["files"])
            bad = []
            for f in man["files"]:
                self._job["message"] = "بررسی " + f["path"]
                p = os.path.join(self._game(), f["path"])
                if not os.path.exists(p) or (f["path"].lower().endswith(".dat") is False and self._sha(p) != f["sha256"]):
                    bad.append(f["path"])
                self._job["done"] += 1
            self._job["message"] = "همه فایل‌ها سالم‌اند" if not bad else "فایل‌های ناقص: %d" % len(bad)
        return self._start("verify", run)

    def _same(self, path, f):
        if not os.path.exists(path):
            return False
        return f["path"].lower().endswith(".dat") or os.path.getsize(path) == f["size"]

    def _sha(self, path):
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        return h.hexdigest()

    def _download(self, url, dest, count=False):
        tmp = dest + ".part"
        have = os.path.getsize(tmp) if os.path.exists(tmp) else 0
        req = urllib.request.Request(url, headers={"Range": "bytes=%d-" % have} if have else {})
        with urllib.request.urlopen(req, timeout=60) as r:
            mode = "ab" if have and r.status == 206 else "wb"
            if count and mode == "ab":
                self._job["done"] += have
            with open(tmp, mode) as out:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    out.write(chunk)
                    if count:
                        self._job["done"] += len(chunk)
        os.replace(tmp, dest)

    def play(self, mode):
        if not os.path.isfile(self._exe()):
            return {"ok": False, "error": "بازی نصب نیست؛ ابتدا آن را نصب کنید یا پوشه آن را انتخاب کنید"}
        self._write_lang()
        env = dict(os.environ)
        online = {"server": self._cfg["server"], "gateway": GATEWAY_PORT, "mode": mode, "token": "", "steamId": "", "name": ""}
        if mode == "multiplayer":
            r = self._ctl.call("gameToken")
            if not r.get("ok"):
                return {"ok": False, "error": r.get("error") or "برای بازی چندنفره ابتدا وارد شوید"}
            online.update(token=r["token"], steamId=r["steamId"], name=r["display"])
            env.update(TLW_SERVER=self._cfg["server"], TLW_GATEWAY=str(GATEWAY_PORT), TLW_TOKEN=r["token"])
        else:
            env["TLW_OFFLINE"] = "1"
        with open(os.path.join(self._game(), "tlb_online.json"), "w", encoding="utf-8") as f:
            json.dump(online, f, ensure_ascii=False)
        subprocess.Popen([self._exe()], cwd=self._game(), env=env)
        return {"ok": True}
