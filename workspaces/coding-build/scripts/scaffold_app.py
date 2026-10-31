#!/usr/bin/env python3
"""Start an app from templates/mynt-app and wire in this build's generated SDKs.

usage: python3 scripts/scaffold_app.py <dest> [--mobile expo|kotlin|swift|flutter] [--no-web] [--no-mobile]
"""
import argparse, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(HERE, "templates", "mynt-app")
MOBILE_TEMPLATES = os.path.join(HERE, "templates", "mynt-app-mobile")
PLACEHOLDER = "__MYNT_SDK_PACKAGE__"
SDK = os.path.join(HERE, "job", "sdk")


def rename_package(path, name):
    with open(path) as f:
        pkg = json.load(f)
    pkg["name"] = name
    with open(path, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")


def native_mobile(mobile, lang):
    """Native apps build outside Compose: swap the Expo skeleton for templates/mynt-app-mobile/<lang>,
    put this build's SDK where that template expects it and fill in the SDK's package/module name."""
    shutil.rmtree(mobile)
    shutil.copytree(os.path.join(MOBILE_TEMPLATES, lang), mobile)
    sdk = os.path.join(SDK, lang)
    if lang == "kotlin":
        src = os.path.join(sdk, "src", "main", "kotlin")
        shutil.copytree(src, os.path.join(mobile, "app", "src", "main", "kotlin"), dirs_exist_ok=True)
        client = next(os.path.join(d, f) for d, _, fs in os.walk(src) for f in fs if f == "MyntClient.kt")
        with open(client) as f:
            name = re.search(r"^package\s+([\w.]+)", f.read(), re.M).group(1)
    elif lang == "swift":
        shutil.copytree(sdk, os.path.join(mobile, "MyntSDK"))
        name = os.listdir(os.path.join(sdk, "Sources"))[0]
    else:
        shutil.copytree(sdk, os.path.join(mobile, "mynt_sdk"))
        with open(os.path.join(sdk, "pubspec.yaml")) as f:
            name = re.search(r"^name:\s*(\S+)", f.read(), re.M).group(1)
    for d, _, fs in os.walk(mobile):
        for f in fs:
            p = os.path.join(d, f)
            with open(p) as fh:
                text = fh.read()
            if PLACEHOLDER in text:
                with open(p, "w") as fh:
                    fh.write(text.replace(PLACEHOLDER, name))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest")
    ap.add_argument("--mobile", default="expo", choices=["expo", "kotlin", "swift", "flutter"])
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--no-mobile", action="store_true")
    a = ap.parse_args()

    if os.path.exists(a.dest) and os.listdir(a.dest):
        sys.exit(f"{a.dest} isn't empty")
    shutil.copytree(TEMPLATE, a.dest, dirs_exist_ok=True)
    packages = os.path.join(a.dest, "packages")

    # The TypeScript SDK (server client + ./browser) serves api/ and web/.
    shutil.copytree(os.path.join(SDK, "typescript"), os.path.join(packages, "mynt-sdk"))
    rename_package(os.path.join(packages, "mynt-sdk", "package.json"), "mynt-sdk")
    shutil.copy(os.path.join(SDK, "openapi.json"), os.path.join(packages, "openapi.json"))

    if a.no_web:
        shutil.rmtree(os.path.join(a.dest, "web"))
    if a.no_mobile:
        shutil.rmtree(os.path.join(a.dest, "mobile"))
    elif a.mobile == "expo":
        shutil.copytree(os.path.join(SDK, "react-native"), os.path.join(packages, "mynt-sdk-react-native"))
        rename_package(os.path.join(packages, "mynt-sdk-react-native", "package.json"), "mynt-sdk-react-native")
    else:
        native_mobile(os.path.join(a.dest, "mobile"), a.mobile)

    # Keep the root workspaces list to the parts that exist.
    root = os.path.join(a.dest, "package.json")
    with open(root) as f:
        pkg = json.load(f)
    pkg["workspaces"] = [w for w in pkg["workspaces"] if w == "packages/*" or os.path.exists(os.path.join(a.dest, w, "package.json"))]
    with open(root, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    print(f"scaffolded {a.dest}: workspaces {', '.join(pkg['workspaces'])}")


if __name__ == "__main__":
    main()
