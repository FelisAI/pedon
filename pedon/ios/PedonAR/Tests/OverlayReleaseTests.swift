import XCTest
import SceneKit
@testable import PedonAR

/// The original-scan overlay holds about 240 MB on a real site and a load peaks far higher
/// (CA1). Switched off and on to compare, it stays loaded; left off, it is freed.
@MainActor final class OverlayReleaseTests: XCTestCase {
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
