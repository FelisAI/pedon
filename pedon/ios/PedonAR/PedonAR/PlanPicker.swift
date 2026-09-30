// Pick real surface points on the ORIGINAL capture, in the exported design's frame.
import SwiftUI
import SceneKit

struct ScanPicker: UIViewRepresentable {
    let scene: SCNScene
    let first: PickPoint?
    let second: PickPoint?
    let picked: (PickPoint, UIImage) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> SCNView {
        let view = ScanView()
        let scene = OriginalScan.pickerScene(scene)
        view.scene = scene
        context.coordinator.view = view
        view.delegate = context.coordinator
        view.accessibilityIdentifier = "original-scan"
        view.backgroundColor = UIColor(white: 0.08, alpha: 1)
        view.allowsCameraControl = true
        view.autoenablesDefaultLighting = true
        view.antialiasingMode = .multisampling4X
        // Fit the capture in perspective. This changes only the camera, never its coordinates.
        let (lo, hi) = scene.rootNode.boundingBox
        let centre = SCNVector3((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, (lo.z + hi.z) / 2)
        let span = max(hi.x - lo.x, hi.z - lo.z, 2)
        let eye = SCNNode()
        eye.camera = SCNCamera()
        eye.camera?.zFar = Double(span * 20)
        eye.position = SCNVector3(centre.x, centre.y + span, centre.z + span * 0.65)
        eye.look(at: centre)
        scene.rootNode.addChildNode(eye)
        view.pointOfView = eye
        view.defaultCameraController.target = centre
        view.defaultCameraController.interactionMode = .orbitTurntable
        view.fitWhenSized = { [weak view, weak eye] in
            guard let view, let eye else { return }
            // Fit the entire capture even in a narrow portrait viewport. The source bounds
            // were measured before camera or badges were inserted.
            let radius = max(simd_length(SIMD3(hi.x-lo.x, hi.y-lo.y, hi.z-lo.z)) / 2, 1)
            let halfFOV = Float((eye.camera?.fieldOfView ?? 60) * .pi / 360)
            let aspect = Float(view.bounds.width / max(view.bounds.height, 1))
            let halfAngle = min(halfFOV, atan(tan(halfFOV) * aspect))
            let distance = radius / sin(halfAngle) * 1.08
            let direction = simd_normalize(SIMD3<Float>(0, 1, 0.65)) * distance
            eye.position = SCNVector3(centre.x + direction.x, centre.y + direction.y, centre.z + direction.z)
            eye.look(at: centre)
            view.defaultCameraController.stopInertia()
            view.defaultCameraController.pointOfView = eye
            view.defaultCameraController.target = centre
        }
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        view.addGestureRecognizer(tap)
        return view
    }
    func updateUIView(_ view: SCNView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.viewHeight = max(1, view.bounds.height)
        context.coordinator.drawPins(in: view)
    }
    static func dismantleUIView(_ view: SCNView, coordinator: Coordinator) {
        view.delegate = nil
        view.isPlaying = false
        view.defaultCameraController.stopInertia()
        view.scene = nil
        coordinator.view = nil
    }

    final class Coordinator: NSObject, SCNSceneRendererDelegate {
        weak var view: SCNView?
        var viewHeight: CGFloat = 1
        var parent: ScanPicker
        init(_ parent: ScanPicker) { self.parent = parent }
        func drawPins(in view: SCNView, extra: PickPoint? = nil) {
            guard let root = view.scene?.rootNode else { return }
            root.childNodes.filter { $0.name == "pick-pin" }.forEach { $0.removeFromParentNode() }
            let picks = extra.map { p in parent.first == nil || parent.second != nil ? [p] : [parent.first!, p] }
                ?? [parent.first, parent.second].compactMap { $0 }
            for (i, p) in picks.enumerated() {
                let badge = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { _ in
                    (i == 0 ? UIColor.systemRed : UIColor.systemOrange).setFill()
                    UIBezierPath(ovalIn: CGRect(x: 2, y: 2, width: 60, height: 60)).fill()
                    UIColor.white.setStroke()
                    let ring = UIBezierPath(ovalIn: CGRect(x: 2, y: 2, width: 60, height: 60))
                    ring.lineWidth = 3; ring.stroke()
                    let text = "\(i + 1)" as NSString
                    let attributes: [NSAttributedString.Key: Any] = [.font: UIFont.boldSystemFont(ofSize: 38), .foregroundColor: UIColor.white]
                    let size = text.size(withAttributes: attributes)
                    text.draw(at: CGPoint(x: (64-size.width)/2, y: (64-size.height)/2), withAttributes: attributes)
                }
                let plane = SCNPlane(width: 1, height: 1)
                plane.firstMaterial?.diffuse.contents = badge
                plane.firstMaterial?.lightingModel = .constant
                plane.firstMaterial?.readsFromDepthBuffer = false
                plane.firstMaterial?.writesToDepthBuffer = false
                plane.firstMaterial?.isDoubleSided = true
                let node = SCNNode(geometry: plane)
                node.constraints = [SCNBillboardConstraint()]
                node.name = "pick-pin"
                node.categoryBitMask = 2 // never hit the marker instead of the measured surface
                node.renderingOrder = 100
                node.position = SCNVector3(p.x, p.y ?? 0, p.z)
                root.addChildNode(node)
            }
            viewHeight = max(1, view.bounds.height)
            sizePins()
        }
        func renderer(_ renderer: SCNSceneRenderer, updateAtTime time: TimeInterval) { sizePins() }
        private func sizePins() {
            guard let view, let camera = view.pointOfView else { return }
            let angle = Float((camera.camera?.fieldOfView ?? 60) * .pi / 360)
            for node in view.scene?.rootNode.childNodes ?? [] where node.name == "pick-pin" {
                let depth = abs(camera.convertPosition(node.position, from: nil).z)
                let width = 2 * depth * tan(angle) * 28 / Float(viewHeight)
                node.scale = SCNVector3(width, width, width)
            }
        }
        @objc func tap(_ gesture: UITapGestureRecognizer) {
            guard let view = gesture.view as? SCNView,
                  let hit = view.hitTest(gesture.location(in: view), options: [.categoryBitMask: 1, .ignoreHiddenNodes: true]).first else { return }
            let v = hit.worldCoordinates
            let number = parent.first == nil || parent.second != nil ? 1 : 2
            let point = PickPoint(x: v.x, z: v.z, label: "point \(number) on the scan", y: v.y)
            drawPins(in: view, extra: point)
            parent.picked(point, view.snapshot())
        }
    }
}

/// Fit after SwiftUI supplies a real viewport, not while makeUIView still has zero bounds.
private final class ScanView: SCNView {
    var fitWhenSized: (() -> Void)?
    override func layoutSubviews() {
        super.layoutSubviews()
        if bounds.width > 0 && bounds.height > 0, let fit = fitWhenSized {
            fitWhenSized = nil
            fit()
        }
    }
}
