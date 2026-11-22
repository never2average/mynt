#!/usr/bin/env python3
"""Start an app from templates/mynt-app and wire in this build's generated SDKs.

usage: python3 scripts/scaffold_app.py <dest> [--kind <kind>] [--mobile expo|kotlin|swift|flutter] [--no-web] [--no-mobile]

--kind lays down the screens of an app kind (templates/kinds/<kind>.json) as placeholders: web/src/screens/
with a shell that switches between them, and mobile/app/<screen>.tsx for Expo. The kind's journey screen is
the starter's journey runner. The kind itself is copied to mynt-kind.json.
"""
import argparse, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE = os.path.join(HERE, "templates", "mynt-app")
MOBILE_TEMPLATES = os.path.join(HERE, "templates", "mynt-app-mobile")
KIND_TEMPLATE = os.path.join(HERE, "templates", "mynt-app-kind")
KINDS = os.path.join(HERE, "templates", "kinds")
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


def load_kind(kind):
    names = sorted(f[:-5] for f in os.listdir(KINDS) if f.endswith(".json"))
    if kind not in names:
        sys.exit(f"no app kind '{kind}' (templates/kinds has {', '.join(names)})")
    with open(os.path.join(KINDS, kind + ".json")) as f:
        data = json.load(f)
    data.pop("$schema", None)
    return data


def component(screen_id):
    return "".join(p.capitalize() for p in screen_id.split("-")) + "Screen"


def lit(text):
    """A TypeScript string literal (a JSON string is one, with non-ASCII escaped)."""
    return json.dumps(text)


def one_line(text):
    return " ".join(str(text).split())


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


WEB_SCREEN = """// Placeholder for the {title} screen of this {kind} app (mynt-kind.json): build it out.
// {purpose}
// SDK calls the kind relies on: {calls}.
export function {name}() {{
  return (
    <section>
      <h1>{{{title_lit}}}</h1>
      <p>{{{purpose_lit}}}</p>
    </section>
  );
}}
"""

MOBILE_SCREEN = """// Placeholder for the {title} screen of this {kind} app (mynt-kind.json): build it out.
// {purpose}
import {{ ScrollView, Text }} from "react-native";

export default function {name}() {{
  return (
    <ScrollView contentContainerStyle={{{{ padding: 16, gap: 12 }}}}>
      <Text accessibilityRole="header">{{{title_lit}}}</Text>
      <Text>{{{purpose_lit}}}</Text>
    </ScrollView>
  );
}}
"""


def lay_down_kind(dest, kind, web, expo):
    """The kind's screens as placeholders that compile, for the engineers to build out."""
    write(os.path.join(dest, "mynt-kind.json"), json.dumps(kind, indent=2) + "\n")
    calls = f"server (api/) {', '.join(kind['sdk_calls']['server'])}; browser {', '.join(kind['sdk_calls']['browser'])}"
    screens = kind["screens"]
    fill = lambda s: dict(
        title=one_line(s["title"]), kind=one_line(kind["title"]), purpose=one_line(s["purpose"]), calls=calls,
        name=component(s["id"]), title_lit=lit(s["title"]), purpose_lit=lit(s["purpose"]),
    )
    if web:
        shutil.copytree(os.path.join(KIND_TEMPLATE, "web"), os.path.join(dest, "web"), dirs_exist_ok=True)
        imports, rows = ['import type { ComponentType } from "react";'], []
        if any(s.get("journey") for s in screens):
            imports.append('import { App } from "../App";')
        for s in screens:
            name = "App" if s.get("journey") else component(s["id"])
            if not s.get("journey"):
                imports.append(f'import {{ {name} }} from "./{s["id"]}";')
                write(os.path.join(dest, "web", "src", "screens", s["id"] + ".tsx"), WEB_SCREEN.format(**fill(s)))
            rows.append(f"  {{ id: {lit(s['id'])}, title: {lit(s['title'])}, Screen: {name} }},")
        write(
            os.path.join(dest, "web", "src", "screens", "index.ts"),
            "// The app's screens, in its kind's order (mynt-kind.json). The first one opens by default.\n"
            + "\n".join(imports)
            + "\n\nexport const SCREENS: { id: string; title: string; Screen: ComponentType }[] = [\n"
            + "\n".join(rows)
            + "\n];\n",
        )
    if expo:
        for s in screens:
            if not s.get("journey"):  # the journey is mobile/app/index.tsx
                write(os.path.join(dest, "mobile", "app", s["id"] + ".tsx"), MOBILE_SCREEN.format(**fill(s)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("dest")
    ap.add_argument("--mobile", default="expo", choices=["expo", "kotlin", "swift", "flutter"])
    ap.add_argument("--no-web", action="store_true")
    ap.add_argument("--no-mobile", action="store_true")
    ap.add_argument("--sdk", default=None, help="the generated SDK folder (default: job/sdk)")
    ap.add_argument("--kind", default=None, help="an app kind from templates/kinds (build.json's kind)")
    a = ap.parse_args()
    kind = load_kind(a.kind) if a.kind else None
    global SDK
    if a.sdk:
        SDK = os.path.abspath(a.sdk)

    # A fresh clone of a new repository (only its git folder and the first commit's README) counts as empty: the
    # template's README replaces that one.
    if os.path.exists(a.dest) and set(os.listdir(a.dest)) - {".git", "README.md"}:
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

    if kind:
        lay_down_kind(a.dest, kind, web=not a.no_web, expo=not a.no_mobile and a.mobile == "expo")

    # Keep the root workspaces list to the parts that exist.
    root = os.path.join(a.dest, "package.json")
    with open(root) as f:
        pkg = json.load(f)
    pkg["workspaces"] = [w for w in pkg["workspaces"] if w == "packages/*" or os.path.exists(os.path.join(a.dest, w, "package.json"))]
    with open(root, "w") as f:
        json.dump(pkg, f, indent=2)
        f.write("\n")
    screens = f"; kind {kind['id']}: screens {', '.join(s['id'] for s in kind['screens'])}" if kind else ""
    print(f"scaffolded {a.dest}: workspaces {', '.join(pkg['workspaces'])}{screens}")


if __name__ == "__main__":
    main()
