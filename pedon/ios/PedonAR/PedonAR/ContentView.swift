// The whole app is four steps: pick two points on the original scan, mark each on the real ground,
// walk through the design. The points are the USER's (AR1) — any two things they can find.
import Combine
import SwiftUI
import simd
import SceneKit

@MainActor
final class Flow: ObservableObject {
    enum Step { case loading, pick, first, second, placed, remark, resuming, failed }
    enum LoadingStage: String {
        case saved = "Opening saved design…"
        case checkingMac = "Checking your Mac…"
        case downloadingDesign = "Downloading design from your Mac…"
        case downloadingScan = "Downloading original scan from your Mac…"
        case models = "Preparing 3D models…"

        var detail: String {
            switch self {
            case .saved: return "Using the copy saved on this iPhone."
            case .checkingMac: return "Looking for the latest design."
            case .downloadingDesign, .downloadingScan: return "Keep PEDON running on your Mac."
            case .models: return "Files are on this iPhone. Opening them for viewing."
            }
        }
    }
    @Published var step: Step = .loading { didSet { holdPickerScan(step == .pick) } }
    @Published private(set) var loadingStage: LoadingStage? {
        didSet { if let stage = loadingStage { MemoryLog.shared.note("loading: \(stage)") } }
    }
    @Published var problem: String?
    @Published var current: Current?
    @Published var scan: SCNScene?
    @Published var firstPhoto: UIImage?
    @Published var secondPhoto: UIImage?
    @Published var first: PickPoint?
    @Published var second: PickPoint?
    @Published var fit: Alignment?
    @Published var hiddenPlants: Set<String> = [] {
        didSet { applyToggles() }
    }
    @Published var selectedPlantID: String? {
        didSet {
            MemoryLog.shared.note("select \(selectedPlantID ?? "none")")
            applyToggles()
            #if DEBUG
            if let point = selectedPlant?.point { garden.previewFocus(point) }
            #endif
        }
    }
    @Published var plantingGuide = false { didSet { MemoryLog.shared.note("guide \(plantingGuide)"); applyToggles() } }
    var selectedPlant: PlantItem? { plants.first { $0.id == selectedPlantID } }
    var guideAvailable: Bool { !plants.isEmpty && plants.allSatisfy { $0.point != nil } }
    var plants: [PlantItem] { (current?.info?.plant_items ?? []).sorted { ($0.name, $0.id) < ($1.name, $1.id) } }
    func showPlant(_ id: String, _ on: Bool) {
        if on { hiddenPlants.remove(id); if !plantingGuide { showPlants = true } } else { hiddenPlants.insert(id) }
    }
    func showOnly(_ id: String) {
        hiddenPlants = Set(plants.map(\.id)).subtracting([id])
        selectedPlantID = id
        if !plantingGuide { showPlants = true }
    }
    @Published var showPlants = true { didSet { applyToggles() } }
    @Published var showBeds = true { didSet { applyToggles() } }
    @Published var showLandmarks = true { didSet { applyToggles() } }
    @Published var hideBehindReal = true { didSet { applyToggles() } }
    @Published var showOriginalScan = false { didSet { MemoryLog.shared.note("original scan \(showOriginalScan)"); applyToggles() } }
    @Published var scanOpacity: Float = 0.35 { didSet { applyToggles() } }
    @Published var savedDesignLoaded = false
    @Published var saveStatus: String?
    @Published var resumePhoto: UIImage?
    @Published var note: String?
    /// Which mark is being redone (1 or 2) while the other stays where it was (AZ2).
    @Published var remarking = 0

    let garden = ARGarden()
    private let source = DesignSource()
    private var tapA: SIMD3<Float>?
    private var tapB: SIMD3<Float>?
    private var relay: AnyCancellable?
    private var scanURL: URL?
    private var scanLoad: Task<Void, Never>?
    private var store: SessionStore?
    private var cached: CachedDesign?
    private var restoringState = false
    private var saveTask: Task<Void, Never>?
    private var mapSaves = MapSaveSchedule()
    private var saveRevision = 0
    private var pickedIn: String?          // which file's frame the picks are in
    // HAND CORRECTIONS on top of the two marks, kept across a reload of the same design so a
    // new version from the Mac lands where he had nudged it; a fresh mark supersedes them.
    private var turnFix: Float = 0
    private var slideFix = SIMD3<Float>(0, 0, 0)

    init() {
        // the camera's tracking note lives on the garden; the screen watches this
        garden.selectedPlant = { [weak self] id in self?.selectedPlantID = id }
        garden.mapBecameReady = { [weak self] in
            guard let self, self.step == .placed else { return }; self.scheduleSave(periodic: true)
        }
        garden.resumed = { [weak self] in
            guard let self, self.step == .resuming else { return }
            self.step = .placed
            self.note = nil
            self.mapSaves.saved()
            self.saveStatus = "Position saved on this iPhone"
            self.applyToggles()
        }
        relay = garden.objectWillChange.sink { [weak self] _ in self?.objectWillChange.send() }
        MemoryLog.shared.pressure = { [weak self] in self?.garden.relieveMemory() }
        MemoryLog.shared.context = { [weak self] in
            guard let self else { return "" }
            return "step=\(self.step);guide=\(self.plantingGuide);selected=\(self.selectedPlantID ?? "-");"
                + "scan=\(self.showOriginalScan);\(self.garden.arSummary())"
        }
    }

    var landmarks: [Landmark] { (current?.info?.landmarks ?? []).sorted { $0.name < $1.name } }
    private var ground: Ground? { current?.info?.ground }

    /// Both picked, and far enough apart to fix a turn.
    var picksReady: Bool {
        guard let a = first, let b = second else { return false }
        return ((a.x - b.x) * (a.x - b.x) + (a.z - b.z) * (a.z - b.z)).squareRoot() >= Alignment.minimumApart
    }

    func begin() {
        garden.start()
        Task { await load(preferSaved: true) }
    }

    /// Fetch what the Mac says is current; if the design is already lined up, keep it lined
    /// up on the SAME marks — unless the new file's frame moved, when the picks are asked for
    /// again rather than silently meaning somewhere else.
    func load(preferSaved: Bool = false) async {
        let wasPlaced = step == .placed
        step = wasPlaced ? .placed : .loading
        problem = nil
        loadingStage = .saved
        defer { loadingStage = nil }
        do {
            guard let connection = source.candidates.first else { throw SourceError.noServer }
            let storage = SessionStore(server: connection)
            let record: CachedDesign
            let usingSaved: Bool
            if preferSaved, let existing = storage.cachedDesign(), source.stillCurrent(existing.current) {
                record = existing; usingSaved = true
            } else {
                loadingStage = .checkingMac
                let (base, cur) = try await source.current()
                guard cur.name != nil else { throw SourceError.nothingMade }
                guard cur.info?.scan != nil else { throw SourceError.noScan }
                let file = try await source.file(for: cur, from: base) { [weak self] in
                    self?.loadingStage = .downloadingDesign
                }
                let scanFile = try await source.file(for: cur, from: base, scan: true) { [weak self] in
                    self?.loadingStage = .downloadingScan
                }
                loadingStage = .models
                record = try storage.cache(cur, design: file, scan: scanFile)
                usingSaved = false
            }
            loadingStage = .models
            try await garden.load(storage.designURL(record), plants: record.current.info?.plant_items ?? [])
            MemoryLog.shared.note("design loaded")
            let scanFile = storage.scanURL(record)
            useScan(scanFile)
            garden.setScanSource(scanFile)
            current = record.current
            savedDesignLoaded = usingSaved
            let frame = storage.folder.lastPathComponent + ":" + record.frame
            let sameFrame = pickedIn == frame
            restoringState = true
            defer { restoringState = false }
            if !sameFrame {
                cancelSave()
                garden.unplace(); garden.clearPins()
                hiddenPlants = []; selectedPlantID = nil
                showOriginalScan = false; scanOpacity = 0.35
                first = nil; second = nil; firstPhoto = nil; secondPhoto = nil
                tapA = nil; tapB = nil; fit = nil; clearFixes(); pickedIn = frame
            }
            store = storage; cached = record
            if let view = storage.plantView(for: record.frame) {
                hiddenPlants = view.hidden; selectedPlantID = view.selected
                plantingGuide = view.guide; showPlants = view.plants; showBeds = view.beds
                showLandmarks = view.landmarks; hideBehindReal = view.occlusion
                showOriginalScan = view.originalScan ?? false; scanOpacity = view.scanOpacity ?? 0.35
            }
            hiddenPlants.formIntersection(Set(plants.map(\.id)))
            if !plants.contains(where: { $0.id == selectedPlantID }) { selectedPlantID = nil }
            applyToggles()
            note = nil
            if wasPlaced, sameFrame, first != nil, let a = tapA, let b = tapB {
                placeFrom(a, b)
            } else if let saved = storage.placement(for: record.frame), let alignment = saved.alignment(on: ground) {
                first = saved.first; second = saved.second; tapA = saved.tapA; tapB = saved.tapB
                turnFix = saved.turn; slideFix = saved.slide; fit = alignment
                firstPhoto = saved.firstPhoto.flatMap(UIImage.init(data:))
                secondPhoto = saved.secondPhoto.flatMap(UIImage.init(data:))
                resumePhoto = saved.surroundings.flatMap(UIImage.init(data:))
                do {
                    try garden.restore(saved)
                    step = .resuming
                    saveStatus = "Saved position ready"
                } catch {
                    storage.forgetPlacement()
                    garden.resetTracking()
                    step = .first
                    saveStatus = nil
                    note = error.localizedDescription
                }
            } else {
                step = picksReady ? .first : .pick
                saveStatus = nil
            }
            if record.current.making == true { note = "A newer version is being made on the Mac — reload in a minute." }
        } catch {
            if wasPlaced {
                step = .placed; note = error.localizedDescription
            } else {
                problem = error.localizedDescription; step = .failed
            }
        }
    }

    /// The original scan this design was exported with; the point picker opens it on demand.
    func useScan(_ url: URL) {
        if scanURL != url { holdPickerScan(false) }
        scanURL = url
    }

    /// The picker's SceneKit copy of the original scan holds about 300 MB with its texture,
    /// measured; only the point picker draws it, so it is kept only while picking (CA1).
    private func holdPickerScan(_ wanted: Bool) {
        guard wanted else {
            scanLoad?.cancel(); scanLoad = nil
            if scan != nil { scan = nil; MemoryLog.shared.note("picker scan released") }
            return
        }
        guard scan == nil, scanLoad == nil, let url = scanURL else { return }
        scanLoad = Task { [weak self] in
            let opened = await Task.detached(priority: .userInitiated) { Result { try OriginalScan.load(url) } }.value
            guard let self, !Task.isCancelled, self.scanURL == url else { return }
            self.scanLoad = nil
            guard self.step == .pick else { return }
            switch opened {
            case .success(let loaded): self.scan = loaded; MemoryLog.shared.note("picker scan loaded")
            case .failure(let error): self.problem = error.localizedDescription; self.step = .failed
            }
        }
    }

    private func cancelSave() {
        saveRevision += 1; saveTask?.cancel(); saveTask = nil
    }

    private func scheduleSave(immediate: Bool = false, periodic: Bool = false) {
        guard step == .placed, tapA != nil, tapB != nil, mapSaves.wants(periodic: periodic) else { return }
        saveRevision += 1
        let revision = saveRevision
        saveTask?.cancel()
        saveStatus = garden.canSaveMap ? "Saving this position…" : "Move slowly around this spot to save its position"
        guard garden.canSaveMap else { return }
        saveTask = Task { [weak self] in
            do { try await Task.sleep(for: immediate ? .zero : .milliseconds(700)) } catch { return }
            guard let self, self.step == .placed, revision == self.saveRevision,
                  let store = self.store, let cached = self.cached, let first = self.first,
                  let second = self.second, let a = self.tapA, let b = self.tapB else { return }
            do {
                MemoryLog.shared.note("map save")
                let snapshot = try await self.garden.snapshot()
                guard !Task.isCancelled, revision == self.saveRevision, self.step == .placed else { return }
                let saved = SavedPlacement(frame: cached.frame, first: first, second: second,
                    tapA: a, tapB: b, turn: self.turnFix, slide: self.slideFix,
                    anchorID: snapshot.anchorID, worldMap: snapshot.data,
                    firstPhoto: self.firstPhoto?.jpegData(compressionQuality: 0.7),
                    secondPhoto: self.secondPhoto?.jpegData(compressionQuality: 0.7),
                    surroundings: snapshot.photo, savedAt: Date())
                try store.save(saved)
                self.mapSaves.saved()
                MemoryLog.shared.note("map saved \(snapshot.data.count) bytes")
                self.saveStatus = "Position saved on this iPhone"
            } catch {
                guard revision == self.saveRevision else { return }
                self.saveStatus = "Position not saved yet — move slowly, then tap Save position"
            }
        }
    }

    func savePosition(immediate: Bool = false) { scheduleSave(immediate: immediate) }

    func alignAgain() {
        cancelSave(); store?.forgetPlacement(); saveStatus = nil; resumePhoto = nil
        garden.resetTracking()
        tapA = nil; tapB = nil; fit = nil; clearFixes()
        step = picksReady ? .first : .pick
        note = nil
    }

    private func persistView() {
        guard !restoringState, let store, let cached else { return }
        try? store.save(SavedPlantView(frame: cached.frame, hidden: hiddenPlants, selected: selectedPlantID,
            guide: plantingGuide, plants: showPlants, beds: showBeds, landmarks: showLandmarks, occlusion: hideBehindReal,
            originalScan: showOriginalScan, scanOpacity: scanOpacity))
    }

    func markFirst() {
        guard let p = garden.groundUnderDot() else { note = "No ground under the dot yet — aim at the ground and move slowly."; return }
        garden.clearPins()
        garden.pin(at: p, colour: .systemRed)
        tapA = p
        note = nil
        step = .second
    }

    func markSecond() {
        guard let a = tapA else { step = .first; return }
        guard let b = garden.groundUnderDot() else { note = "No ground under the dot yet — aim at the ground and move slowly."; return }
        garden.pin(at: b, colour: .systemOrange)
        tapB = b
        placeFrom(a, b)
    }

    private func placeFrom(_ a: SIMD3<Float>, _ b: SIMD3<Float>) {
        guard let first, let second,
              let f = Alignment.solve(planA: first.point(on: ground), planB: second.point(on: ground),
                                      tapA: a, tapB: b) else {
            note = "Those two marks are too close together to line anything up. Mark them again."
            startOver()
            return
        }
        var g = f
        if turnFix != 0 { g = g.turned(by: turnFix, about: first.point(on: ground)) }
        g = g.moved(by: slideFix)
        fit = g
        garden.place(g)
        applyToggles()
        step = .placed
        note = abs(f.stretch) > 0.03
            ? "Your marks are \(Int((abs(f.stretch) * 100).rounded()))% \(f.stretch > 0 ? "further apart" : "closer together") than the scan — one may be on the wrong spot."
            : nil
        scheduleSave()
    }

    func turn(_ degrees: Float) {
        guard let f = fit, let first else { return }
        turnFix += degrees * .pi / 180
        fit = f.turned(by: degrees * .pi / 180, about: first.point(on: ground))
        garden.place(fit!)
        applyToggles()
        scheduleSave()
    }

    /// Slide the design from where he stands: `forward` metres away from him, `right` metres
    /// to his right (AZ2 — a mark 20 cm off used to mean redoing both).
    func slide(forward: Float, right: Float) {
        guard let f = fit else { return }
        guard let axes = garden.cameraAxes() else { note = "Hold the phone up so it can tell which way you face."; return }
        let g = f.slid(forward: forward, right: right, look: axes.look, screenUp: axes.up)
        slideFix += g.translation - f.translation
        fit = g
        garden.place(g)
        applyToggles()
        scheduleSave()
    }

    /// Redo ONE mark; the other stays where it was.
    func remark(_ which: Int) {
        remarking = which
        note = nil
        step = .remark
    }

    func markRemark() {
        guard let p = garden.groundUnderDot() else { note = "No ground under the dot yet — aim at the ground and move slowly."; return }
        if remarking == 1 { tapA = p } else { tapB = p }
        remarking = 0
        clearFixes()                       // the new mark is the truth now
        garden.clearPins()
        if let a = tapA { garden.pin(at: a, colour: .systemRed) }
        if let b = tapB { garden.pin(at: b, colour: .systemOrange) }
        guard let a = tapA, let b = tapB else { step = .first; return }
        placeFrom(a, b)
    }

    func cancelRemark() {
        remarking = 0
        step = .placed
    }

    private func clearFixes() { turnFix = 0; slideFix = .zero }

    #if DEBUG
    /// `-previewPlaced`: the lined-up screen with sample marks, for looking at the controls
    /// in the Simulator, which has no camera to mark real ground with.
    func previewPlaced(keepView: Bool = false) async {
        if !keepView {
            plantingGuide = false; hiddenPlants = []; selectedPlantID = nil
            showOriginalScan = false; scanOpacity = 0.35
            showPlants = true; showBeds = true; showLandmarks = true
        }
        first = PickPoint(x: 0, z: 0, label: "Reference 1", y: 0)
        second = PickPoint(x: 6, z: 14, label: "Reference 2", y: 0)
        fit = Alignment.solve(planA: [0, 0, 0], planB: [6, 0, 14], tapA: [0, 0, 0], tapB: [6, 0, 14])
        if let scanURL, let focus = plants.first?.point {
            do { try await garden.preview(scan: scanURL, focus: focus) }
            catch { problem = error.localizedDescription; step = .failed; return }
        }
        if ProcessInfo.processInfo.arguments.contains("-previewWide") { garden.previewFrame(plants.compactMap(\.point)) }
        step = .placed
    }
    func previewResumePrompt() {
        garden.hidePreviewDesign()
        step = .resuming
    }

    /// `-probeGuide`: what looking through many planting targets costs (CA1). Turns the guide
    /// on and selects every plant in turn, as tapping one target after another does on site.
    /// With `models`, the 3D view instead of the guide; with `scan`, the original scan shown too.
    func probeGuide(rounds: Int, every seconds: Double, hold: Double = 0, models: Bool = false, scan: Bool = false) async {
        plantingGuide = !models
        if models { showPlants = true; showBeds = true; showLandmarks = true }
        showOriginalScan = scan
        MemoryLog.shared.note("probe start")
        if hold > 0 {   // the guide on with nothing selected, every target where the camera can see it
            try? await Task.sleep(for: .seconds(hold))
            MemoryLog.shared.note("probe held \(Int(hold)) s")
        }
        for round in 1...max(rounds, 1) {
            for plant in plants {
                selectedPlantID = plant.id
                try? await Task.sleep(for: .seconds(seconds))
            }
            MemoryLog.shared.note("probe round \(round)")
        }
        selectedPlantID = nil
        MemoryLog.shared.note("probe done")
    }

    /// `-probeToggle N`: the 3D view with every model drawn and occlusion on, then the planting
    /// guide switched on and off N times as its button does, memory sampled every 20 ms (CA1).
    func probeToggle(times: Int) async {
        plantingGuide = false; showPlants = true; showBeds = true; showLandmarks = true; hideBehindReal = true
        MemoryLog.shared.note("probe toggle: 3D view, every model")
        try? await Task.sleep(for: .seconds(20))
        for i in 1...max(times, 1) {
            for on in [true, false] {
                plantingGuide = on
                try? await Task.sleep(for: .seconds(4))
                MemoryLog.shared.note("probe guide \(on ? "on" : "off") \(i)")
                try? await Task.sleep(for: .seconds(4))
            }
        }
        MemoryLog.shared.note("probe toggle done")
    }

    /// `-probePlaceHere`: stand the planting in front of where the phone started, 1.2 m below it,
    /// without marks, so a probe runs with ARKit tracking, mesh and map saving as on site, and
    /// with many planting targets in view at once (CA1).
    func probePlaceHere() {
        cancelSave(); store?.forgetPlacement()
        let centres = plants.compactMap(\.point)
        let centre = centres.reduce(SIMD3<Float>(0, 0, 0), +) / Float(max(centres.count, 1))
        first = PickPoint(x: centre.x, z: centre.z, label: "Reference 1", y: centre.y)
        second = PickPoint(x: centre.x, z: centre.z + 6, label: "Reference 2", y: centre.y)
        // the planting's centre 4 m along the camera's line of sight, whichever way the phone
        // lies, so the design is on screen (the first probes placed it where nothing looked)
        let m = garden.view.cameraTransform.matrix
        let eye = SIMD3<Float>(m.columns.3.x, m.columns.3.y, m.columns.3.z)
        let look = simd_normalize(-SIMD3<Float>(m.columns.2.x, m.columns.2.y, m.columns.2.z))
        var flat = SIMD3<Float>(look.x, 0, look.z)
        if simd_length(flat) < 0.2 { flat = SIMD3<Float>(m.columns.1.x, 0, m.columns.1.z) }
        if simd_length(flat) < 0.2 { flat = SIMD3<Float>(0, 0, -1) }
        let distance = UserDefaults.standard.double(forKey: "probeDistance") > 0 ? Float(UserDefaults.standard.double(forKey: "probeDistance")) : 4
        if abs(look.y) < 0.5 {
            // a phone standing up looks across a room: lay the planting on the floor ahead of it,
            // seen at a shallow angle as across a bed on site, where ARKit's planes are
            let floor = garden.lowestHorizontalPlane() ?? (eye.y - 1.0)
            let ahead = eye + simd_normalize(flat) * distance
            tapA = SIMD3(ahead.x, floor, ahead.z)
        } else {
            tapA = eye + look * distance
        }
        tapB = tapA! + simd_normalize(flat) * 6
        clearFixes()
        placeFrom(tapA!, tapB!)
        MemoryLog.shared.note(String(format: "probe placed; looking %.2f %.2f %.2f", look.x, look.y, look.z))
    }

    /// What the screen shows, saved where `devicectl` can copy it (Documents/probe-NAME.png).
    func probeSnapshot(_ name: String) {
        garden.view.snapshot(saveToHDR: false) { image in
            guard let data = image?.pngData() else { return }
            let docs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try? data.write(to: docs.appendingPathComponent("probe-\(name).png"))
            MemoryLog.shared.note("probe snapshot \(name)")
        }
    }
    #endif

    func startOver() {
        cancelSave(); store?.forgetPlacement(); saveStatus = nil
        garden.unplace()
        garden.clearPins()
        tapA = nil; tapB = nil; fit = nil
        clearFixes()
        step = .first
    }

    private func applyToggles() {
        garden.showPlants(models: showPlants, guide: plantingGuide, hidden: hiddenPlants, selected: selectedPlantID)
        garden.show("design", showBeds && !plantingGuide)
        garden.show("ar_landmark", showLandmarks && !plantingGuide)
        garden.showGuide(plantingGuide, hidden: hiddenPlants, selected: selectedPlantID)
        // A soil depth estimate must not swallow the centimetre-thin targets.
        garden.setOcclusion(hideBehindReal && !plantingGuide && !showOriginalScan)
        garden.showOriginalScan(showOriginalScan, opacity: scanOpacity)
        persistView()
    }

    func choose(_ point: PickPoint, photo: UIImage) {
        if first == nil || second != nil {
            first = point; firstPhoto = photo; second = nil; secondPhoto = nil
        } else { second = point; secondPhoto = photo }
    }

    /// Back to the original scan to choose other points.
    func changePoints() {
        alignAgain()
        first = nil; second = nil; firstPhoto = nil; secondPhoto = nil
        note = nil
        step = .pick
    }

    func plannedApart() -> String? {
        guard let a = first?.point(on: ground), let b = second?.point(on: ground) else { return nil }
        return String(format: "%.1f m", simd_length(SIMD2(b.x - a.x, b.z - a.z)))
    }
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var flow = Flow()
    @State private var settings = false
    @State private var started = false
    @AppStorage("controlsCollapsed") private var controlsCollapsed = false
    @State private var plantList = false
    @State private var detailPlant: PlantItem?
    @State private var scanRevision = 0
    @State private var panelHeight: CGFloat = 320

    var body: some View {
        GeometryReader { geometry in
        ZStack {
            ARGardenView(garden: flow.garden).ignoresSafeArea()
            if flow.step == .first || flow.step == .second || flow.step == .remark { AimDot() }
            VStack(spacing: 0) {
                if !controlsCollapsed || flow.step != .placed || flow.loadingStage != nil { header }
                if flow.step == .pick {
                    if let scan = flow.scan {
                        ScanPicker(scene: scan, first: flow.first, second: flow.second, picked: flow.choose)
                            .id(scanRevision)
                            .overlay(alignment: .topTrailing) {
                                Button("Show whole scan") { scanRevision += 1 }.buttonStyle(Quiet()).padding(8)
                            }
                    } else {
                        VStack(spacing: 10) {
                            ProgressView().tint(.white)
                            Text("Opening the original scan…").font(.subheadline).foregroundStyle(.white)
                        }.frame(maxWidth: .infinity, maxHeight: .infinity).background(Color(white: 0.08))
                    }
                } else {
                    Spacer()
                }
                if let n = flow.garden.trackingNote, flow.step == .first || flow.step == .second || flow.step == .remark || flow.step == .placed { Banner(text: n) }
                if controlsCollapsed && flow.step == .placed, let note = flow.note { Banner(text: note) }
                if flow.step == .placed && controlsCollapsed {
                    VStack(spacing: 8) {
                        selectedPlantBar
                        HStack(spacing: 8) {
                            Button("Controls", systemImage: "slider.horizontal.3") { controlsCollapsed = false }
                            Button(flow.plantingGuide ? "3D view" : "Guide", systemImage: "scope") {
                                flow.plantingGuide.toggle()
                            }.disabled(!flow.guideAvailable)
                                .accessibilityLabel(flow.plantingGuide ? "3D view" : "Planting guide")
                            Button { flow.showOriginalScan.toggle() } label: {
                                Image(systemName: "square.3.layers.3d")
                                    .foregroundStyle(flow.showOriginalScan ? .orange : .white)
                            }.accessibilityLabel(flow.showOriginalScan ? "Hide original scan" : "Show original scan")
                            Button { plantList = true } label: { Image(systemName: "leaf") }
                                .accessibilityLabel("Individual plants")
                        }.buttonStyle(Quiet())
                    }.padding(10).background(.black.opacity(0.7), in: RoundedRectangle(cornerRadius: 18))
                        .padding(.horizontal, 10)
                } else if flow.step == .placed {
                    ScrollView {
                        panel.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { panelHeight = $0 }
                    }
                        .scrollBounceBehavior(.basedOnSize)
                        .frame(height: min(panelHeight, geometry.size.height * 0.58))
                } else { panel }
            }
        }
        }
        .onAppear {
            guard !started else { return }; started = true
            UIApplication.shared.isIdleTimerDisabled = true
            MemoryLog.shared.start()
            #if DEBUG
            let arguments = ProcessInfo.processInfo.arguments
            let rounds = max(UserDefaults.standard.integer(forKey: "probeRounds"), 1)
            let every = UserDefaults.standard.double(forKey: "probeEvery") > 0 ? UserDefaults.standard.double(forKey: "probeEvery") : 1
            let hold = UserDefaults.standard.double(forKey: "probeHold")
            let models = arguments.contains("-probeModels"), scan = arguments.contains("-probeScan")
            if arguments.contains("-probePlaceHere") {
                flow.garden.start()
                Task {
                    await flow.load(preferSaved: true)
                    guard flow.step != .failed else { return }
                    flow.garden.resetTracking()     // a fresh session, not a saved map
                    try? await Task.sleep(for: .seconds(8)) // tracking finds its feet first
                    flow.probePlaceHere()
                    let label = UserDefaults.standard.string(forKey: "probeLabel") ?? "run"
                    Task { try? await Task.sleep(for: .seconds(6)); flow.probeSnapshot(label + "-placed") }
                    let toggles = UserDefaults.standard.integer(forKey: "probeToggle")
                    if toggles > 0 { await flow.probeToggle(times: toggles); return }
                    if arguments.contains("-probeGuide") { await flow.probeGuide(rounds: rounds, every: every, hold: hold, models: models, scan: scan) }
                }
                return
            }
            if ProcessInfo.processInfo.arguments.contains("-resetConnection") { UserDefaults.standard.removeObject(forKey: DesignSource.serverKey) }
            if ProcessInfo.processInfo.arguments.contains("-previewPlaced") {
                let saved = ProcessInfo.processInfo.arguments.contains("-useSavedDesign")
                if !saved { controlsCollapsed = false }
                Task {
                    await flow.load(preferSaved: saved)
                    guard flow.step != .failed else { return }
                    await flow.previewPlaced(keepView: saved)
                    if ProcessInfo.processInfo.arguments.contains("-previewRestoring") { flow.previewResumePrompt() }
                    if arguments.contains("-probeGuide") { await flow.probeGuide(rounds: rounds, every: every, hold: hold, models: models, scan: scan) }
                }
                return
            }
            #endif
            if DesignSource().candidates.isEmpty { settings = true }
            flow.begin()
        }
        .onChange(of: scenePhase) { _, phase in
            MemoryLog.shared.note("phase \(phase)")
            if phase != .active { flow.savePosition(immediate: true) }
        }
        .sheet(item: $detailPlant) { PlantDetailsView(plant: $0) }
        .sheet(isPresented: $plantList) { PlantVisibilityView(flow: flow) }
        .sheet(isPresented: $settings) { SettingsView { settings = false; Task { await flow.load(preferSaved: true) } } }
    }

    @ViewBuilder private func reference(_ photo: UIImage?) -> some View {
        if let photo {
            Image(uiImage: photo).resizable().scaledToFit().frame(maxHeight: 140)
                .frame(maxWidth: .infinity).accessibilityLabel("Your selected point on the original scan")
        }
    }

    @ViewBuilder private var selectedPlantBar: some View {
        if let plant = flow.selectedPlant {
            HStack {
                VStack(alignment: .leading) {
                    Text(plant.name).font(.subheadline.weight(.semibold))
                    Text(plant.id + (flow.hiddenPlants.contains(plant.id) ? " · hidden" : ""))
                        .font(.caption).foregroundStyle(.secondary)
                    if let size = PlantSize.summary(plant) {
                        Text(size).font(.caption).foregroundStyle(.white.opacity(0.85))
                    }
                }
                Spacer()
                Button { detailPlant = plant } label: { Image(systemName: "info.circle") }
                    .accessibilityLabel("Plant details").frame(minWidth: 36, minHeight: 44)
                Button(flow.hiddenPlants.contains(plant.id) ? "Show" : "Hide") {
                    flow.showPlant(plant.id, flow.hiddenPlants.contains(plant.id))
                }.buttonStyle(Quiet())
                Button { flow.selectedPlantID = nil } label: { Image(systemName: "xmark") }
                    .accessibilityLabel("Deselect plant")
            }.foregroundStyle(.white)
        }
    }

    private var header: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 2) {
                Text("◈ PEDON").font(.caption.weight(.bold)).tracking(2).foregroundStyle(.orange)
                if let c = flow.current {
                    Text(c.info?.design_name ?? "Design").font(.headline)
                    Text([c.info?.plants.map { "\($0) plants" }, c.made.map { "made \($0.formatted(.relative(presentation: .named)))" }]
                        .compactMap { $0 }.joined(separator: " · ")).font(.caption)
                    if flow.savedDesignLoaded {
                        Text("Saved on this iPhone · refresh for changes").font(.caption).foregroundStyle(.white.opacity(0.75))
                    }
                }
                if flow.step != .loading, flow.loadingStage != nil { loadingIndicator.padding(.top, 6) }
            }
            Spacer()
            Button { Task { await flow.load() } } label: { Image(systemName: "arrow.clockwise") }
                .accessibilityLabel("Get the latest version from the Mac")
                .disabled(flow.loadingStage != nil)
            Button { settings = true } label: { Image(systemName: "gearshape") }.padding(.leading, 14)
        }
        .foregroundStyle(.white)
        .padding(14)
        .background(.black.opacity(0.55))
    }

    private var alignmentControls: some View {
        VStack(alignment: .leading, spacing: 12) {
            Button("Save position", systemImage: "square.and.arrow.down") { flow.savePosition() }
                .buttonStyle(Quiet())
            if let f = flow.fit {
                Text(String(format: "Your marks: %.1f m apart · scan: %.1f m", f.tappedApart, f.plannedApart))
                    .font(.caption)
            }
            // LINING IT UP BY HAND (AZ2): slide 5 cm from where you stand, turn half a degree,
            // or redo one mark — instead of redoing both when one is a little off
            Text("A little off? Slide it 5 cm (↑ away from you) or turn it ½°.")
                .font(.caption).foregroundStyle(.white.opacity(0.75))
            HStack(spacing: 8) {
                Button { flow.slide(forward: 0, right: -0.05) } label: { Image(systemName: "arrow.left") }.buttonStyle(Quiet())
                    .accessibilityLabel("Slide 5 centimetres to your left")
                Button { flow.slide(forward: 0.05, right: 0) } label: { Image(systemName: "arrow.up") }.buttonStyle(Quiet())
                    .accessibilityLabel("Slide 5 centimetres away from you")
                Button { flow.slide(forward: -0.05, right: 0) } label: { Image(systemName: "arrow.down") }.buttonStyle(Quiet())
                    .accessibilityLabel("Slide 5 centimetres towards you")
                Button { flow.slide(forward: 0, right: 0.05) } label: { Image(systemName: "arrow.right") }.buttonStyle(Quiet())
                    .accessibilityLabel("Slide 5 centimetres to your right")
                Spacer()
                Button { flow.turn(-0.5) } label: { Image(systemName: "rotate.left") }.buttonStyle(Quiet())
                    .accessibilityLabel("Turn half a degree left")
                Button { flow.turn(0.5) } label: { Image(systemName: "rotate.right") }.buttonStyle(Quiet())
                    .accessibilityLabel("Turn half a degree right")
            }
            Text("Or re-mark one point — 1 · \(flow.first?.label ?? "first")   2 · \(flow.second?.label ?? "second")")
                .font(.caption).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
            HStack {
                Button("Re-mark 1") { flow.remark(1) }.buttonStyle(Quiet())
                    .accessibilityLabel("Mark \(flow.first?.label ?? "the first point") again; keep the second")
                Button("Re-mark 2") { flow.remark(2) }.buttonStyle(Quiet())
                    .accessibilityLabel("Mark \(flow.second?.label ?? "the second point") again; keep the first")
                Spacer()
                Button("Other points") { flow.changePoints() }.buttonStyle(Quiet())
            }
        }.padding(.top, 8)
    }

    private var loadingIndicator: some View {
        HStack(alignment: .top, spacing: 12) {
            ProgressView().tint(.white).padding(.top, 3)
            VStack(alignment: .leading, spacing: 5) {
                Text(flow.loadingStage?.rawValue ?? "Opening PEDON…").font(.subheadline.weight(.semibold))
                if let stage = flow.loadingStage {
                    Text(stage.detail).font(.caption).foregroundStyle(.white.opacity(0.8))
                }
            }
        }.accessibilityIdentifier("design-loading-status")
    }

    @ViewBuilder private var panel: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch flow.step {
            case .loading:
                loadingIndicator
            case .failed:
                Text(flow.problem ?? "Something went wrong.")
                Button("Connection settings") { settings = true }.buttonStyle(Quiet())
                Button("Try again") { Task { await flow.load() } }.buttonStyle(Big())
            case .resuming:
                reference(flow.resumePhoto)
                HStack { ProgressView().tint(.white); Text("Finding your saved position").font(.headline) }
                Text("Point the camera at the same area and move slowly. The design will appear when this spot is recognized.")
                    .font(.subheadline)
                Button("Align again") { flow.alignAgain() }.buttonStyle(Quiet())
            case .pick:
                Text("Original 3D scan").font(.headline)
                Text("Rotate with one finger, pan with two, pinch to zoom. Tap two existing ground features far apart, such as paving corners or the foot of a fixed post.")
                    .font(.subheadline)
                VStack(alignment: .leading, spacing: 4) {
                    Text("1 · \(flow.first?.label ?? "tap the scan")").foregroundStyle(flow.first == nil ? .secondary : .primary)
                    Text("2 · \(flow.second?.label ?? (flow.first == nil ? "—" : "tap a second point"))")
                        .foregroundStyle(flow.second == nil ? .secondary : .primary)
                }.font(.footnote.weight(.semibold))
                Button(flow.picksReady || flow.second == nil ? "Use these two points" : "Pick points further apart") {
                    flow.step = .first
                }.buttonStyle(Big()).disabled(!flow.picksReady)
            case .first:
                reference(flow.firstPhoto)
                Text("1 of 2 · Go to **\(flow.first?.label ?? "the first point")**. Aim the dot at that exact spot on the ground.")
                HStack {
                    Button("Change points") { flow.changePoints() }.buttonStyle(Quiet())
                    Button("Mark it") { flow.markFirst() }.buttonStyle(Big())
                }
            case .second:
                reference(flow.secondPhoto)
                Text("2 of 2 · Now go to **\(flow.second?.label ?? "the second point")**\(flow.plannedApart().map { " (\($0) away)" } ?? ""). Aim the dot at it.")
                HStack {
                    Button("Back") { flow.startOver() }.buttonStyle(Quiet())
                    Button("Mark it") { flow.markSecond() }.buttonStyle(Big())
                }
            case .remark:
                reference(flow.remarking == 1 ? flow.firstPhoto : flow.secondPhoto)
                let label = (flow.remarking == 1 ? flow.first?.label : flow.second?.label) ?? "that point"
                Text("Re-mark \(flow.remarking) · Go to **\(label)** and aim the dot at it. The other mark stays where it is.")
                HStack {
                    Button("Cancel") { flow.cancelRemark() }.buttonStyle(Quiet())
                    Button("Mark it") { flow.markRemark() }.buttonStyle(Big())
                }
            case .placed:
                selectedPlantBar
                if let status = flow.saveStatus {
                    Text(status).font(.caption).foregroundStyle(.white.opacity(0.8))
                }
                HStack {
                    Button("Individual plants", systemImage: "leaf") { plantList = true }.buttonStyle(Quiet())
                    Spacer()
                    Button { controlsCollapsed = true } label: { Image(systemName: "chevron.down") }
                        .buttonStyle(Quiet()).accessibilityLabel("Hide controls")
                }
                HStack {
                    Text("Planting guide")
                    Spacer()
                    Toggle("Planting guide", isOn: $flow.plantingGuide).labelsHidden().disabled(!flow.guideAvailable)
                }
                if !flow.guideAvailable {
                    Text("Make a fresh export on the Mac, then reload to see planting centers.").font(.footnote)
                }
                Toggle("Original scan", isOn: $flow.showOriginalScan)
                if flow.showOriginalScan {
                    HStack {
                        Text("Scan opacity").font(.caption)
                        Slider(value: $flow.scanOpacity, in: 0.15...0.8)
                            .accessibilityLabel("Scan opacity")
                        Text("\(Int(flow.scanOpacity * 100))%").font(.caption.monospacedDigit())
                    }
                    if flow.garden.scanLoading {
                        HStack { ProgressView().tint(.white); Text("Loading original scan…") }.font(.caption)
                    } else if let error = flow.garden.scanError {
                        Text(error).font(.caption).foregroundStyle(.yellow)
                    } else {
                        Text("Compare fixed features with the camera view. Use Adjust alignment to move the scan and design together.")
                            .font(.caption).foregroundStyle(.white.opacity(0.8))
                    }
                }
                if flow.plantingGuide {
                    Text("Cross = planting center. Tap a target or choose a plant from the list. Check alignment against a fixed feature before planting.")
                        .font(.footnote).foregroundStyle(.white.opacity(0.85))
                }
                if !flow.plantingGuide {
                    DisclosureGroup("Visible layers") {
                        Toggle("Plant models", isOn: $flow.showPlants)
                        Toggle("Beds & paths", isOn: $flow.showBeds)
                        Toggle("Landmarks", isOn: $flow.showLandmarks)
                        if flow.garden.hasLiDAR { Toggle("Behind real things", isOn: $flow.hideBehindReal) }
                    }.tint(.white)
                }
                DisclosureGroup("Adjust alignment") {
                    alignmentControls
                }.tint(.white)

            }
            if let n = flow.note { Text(n).font(.footnote).foregroundStyle(.yellow) }
        }
        .toggleStyle(.switch)
        .font(.body)
        .foregroundStyle(.white)
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.black.opacity(0.62))
    }
}

struct AimDot: View {
    var body: some View {
        ZStack {
            Circle().stroke(.white, lineWidth: 2).frame(width: 34, height: 34)
            Circle().fill(.red).frame(width: 7, height: 7)
        }
        .shadow(radius: 2)
        .allowsHitTesting(false)
    }
}

struct Banner: View {
    let text: String
    var body: some View {
        Text(text).font(.footnote.weight(.semibold)).foregroundStyle(.black)
            .padding(.horizontal, 12).padding(.vertical, 6)
            .background(.yellow, in: Capsule()).padding(.bottom, 8)
    }
}

struct Big: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View { BigBody(configuration: configuration) }
    private struct BigBody: View {
        let configuration: Configuration
        @Environment(\.isEnabled) private var enabled
        var body: some View {
            configuration.label.font(.headline).foregroundStyle(enabled ? .black : .white.opacity(0.5))
                .frame(maxWidth: .infinity).padding(.vertical, 14)
                .background(enabled ? Color.orange.opacity(configuration.isPressed ? 0.7 : 1) : Color.white.opacity(0.12),
                            in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

struct Quiet: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.font(.subheadline.weight(.semibold)).foregroundStyle(.white)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.white.opacity(configuration.isPressed ? 0.3 : 0.18), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct SettingsView: View {
    let done: () -> Void
    @State private var server = UserDefaults.standard.string(forKey: DesignSource.serverKey)
        .flatMap { $0 == DesignSource.sampleAddress ? "" : $0 } ?? ""
    @State private var error: String?
    var body: some View {
        NavigationStack {
            Form {
                Section("Your Mac") {
                    TextField("http://your-mac.local:5179/", text: $server)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    if let error { Text(error).foregroundStyle(.red) }
                    Text("Enter the address shown in the Mac’s ··· → See it on site sheet.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if DesignSource.sampleFolder != nil {
                    Section {
                        Button("Try the sample garden") {
                            UserDefaults.standard.set(DesignSource.sampleAddress, forKey: DesignSource.serverKey)
                            done()
                        }
                    } footer: {
                        Text("A small garden built into PEDON, for trying it without a Mac. Pick two points on its scan, then mark any two spots on the ground around you.")
                    }
                }
                Section("About PEDON") {
                    NavigationLink("Privacy", destination: PrivacyPolicyView())
                    Link("Help and support", destination: URL(string: "https://github.com/FelisAI/pedon/blob/main/pedon/ios/support.md")!)
                    Link("Open-source code", destination: URL(string: "https://github.com/FelisAI/pedon/tree/main/pedon/ios")!)
                    if let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String,
                       let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String {
                        LabeledContent("Version", value: "\(version) (\(build))")
                    }
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                Button("Done") {
                    let entered = server.trimmingCharacters(in: .whitespacesAndNewlines)
                    if entered.isEmpty, UserDefaults.standard.string(forKey: DesignSource.serverKey) == DesignSource.sampleAddress {
                        done(); return                      // keep the sample garden
                    }
                    let value = entered.contains("://") ? entered : "http://" + entered
                    guard let url = URL(string: value), ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                          url.host != nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else {
                        error = "Enter the full address beginning with http:// or https://."; return
                    }
                    UserDefaults.standard.set(value, forKey: DesignSource.serverKey)
                    done()
                }
            }
        }
    }
}
