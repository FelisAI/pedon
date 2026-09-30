// WHERE THE DESIGN COMES FROM: the Mac's read-only door on :5179 (viewer/ar_server.js).
//
// The app is never rebuilt for a new design. It asks `current.json` which file is
// current — the design's name, its plants, and where each landmark is in the file's own
// frame — and downloads the .usdz once per version.
import Foundation

struct Landmark: Decodable, Hashable, Identifiable {
    let name: String
    let at: [Float]
    var id: String { name }
    var point: SIMD3<Float> { SIMD3(at[0], at[1], at[2]) }
    /// "gate_post" -> "gate post": the designer's own name.
    var spoken: String { name.replacingOccurrences(of: "_", with: " ") }
}

struct PlantItem: Decodable, Identifiable {
    let id: String
    let name: String
    let node: String
    let at: [Float]?
    let species: String?
    let mature_height_m: Double?
    let mature_spread_m: Double?
    let size_override: Bool?
    let details: PlantFacts?
    var point: SIMD3<Float>? {
        guard let at, at.count == 3, at.allSatisfy({ $0.isFinite }) else { return nil }
        return SIMD3(at[0], at[1], at[2])
    }
}

struct PlantFacts: Decodable {
    let sun: String?
    let water: String?
    let bloom: String?
    let form: String?
    let evergreen: Bool?
    let ca_native: Bool?
    let note: String?
    let cat_safe: Bool?
    let identity_status: String?
    let flowering_height_range_m: [Double]?
}

struct DesignInfo: Decodable {
    let design_name: String?
    let plants: Int?
    let species: Int?
    let plant_items: [PlantItem]?
    let origin: String?
    let second: String?
    let landmarks: [Landmark]?
    /// Original capture for measured alignment picks, plus legacy ground metadata.
    let ground: Ground?
    let scan: ScanInfo?
    let shift: [Float]?
}

struct ScanInfo: Decodable {
    let file: String
}

struct Current: Decodable {
    let name: String?
    let bytes: Int?
    let mtime_ms: Double?
    let info: DesignInfo?
    let making: Bool?

    var made: Date? { mtime_ms.map { Date(timeIntervalSince1970: $0 / 1000) } }
}

enum SourceError: LocalizedError {
    case unreachable([String])
    case nothingMade
    case noScan
    case noServer

    var errorDescription: String? {
        switch self {
        case .unreachable(let tried):
            return "Can't reach PEDON on your Mac (tried \(tried.joined(separator: ", "))). "
                + "Is the viewer running, and is this phone on the same Wi-Fi?"
        case .nothingMade:
            return "Nothing to show yet. On the Mac: ··· → See it on site."
        case .noScan:
            return "Make a new export on the Mac with the original 3D scan loaded: ··· → See it on site."
        case .noServer:
            return "Connect to your Mac in Settings. Copy the address shown in PEDON’s ··· → See it on site sheet."
        }
    }
}

final class DesignSource {
    static let serverKey = "server"

    /// Only the address this user saved. No developer machine fallback.
    var candidates: [String] {
        let saved = UserDefaults.standard.string(forKey: Self.serverKey).map { [$0] } ?? []
        return saved.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    }

    private let quick: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 5
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: c)
    }()

    /// The first address that answers, and what it says is current.
    func current() async throws -> (base: URL, current: Current) {
        guard !candidates.isEmpty else { throw SourceError.noServer }
        for s in candidates {
            guard let base = URL(string: s.hasSuffix("/") ? s : s + "/"),
                  let url = URL(string: "current.json", relativeTo: base) else { continue }
            do {
                let (data, reply) = try await quick.data(from: url)
                guard (reply as? HTTPURLResponse)?.statusCode == 200 else { continue }
                return (base, try JSONDecoder().decode(Current.self, from: data))
            } catch { continue }
        }
        throw SourceError.unreachable(candidates)
    }

    /// The .usdz for `current`, downloaded once per version and kept in Caches.
    func file(for current: Current, from base: URL, scan: Bool = false) async throws -> URL {
        guard let name = scan ? current.info?.scan?.file : current.name, let url = URL(string: name, relativeTo: base) else { throw SourceError.nothingMade }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let local = caches.appendingPathComponent("\(Int(current.mtime_ms ?? 0))-\(name)")
        if FileManager.default.fileExists(atPath: local.path) { return local }
        let (tmp, reply) = try await URLSession.shared.download(from: url)
        guard (reply as? HTTPURLResponse)?.statusCode == 200 else { throw SourceError.unreachable([base.absoluteString]) }
        // Keep both halves of this version: the design and its original scan.
        for old in (try? FileManager.default.contentsOfDirectory(at: caches, includingPropertiesForKeys: nil)) ?? []
            where old.pathExtension == "usdz" && !old.lastPathComponent.hasPrefix("\(Int(current.mtime_ms ?? 0))-") { try? FileManager.default.removeItem(at: old) }
        try FileManager.default.moveItem(at: tmp, to: local)
        return local
    }
}
