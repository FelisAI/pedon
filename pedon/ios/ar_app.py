#!/usr/bin/env python3
"""BUILD AND INSTALL THE PHONE APP — PEDON on site.

The app in ios/PedonAR aligns the design from two points picked on the original scan
and matched on the real ground (Alignment.swift). The app is
built ONCE: every design after that it downloads from the Mac's read-only door on :5179.

    python3 ios/ar_app.py                 # build, install and open it on a paired iPhone
    python3 ios/ar_app.py --wait 20       # ...waiting up to 20 min for the phone to be reachable
    python3 ios/ar_app.py --build-only
    python3 ios/ar_app.py --device "iPhone"

Signing uses a development profile ALREADY on this Mac that includes the phone, so nothing
is registered in anyone's developer account. The app stores the address entered by its user in Settings. Builds contain no site
or personal connection addresses.
"""
import argparse
import glob
import hashlib
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_DIR = os.path.join(ROOT, "ios", "PedonAR")
BUNDLE_ID = "com.felisai.pedon.ar"
PROFILES = os.path.expanduser("~/Library/Developer/Xcode/UserData/Provisioning Profiles")


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        lines = (r.stdout + r.stderr).strip().splitlines()
        # the compiler's own "error:" lines when there are any, not its 4 KB command dump
        said = [l for l in lines if "error:" in l] or lines[-25:]
        raise SystemExit(f"[app] failed: {' '.join(cmd[:3])}…\n" + "\n".join(l[:400] for l in said[:20]))
    return r.stdout


def devices():
    out = os.path.join(tempfile.mkdtemp(), "d.json")
    run(["xcrun", "devicectl", "list", "devices", "--json-output", out])
    found = []
    for d in json.load(open(out))["result"]["devices"]:
        hp, dp, cp = d.get("hardwareProperties", {}), d.get("deviceProperties", {}), d.get("connectionProperties", {})
        if hp.get("platform") != "iOS" or hp.get("deviceType") != "iPhone":
            continue
        found.append({"id": d["identifier"], "udid": hp.get("udid"), "name": dp.get("name"),
                      # REACHABLE = there is a way to it. The tunnel is opened on demand, so a
                      # phone plugged in by cable reads "disconnected" until something asks —
                      # requiring "connected" would refuse a phone sitting on the desk
                      "model": hp.get("marketingName", ""),
                      "reachable": bool(cp.get("transportType")) or cp.get("tunnelState") == "connected",
                      "paired": cp.get("pairingState") == "paired"})
    return found


def pick_device(want):
    ds = [d for d in devices() if d["paired"]]
    if want:
        ds = [d for d in ds if want.lower() in f"{d['name']} {d['model']}".lower() or want in (d["id"], d["udid"])]
    # a Pro first: LiDAR is what lets the real world hide the design behind it
    ds.sort(key=lambda d: (not d["reachable"], "Pro" not in d["model"], d["model"]), reverse=False)
    return ds


def signing_for(udid):
    """A development profile on this Mac that covers the app and the phone, and its key."""
    ids = run(["security", "find-identity", "-v", "-p", "codesigning"])
    have = {line.split()[1] for line in ids.splitlines() if line.strip()[:2].rstrip(")").isdigit()}
    now = datetime.now(timezone.utc)
    for path in glob.glob(os.path.join(PROFILES, "*.mobileprovision")):
        raw = subprocess.run(["security", "cms", "-D", "-i", path], capture_output=True).stdout
        if not raw:
            continue
        p = plistlib.loads(raw)
        team = p["TeamIdentifier"][0]
        app_id = p["Entitlements"].get("application-identifier", "")
        covers = app_id in (f"{team}.*", f"{team}.{BUNDLE_ID}")
        exp = p["ExpirationDate"].replace(tzinfo=timezone.utc)
        if not covers or exp < now or udid not in p.get("ProvisionedDevices", []):
            continue
        for cert in p.get("DeveloperCertificates", []):
            sha = hashlib.sha1(cert).hexdigest().upper()
            if sha in have:
                return {"team": team, "profile": p["UUID"], "identity": sha, "profile_name": p["Name"]}
    return None


def build(sign):
    """Build UNSIGNED, then sign with the profile by hand.

    xcodebuild refuses an Xcode-managed profile under manual signing ("is Xcode managed,
    but signing settings require a manually managed profile"), and automatic signing would
    register an App ID in the team's account. Embedding the profile and signing with its
    own entitlements needs neither."""
    run(["xcodegen", "generate", "--spec", "project.yml", "--quiet"], cwd=APP_DIR)
    run(["xcodebuild", "-project", "PedonAR.xcodeproj", "-scheme", "PedonAR", "-configuration", "Release",
         "-destination", "generic/platform=iOS", "-derivedDataPath", "build", "-quiet",
         "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO", "build"], cwd=APP_DIR)
    app = os.path.join(APP_DIR, "build", "Build", "Products", "Release-iphoneos", "PedonAR.app")
    if not os.path.isdir(app):
        raise SystemExit(f"[app] built, but {app} is not there")
    profile = os.path.join(PROFILES, sign["profile"] + ".mobileprovision")
    with open(profile, "rb") as src, open(os.path.join(app, "embedded.mobileprovision"), "wb") as dst:
        dst.write(src.read())
    team = sign["team"]
    ents = {"application-identifier": f"{team}.{BUNDLE_ID}", "com.apple.developer.team-identifier": team,
            "get-task-allow": True, "keychain-access-groups": [f"{team}.*"]}
    ents_path = os.path.join(tempfile.mkdtemp(), "app.entitlements")
    with open(ents_path, "wb") as f:
        plistlib.dump(ents, f)
    for fw in sorted(glob.glob(os.path.join(app, "Frameworks", "*"))):
        run(["codesign", "--force", "--sign", sign["identity"], "--timestamp=none", fw])
    run(["codesign", "--force", "--sign", sign["identity"], "--timestamp=none", "--entitlements", ents_path, app])
    run(["codesign", "--verify", "--deep", "--strict", app])
    return app


def build_registering(team, udid):
    """AUTOMATIC signing, which lets Xcode add the phone and the app's ID to the team's
    developer account and make a profile — what running any app on a new device does.
    Only on --register: it changes an account, so it is asked for, never a fallback."""
    run(["xcodegen", "generate", "--spec", "project.yml", "--quiet"], cwd=APP_DIR)
    run(["xcodebuild", "-project", "PedonAR.xcodeproj", "-scheme", "PedonAR", "-configuration", "Release",
         "-destination", f"id={udid}", "-derivedDataPath", "build", "-quiet",
         "-allowProvisioningUpdates", "-allowProvisioningDeviceRegistration",
         "CODE_SIGN_STYLE=Automatic", f"DEVELOPMENT_TEAM={team}", "build"], cwd=APP_DIR)
    app = os.path.join(APP_DIR, "build", "Build", "Products", "Release-iphoneos", "PedonAR.app")
    run(["codesign", "--verify", "--deep", "--strict", app])
    return app


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--device", help="name, model or identifier of a paired iPhone")
    ap.add_argument("--wait", type=float, default=0, help="minutes to wait for the phone to be reachable")
    ap.add_argument("--build-only", action="store_true")
    ap.add_argument("--register", metavar="TEAM",
                    help="no profile here covers the phone: let Xcode register it and the app "
                         "with this team (changes that developer account — ask first)")
    a = ap.parse_args(argv)

    phones = pick_device(a.device)
    if not phones:
        raise SystemExit("[app] no paired iPhone matches — pair it once in Xcode (Window → Devices)")
    phone = phones[0]
    sign = signing_for(phone["udid"])
    if not sign and not a.register:
        raise SystemExit(f"[app] no development profile on this Mac includes {phone['name']} ({phone['model']}) — "
                         "--register TEAM lets Xcode add it to a developer account (ask the owner first)")
    t0 = time.time()
    app = build(sign) if sign else build_registering(a.register, phone["udid"])
    print(f"[app] built for {phone['name']} ({phone['model']}) in {time.time() - t0:.0f} s, "
          + (f"signed with '{sign['profile_name']}' (team {sign['team']})" if sign
             else f"signed automatically for team {a.register}"))
    if a.build_only:
        return 0
    deadline = time.time() + a.wait * 60
    while not phone["reachable"]:
        if time.time() > deadline:
            raise SystemExit(f"[app] {phone['name']} is not reachable — unlock it, keep it near the Mac on "
                             "the same Wi-Fi (or plug it in), and run this again")
        time.sleep(10)
        phone = next((d for d in pick_device(phone["id"]) if d["id"] == phone["id"]), phone)
    run(["xcrun", "devicectl", "device", "install", "app", "--device", phone["id"], app])
    # opening it is a courtesy: a LOCKED phone refuses the launch after the install succeeded
    opened = subprocess.run(["xcrun", "devicectl", "device", "process", "launch", "--device", phone["id"],
                             BUNDLE_ID], capture_output=True, text=True)
    if opened.returncode == 0:
        print(f"[app] installed and opened on {phone['name']}")
    else:
        locked = "Locked" in (opened.stdout + opened.stderr)
        print(f"[app] installed on {phone['name']}" + (" — unlock it and open PEDON" if locked else
              f"; it did not open by itself: {(opened.stderr or opened.stdout).strip().splitlines()[-1][:200]}"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
