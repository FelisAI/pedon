import Foundation
import CryptoKit
import simd

/// A durable copy of the last loaded export, independent of the OS's purgeable caches.
struct CachedDesign: Codable {
    let version: Int
    let current: Current
    let assets: UUID
    let frame: String
}

struct SavedPlacement: Codable {
    var version = 1
    let frame: String
    let first: PickPoint
    let second: PickPoint
    let tapA: SIMD3<Float>
    let tapB: SIMD3<Float>
    let turn: Float
    let slide: SIMD3<Float>
    let anchorID: UUID
    let worldMap: Data
    let firstPhoto: Data?
    let secondPhoto: Data?
    let surroundings: Data?
    let savedAt: Date

    func alignment(on ground: Ground?) -> Alignment? {
        guard let fit = Alignment.solve(planA: first.point(on: ground), planB: second.point(on: ground),
                                        tapA: tapA, tapB: tapB) else { return nil }
        return fit.turned(by: turn, about: first.point(on: ground)).moved(by: slide)
    }
}

struct SavedPlantView: Codable {
    let frame: String
    let hidden: Set<String>
    let selected: String?
    let guide: Bool
    let plants: Bool
    let beds: Bool
    let landmarks: Bool
    let occlusion: Bool
    var originalScan: Bool? = nil
    var scanOpacity: Float? = nil
}

/// Never show a saved placement in a new session's unrelated coordinate system.
struct ResumeGate {
    private(set) var anchorID: UUID?
    private var after: TimeInterval = -.infinity
    mutating func begin(anchorID: UUID, after: TimeInterval) {
        self.anchorID = anchorID; self.after = after
    }
    mutating func cancel() { anchorID = nil }
    mutating func observe(timestamp: TimeInterval, normal: Bool, anchors: Set<UUID>) -> Bool {
        guard let id = anchorID, timestamp > after, normal, anchors.contains(id) else { return false }
        anchorID = nil
        return true
    }
}

final class SessionStore {
    let folder: URL
    private let fm = FileManager.default

    init(server: String, root: URL? = nil) {
        let base = root ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PEDON Sessions", isDirectory: true)
        let normalized = server.trimmingCharacters(in: .whitespacesAndNewlines).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        let key = SHA256.hash(data: Data(normalized.utf8)).map { String(format: "%02x", $0) }.joined()
        folder = base.appendingPathComponent(key, isDirectory: true)
    }

    func designURL(_ design: CachedDesign) -> URL { assetsURL(design).appendingPathComponent("design.usdz") }
    func scanURL(_ design: CachedDesign) -> URL { assetsURL(design).appendingPathComponent("scan.usdz") }
    private func assetsURL(_ design: CachedDesign) -> URL { folder.appendingPathComponent(design.assets.uuidString, isDirectory: true) }

    func cachedDesign() -> CachedDesign? {
        guard let record: CachedDesign = read("design.plist"), record.version == 1,
              fm.fileExists(atPath: designURL(record).path), fm.fileExists(atPath: scanURL(record).path) else { return nil }
        return record
    }

    func cache(_ current: Current, design: URL, scan: URL) throws -> CachedDesign {
        var hash = SHA256()
        // A different capture/calibration must never inherit yesterday's real-world placement.
        if let identity = current.info?.scan?.content_hash, !identity.isEmpty {
            hash.update(data: Data(identity.utf8)) // Exporter hashes members, excluding changing ZIP timestamps.
        } else {
            hash.update(data: try Data(contentsOf: scan, options: .mappedIfSafe)) // Older exports.
        }
        hash.update(data: Data((current.info?.origin ?? "").utf8))
        hash.update(data: try JSONEncoder().encode(current.info?.shift))
        let frame = hash.finalize().map { String(format: "%02x", $0) }.joined()
        let record = CachedDesign(version: 1, current: current, assets: UUID(), frame: frame)
        let destination = assetsURL(record)
        try fm.createDirectory(at: destination, withIntermediateDirectories: true)
        do {
            try fm.copyItem(at: design, to: designURL(record))
            try fm.copyItem(at: scan, to: scanURL(record))
            try write(record, to: "design.plist") // Commit only after both files exist.
        } catch {
            try? fm.removeItem(at: destination)
            throw error
        }
        // Keep the new record's pair only; a failed write above leaves the previous pair intact.
        // Enumeration resolves /var/mobile to /private/var/mobile on iPhone. URL inequality
        // would mistake the new pair for an old one and delete it before RealityKit opens it.
        for old in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
            if let id = UUID(uuidString: old.lastPathComponent), id != record.assets {
                try? fm.removeItem(at: old)
            }
        }
        return record
    }

    func placement(for frame: String) -> SavedPlacement? {
        guard let saved: SavedPlacement = read("placement.plist"), saved.version == 1,
              saved.frame == frame, !saved.worldMap.isEmpty else { return nil }
        return saved
    }
    func save(_ placement: SavedPlacement) throws { try write(placement, to: "placement.plist") }
    func forgetPlacement() { try? fm.removeItem(at: folder.appendingPathComponent("placement.plist")) }
    func plantView(for frame: String) -> SavedPlantView? {
        guard let view: SavedPlantView = read("view.plist"), view.frame == frame else { return nil }
        return view
    }
    func save(_ view: SavedPlantView) throws { try write(view, to: "view.plist") }

    private func read<T: Decodable>(_ name: String) -> T? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent(name)) else { return nil }
        return try? PropertyListDecoder().decode(T.self, from: data)
    }
    private func write<T: Encodable>(_ value: T, to name: String) throws {
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        var localFolder = folder
        var options = URLResourceValues(); options.isExcludedFromBackup = true
        try localFolder.setResourceValues(options)
        let encoder = PropertyListEncoder(); encoder.outputFormat = .binary
        try encoder.encode(value).write(to: folder.appendingPathComponent(name), options: .atomic)
    }
}
