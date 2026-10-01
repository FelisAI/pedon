import XCTest
import RealityKit
@testable import PedonAR

@MainActor final class ScanOverlayTests: XCTestCase {
    func testOverlayVisibilityAndOpacityKeepTheSharedAlignment() throws {
        let parent = Entity(), overlay = Entity()
        let mesh = ModelEntity(mesh: .generateBox(size: 1))
        mesh.position = [2, 0.5, -3]
        overlay.addChild(mesh); parent.addChild(overlay)
        parent.orientation = simd_quatf(angle: 25 * .pi / 180, axis: [0, 1, 0])
        parent.position = [4, -1, 6]
        let before = mesh.position(relativeTo: nil)
        ScanOverlay.update(overlay, visible: true, opacity: 0.35)
        XCTAssertTrue(overlay.isEnabled)
        XCTAssertEqual(overlay.components[OpacityComponent.self]?.opacity, 0.35)
        XCTAssertEqual(mesh.position(relativeTo: nil), before)
        ScanOverlay.update(overlay, visible: false, opacity: 0.6)
        XCTAssertFalse(overlay.isEnabled)
        XCTAssertEqual(mesh.position(relativeTo: nil), before)
        parent.position += [0.05, 0, -0.05]
        ScanOverlay.update(overlay, visible: true, opacity: 0.6)
        XCTAssertLessThan(simd_distance(mesh.position(relativeTo: nil), before + SIMD3(0.05, 0, -0.05)), 0.00001)
    }

    func testActualScanOverlayMatchesTheExportFrame() async throws {
        guard let server = ProcessInfo.processInfo.environment["PEDON_TEST_SERVER"],
              server.hasPrefix("http"), let base = URL(string: server) else {
            throw XCTSkip("Set PEDON_TEST_SERVER to check the real scan's AR overlay")
        }
        let (data, _) = try await URLSession.shared.data(from: base.appendingPathComponent("current.json"))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let info = try XCTUnwrap(json["info"] as? [String: Any])
        let scan = try XCTUnwrap(info["scan"] as? [String: Any])
        let bounds = try XCTUnwrap(scan["bounds"] as? [String: [Double]])
        let file = try XCTUnwrap(scan["file"] as? String)
        let (temporary, _) = try await URLSession.shared.download(from: base.appendingPathComponent(file))
        let local = temporary.appendingPathExtension("usdz")
        try FileManager.default.moveItem(at: temporary, to: local)
        defer { try? FileManager.default.removeItem(at: local) }
        let overlay = try await ScanOverlay.load(local)
        let parent = Entity(); parent.addChild(overlay)
        ScanOverlay.update(overlay, visible: true, opacity: 0.35)
        let actual = overlay.visualBounds(relativeTo: parent)
        for (key, values) in [("min", actual.min), ("max", actual.max)] {
            let expected = try XCTUnwrap(bounds[key])
            for i in 0..<3 { XCTAssertEqual(Double(values[i]), expected[i], accuracy: 0.002, "\(key) axis \(i)") }
        }
        // A nudge must move scan and design together even when north is not zero.
        parent.orientation = simd_quatf(angle: 25 * .pi / 180, axis: [0, 1, 0])
        parent.position = [3, 0.5, -2]
        let center = overlay.convert(position: actual.center, to: nil)
        XCTAssertLessThan(simd_distance(center, parent.convert(position: actual.center, to: nil)), 0.00001)
    }
}
