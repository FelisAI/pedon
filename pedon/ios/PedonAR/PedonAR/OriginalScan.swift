import SceneKit

/// Keep native surface picks in the same metre, Y-up frame as RealityKit's design.
enum OriginalScan {
    /// A picker owns its camera and badges. Never leave them in the cached capture:
    /// a disappearing view can resize its badges while the next view measures bounds.
    static func pickerScene(_ capture: SCNScene) -> SCNScene {
        let scene = SCNScene()
        scene.rootNode.addChildNode(capture.rootNode.clone())
        return scene
    }

    static func load(_ url: URL) throws -> SCNScene {
        let scene = try SCNScene(url: url, options: [.convertToYUp: true])
        scene.rootNode.enumerateChildNodes { node, _ in
            node.geometry?.materials.forEach { $0.lightingModel = .constant }
        }
        return scene
    }
}
