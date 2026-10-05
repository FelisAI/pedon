import XCTest
import simd
@testable import PedonAR

final class SessionStoreTests: XCTestCase {
    func testMapRefreshesAtMostEveryFiveMinutesUntilTheAlignmentChanges() {
        var schedule = MapSaveSchedule()
        let start = Date(timeIntervalSince1970: 1_000)
        XCTAssertTrue(schedule.wants(periodic: true, now: start), "The first ready map is saved")
        schedule.saved(at: start)
        XCTAssertFalse(schedule.wants(periodic: true, now: start.addingTimeInterval(30)), "Not again 30 s later")
        XCTAssertFalse(schedule.wants(periodic: true, now: start.addingTimeInterval(299)))
        XCTAssertTrue(schedule.wants(periodic: true, now: start.addingTimeInterval(301)), "Refreshed after five minutes")
        XCTAssertTrue(schedule.wants(periodic: false, now: start.addingTimeInterval(60)), "A new alignment saves at once")
        XCTAssertTrue(schedule.wants(periodic: true, now: start.addingTimeInterval(61)),
                      "Until the new alignment is saved, the next ready map saves it")
        schedule.saved(at: start.addingTimeInterval(62))
        XCTAssertFalse(schedule.wants(periodic: true, now: start.addingTimeInterval(90)))
    }

    func testRefreshThroughDirectoryAliasKeepsTheCurrentModels() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? fm.removeItem(at: root) }
        let physical = root.appendingPathComponent("physical", isDirectory: true)
        let alias = root.appendingPathComponent("alias", isDirectory: true)
        try fm.createDirectory(at: physical, withIntermediateDirectories: true)
        try fm.createSymbolicLink(at: alias, withDestinationURL: physical)
        let original = root.appendingPathComponent("download.usdz"), scan = root.appendingPathComponent("scan.usdz")
        try Data("first design".utf8).write(to: original)
        try Data("same scan".utf8).write(to: scan)
        let current = try JSONDecoder().decode(Current.self, from: Data(#"{"name":"yard.usdz","info":{"scan":{"file":"yard.scan.usdz"}}}"#.utf8))
        // On iPhone the app uses /var/mobile; enumeration can return /private/var/mobile.
        // A symbolic alias reproduces that difference on Simulator and macOS too.
        let store = SessionStore(server: "http://example.local:5179", root: alias)
        let first = try store.cache(current, design: original, scan: scan)
        XCTAssertEqual(try Data(contentsOf: store.designURL(first)), Data("first design".utf8))
        XCTAssertEqual(try Data(contentsOf: store.scanURL(first)), Data("same scan".utf8))
        XCTAssertNotNil(store.cachedDesign())
        let note = store.folder.appendingPathComponent("keep.txt")
        try Data("session note".utf8).write(to: note)
        try Data("changed design".utf8).write(to: original)
        let refreshed = try store.cache(current, design: original, scan: scan)
        XCTAssertNotEqual(first.assets, refreshed.assets)
        XCTAssertEqual(first.frame, refreshed.frame)
        XCTAssertFalse(fm.fileExists(atPath: store.designURL(first).path))
        XCTAssertFalse(fm.fileExists(atPath: store.scanURL(first).path))
        let reopened = SessionStore(server: "http://example.local:5179", root: alias)
        let saved = try XCTUnwrap(reopened.cachedDesign())
        XCTAssertEqual(saved.assets, refreshed.assets)
        XCTAssertEqual(try Data(contentsOf: reopened.designURL(saved)), Data("changed design".utf8))
        XCTAssertEqual(try Data(contentsOf: reopened.scanURL(saved)), Data("same scan".utf8))
        XCTAssertEqual(try Data(contentsOf: note), Data("session note".utf8))
    }

    func testDurableDesignAndPlacementRoundTripWithoutServer() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let original = root.appendingPathComponent("download.usdz"), scan = root.appendingPathComponent("scan.usdz")
        try Data("design bytes".utf8).write(to: original)
        try Data("original scan bytes".utf8).write(to: scan)
        let current = try JSONDecoder().decode(Current.self, from: Data(#"{"name":"yard.usdz","mtime_ms":100,"info":{"design_name":"Test planting","shift":[1,2,3],"scan":{"file":"yard.scan.usdz"}}}"#.utf8))
        let store = SessionStore(server: "http://example.local:5179/", root: root)
        let design = try store.cache(current, design: original, scan: scan)
        let a = PickPoint(x: 1, z: 2, label: "First corner", y: 0.4)
        let b = PickPoint(x: 5, z: -3, label: "Second corner", y: 1.2)
        let q = simd_quatf(angle: 25 * .pi / 180, axis: [0,1,0])
        let offset = SIMD3<Float>(3,-1,7)
        let saved = SavedPlacement(frame: design.frame, first: a, second: b,
            tapA: q.act(a.point(on: nil)) + offset, tapB: q.act(b.point(on: nil)) + offset,
            turn: 0.1, slide: [0.05,0,-0.1], anchorID: UUID(), worldMap: Data([1,2,3]),
            firstPhoto: Data([4]), secondPhoto: nil, surroundings: Data([5]), savedAt: Date())
        try store.save(saved)
        try store.save(SavedPlantView(frame: design.frame, hidden: ["p2"], selected: "p1", guide: true,
                                    plants: true, beds: false, landmarks: false, occlusion: true,
                                    originalScan: true, scanOpacity: 0.55))
        // Downloads can disappear. A newly constructed store still has everything it needs.
        try FileManager.default.removeItem(at: original)
        try FileManager.default.removeItem(at: scan)
        let reopened = SessionStore(server: "http://example.local:5179", root: root)
        let copy = try XCTUnwrap(reopened.cachedDesign())
        XCTAssertEqual(copy.current.info?.design_name, "Test planting")
        XCTAssertEqual(try Data(contentsOf: reopened.designURL(copy)), Data("design bytes".utf8))
        XCTAssertEqual(try Data(contentsOf: reopened.scanURL(copy)), Data("original scan bytes".utf8))
        let placement = try XCTUnwrap(reopened.placement(for: copy.frame))
        XCTAssertEqual(placement.anchorID, saved.anchorID)
        XCTAssertEqual(placement.worldMap, saved.worldMap)
        XCTAssertEqual(placement.first, a)
        XCTAssertEqual(placement.firstPhoto, saved.firstPhoto)
        let fit = try XCTUnwrap(placement.alignment(on: nil))
        let expected = Alignment(rotation: q, translation: offset, tappedApart: 1, plannedApart: 1)
            .turned(by: 0.1, about: a.point(on: nil)).moved(by: [0.05,0,-0.1])
        XCTAssertLessThan(simd_distance(fit.apply([8,0.5,4]), expected.apply([8,0.5,4])), 0.00001)
        XCTAssertEqual(reopened.plantView(for: copy.frame)?.hidden, ["p2"])
        XCTAssertEqual(reopened.plantView(for: copy.frame)?.guide, true)
        XCTAssertEqual(reopened.plantView(for: copy.frame)?.originalScan, true)
        XCTAssertEqual(reopened.plantView(for: copy.frame)?.scanOpacity, 0.55)
        XCTAssertNil(reopened.placement(for: "different scan frame"))
        XCTAssertNil(reopened.plantView(for: "different scan frame"))
        XCTAssertNil(SessionStore(server: "http://another-mac.local:5179", root: root).cachedDesign())
        // An interrupted or failed download must not destroy the usable offline copy.
        XCTAssertThrowsError(try reopened.cache(current, design: original, scan: reopened.scanURL(copy)))
        XCTAssertEqual(reopened.cachedDesign()?.assets, copy.assets)
        // A changed capture cannot inherit the old placement even if its filename stays the same.
        try Data("recalibrated scan".utf8).write(to: scan)
        let changed = try reopened.cache(current, design: reopened.designURL(copy), scan: scan)
        XCTAssertNotEqual(changed.frame, copy.frame)
        XCTAssertNil(reopened.placement(for: changed.frame))
        // Export packaging timestamps can change while the measured scan content stays identical.
        let identified = try JSONDecoder().decode(Current.self, from: Data(#"{"name":"yard.usdz","info":{"shift":[1,2,3],"scan":{"file":"a.scan.usdz","content_hash":"same measured content"}}}"#.utf8))
        let packaged = try reopened.cache(identified, design: reopened.designURL(changed), scan: scan)
        try Data("new ZIP timestamp, same measured content".utf8).write(to: scan)
        let repackaged = try reopened.cache(identified, design: reopened.designURL(packaged), scan: scan)
        XCTAssertEqual(packaged.frame, repackaged.frame)
        // Corrupt local state is treated as absent; the user can load/align again.
        try Data([0]).write(to: reopened.folder.appendingPathComponent("placement.plist"))
        XCTAssertNil(reopened.placement(for: copy.frame))
    }

    func testResumeWaitsForNormalTrackingAndTheSavedAnchor() {
        var gate = ResumeGate()
        let saved = UUID(), other = UUID()
        gate.begin(anchorID: saved, after: 100)
        XCTAssertFalse(gate.observe(timestamp: 99, normal: true, anchors: [saved]), "stale callbacks must not reveal a saved design")
        XCTAssertFalse(gate.observe(timestamp: 101, normal: false, anchors: [saved]), "anchor alone does not mean the location was recognized")
        XCTAssertFalse(gate.observe(timestamp: 102, normal: true, anchors: [other]), "normal tracking in a different coordinate frame is not enough")
        XCTAssertTrue(gate.observe(timestamp: 103, normal: true, anchors: [saved]))
        XCTAssertFalse(gate.observe(timestamp: 104, normal: true, anchors: [saved]), "resume is delivered once")
        gate.begin(anchorID: saved, after: 105)
        gate.cancel()
        XCTAssertFalse(gate.observe(timestamp: 106, normal: true, anchors: [saved]))
    }
}
