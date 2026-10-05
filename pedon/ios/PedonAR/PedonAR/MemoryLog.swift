import Foundation
import UIKit
import os

/// HOW MUCH MEMORY PEDON HOLDS, and how much more iOS allows before it ends the app (CA1).
/// iOS ends an app over its memory limit without a crash report, so this small log is the
/// only record of why: a line every few seconds and at each event, kept on this iPhone and
/// excluded from backups. ios/README.md says how to read it from the Mac.
@MainActor
final class MemoryLog {
    static let shared = MemoryLog()

    /// What iOS compares with the app's limit (`phys_footprint`), and the parts of it the
    /// kernel can name: graphics (textures, buffers), media (camera) and the app's own memory.
    struct Use { var footprint: UInt64 = 0, graphics: UInt64 = 0, media: UInt64 = 0, own: UInt64 = 0 }
    nonisolated static func use() -> Use {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return Use() }
        return Use(footprint: info.phys_footprint, graphics: UInt64(max(info.ledger_tag_graphics_footprint, 0)),
                   media: UInt64(max(info.ledger_tag_media_footprint, 0)), own: info.internal + info.compressed)
    }
    nonisolated static func footprint() -> UInt64 { use().footprint }
    /// Bytes left before iOS ends the app; 0 where there is no limit, as in the Simulator.
    nonisolated static func available() -> UInt64 { UInt64(os_proc_available_memory()) }

    let url: URL
    /// A short description of what the app is doing, filled in by the screen.
    var context: (() -> String)?
    private var handle: FileHandle?
    private var written: UInt64 = 0
    private var timer: Timer?
    private var warnings: NSObjectProtocol?
    private let clock: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let limit: UInt64 = 2_000_000
    private static let header = "time,footprint_mb,available_mb,graphics_mb,media_mb,own_mb,event,context\n"

    private init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("PEDON Diagnostics", isDirectory: true)
        url = base.appendingPathComponent("memory.csv")
    }

    func start() {
        guard timer == nil else { return }
        open()
        note("launch")
        timer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { _ in
            Task { @MainActor in MemoryLog.shared.note("sample") }
        }
        warnings = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
                                                          object: nil, queue: .main) { _ in
            Task { @MainActor in MemoryLog.shared.note("memory warning") }
        }
    }

    func note(_ event: String) {
        guard let handle else { return }
        let mb = { (bytes: UInt64) in String(format: "%.1f", Double(bytes) / 1_048_576) }
        let use = Self.use()
        let line = "\(clock.string(from: Date())),\(mb(use.footprint)),\(mb(Self.available())),\(mb(use.graphics)),"
            + "\(mb(use.media)),\(mb(use.own)),\(event),\(context?() ?? "")\n"
        let data = Data(line.utf8)
        // Written straight to the file, so the lines before iOS ends the app are still there.
        do { try handle.write(contentsOf: data) } catch { return }
        written += UInt64(data.count)
        if written > Self.limit { open(rotating: true) }
    }

    private func open(rotating: Bool = false) {
        let fm = FileManager.default
        try? handle?.close(); handle = nil
        var folder = url.deletingLastPathComponent()
        try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
        var local = URLResourceValues(); local.isExcludedFromBackup = true
        try? folder.setResourceValues(local)
        // A log written before these columns existed starts the new file afresh.
        if !rotating, let first = try? FileHandle(forReadingFrom: url),
           let head = try? first.read(upToCount: Self.header.utf8.count), head != Data(Self.header.utf8) {
            try? first.close(); open(rotating: true); return
        }
        if rotating {
            let previous = folder.appendingPathComponent("memory-previous.csv")
            try? fm.removeItem(at: previous)
            try? fm.moveItem(at: url, to: previous)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: Data(Self.header.utf8))
        }
        handle = try? FileHandle(forWritingTo: url)
        written = (try? handle?.seekToEnd()) ?? 0
    }
}
