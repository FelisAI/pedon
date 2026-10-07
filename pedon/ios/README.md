# PEDON for iPhone

Place a landscape design over the real site, then use the **Planting guide** to see where
each plant goes. Tap a planting target for a half-transparent preview at its planned mature
size, and **ⓘ** for available plant details. Individual plants can be shown or hidden, and
controls can be collapsed while you work.

This is the native companion to the [PEDON desktop design editor](../../README.md), under
the same [AGPL-3.0-only license](../../LICENSE). On-site visualization uses this app.
There is no Safari AR viewer. An App Store release is [being prepared](appstore/README.md);
until it is approved and released, build and install from source below.

## Requirements

- A Mac with **Xcode 16 or later**, its iOS platform support and command-line tools selected.
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).
- An ARKit-capable iPhone running **iOS 18 or later**. LiDAR improves real-world occlusion
  but is not required. Simulator can test the interface, not physical AR alignment.
- A running PEDON desktop viewer, with a **textured mesh scan** of your site and a design.
  The AR export also needs Blender, as described in [planting out](../docs/planting-out.md).
  A splat-only capture cannot provide the mesh surface used for alignment picks.

## Build and install

From the repository root:

```bash
xcodegen generate --spec pedon/ios/PedonAR/project.yml
open pedon/ios/PedonAR/PedonAR.xcodeproj
```

In Xcode:

1. Add your Apple account in **Xcode → Settings → Accounts**.
2. Select the **PedonAR** app target, then **Signing & Capabilities**. Select your own team
   and automatic signing. Use a bundle identifier belonging to you if the default is unavailable.
3. Connect and trust your iPhone, enable Developer Mode if Xcode asks, select that phone as
   the destination, and run **PedonAR**. Accept the camera and local-network prompts.

Signing is local to your Mac. Never commit certificates, provisioning profiles, team IDs,
device identifiers or the generated Xcode project. Re-running XcodeGen replaces local project
settings; select your signing settings again afterwards.

For repeat installs with an existing development profile covering `com.felisai.pedon.ar`
and your paired phone, the optional helper can reuse it:

```bash
cd pedon
python3 ios/ar_app.py --device "iPhone" --wait 20
```

`--build-only` signs without installing. `--register TEAM` explicitly lets Xcode register the
app/device with that developer team when no suitable local profile exists; it is never an
automatic fallback. Use Xcode directly if you changed the app's bundle identifier.

## Connect and align

1. On the Mac, open your design in PEDON and choose **··· → See it on site…**. Wait for
   the export, then open the phone connection there.
2. On the iPhone, use the same Wi-Fi. Open **PEDON → Settings** and enter the Mac address
   displayed in that sheet. No address, site or account is compiled into the app.
3. Rotate and zoom the **original 3D scan**. Pick two existing features you can find on
   site, well apart, such as paving corners or the foot of a fixed post. **Show whole scan**
   recovers the camera if you lose your place.
4. Match each feature on the real ground with the camera's aiming dot and **Mark it**.
   The design is aligned by a turn and a move at scale 1. Check the displayed distance between
   the marks and another fixed reference before planting.
5. Switch between **3D view** and **Planting guide**. The guide crosses are planting centers,
   not hole sizes. Select by tapping a target or searching **Individual plants**. The selected
   translucent model shows its planned dimensions; **ⓘ** opens the details included in the export.

**Adjust alignment** offers small slides, turns and re-marking either reference. **Other points**
returns to a fresh scan picker. Keep the Mac's viewer and phone connection running for the first download
or when refreshing a design. Close the connection in the desktop sheet when finished; it exposes
only exports and the original alignment scan, never the editor's write APIs.

The app has been used on a real site. Simulator tests check geometry and controls; they cannot
measure outdoor tracking drift. Reference choice, scan calibration and AR tracking affect where
any target appears. Plant sizes are design values, not guarantees of growth.

**Original scan** overlays the captured site at adjustable opacity after alignment. Compare
fixed features with the camera, then use **Adjust alignment** to move or turn the scan and
design together. The scan is off by default, loads only when requested, and has a shortcut
in compact controls. Real-world occlusion is temporarily disabled while comparing the scan.
The overlay does not replace the initial two-point match or saved-location recognition.
Settings also includes an offline [privacy policy](privacy.md), [support](support.md), and
the app version.

## Tests

From the repository root, the alignment math can run on the Mac without a site or phone:

```bash
swiftc -O pedon/ios/PedonAR/PedonAR/Alignment.swift \
  pedon/ios/PedonAR/PedonAR/PlanPick.swift \
  pedon/ios/PedonAR/PedonAR/DesignSource.swift \
  pedon/ios/PedonAR/AlignmentTests/main.swift -o /tmp/pedon-alignment-tests
/tmp/pedon-alignment-tests
```

After generating the Xcode project, choose an iPhone Simulator and **Product → Test**.
The default suite checks planting target transforms at nonzero yaw, individual visibility,
50% opacity, normal-view restoration and optional plant details without a server, and that
only an actual transfer from the Mac is announced as a download. Integration
checks skip unless you explicitly supply your own export server.

To check a real export, open the desktop phone connection and use a design with at least two
plants and a textured scan. Pick a Simulator from `xcrun simctl list devices available`, then:

```bash
xcodebuild -project pedon/ios/PedonAR/PedonAR.xcodeproj -scheme PedonAR \
  -destination 'platform=iOS Simulator,name=YOUR_SIMULATOR_NAME' \
  PEDON_TEST_SERVER=http://localhost:5179/ CODE_SIGNING_ALLOWED=NO test
```

The integration tests use the current export's plant IDs and facts. They verify native model
bounds against planting targets, repeatedly choose scan markers, toggle individual plants,
collapse controls and open details. Screenshots stay in the local `.xcresult`; do not publish
real-site test artifacts without the site owner's permission.

To measure memory on a device, a Debug build launched with `-probePlaceHere -probeGuide`
stands the planting 4 m along the camera's line of sight, whichever way the phone lies, saves
what the screen shows as `Documents/probe-LABEL-placed.png` (`-probeLabel LABEL`) so the run can
prove the design was drawn, and selects every plant in turn (`-probeHold SECONDS` first holds with
the guide on, `-probeRounds N`, `-probeEvery SECONDS`, `-probeModels` for the 3D view instead,
`-probeScan` with the original scan shown). `-probeToggle N` switches the guide on and off from
the 3D view. With `-previewPlaced -probeGuide` it runs without ARKit. Pass the app's options
after `--` to `devicectl device process launch`, or devicectl reads them as its own. Each step
lands in the memory log described under *When the app quits by itself*. A probe whose camera
sees nothing measures nothing: check the screenshot and the log's mesh and plane counts.

The scan frame and picker lifecycle also have standalone checks in `PedonAR/AlignmentTests`.
Compile `OriginalScan.swift` with `scan_frame.swift` or `scan_lifecycle.swift`, then pass the
path to your exported `yard.json`. The frame check compares native bounds against the viewer's
measurements within 2 mm. `OriginalScan.convertToYUp` and `DesignScene`'s plain Y-up wrapper
are required: the USD import can carry its own axis correction.

## Source map

- `project.yml` generates the Xcode project; there are no external Swift dependencies.
- `ContentView` owns the connection/alignment flow and compact controls.
- `OriginalScan` / `PlanPicker` load and pick the original capture; `Alignment` fits it to AR.
- `ARGarden` / `DesignScene` load the design into RealityKit.
- `ScanOverlay` loads the original capture in the design's frame as an optional translucent reference.
- `PlantingGuide` / `PlantDisplay` own planting targets and model visibility/opacity.
- `DesignSource` reads the desktop's `current.json`, USDZ files and catalogue metadata.
- `PrivacyPolicyView` reads the same privacy document published alongside this README.
- `appstore/README.md` tracks release requirements, metadata and archive inspection.

The exported scan, designs, caches and settings belong to each user, outside this repository.

## Reopening an aligned design

PEDON saves the loaded design and original scan on the iPhone. After alignment, it also
saves the AR world map, selected reference points/photos, and your alignment corrections
once tracking has mapped enough of the area. Look for **Position saved on this iPhone**.
It refreshes the saved map as you work; **Adjust alignment → Save position** requests a save.

When reopened, the app loads the saved design without needing the Mac and tries to recognize
the saved location. Point the camera around the same area; a saved camera picture helps you
find it. The planting overlay stays hidden until tracking recognizes the saved coordinate
frame. **Align again** reuses your scan points but lets you mark them on the ground again;
**Change points** picks a new pair. Plant visibility, selection, guide mode and collapsed
controls are remembered too.

Use **↻** to fetch design changes from the Mac. A changed scan or export coordinate frame
invalidates the old alignment. Changing lighting, vegetation or surroundings can prevent
relocalization; in that case align again. A saved map improves reopening, but does not make
AR tracking a surveying instrument. This follows [Apple's saved-world-map workflow](https://developer.apple.com/documentation/arkit/saving-and-loading-world-data).

The loading indicator distinguishes **Checking your Mac**, **Downloading design / original
scan from your Mac**, and **Preparing 3D models**. Preparation uses files already on the
iPhone; a saved copy does not show a download stage. Refresh progress also appears above
an already aligned view.

### When the app quits by itself

iOS ends an app that goes over its memory limit and writes no crash report for it. So PEDON
keeps a small log of its own memory, `Library/Application Support/PEDON Diagnostics/memory.csv`
(the older half moves to `memory-previous.csv` at 2 MB): a line every 5 seconds and at each
selection, guide or original-scan switch, loading stage and map save, with PEDON's footprint
(the figure iOS compares with its limit), what is left before that limit, the part that is
graphics, camera media and the app's own memory, and what ARKit holds (reconstructed mesh,
lighting probes, planes). It stays on the iPhone. Read it from the Mac:

```bash
xcrun devicectl device copy from --device "YOUR_IPHONE" --domain-type appDataContainer \
  --domain-identifier com.felisai.pedon.ar \
  --source "Library/Application Support/PEDON Diagnostics/memory.csv" --destination memory.csv
xcrun devicectl device info files --device "YOUR_IPHONE" --domain-type systemCrashLogs
```

A crash leaves a `PedonAR-….ips` report in the second listing; a memory exit leaves none,
at most a `JetsamEvent-….ips` naming the largest process. The log's last lines show what was
happening, and each line carries the peak since the one before, sampled every 50 ms. The limit
on an iPhone 17 Pro measured 3.3 GB. ARKit's automatic lighting probes
(`environmentTexturing = .automatic`) grew graphics memory about 2.5 MB a second for as long as
the camera ran; they are off. On site, drawing the planting guide over the real garden burst
graphics memory by 1-2 GB in under a second: every drawn object casts a grounding shadow onto
the surfaces ARKit scans, and for the old 616-object guide RealityKit's `MeshShadowProvider`
allocated about 1.4 GB of shadow maps (five 253 MB textures, seen in Instruments' Game Memory).
ARView's `.disableGroundingShadows` does not stop it; `GroundingShadowComponent(castsShadow:
false)` on each object does, so nothing PEDON draws casts one (`DesignScene.castNoShadows`). It
needs real surfaces, so a phone lying flat cannot show it: stand it up facing a room. The guide
also draws as three objects for any bed (`PlantingGuide.swift`), the AR view skips motion blur,
depth of field and film grain, and a memory warning frees a hidden original scan at once. What
PEDON holds is kept down on purpose, measured with a real site: the point
picker's copy of the original scan (about 300 MB with its 8192² texture) is held only while
picking; the original-scan overlay (about 240 MB loaded, far more while loading) is freed
after 20 seconds switched off; and the saved AR map (about 60 MB for a whole site) refreshes
at most every five minutes while the alignment is unchanged.

The saved scan, map and reference pictures stay in the app's local Application Support
folder, excluded from device backups. The exporter identifies scan contents without ZIP timestamps, so rebuilding an unchanged
scan keeps its alignment. `SessionStore.swift` writes metadata atomically and
keeps the previous export if a new copy fails. Cleanup compares saved asset IDs, since iPhone
file enumeration may resolve `/var/mobile` to `/private/var/mobile`; those paths can name the
same folder. A directory-alias regression checks download, refresh and offline reopening.
`ResumeGate` requires normal tracking and
the specific saved anchor in a new camera frame before revealing the design. Simulator tests
check durable caching, offline reopen and recovery controls; physical relocalization requires
an iPhone at the saved site.
