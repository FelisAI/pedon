import RealityKit
import UIKit

/// Small targets at the measured stem centres. No plant crowns or hole-size claims.
@MainActor
final class PlantingGuide {
    let root = Entity()
    private(set) var targets: [String: Entity] = [:]
    private var crosses: [String: ModelEntity] = [:]
    private let normal = UnlitMaterial(color: .systemCyan)
    private let selected = UnlitMaterial(color: .systemYellow)

    init(plants: [PlantItem]) {
        root.name = "planting-guide"
        let crossMesh = Self.crossMesh()
        let black = UnlitMaterial(color: .black)
        for plant in plants {
            guard let at = plant.point else { continue }
            let target = Entity()
            target.name = "guide-\(plant.id)"
            target.position = at
            let outline = ModelEntity(mesh: crossMesh, materials: [black])
            outline.scale = [1.12, 1, 1.12]
            outline.position.y = 0.008
            target.addChild(outline)
            let cross = ModelEntity(mesh: crossMesh, materials: [normal])
            cross.position.y = 0.012
            target.addChild(cross)
            crosses[plant.id] = cross

            let badge = Entity()
            let text = ModelEntity(mesh: .generateText(plant.id, extrusionDepth: 0.001,
                font: .systemFont(ofSize: 0.075, weight: .bold)), materials: [UnlitMaterial(color: .white)])
            let bounds = text.visualBounds(relativeTo: text)
            text.position = [-bounds.center.x, -bounds.center.y, 0.003]
            let background = ModelEntity(mesh: .generatePlane(width: max(bounds.extents.x + 0.04, 0.12),
                height: bounds.extents.y + 0.035), materials: [black])
            badge.addChild(background); badge.addChild(text)
            badge.position = [0, 0.16, 0]
            badge.components.set(BillboardComponent())
            target.addChild(badge)
            root.addChild(target)
            targets[plant.id] = target
        }
        root.isEnabled = false
    }

    func update(on: Bool, hidden: Set<String>, selected: String?) {
        root.isEnabled = on
        for (id, target) in targets {
            target.isEnabled = !hidden.contains(id)
            crosses[id]?.model?.materials = [id == selected ? self.selected : normal]
        }
    }

    private static func crossMesh() -> MeshResource {
        var positions: [SIMD3<Float>] = []
        var indices: [UInt32] = []
        func quad(_ x0: Float, _ z0: Float, _ x1: Float, _ z1: Float) {
            let i = UInt32(positions.count)
            positions += [[x0,0,z0],[x0,0,z1],[x1,0,z1],[x1,0,z0]]
            indices += [i,i+1,i+2,i,i+2,i+3]
        }
        quad(-0.12,-0.008,0.12,0.008)
        quad(-0.008,-0.12,0.008,-0.008)
        quad(-0.008,0.008,0.008,0.12)
        // A broken ring makes the centre easy to aim at without covering the soil.
        for k in 0..<32 where k % 8 < 6 {
            let a = Float(k) * 2 * .pi / 32, b = Float(k+1) * 2 * .pi / 32
            let i = UInt32(positions.count)
            positions += [SIMD3(cos(a)*0.15,0,sin(a)*0.15), SIMD3(cos(b)*0.15,0,sin(b)*0.15),
                          SIMD3(cos(b)*0.14,0,sin(b)*0.14), SIMD3(cos(a)*0.14,0,sin(a)*0.14)]
            indices += [i,i+2,i+1,i,i+3,i+2]
        }
        var mesh = MeshDescriptor(name: "planting-centre")
        mesh.positions = MeshBuffers.Positions(positions)
        mesh.normals = MeshBuffers.Normals(Array(repeating: SIMD3<Float>(0,1,0), count: positions.count))
        mesh.primitives = .triangles(indices)
        return try! MeshResource.generate(from: [mesh])
    }
}
