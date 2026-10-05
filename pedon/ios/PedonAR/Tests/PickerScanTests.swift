import XCTest
import SceneKit
@testable import PedonAR

/// The picker's copy of the original scan is about 300 MB on a real site (CA1). It must be
/// released when the point picker closes, and opened again when it returns.
@MainActor final class PickerScanTests: XCTestCase {
    func testTheOriginalScanIsHeldOnlyWhilePicking() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).scn")
        let capture = SCNScene()
        capture.rootNode.addChildNode(SCNNode(geometry: SCNBox(width: 1, height: 0.2, length: 1, chamferRadius: 0)))
        XCTAssertTrue(capture.write(to: url, options: nil, delegate: nil, progressHandler: nil))
        defer { try? FileManager.default.removeItem(at: url) }

        let flow = Flow()
        flow.useScan(url)
        flow.step = .pick
        try await opened(flow)
        weak var held = flow.scan
        XCTAssertNotNil(held)
        flow.step = .first
        XCTAssertNil(flow.scan, "Marking points on site does not draw the scan")
        XCTAssertNil(held, "Nothing else may keep the released scan")

        flow.step = .pick
        try await opened(flow)
        flow.step = .placed
        XCTAssertNil(flow.scan, "The aligned view does not draw it either")
    }

    private func opened(_ flow: Flow) async throws {
        for _ in 0..<200 where flow.scan == nil { try await Task.sleep(for: .milliseconds(25)) }
        XCTAssertNotNil(flow.scan, "Returning to the picker opens the scan again")
    }
}
