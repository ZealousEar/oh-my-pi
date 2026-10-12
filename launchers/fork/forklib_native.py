"""Native addon (packages/natives/native/pi_natives.darwin-arm64.node) stamp check and npm refresh.

The addon is gitignored, so a checkout carries whatever was last copied in. Every addon has a fixed
stamp slot `PI_NATIVES_VERSION_STAMP:<version>` (packages/natives/native/version-sentinel.js); it must
equal packages/natives/package.json `version`, i.e. the upstream tag the stack sits on."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import tarfile
import tempfile
import urllib.request

ADDON_REL = "packages/natives/native/pi_natives.darwin-arm64.node"
NPM_PACKAGE = "@oh-my-pi/pi-natives-darwin-arm64"
STAMP_MAGIC = b"PI_NATIVES_VERSION_STAMP:"
STAMP_SIZE = 64


def addon_path(checkout: str) -> str:
    return os.path.join(checkout, ADDON_REL)


def expected_version(checkout: str) -> str:
    with open(os.path.join(checkout, "packages", "natives", "package.json")) as f:
        return json.load(f)["version"]


def read_stamp(path: str) -> str:
    """Stamped version, '' when the file is missing or unstamped."""
    try:
        with open(path, "rb") as f:
            data = f.read()
    except FileNotFoundError:
        return ""
    i = data.find(STAMP_MAGIC)
    if i < 0:
        return ""
    return data[i + len(STAMP_MAGIC) : i + STAMP_SIZE].split(b"\0", 1)[0].decode("ascii", "replace")


def status(checkout: str) -> tuple:
    """(ok, stamped, expected)."""
    want = expected_version(checkout)
    have = read_stamp(addon_path(checkout))
    return have == want, have, want


def fetch(checkout: str, version: str, log=print) -> str:
    """Download the npm tarball, verify its sha512 against registry dist.integrity, install the addon."""
    meta_url = f"https://registry.npmjs.org/{NPM_PACKAGE}/{version}"
    with urllib.request.urlopen(meta_url, timeout=60) as r:
        dist = json.load(r)["dist"]
    algo, _, want_b64 = dist["integrity"].partition("-")
    if algo != "sha512":
        raise RuntimeError(f"unexpected integrity algorithm {algo!r} for {NPM_PACKAGE}@{version}")
    log(f"downloading {dist['tarball']}")
    with tempfile.TemporaryDirectory(prefix="fork-native-") as tmp:
        tgz = os.path.join(tmp, "pkg.tgz")
        h = hashlib.sha512()
        with urllib.request.urlopen(dist["tarball"], timeout=600) as r, open(tgz, "wb") as out:
            for chunk in iter(lambda: r.read(1 << 20), b""):
                h.update(chunk)
                out.write(chunk)
        got_b64 = base64.b64encode(h.digest()).decode()
        if got_b64 != want_b64:
            raise RuntimeError(f"tarball sha512 mismatch: registry {want_b64}, downloaded {got_b64}")
        log(f"tarball sha512 matches npm dist.integrity ({dist['integrity'][:24]}…)")
        name = os.path.basename(ADDON_REL)
        with tarfile.open(tgz, "r:gz") as tar:
            members = [m for m in tar.getmembers() if m.isfile() and os.path.basename(m.name) == name]
            if len(members) != 1:
                raise RuntimeError(f"expected exactly one {name} in the tarball, found {len(members)}")
            src = tar.extractfile(members[0])
            staged = os.path.join(tmp, name)
            with open(staged, "wb") as out:
                shutil.copyfileobj(src, out)
        stamped = read_stamp(staged)
        if stamped != version:
            raise RuntimeError(f"downloaded addon is stamped {stamped!r}, expected {version}")
        dest = addon_path(checkout)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        tmp_dest = f"{dest}.tmp.{os.getpid()}"
        shutil.copyfile(staged, tmp_dest)
        os.chmod(tmp_dest, 0o755)
        os.replace(tmp_dest, dest)
    log(f"installed {dest} (stamp {version})")
    return dest
