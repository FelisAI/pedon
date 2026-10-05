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

    /// What iOS compares with the app's limit (`phys_footprint`), graphics memory included.
    nonisolated static func footprint() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return result == KERN_SUCCESS ? info.phys_footprint : 0
    }
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
        let line = "\(clock.string(from: Date())),\(mb(Self.footprint())),\(mb(Self.available())),\(event),\(context?() ?? "")\n"
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
        if rotating {
            let previous = folder.appendingPathComponent("memory-previous.csv")
            try? fm.removeItem(at: previous)
            try? fm.moveItem(at: url, to: previous)
        }
        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: Data("time,footprint_mb,available_mb,event,context\n".utf8))
        }
        handle = try? FileHandle(forWritingTo: url)
        written = (try? handle?.seekToEnd()) ?? 0
    }
}
