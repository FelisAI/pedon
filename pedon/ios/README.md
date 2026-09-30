# PEDON for iPhone

Place a landscape design over the real site, then use the **Planting guide** to see where
each plant goes. Tap a planting target for a half-transparent preview at its planned mature
size, and **ⓘ** for available plant details. Individual plants can be shown or hidden, and
controls can be collapsed while you work.

This is the native companion to the [PEDON desktop design editor](../../README.md), under
the same [AGPL-3.0-only license](../../LICENSE). On-site visualization uses this app.
There is no Safari AR viewer or App Store download; build and install from source below.

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
returns to a fresh scan picker. Keep the Mac's viewer and phone connection running when loading
or refreshing a design. Close the connection in the desktop sheet when finished; it exposes
only exports and the original alignment scan, never the editor's write APIs.

The app has been used on a real site. Simulator tests check geometry and controls; they cannot
measure outdoor tracking drift. Reference choice, scan calibration and AR tracking affect where
any target appears. Plant sizes are design values, not guarantees of growth.

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
50% opacity, normal-view restoration and optional plant details without a server. Integration
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
- `PlantingGuide` / `PlantDisplay` own planting targets and model visibility/opacity.
- `DesignSource` reads the desktop's `current.json`, USDZ files and catalogue metadata.

The exported scan, designs, caches and settings belong to each user, outside this repository.
