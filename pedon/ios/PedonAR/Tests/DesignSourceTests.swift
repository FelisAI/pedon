import XCTest
@testable import PedonAR

/// The loading message names the Mac only while a transfer actually runs (BZ1): a file
/// already on this iPhone is local work, and must not read as a download.
@MainActor
final class DesignSourceTests: XCTestCase {
    func testOnlyAnActualDownloadIsAnnounced() async throws {
        let name = "loading-\(UUID().uuidString).usdz"
        let current = try JSONDecoder().decode(Current.self, from: Data(#"{"name":"\#(name)","mtime_ms":7}"#.utf8))
        // Nothing listens on the discard port, so the transfer fails before anything is kept.
        let base = try XCTUnwrap(URL(string: "http://127.0.0.1:9/"))
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let local = caches.appendingPathComponent("7-\(name)")
        defer { try? FileManager.default.removeItem(at: local) }
        var announced = 0

        do {
            _ = try await DesignSource().file(for: current, from: base) { announced += 1 }
            XCTFail("Nothing listens on the discard port")
        } catch {}
        XCTAssertEqual(announced, 1, "A transfer from the Mac is announced before it starts")

        try Data("saved".utf8).write(to: local)
        announced = 0
        let reused = try await DesignSource().file(for: current, from: base) { announced += 1 }
        XCTAssertEqual(reused.standardizedFileURL, local.standardizedFileURL)
        XCTAssertEqual(announced, 0, "A file already on this iPhone must not say it is downloading")
    }
}
