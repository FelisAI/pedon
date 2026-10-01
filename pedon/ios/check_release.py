#!/usr/bin/env python3
"""Inspect the compiled iPhone app before App Store export; never upload or sign.

    python3 ios/check_release.py /tmp/PEDON.xcarchive

Content checks can pass for an unsigned archive. Apple signing, App Store Connect
validation, reviewer access and distribution rights remain separate release gates.
"""
import argparse
import json
import plistlib
import re
from pathlib import Path


def inspect(path):
    path = Path(path)
    if path.suffix == ".xcarchive":
        apps = list((path / "Products" / "Applications").glob("*.app"))
        if len(apps) != 1:
            return {"errors": ["Archive must contain exactly one application"]}
        path = apps[0]
    errors = []

    def require(condition, message):
        if not condition:
            errors.append(message)

    with (path / "Info.plist").open("rb") as f:
        info = plistlib.load(f)
    require(info.get("CFBundleSupportedPlatforms") == ["iPhoneOS"], "Archive a physical-device build, not a Simulator app")
    require(info.get("UIDeviceFamily") == [1], "First release is verified for iPhone only")
    require(bool(info.get("CFBundleIdentifier")), "Bundle identifier is missing")
    for key in ("CFBundleShortVersionString", "CFBundleVersion"):
        require(bool(re.fullmatch(r"\d+(\.\d+){0,2}", info.get(key, ""))), f"Invalid {key}")
    sdk = re.match(r"iphoneos(\d+)", info.get("DTSDKName", ""))
    require(sdk is not None and int(sdk.group(1)) >= 26, "App Store uploads require iOS 26 SDK or later")
    for key in ("NSCameraUsageDescription", "NSLocalNetworkUsageDescription"):
        require(bool(info.get(key)), f"Missing permission explanation: {key}")
    require(info.get("ITSAppUsesNonExemptEncryption") is False, "Export-compliance declaration is missing or changed; review cryptography")
    require(not info.get("NSAppTransportSecurity", {}).get("NSAllowsArbitraryLoads"), "Do not disable transport security globally")
    icons = info.get("CFBundleIcons", {}).get("CFBundlePrimaryIcon", {})
    require(bool(icons.get("CFBundleIconName")), "Compiled primary app icon is missing")
    require((path / "Assets.car").exists(), "Compiled asset catalog is missing")
    require((path / "privacy.md").is_file(), "Offline privacy policy is missing from the app bundle")
    privacy_path = path / "PrivacyInfo.xcprivacy"
    require(privacy_path.is_file(), "Privacy manifest is missing from the app bundle")
    if privacy_path.is_file():
        with privacy_path.open("rb") as f:
            privacy = plistlib.load(f)
        require(privacy.get("NSPrivacyTracking") is False, "Tracking declaration differs from the audited app")
        require(privacy.get("NSPrivacyCollectedDataTypes") == [], "Data collection differs from the audited app; review disclosures")
        defaults = next((api for api in privacy.get("NSPrivacyAccessedAPITypes", [])
                         if api.get("NSPrivacyAccessedAPIType") == "NSPrivacyAccessedAPICategoryUserDefaults"), {})
        require("CA92.1" in defaults.get("NSPrivacyAccessedAPITypeReasons", []), "App-local preferences need their approved API reason")
    return {"bundle": info.get("CFBundleIdentifier"), "version": info.get("CFBundleShortVersionString"),
            "build": info.get("CFBundleVersion"), "sdk": info.get("DTSDKName"), "errors": errors,
            "note": "Checks compiled contents only. This is not Apple upload validation or submission approval."}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("archive", help="An .xcarchive or compiled .app")
    args = parser.parse_args()
    result = inspect(args.archive)
    print(json.dumps(result, indent=2))
    raise SystemExit(bool(result["errors"]))
