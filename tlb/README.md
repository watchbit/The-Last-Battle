# آخرین نبرد (The Last Battle)

## پچ‌ها
- ساخت همه پچ‌ها از روی بازی اصلی:
  `python tlb/make_patches.py <پوشه بازی> updates <پوشه فونت وزیر>`
- اعمال و بازگردانی دستی:
  `python tlb/patcher.py apply <پوشه بازی> updates/patch_001.zip`
  `python tlb/patcher.py revert <پوشه بازی> 1`
- خروجی RUSE Studio به پچ: یک کپی تمیز از بازی و یک کپی که مود Studio روی آن اعمال شده:
  `python tlb/patch_from_game.py <بازی تمیز> <بازی مودشده> <شماره پچ> "<نام پچ>" updates`
  زیپ ساخته‌شده را در پنل مدیریت آپلود کنید.

## سرور (`server/`)
- نصب روی اوبونتو: `bash install_ubuntu.sh`، سپس در `/etc/systemd/system/tlw.service` مقدار `TLW_ADMIN_PASSWORD` را عوض کنید.
- پنل مدیریت: `http://2.144.24.35:8080/admin`
- فایل‌های بازی برای دانلود از لانچر:
  `python tlb/make_game_manifest.py <پوشه بازی تمیز> /opt/tlw/data/game 1`

## لانچر (`tlb/launcher/`)
- اجرا: `pip install -r tlb/requirements.txt` و سپس از پوشه `tlb`: `python -m launcher`
- ساخت فایل exe:
  `pyinstaller --noconfirm --windowed --name TheLastBattle --icon tlb/brand/icon.ico --add-data "tlb/launcher/ui;launcher/ui" --paths tlb --paths src tlb/launcher/__main__.py`

بر پایه بازی R.U.S.E. ساخت Eugen Systems و انتشار Ubisoft. فونت وزیر با مجوز OFL.
