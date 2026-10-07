// WHERE THE DESIGN COMES FROM: the Mac's read-only door on :5179 (viewer/ar_server.js).
//
// The app is never rebuilt for a new design. It asks `current.json` which file is
// current — the design's name, its plants, and where each landmark is in the file's own
// frame — and downloads the .usdz once per version.
import Foundation

struct Landmark: Codable, Hashable, Identifiable {
    let name: String
    let at: [Float]
    var id: String { name }
    var point: SIMD3<Float> { SIMD3(at[0], at[1], at[2]) }
    /// "gate_post" -> "gate post": the designer's own name.
    var spoken: String { name.replacingOccurrences(of: "_", with: " ") }
}

struct PlantItem: Codable, Identifiable {
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

struct PlantFacts: Codable {
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

struct DesignInfo: Codable {
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

struct ScanInfo: Codable {
    let file: String
    let content_hash: String?
}

struct Current: Codable {
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
    /// The sample garden built into the app (ios/make_sample.py): the demo site, exported as
    /// the Mac exports any design, so the app can be tried without a Mac — App Review included.
    static let sampleAddress = "pedon-sample:"
    static var sampleFolder: URL? {
        Bundle.main.url(forResource: "current", withExtension: "json", subdirectory: "Sample")?.deletingLastPathComponent()
    }

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

    /// Whether a saved copy can stand for what is current without asking. A Mac can only be
    /// asked over the network, so its saved copy stands until ↻; the built-in sample is on this
    /// iPhone, so a newer one, after an app update, replaces the copy saved from an older one.
    func stillCurrent(_ saved: Current) -> Bool {
        guard candidates.first == Self.sampleAddress else { return true }
        guard let folder = Self.sampleFolder,
              let data = try? Data(contentsOf: folder.appendingPathComponent("current.json")),
              let bundled = try? JSONDecoder().decode(Current.self, from: data) else { return true }
        return bundled.mtime_ms == saved.mtime_ms
    }

    /// The first address that answers, and what it says is current.
    func current() async throws -> (base: URL, current: Current) {
        guard !candidates.isEmpty else { throw SourceError.noServer }
        if candidates.first == Self.sampleAddress {
            guard let folder = Self.sampleFolder else { throw SourceError.noServer }
            let data = try Data(contentsOf: folder.appendingPathComponent("current.json"))
            return (folder, try JSONDecoder().decode(Current.self, from: data))
        }
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-offline") { throw SourceError.unreachable(candidates) }
        #endif
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
    func file(for current: Current, from base: URL, scan: Bool = false,
              onDownload: (@MainActor () -> Void)? = nil) async throws -> URL {
        guard let name = scan ? current.info?.scan?.file : current.name, let url = URL(string: name, relativeTo: base) else { throw SourceError.nothingMade }
        // the built-in sample is already on this iPhone: nothing to download
        if base.isFileURL { return base.appendingPathComponent(name) }
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let local = caches.appendingPathComponent("\(Int(current.mtime_ms ?? 0))-\(name)")
        if FileManager.default.fileExists(atPath: local.path) { return local }
        // A cached file is local work, so only announce a download when one actually starts.
        await onDownload?()
        let (tmp, reply) = try await URLSession.shared.download(from: url)
        guard (reply as? HTTPURLResponse)?.statusCode == 200 else { throw SourceError.unreachable([base.absoluteString]) }
        // Keep both halves of this version: the design and its original scan.
        for old in (try? FileManager.default.contentsOfDirectory(at: caches, includingPropertiesForKeys: nil)) ?? []
            where old.pathExtension == "usdz" && !old.lastPathComponent.hasPrefix("\(Int(current.mtime_ms ?? 0))-") { try? FileManager.default.removeItem(at: old) }
        try FileManager.default.moveItem(at: tmp, to: local)
        return local
    }
}
