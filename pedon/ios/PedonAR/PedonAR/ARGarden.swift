// The camera, the real ground, and the design standing on it.
//
// World tracking with gravity as +Y, so the design never tilts; the real ground is found
// under the dot in the middle of the screen; the design is held by an ARAnchor, so ARKit
// keeps refining where it is as it learns the place. On a phone with LiDAR the real world
// hides what is behind it — a plant behind the real fence is behind the fence.
import ARKit
import RealityKit
import SwiftUI
import CoreImage
import Combine

@MainActor
final class ARGarden: NSObject, ObservableObject, ARSessionDelegate {
    let view: ARView = {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-previewPlaced") {
            return ARView(frame: .zero, cameraMode: .nonAR, automaticallyConfigureSession: false)
        }
        #endif
        return ARView(frame: .zero, cameraMode: .ar, automaticallyConfigureSession: false)
    }()
    let hasLiDAR = ARWorldTrackingConfiguration.supportsSceneReconstruction(.mesh)
    @Published var trackingNote: String? = "Move the phone slowly to find the ground"

    @Published private(set) var canSaveMap = false
    var mapBecameReady: (() -> Void)?
    var resumed: (() -> Void)?
    private var resumeGate = ResumeGate()
    private var started = false
    private var lastMapSignal: TimeInterval = -.infinity
    private let imageContext = CIContext()

    private var design: Entity?
    /// The loaded design, guide included (read by tests).
    var designRoot: Entity? { design }
    @Published private(set) var scanLoading = false
    @Published private(set) var scanError: String?
    private var scanSource: URL?
    private var scanOverlay: Entity?
    private var scanTask: Task<Void, Never>?
    private var scanRelease: Task<Void, Never>?
    /// How long the original scan stays loaded after it is switched off.
    static var overlayRelease: Duration = .seconds(20)
    var overlayLoaded: Bool { scanOverlay != nil }
    private var scanGeneration = 0
    private var scanVisible = false
    private var scanOpacity: Float = 0.35
    private var holder: AnchorEntity?
    private var anchor: ARAnchor?
    private var pins: [AnchorEntity] = []
    private var plantingGuide: PlantingGuide?
    private var frameUpdates: Cancellable?
    private var plantDisplay: PlantDisplay?
    var selectedPlant: ((String) -> Void)?
    private var items: [PlantItem] = []

    func configuration(map: ARWorldMap? = nil) -> ARWorldTrackingConfiguration {
        let c = ARWorldTrackingConfiguration()
        c.planeDetection = [.horizontal]
        // No lighting probes (CA1). With `.automatic`, graphics memory grew about 2.5 MB a second
        // for as long as the camera ran, measured on an iPhone 17 Pro, until iOS ended the app at
        // its 3.3 GB limit; with probes off it stayed flat. They only add reflections, which the
        // design's matte plant pictures barely show.
        c.environmentTexturing = .none
        if hasLiDAR { c.sceneReconstruction = .mesh }
        c.initialWorldMap = map
        return c
    }

    func start() {
        guard !started else { return }; started = true
        applyRenderBudget()
        view.session.delegate = self
        view.session.run(configuration())
        let coach = ARCoachingOverlayView()
        coach.session = view.session
        coach.goal = .horizontalPlane
        coach.activatesAutomatically = true
        coach.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(coach)
        NSLayoutConstraint.activate([coach.topAnchor.constraint(equalTo: view.topAnchor),
                                     coach.bottomAnchor.constraint(equalTo: view.bottomAnchor),
                                     coach.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                                     coach.trailingAnchor.constraint(equalTo: view.trailingAnchor)])
        setOcclusion(true)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(selectPlant(_:))))
    }

    struct MapSnapshot {
        let data: Data
        let anchorID: UUID
        let photo: Data?
    }
    enum MapError: LocalizedError {
        case notReady, invalid
        var errorDescription: String? {
            switch self {
            case .notReady: return "Move slowly around this spot so PEDON can remember it."
            case .invalid: return "The saved position could not be restored. Align the design again."
            }
        }
    }

    func snapshot() async throws -> MapSnapshot {
        guard canSaveMap, let id = anchor?.identifier else { throw MapError.notReady }
        let map: ARWorldMap = try await withCheckedThrowingContinuation { continuation in
            view.session.getCurrentWorldMap { map, error in
                if let map { continuation.resume(returning: map) }
                else { continuation.resume(throwing: error ?? MapError.notReady) }
            }
        }
        guard id == anchor?.identifier, map.anchors.contains(where: { $0.identifier == id }) else { throw MapError.notReady }
        let data = try NSKeyedArchiver.archivedData(withRootObject: map, requiringSecureCoding: true)
        var photo: Data?
        if let frame = view.session.currentFrame {
            let image = CIImage(cvPixelBuffer: frame.capturedImage).oriented(.right)
            let reduced = image.transformed(by: CGAffineTransform(scaleX: 720 / image.extent.width, y: 720 / image.extent.width))
            if let cg = imageContext.createCGImage(reduced, from: reduced.extent) {
                photo = UIImage(cgImage: cg).jpegData(compressionQuality: 0.65)
            }
        }
        return MapSnapshot(data: data, anchorID: id, photo: photo)
    }

    func restore(_ saved: SavedPlacement) throws {
        guard let map = try NSKeyedUnarchiver.unarchivedObject(ofClass: ARWorldMap.self, from: saved.worldMap),
              let a = map.anchors.first(where: { $0.identifier == saved.anchorID && $0.name == "design" }),
              let design else { throw MapError.invalid }
        unplace(); clearPins()
        let h = AnchorEntity(anchor: a)
        design.removeFromParent(); h.addChild(design)
        h.isEnabled = false // Only reappear after ARKit recognizes this saved coordinate frame.
        view.scene.addAnchor(h)
        holder = h; anchor = a
        canSaveMap = false
        resumeGate.begin(anchorID: a.identifier, after: view.session.currentFrame?.timestamp ?? -.infinity)
        trackingNote = "Finding your saved position…"
        view.session.run(configuration(map: map), options: [.resetTracking, .removeExistingAnchors])
    }

    func resetTracking() {
        unplace(); clearPins(); canSaveMap = false
        view.session.run(configuration(), options: [.resetTracking, .removeExistingAnchors])
    }

    func setOcclusion(_ on: Bool) {
        guard hasLiDAR else { return }
        if on { view.environment.sceneUnderstanding.options.insert(.occlusion) }
        else { view.environment.sceneUnderstanding.options.remove(.occlusion) }
    }

    /// The real ground under the dot in the middle of the screen, or nil if there is none yet.
    func groundUnderDot() -> SIMD3<Float>? {
        let c = CGPoint(x: view.bounds.midX, y: view.bounds.midY)
        guard let hit = view.raycast(from: c, allowing: .estimatedPlane, alignment: .any).first else { return nil }
        let t = hit.worldTransform.columns.3
        return SIMD3(t.x, t.y, t.z)
    }

    /// Which way the phone faces, in world: the ray through the middle of the screen, and
    /// the way the TOP of the screen points. Taken from rays through the screen rather than
    /// the camera's own axes, which are in the sensor's landscape frame whatever way it is held.
    func cameraAxes() -> (look: SIMD3<Float>, up: SIMD3<Float>)? {
        let b = view.bounds
        guard let mid = view.ray(through: CGPoint(x: b.midX, y: b.midY)),
              let top = view.ray(through: CGPoint(x: b.midX, y: b.minY + b.height * 0.1)) else { return nil }
        let up = top.direction - mid.direction
        guard simd_length(up) > 1e-6 else { return nil }
        return (mid.direction, simd_normalize(up))
    }

    /// A small flag where he marked, so he can see what the design was lined up on.
    func pin(at p: SIMD3<Float>, colour: UIColor) {
        let a = AnchorEntity(world: p)
        let paint = SimpleMaterial(color: colour, isMetallic: false)
        let post = ModelEntity(mesh: .generateCylinder(height: 0.5, radius: 0.012), materials: [paint])
        post.position.y = 0.25
        let head = ModelEntity(mesh: .generateSphere(radius: 0.04), materials: [paint])
        head.position.y = 0.52
        let foot = ModelEntity(mesh: .generateCylinder(height: 0.004, radius: 0.08), materials: [paint])
        a.addChild(post); a.addChild(head); a.addChild(foot)
        DesignScene.castNoShadows(a)
        view.scene.addAnchor(a)
        pins.append(a)
    }

    func clearPins() {
        pins.forEach { view.scene.removeAnchor($0) }
        pins.removeAll()
    }

    func load(_ url: URL, plants: [PlantItem]) async throws {
        let e = try await DesignScene.load(url)
        if let holder { holder.children.removeAll() }
        design = e
        items = plants
        plantDisplay = PlantDisplay(root: e, plants: plants)
        let guide = PlantingGuide(plants: plants)
        e.addChild(guide.root)
        plantingGuide = guide
        // the guide's labels face the camera: one buffer write a frame, not an entity each
        if frameUpdates == nil {
            frameUpdates = view.scene.subscribe(to: SceneEvents.Update.self) { [weak self] _ in
                guard let self else { return }
                self.plantingGuide?.face(camera: self.view.cameraTransform.matrix)
            }
        }
    }

    func setScanSource(_ url: URL) {
        scanGeneration += 1
        scanRelease?.cancel(); scanRelease = nil
        scanTask?.cancel(); scanTask = nil
        scanOverlay?.removeFromParent(); scanOverlay = nil
        scanSource = url; scanLoading = false; scanError = nil
    }

    func showOriginalScan(_ visible: Bool, opacity: Float) {
        scanVisible = visible; scanOpacity = opacity
        guard visible else {
            if let scanOverlay { ScanOverlay.update(scanOverlay, visible: false, opacity: opacity) }
            // Hidden, it still holds its texture and mesh (about 240 MB, and a load peaks far
            // higher; measured, CA1). Free it once it has stayed hidden, so switching it off
            // and on to compare does not load it again each time.
            guard scanOverlay != nil || scanTask != nil, scanRelease == nil else { return }
            scanRelease = Task { [weak self] in
                try? await Task.sleep(for: Self.overlayRelease)
                guard let self, !Task.isCancelled, !self.scanVisible else { return }
                self.scanRelease = nil
                self.scanGeneration += 1
                self.scanTask?.cancel(); self.scanTask = nil
                self.scanOverlay?.removeFromParent(); self.scanOverlay = nil
                self.scanLoading = false
                MemoryLog.shared.note("original scan overlay released")
            }
            return
        }
        scanRelease?.cancel(); scanRelease = nil
        if let scanOverlay {
            ScanOverlay.update(scanOverlay, visible: visible, opacity: opacity)
            return
        }
        guard scanTask == nil, let source = scanSource, let parent = design else { return }
        let generation = scanGeneration
        scanLoading = true; scanError = nil
        scanTask = Task { [weak self] in
            do {
                let overlay = try await ScanOverlay.load(source)
                try Task.checkCancellation()
                guard let self, self.scanGeneration == generation else { return }
                parent.addChild(overlay)
                self.scanOverlay = overlay
                ScanOverlay.update(overlay, visible: self.scanVisible, opacity: self.scanOpacity)
            } catch {
                guard let self, self.scanGeneration == generation, !Task.isCancelled else { return }
                self.scanError = "The scan overlay could not load. Turn it off and on to try again."
            }
            guard let self, self.scanGeneration == generation else { return }
            self.scanLoading = false; self.scanTask = nil
        }
    }

    /// A measuring tool, not a film (CA1): no motion blur, depth of field, film grain or grounding
    /// shadows. Each is extra drawing over the whole screen every frame, and none helps put a
    /// plant where the cross is.
    func applyRenderBudget() {
        view.renderOptions.formUnion([.disableMotionBlur, .disableDepthOfField, .disableCameraGrain, .disableGroundingShadows])
    }

    /// iOS is short of memory: free what is loaded but not on screen, now (CA1).
    func relieveMemory() {
        guard !scanVisible, scanOverlay != nil || scanTask != nil else { return }
        scanRelease?.cancel(); scanRelease = nil
        scanGeneration += 1
        scanTask?.cancel(); scanTask = nil
        scanOverlay?.removeFromParent(); scanOverlay = nil
        scanLoading = false
        MemoryLog.shared.note("original scan overlay released for memory")
    }

    /// Stand the design in the world where the two marks say it goes.
    func place(_ fit: Alignment) {
        guard let design else { return }
        if let holder { view.scene.removeAnchor(holder) }
        if let anchor { view.session.remove(anchor: anchor) }
        let a = ARAnchor(name: "design", transform: fit.matrix)
        view.session.add(anchor: a)
        let h = AnchorEntity(anchor: a)
        design.removeFromParent()
        h.addChild(design)
        view.scene.addAnchor(h)
        anchor = a
        holder = h
    }

    func unplace() {
        resumeGate.cancel()
        if let holder { view.scene.removeAnchor(holder) }
        if let anchor { view.session.remove(anchor: anchor) }
        holder = nil
        anchor = nil
    }

    /// "planting", "design" (beds, paths, walls, objects) or "ar_landmark" — the groups the
    /// exporter names (viewer/src/ar_cards.js).
    func show(_ group: String, _ on: Bool) {
        design?.findEntity(named: group)?.isEnabled = on
    }

    func showPlants(models: Bool, guide: Bool, hidden: Set<String>, selected: String?) {
        plantDisplay?.update(models: models, guide: guide, hidden: hidden, selected: selected)
    }

    func showGuide(_ on: Bool, hidden: Set<String>, selected: String?) {
        plantingGuide?.update(on: on, hidden: hidden, selected: selected)
        pins.forEach { $0.isEnabled = !on }
    }

    #if DEBUG
    /// The height of the lowest horizontal plane ARKit has found (a room's floor), for probes.
    func lowestHorizontalPlane() -> Float? {
        view.session.currentFrame?.anchors.compactMap { $0 as? ARPlaneAnchor }
            .filter { $0.alignment == .horizontal }.map { $0.transform.columns.3.y }.min()
    }
    #endif

    /// What ARKit holds, for the memory log: reconstructed mesh, lighting probes, planes.
    func arSummary() -> String {
        guard let frame = view.session.currentFrame else { return "ar=none" }
        var meshes = 0, vertices = 0, probes = 0, planes = 0
        for anchor in frame.anchors {
            if let mesh = anchor as? ARMeshAnchor { meshes += 1; vertices += mesh.geometry.vertices.count }
            else if anchor is AREnvironmentProbeAnchor { probes += 1 }
            else if anchor is ARPlaneAnchor { planes += 1 }
        }
        return "meshes=\(meshes);vertices=\(vertices);probes=\(probes);planes=\(planes);mapping=\(frame.worldMappingStatus.rawValue)"
    }

    @objc private func selectPlant(_ gesture: UITapGestureRecognizer) {
        guard let design, let holder, holder.isActive else { return }
        let tapped = gesture.location(in: view)
        let candidates = items.compactMap { plant -> (String, CGFloat)? in
            guard plantingGuide?.isTargetShown(plant.id) == true, let point = plant.point else { return nil }
            if plantingGuide?.root.isEnabled != true {
                guard design.findEntity(named: "planting")?.isEnabled == true,
                      design.findEntity(named: plant.node)?.isEnabled == true else { return nil }
            }
            let world = design.convert(position: point, to: nil)
            let inCamera = simd_inverse(view.cameraTransform.matrix) * SIMD4(world, 1)
            guard inCamera.z < 0 else { return nil }
            guard let screen = view.project(world) else { return nil }
            let distance = hypot(screen.x-tapped.x, screen.y-tapped.y)
            return distance <= 36 ? (plant.id, distance) : nil
        }
        if let hit = candidates.min(by: { $0.1 < $1.1 }) { selectedPlant?(hit.0) }
    }

    #if DEBUG
    private var previewCamera: PerspectiveCamera?
    /// The same native guide over the real capture, only for simulator visual inspection.
    func preview(scan url: URL, focus: SIMD3<Float>) async throws {
        let capture = try await Entity(contentsOf: url)
        let anchor = AnchorEntity(world: .zero)
        anchor.addChild(capture)
        if let design { anchor.addChild(design) }
        let camera = PerspectiveCamera()
        camera.camera.fieldOfViewInDegrees = 55
        anchor.addChild(camera)
        view.scene.addAnchor(anchor)
        holder = anchor
        trackingNote = nil
        previewCamera = camera
        previewFocus(focus)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(selectPlant(_:))))
    }
    func previewFocus(_ point: SIMD3<Float>) {
        previewCamera?.look(at: point, from: point + SIMD3(0, 3.5, 4), relativeTo: nil)
    }
    /// `-previewWide`: a high view over the whole planting, for store screenshots.
    func previewFrame(_ points: [SIMD3<Float>]) {
        guard !points.isEmpty, let camera = previewCamera else { return }
        let centre = points.reduce(SIMD3<Float>(0, 0, 0), +) / Float(points.count)
        let reach = max(points.map { simd_distance($0, centre) }.max() ?? 1, 2)
        camera.look(at: centre, from: centre + SIMD3(0, reach * 2.4, reach * 2.6), relativeTo: nil)
    }
    func hidePreviewDesign() { design?.isEnabled = false }
    func plantIsEnabled(_ plant: PlantItem) -> Bool? { design?.findEntity(named: plant.node)?.isEnabled }
    #endif

    nonisolated func sessionShouldAttemptRelocalization(_ session: ARSession) -> Bool { true }

    nonisolated func session(_ session: ARSession, didUpdate frame: ARFrame) {
        let normal: Bool
        if case .normal = frame.camera.trackingState { normal = true } else { normal = false }
        let mapped = frame.worldMappingStatus == .mapped || frame.worldMappingStatus == .extending
        let ids = Set(frame.anchors.map(\.identifier)), timestamp = frame.timestamp
        Task { @MainActor in
            if self.resumeGate.observe(timestamp: timestamp, normal: normal, anchors: ids) {
                self.holder?.isEnabled = true
                self.resumed?()
            }
            let ready = normal && mapped && self.anchor.map { ids.contains($0.identifier) } == true
            let becameReady = ready && !self.canSaveMap
            if self.canSaveMap != ready { self.canSaveMap = ready }
            if ready && (becameReady || timestamp - self.lastMapSignal > 30) {
                self.lastMapSignal = timestamp
                self.mapBecameReady?()
            }
        }
    }

    nonisolated func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
        let note: String?
        switch camera.trackingState {
        case .normal: note = nil
        case .notAvailable: note = "Tracking is not available"
        case .limited(.excessiveMotion): note = "Slow down — the phone is moving too fast"
        case .limited(.insufficientFeatures): note = "Too little detail here — aim at textured ground"
        case .limited(.relocalizing): note = "Finding its place again…"
        case .limited: note = "Move the phone slowly to find the ground"
        }
        Task { @MainActor in self.trackingNote = note }
    }
}

struct ARGardenView: UIViewRepresentable {
    let garden: ARGarden
    func makeUIView(context: Context) -> ARView { garden.view }
    func updateUIView(_ uiView: ARView, context: Context) {}
}
