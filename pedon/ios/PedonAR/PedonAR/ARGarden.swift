// The camera, the real ground, and the design standing on it.
//
// World tracking with gravity as +Y, so the design never tilts; the real ground is found
// under the dot in the middle of the screen; the design is held by an ARAnchor, so ARKit
// keeps refining where it is as it learns the place. On a phone with LiDAR the real world
// hides what is behind it — a plant behind the real fence is behind the fence.
import ARKit
import RealityKit
import SwiftUI

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

    private var design: Entity?
    private var holder: AnchorEntity?
    private var anchor: ARAnchor?
    private var pins: [AnchorEntity] = []
    private var plantingGuide: PlantingGuide?
    private var plantDisplay: PlantDisplay?
    var selectedPlant: ((String) -> Void)?
    private var items: [PlantItem] = []

    func start() {
        let c = ARWorldTrackingConfiguration()
        c.planeDetection = [.horizontal]
        c.environmentTexturing = .automatic
        if hasLiDAR { c.sceneReconstruction = .mesh }
        view.session.delegate = self
        view.session.run(c)
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

    @objc private func selectPlant(_ gesture: UITapGestureRecognizer) {
        guard let design, let holder, holder.isActive else { return }
        let tapped = gesture.location(in: view)
        let candidates = items.compactMap { plant -> (String, CGFloat)? in
            guard let target = plantingGuide?.targets[plant.id], target.isEnabled,
                  let point = plant.point else { return nil }
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
    func plantIsEnabled(_ plant: PlantItem) -> Bool? { design?.findEntity(named: plant.node)?.isEnabled }
    #endif

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
