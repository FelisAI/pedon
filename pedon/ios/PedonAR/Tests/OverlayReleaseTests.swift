import XCTest
import SceneKit
@testable import PedonAR

/// The original-scan overlay holds about 240 MB on a real site and a load peaks far higher
/// (CA1). Switched off and on to compare, it stays loaded; left off, it is freed.
@MainActor final class OverlayReleaseTests: XCTestCase {
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
