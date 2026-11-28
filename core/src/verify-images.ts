// The container-image stage of Mynt's build verification (verify.sh writes this beside itself and runs it): the
// images an app ships are built from the verified source in the clean sandbox, each gets a CycloneDX SBOM (syft)
// and a vulnerability scan (grype, over that SBOM), and the result is kept in images.json for the `sbom` and
// `image_scan` checks and for the pipeline evidence Mynt shows its auditor. Python's standard library only.
//
// What it builds is what Mynt's hosting starts: every service of the root Compose file that isn't behind a profile
// (built from its Dockerfile, or pulled when it names an image), or the root Dockerfile of an app without Compose.
// Hosting builds the images again on the app's own machine from the same verified commit, so what is scanned here
// is a build of the same source and Dockerfiles, not the deployed bytes; base images pinned by digest and a
// lockfile are what keep the two the same.
//
// What fails the check is what the app's own Dockerfile can put right: a high or critical vulnerability with a fixed
// version in a system package (upgrade it), in a package the image installs, or in a runtime the image is built on
// (a newer base image). Two kinds are warnings instead, each listed by id: one with no fixed version yet, and one in
// a library compiled into a program that came with the base image (a Go or Rust executable its publisher built:
// the same library, version and file as in the base image's own SBOM),
// which only a newer build of that image can fix. Every count goes into the record whatever its kind.
//
// Without docker in the sandbox nothing can be built: the base images the Dockerfiles name are scanned instead,
// read straight from their registries, and the check says exactly that (a warning at best, never a pass).

export const VERIFY_IMAGES_SCRIPT = String.raw`#!/usr/bin/env python3
"""usage: images.py <source-dir> <verify-dir> <syft> <grype> [--syft-version V] [--grype-version V]"""
import hashlib, json, os, re, shutil, subprocess, sys, time

SRC, V, SYFT, GRYPE = sys.argv[1:5]
VERSIONS = dict(zip(sys.argv[5::2], sys.argv[6::2]))
COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]
SEVERITIES = ["critical", "high", "medium", "low", "unknown"]
# Package types that exist only inside a compiled executable: fixing one means rebuilding that executable.
COMPILED = ("go-module", "rust-crate")
BUILD_SECONDS, SCAN_SECONDS = 1200, 600
os.makedirs(os.path.join(V, "sbom-images"), exist_ok=True)
os.makedirs(os.path.join(V, "images"), exist_ok=True)
ENV = dict(os.environ, DOCKER_BUILDKIT="1", GRYPE_CHECK_FOR_APP_UPDATE="false", SYFT_CHECK_FOR_APP_UPDATE="false",
           GRYPE_DB_CACHE_DIR=os.path.join(V, "grype-db"))
now = lambda: time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
slug = lambda s: re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "image"


def run(cmd, timeout, cwd=None):
    try:
        p = subprocess.run(cmd, cwd=cwd, env=ENV, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
        return p.returncode, p.stdout.decode("utf-8", "replace")
    except subprocess.TimeoutExpired:
        return 124, f"timed out after {timeout}s"
    except OSError as e:
        return 127, str(e)


def base_images(dockerfile):
    """The images a Dockerfile starts from (not its own earlier stages), and which one the shipped stage uses."""
    try:
        text = open(dockerfile, encoding="utf-8", errors="replace").read()
    except OSError:
        return []
    # Each stage's base, by its name and its number; the last stage is the one that ships.
    stages, refs, final, n = {}, [], None, 0
    for line in re.sub(r"\\\r?\n", " ", text).splitlines():
        m = re.match(r"\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?", line, re.I)
        if not m:
            continue
        ref, alias = m.group(1), m.group(2)
        if ref.lower() in stages:
            final = stages[ref.lower()]
        elif ref.lower() == "scratch":
            final = None
        else:
            final = ref
            if ref not in refs:
                refs.append(ref)
        stages[str(n)] = final
        if alias:
            stages[alias.lower()] = final
        n += 1
    return [{"ref": r, "pinned": "@sha256:" in r, "final": r == final} for r in refs]


def sbom_of(source, name):
    """A CycloneDX SBOM of an image (syft), kept beside the source's. Returns its record, or the reason it failed."""
    path = os.path.join(V, "sbom-images", name + ".cdx.json")
    code, out = run([SYFT, source, "-o", "cyclonedx-json=" + path, "-q"], SCAN_SECONDS)
    try:
        components = len(json.load(open(path)).get("components") or [])
    except (OSError, ValueError):
        components = 0
    if code != 0 or not components:
        return None, (out.strip()[-300:] or "the SBOM has no components")
    digest = hashlib.sha256(open(path, "rb").read()).hexdigest()
    return {"path": path, "format": "CycloneDX", "tool": "syft", "tool_version": VERSIONS.get("--syft-version", ""), "sha256": digest, "components": components}, None


BASES = {"": set()}


def base_contents(ref):
    """What a base image itself holds: (package url, file) pairs from its own SBOM, read from its registry once.
    A Dockerfile may rewrite a base image's file without changing it (stripping a capability does), so the layer a
    file sits in doesn't say whose it is; the base image's own list does."""
    if ref not in BASES:
        found = set()
        if "$" not in ref:
            path = os.path.join(V, "images", slug("base-" + ref.split("@")[0]) + ".cdx.json")
            run([SYFT, "registry:" + ref, "-o", "cyclonedx-json=" + path, "-q"], SCAN_SECONDS)
            try:
                for c in json.load(open(path)).get("components") or []:
                    for prop in c.get("properties") or []:
                        if re.fullmatch(r"syft:location:\d+:path", prop.get("name") or ""):
                            found.add((c.get("purl"), prop.get("value")))
            except (OSError, ValueError):
                pass
        BASES[ref] = found
    return BASES[ref]


def scan_of(sbom_path, name, base):
    """grype over the image's SBOM: counts by severity, and the high and critical ones by what can be done about
    them. base: the image the shipped stage is built on (None when the whole image is someone else's, as pulled)."""
    report = os.path.join(V, "images", name + ".grype.json")
    started = now()
    code, out = run([GRYPE, "sbom:" + sbom_path, "-o", "json", "--file", report, "-q"], SCAN_SECONDS)
    try:
        data = json.load(open(report))
    except (OSError, ValueError):
        return None, (out.strip()[-300:] or "the scanner wrote no report")
    if code != 0:
        return None, out.strip()[-300:]
    counts = {s: 0 for s in SEVERITIES}
    fixable = {s: 0 for s in SEVERITIES}
    blocking, unfixable, publisher, seen = [], [], [], set()
    for m in data.get("matches") or []:
        v, a = m.get("vulnerability") or {}, m.get("artifact") or {}
        key = (v.get("id"), a.get("name"), a.get("version"))
        if key in seen:
            continue
        seen.add(key)
        sev = str(v.get("severity") or "").lower()
        sev = sev if sev in ("critical", "high", "medium", "low") else "unknown"
        fix = v.get("fix") or {}
        fixed = fix.get("state") == "fixed" and bool(fix.get("versions"))
        counts[sev] += 1
        if fixed:
            fixable[sev] += 1
        if sev in ("critical", "high"):
            row = f'{v.get("id")} {sev} in {a.get("name")} {a.get("version")}'
            places = [l.get("path") for l in a.get("locations") or [] if l.get("path")]
            if not fixed:
                unfixable.append(row + " (no fixed version yet)")
            # The same library, at the same version, in the same program as the base image has: its publisher's build.
            elif a.get("type") in COMPILED and (base is None or any((a.get("purl"), where) in base_contents(base) for where in places)):
                where = places[0] if places else "a program"
                publisher.append(row + f' compiled into {where} (the library is fixed in {", ".join(fix["versions"][:2])})')
            else:
                blocking.append(row + f' (fixed in {", ".join(fix["versions"][:2])})')
    db = ((data.get("descriptor") or {}).get("db") or {})
    built = db.get("built") or ((db.get("status") or {}).get("built")) or None
    return {"at": started, "tool": "grype", "tool_version": VERSIONS.get("--grype-version", ""), "database_built": built,
            **counts, "fixable": fixable, "blocking": sorted(blocking), "unfixable": sorted(unfixable), "publisher_built": sorted(publisher)}, None


def plan():
    """What to build: (targets, skipped, compose file, problem)."""
    compose = next((f for f in COMPOSE_FILES if os.path.isfile(os.path.join(SRC, f))), None)
    if not compose:
        if os.path.isfile(os.path.join(SRC, "Dockerfile")):
            return [{"service": "app", "source": "build", "context": SRC, "dockerfile": "Dockerfile", "args": {}, "target": None}], [], None, None
        return [], [], None, None
    code, out = run(["docker", "compose", "-f", compose, "--profile", "*", "config", "--no-interpolate", "--format", "json"], 120, cwd=SRC)
    try:
        services = json.loads(out[out.index("{"):]).get("services") or {}
    except ValueError:
        return [], [], compose, f"docker compose couldn't read {compose}: {out.strip()[-300:]}"
    if code != 0:
        return [], [], compose, f"docker compose couldn't read {compose}: {out.strip()[-300:]}"
    targets, skipped = [], []
    for name in sorted(services):
        svc = services[name] or {}
        if svc.get("profiles"):
            skipped.append({"service": name, "reason": "only in profile " + ", ".join(svc["profiles"]) + ": Mynt's hosting doesn't start it"})
            continue
        build = svc.get("build")
        if isinstance(build, str):
            build = {"context": build}
        if build:
            context = os.path.normpath(os.path.join(SRC, build.get("context") or "."))
            args = build.get("args") or {}
            if isinstance(args, list):
                args = dict(a.split("=", 1) for a in args if "=" in a)
            targets.append({"service": name, "source": "build", "context": context, "dockerfile": build.get("dockerfile") or "Dockerfile", "args": args, "target": build.get("target")})
        elif svc.get("image"):
            targets.append({"service": name, "source": "pull", "image": svc["image"]})
    return targets, skipped, compose, None


def with_docker():
    targets, skipped, compose, problem = plan()
    images, problems = [], [problem] if problem else []
    tag_suffix = hashlib.sha256(SRC.encode()).hexdigest()[:12]
    for t in targets:
        name = slug(t["service"])
        row = {"service": t["service"], "source": t["source"]}
        if t["source"] == "build":
            dockerfile = os.path.normpath(os.path.join(t["context"], t["dockerfile"]))
            ref = f"mynt-verify/{name}:{tag_suffix}"
            cmd = ["docker", "build", "-q", "-f", dockerfile, "-t", ref]
            if t.get("target"):
                cmd += ["--target", str(t["target"])]
            for k, v in (t.get("args") or {}).items():
                cmd += ["--build-arg", f"{k}={v}" if v is not None else str(k)]
            row.update(dockerfile=os.path.relpath(dockerfile, SRC), base_images=base_images(dockerfile))
        else:
            ref = t["image"]
            cmd = ["docker", "pull", "-q", ref]
            row.update(image=ref, base_images=[{"ref": ref, "pinned": "@sha256:" in ref, "final": True}])
        started = time.time()
        code, out = run(cmd + ([t["context"]] if t["source"] == "build" else []), BUILD_SECONDS)
        row["build_seconds"] = round(time.time() - started)
        if code != 0:
            what = "didn't build" if t["source"] == "build" else "couldn't be pulled"
            problems.append(f'{t["service"]}: the image {what}: {out.strip()[-400:]}')
            images.append(row)
            continue
        code, out = run(["docker", "image", "inspect", "-f", "{{.Id}} {{.Size}}", ref], 60)
        parts = out.split()
        if code == 0 and len(parts) >= 2:
            row.update(ref=ref, image_id=parts[0], size_bytes=int(parts[1]) if parts[1].isdigit() else None, built_at=now())
        sbom, why = sbom_of("docker:" + ref, name)
        if not sbom:
            problems.append(f'{t["service"]}: no SBOM of the image: {why}')
            images.append(row)
            continue
        row["sbom"] = sbom
        # The base image the shipped stage is built on (the whole image, for one pulled as it is). "" when there is none.
        final = next((b["ref"] for b in row["base_images"] if b["final"]), "")
        scan, why = scan_of(sbom["path"], name, None if t["source"] == "pull" else final)
        if not scan:
            problems.append(f'{t["service"]}: the image scan didn\'t finish: {why}')
        else:
            row["scan"] = scan
        images.append(row)
    return {"applicable": True, "built": True, "compose_file": compose, "images": images, "skipped": skipped, "problems": problems,
            "coverage": "every image Mynt's hosting starts, built from the verified source: its base image, the packages its Dockerfile installs and the app's own files"}


def without_docker():
    """Nothing can be built: the base images the Dockerfiles name, read from their registries."""
    dockerfiles = []
    for d, dirs, files in os.walk(SRC):
        dirs[:] = [x for x in dirs if x not in ("node_modules", ".git")]
        dockerfiles += [os.path.join(d, f) for f in files if f == "Dockerfile" or f.startswith("Dockerfile.") or f.endswith(".Dockerfile")]
    images, problems, done = [], [], {}
    for path in sorted(dockerfiles):
        for base in base_images(path):
            if base["ref"] in done or "$" in base["ref"]:
                continue
            name = slug("base-" + base["ref"].split("@")[0])
            row = {"service": None, "source": "base-image", "dockerfile": os.path.relpath(path, SRC), "ref": base["ref"], "base_images": [base]}
            done[base["ref"]] = row
            sbom, why = sbom_of("registry:" + base["ref"], name)
            if not sbom:
                problems.append(f'{base["ref"]}: no SBOM of the base image: {why}')
            else:
                row["sbom"] = sbom
                scan, why = scan_of(sbom["path"], name, None)
                if scan:
                    row["scan"] = scan
                else:
                    problems.append(f'{base["ref"]}: the scan didn\'t finish: {why}')
            images.append(row)
    return {"applicable": True, "built": False, "compose_file": next((f for f in COMPOSE_FILES if os.path.isfile(os.path.join(SRC, f))), None), "images": images, "skipped": [], "problems": problems,
            "coverage": "docker isn't available in this verification sandbox, so no image was built: only the base images the Dockerfiles name were scanned, as their registries serve them. "
                        "What each Dockerfile adds on top (installed packages, the app's own files) is covered by dependency_audit and the source SBOM, not by this scan"}


def checks(r):
    """The image_scan row, and the images' part of the sbom row."""
    rows = r["images"]
    label = lambda i: i.get("service") or i.get("ref") or "?"
    scanned = [i for i in rows if i.get("scan")]
    blocking = [f"{label(i)}: {b}" for i in scanned for b in i["scan"]["blocking"]]
    unfixable = [f"{label(i)}: {u}" for i in scanned for u in i["scan"]["unfixable"]]
    publisher = [f"{label(i)}: {u}" for i in scanned for u in i["scan"]["publisher_built"]]
    unpinned = sorted({b["ref"] for i in rows for b in i.get("base_images", []) if not b["pinned"]})
    skipped = [f'{s["service"]} ({s["reason"]})' for s in r["skipped"]]
    tool = f'grype {VERSIONS.get("--grype-version", "")}'.strip()
    summary = ", ".join(f'{label(i)} {i["scan"]["critical"]} critical / {i["scan"]["high"]} high' for i in scanned)
    notes = []
    if publisher:
        notes.append(f"{len(publisher)} high or critical in programs the base image's publisher compiled, which only a newer build of that image fixes: " + "; ".join(publisher[:6]))
    if unfixable:
        notes.append(f"{len(unfixable)} high or critical with no fixed version yet: " + "; ".join(unfixable[:6]))
    if unpinned:
        notes.append("base image not pinned by digest: " + ", ".join(unpinned[:6]))
    if not r["built"]:
        notes.append(r["coverage"])
    if skipped:
        notes.append("not scanned: " + "; ".join(skipped))
    if not r["applicable"]:
        scan = ("pass", "no Compose file or Dockerfile at the root: this build ships no container image")
    elif r["problems"]:
        scan = ("fail", "; ".join(r["problems"]))
    elif blocking:
        scan = ("fail", f"{len(blocking)} high or critical vulnerabilit{'y' if len(blocking) == 1 else 'ies'} with a fix available ({tool}): " + "; ".join(blocking[:12]) + ("; " + "; ".join(notes) if notes else ""))
    elif not rows:
        scan = ("pass", "the Compose file starts no service with an image to build or pull" + ("; " + "; ".join(notes) if notes else ""))
    elif unfixable or publisher or unpinned or not r["built"]:
        scan = ("warn", f"no high or critical vulnerability this build's Dockerfiles can fix ({tool}; {summary}); " + "; ".join(notes))
    else:
        scan = ("pass", f"no high or critical vulnerability in {len(scanned)} image(s) ({tool}; {summary})" + ("; " + "; ".join(notes) if notes else ""))
    with_sbom = [i for i in rows if i.get("sbom")]
    missing = [label(i) for i in rows if not i.get("sbom")]
    sbom = {"ok": not missing, "detail": ", ".join(f'{label(i)} ({i["sbom"]["components"]} components)' for i in with_sbom), "missing": missing}
    return {"status": scan[0], "detail": scan[1]}, sbom


def main():
    code, _ = run(["docker", "info"], 30) if shutil.which("docker") else (127, "")
    root = any(os.path.isfile(os.path.join(SRC, f)) for f in COMPOSE_FILES + ["Dockerfile"])
    if not root:
        r = {"applicable": False, "built": False, "compose_file": None, "images": [], "skipped": [], "problems": [], "coverage": "nothing to scan"}
    else:
        r = with_docker() if code == 0 else without_docker()
    r["check"], r["sbom"] = checks(r)
    r["generated_at"] = now()
    with open(os.path.join(V, "images.json"), "w") as f:
        json.dump(r, f, indent=2)


main()
`;
