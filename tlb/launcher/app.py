import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from launcher.api import Api

UI = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ui")


def main():
    import webview
    api = Api()
    window = webview.create_window("آخرین نبرد", os.path.join(UI, "index.html"), js_api=api, width=1200, height=760,
                                   min_size=(1000, 640), background_color="#100d0b")
    api._window = window
    webview.start(icon=os.path.join(UI, "icon.png"))


if __name__ == "__main__":
    main()
