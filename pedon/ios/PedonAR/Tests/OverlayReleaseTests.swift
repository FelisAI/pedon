import XCTest
import SceneKit
import RealityKit
@testable import PedonAR

/// The original-scan overlay holds about 240 MB on a real site and a load peaks far higher
/// (CA1). Switched off and on to compare, it stays loaded; left off, it is freed.
@MainActor final class OverlayReleaseTests: XCTestCase {
    /// CA1: drawn over a real garden, the 616-object guide made RealityKit allocate 1.4 GB of
    /// shadow maps, one caster per object; turning casting off on each object stopped it.
    func testNothingPEDONDrawsCastsAShadow() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).usdz")
        let capture = SCNScene()
        capture.rootNode.addChildNode(SCNNode(geometry: SCNBox(width: 1, height: 0.2, length: 1, chamferRadius: 0)))
        XCTAssertTrue(capture.write(to: url, options: nil, delegate: nil, progressHandler: nil))
        defer { try? FileManager.default.removeItem(at: url) }
        let items = try JSONDecoder().decode([PlantItem].self, from: Data(#"[{"id":"p1","name":"A","node":"plant_1","at":[1,0,2]},{"id":"p2","name":"B","node":"plant_2","at":[3,0,1]}]"#.utf8))
        let garden = ARGarden()
        try await garden.load(url, plants: items)
        let root = try XCTUnwrap(garden.designRoot)
        var models = 0, casting: [String] = []
        func walk(_ e: Entity) {
            if e.components.has(ModelComponent.self) {
                models += 1
                if e.components[GroundingShadowComponent.self]?.castsShadow != false { casting.append(e.name) }
            }
            e.children.forEach(walk)
        }
        walk(root)
        XCTAssertGreaterThanOrEqual(models, 3, "the design's box and the guide's crosses, labels and highlight")
        XCTAssertEqual(casting, [], "These would cast grounding shadows onto the real ground")
    }

    func testTheARViewDrawsNoCinematicEffects() {
        let garden = ARGarden()
        garden.applyRenderBudget()
        XCTAssertTrue(garden.view.renderOptions.isSuperset(of: [.disableMotionBlur, .disableDepthOfField,
                                                                 .disableCameraGrain, .disableGroundingShadows]))
    }

    func testAMemoryWarningFreesAHiddenOverlayAtOnce() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).usdz")
        let capture = SCNScene()
        capture.rootNode.addChildNode(SCNNode(geometry: SCNBox(width: 1, height: 0.2, length: 1, chamferRadius: 0)))
        XCTAssertTrue(capture.write(to: url, options: nil, delegate: nil, progressHandler: nil))
        defer { try? FileManager.default.removeItem(at: url) }
        let garden = ARGarden()
        try await garden.load(url, plants: [])
        garden.setScanSource(url)
        garden.showOriginalScan(true, opacity: 0.5)
        for _ in 0..<200 where !garden.overlayLoaded { try await Task.sleep(for: .milliseconds(25)) }
        garden.relieveMemory()
        XCTAssertTrue(garden.overlayLoaded, "A scan on screen stays")
        garden.showOriginalScan(false, opacity: 0.5)
        garden.relieveMemory()
        XCTAssertFalse(garden.overlayLoaded, "A hidden scan is freed without waiting")
    }

    func testNoAutomaticLightingProbes() {
        // On an iPhone 17 Pro they grew graphics memory 2.5 MB a second until iOS ended the app.
        XCTAssertEqual(ARGarden().configuration().environmentTexturing, .none)
    }

    func testAHiddenOverlayIsFreedOnlyOnceItStaysHidden() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).usdz")
        let capture = SCNScene()
        capture.rootNode.addChildNode(SCNNode(geometry: SCNBox(width: 1, height: 0.2, length: 1, chamferRadius: 0)))
        XCTAssertTrue(capture.write(to: url, options: nil, delegate: nil, progressHandler: nil))
        defer { try? FileManager.default.removeItem(at: url) }
        let saved = ARGarden.overlayRelease
        ARGarden.overlayRelease = .milliseconds(300)
        defer { ARGarden.overlayRelease = saved }

        let garden = ARGarden()
        try await garden.load(url, plants: [])
        garden.setScanSource(url)
        garden.showOriginalScan(true, opacity: 0.5)
        for _ in 0..<200 where !garden.overlayLoaded { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertTrue(garden.overlayLoaded)

        garden.showOriginalScan(false, opacity: 0.5)
        try await Task.sleep(for: .milliseconds(150))
        garden.showOriginalScan(true, opacity: 0.5)
        XCTAssertTrue(garden.overlayLoaded, "Off and on again keeps the loaded scan")
        try await Task.sleep(for: .milliseconds(450))
        XCTAssertTrue(garden.overlayLoaded, "A visible scan is never freed")

        garden.showOriginalScan(false, opacity: 0.5)
        XCTAssertTrue(garden.overlayLoaded)
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertFalse(garden.overlayLoaded, "Left off, the scan is freed")
    }
}
