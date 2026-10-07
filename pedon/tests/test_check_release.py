"""The release checker refuses an app App Review could not open: no sample garden, no way in."""
import importlib.util
import json
import plistlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("check_release", HERE.parent / "ios" / "check_release.py")
check_release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check_release)


def make_app(root):
    app = root / "PedonAR.app"
    app.mkdir()
    with (app / "Info.plist").open("wb") as f:
        plistlib.dump({"CFBundleSupportedPlatforms": ["iPhoneOS"], "UIDeviceFamily": [1],
                       "CFBundleIdentifier": "com.example.pedon", "CFBundleShortVersionString": "1.0",
                       "CFBundleVersion": "1", "DTSDKName": "iphoneos26.5",
                       "NSCameraUsageDescription": "AR", "NSLocalNetworkUsageDescription": "Mac",
                       "ITSAppUsesNonExemptEncryption": False,
                       "CFBundleIcons": {"CFBundlePrimaryIcon": {"CFBundleIconName": "AppIcon"}}}, f)
    (app / "Assets.car").write_bytes(b"")
    (app / "privacy.md").write_text("policy")
    with (app / "PrivacyInfo.xcprivacy").open("wb") as f:
        plistlib.dump({"NSPrivacyTracking": False, "NSPrivacyCollectedDataTypes": [],
                       "NSPrivacyAccessedAPITypes": [{"NSPrivacyAccessedAPIType": "NSPrivacyAccessedAPICategoryUserDefaults",
                                                      "NSPrivacyAccessedAPITypeReasons": ["CA92.1"]}]}, f)
    sample = app / "Sample"
    sample.mkdir()
    (sample / "current.json").write_text(json.dumps({"name": "yard.usdz", "info": {"scan": {"file": "yard-1.scan.usdz"}}}))
    (sample / "yard.usdz").write_bytes(b"usdz")
    (sample / "yard-1.scan.usdz").write_bytes(b"usdz")
    return app


def test_a_complete_app_passes(tmp_path):
    assert check_release.inspect(make_app(tmp_path))["errors"] == []


def test_an_app_without_the_sample_garden_is_refused(tmp_path):
    app = make_app(tmp_path)
    for f in (app / "Sample").iterdir():
        f.unlink()
    (app / "Sample").rmdir()
    assert any("sample garden" in e for e in check_release.inspect(app)["errors"])


def test_a_sample_missing_its_scan_is_refused(tmp_path):
    app = make_app(tmp_path)
    (app / "Sample" / "yard-1.scan.usdz").unlink()
    assert any("sample garden" in e for e in check_release.inspect(app)["errors"])


def test_a_source_only_build_may_leave_the_sample_out_but_not_half_of_it(tmp_path):
    app = make_app(tmp_path)
    (app / "Sample" / "yard-1.scan.usdz").unlink()
    assert any("sample garden" in e for e in check_release.inspect(app, sample=False)["errors"])
    for f in (app / "Sample").iterdir():
        f.unlink()
    assert check_release.inspect(app, sample=False)["errors"] == []
