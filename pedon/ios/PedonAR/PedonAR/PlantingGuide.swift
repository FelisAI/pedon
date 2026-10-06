import RealityKit
import UIKit

/// Small targets at the measured stem centres. No plant crowns or hole-size claims.
///
/// DRAWN AS A FIXED HANDFUL OF OBJECTS, whatever the number of plants (CA1). It used to be four
/// entities per plant — two crosses, a label mesh of its own and its backing plane, each label
/// turned to the camera every frame — 616 entities and 308 meshes for a 154-plant bed. Looking
/// across the bed in AR with many of them on screen ran the phone out of memory; a corner with
/// few did not. Now every visible cross is one mesh, every label one mesh cut from one picture of
/// all the plant IDs, and the selected target one more: four entities for any bed.
@MainActor
final class PlantingGuide {
    let root = Entity()
    /// Each plant's stem centre, in the design's frame.
    private(set) var points: [String: SIMD3<Float>] = [:]
    private var order: [String] = []                       // plants in atlas order
    private var hidden: Set<String> = []
    private var selected: String?
    private let crosses = ModelEntity()
    private let highlight: ModelEntity
    private let labels: ModelEntity
    private let labelMesh: LowLevelMesh?
    private var labelCount = 0
    private var facing: simd_float4x4?                     // the camera the labels last faced

    static let labelWidth: Float = 0.18, labelHeight: Float = 0.0675, labelLift: Float = 0.16
    private static let cell = CGSize(width: 128, height: 48), columns = 16

    init(plants: [PlantItem]) {
        root.name = "planting-guide"
        for plant in plants {
            guard let at = plant.point, points[plant.id] == nil else { continue }
            points[plant.id] = at; order.append(plant.id)
        }
        let cross = Self.crossGeometry()
        highlight = ModelEntity(mesh: (try? MeshResource.generate(from: [Self.descriptor(cross, at: [.zero], lift: 0.014)]))
                                ?? .generatePlane(width: 0.2, depth: 0.2),
                                materials: [UnlitMaterial(color: .systemYellow)])
        highlight.name = "guide-selected"
        crosses.name = "guide-crosses"
        labelMesh = Self.makeLabelMesh(capacity: order.count)
        labels = ModelEntity()
        labels.name = "guide-labels"
        if let labelMesh, let resource = try? MeshResource(from: labelMesh),
           let atlas = Self.atlas(order) {
            var material = UnlitMaterial()
            material.color = .init(tint: .white, texture: .init(atlas))
            material.faceCulling = .none
            labels.model = ModelComponent(mesh: resource, materials: [material])
        }
        root.addChild(crosses); root.addChild(labels); root.addChild(highlight)
        rebuildCrosses()
        root.isEnabled = false
    }

    /// Hidden plants have no target; the selected one is yellow. Geometry is rebuilt only when
    /// either changes, not on every switch of the screen's other controls.
    func update(on: Bool, hidden: Set<String>, selected: String?) {
        root.isEnabled = on
        let hidden = hidden.intersection(points.keys)
        guard hidden != self.hidden || selected != self.selected else { return }
        self.hidden = hidden; self.selected = selected
        rebuildCrosses()
        facing = nil                                        // relay the labels on the next frame
    }

    /// Whether this plant's target is drawn when the guide is on (not hidden).
    func isTargetShown(_ id: String) -> Bool { points[id] != nil && !hidden.contains(id) }

    /// Turn every label to face the camera (world transform), as one buffer write. Called each
    /// frame; it only rewrites the labels when the camera has moved or turned.
    func face(camera: simd_float4x4) {
        guard root.isEnabled, let labelMesh else { return }
        if let last = facing, Self.near(last, camera) { return }
        facing = camera
        // the camera's right and up, in the guide's own frame: labels lie in the screen's plane
        let toLocal = root.transformMatrix(relativeTo: nil).inverse
        func local(_ v: SIMD4<Float>) -> SIMD3<Float> { let l = toLocal * v; return simd_normalize(SIMD3(l.x, l.y, l.z)) }
        let right = local(camera.columns.0) * (Self.labelWidth / 2)
        let up = local(camera.columns.1) * (Self.labelHeight / 2)
        let visible = order.enumerated().filter { !hidden.contains($0.element) }
        labelMesh.withUnsafeMutableBytes(bufferIndex: 0) { raw in
            let v = raw.bindMemory(to: LabelVertex.self)
            for (slot, (index, id)) in visible.enumerated() {
                let c = points[id]! + SIMD3(0, Self.labelLift, 0)
                let uv = cellUV(index)
                v[slot * 4 + 0] = LabelVertex(position: c - right - up, uv: SIMD2(uv.u0, uv.bottom))
                v[slot * 4 + 1] = LabelVertex(position: c + right - up, uv: SIMD2(uv.u1, uv.bottom))
                v[slot * 4 + 2] = LabelVertex(position: c + right + up, uv: SIMD2(uv.u1, uv.top))
                v[slot * 4 + 3] = LabelVertex(position: c - right + up, uv: SIMD2(uv.u0, uv.top))
            }
        }
        if visible.count != labelCount {
            labelCount = visible.count
            let reach = Self.labelWidth + Self.labelLift
            let all = visible.map { points[$0.element]! }
            let lo = all.reduce(SIMD3<Float>(repeating: .greatestFiniteMagnitude)) { simd_min($0, $1) } - reach
            let hi = all.reduce(SIMD3<Float>(repeating: -.greatestFiniteMagnitude)) { simd_max($0, $1) } + reach
            labelMesh.parts.replaceAll(visible.isEmpty ? [] : [LowLevelMesh.Part(indexCount: visible.count * 6, topology: .triangle,
                                                                                 bounds: BoundingBox(min: lo, max: hi))])
        }
    }

    /// The entities that draw the guide: a fixed number, whatever the number of plants.
    var drawnEntities: Int { root.children.count }
    /// Crosses in the one crosses mesh (each target is an outline and a cross).
    var drawnCrosses: Int {
        guard let mesh = crosses.model?.mesh else { return 0 }
        // triangles, not vertices: building a mesh welds the vertices copies share
        let indices = mesh.contents.models.reduce(0) { $0 + $1.parts.reduce(0) { $0 + ($1.triangleIndices?.count ?? 0) } }
        return indices / (2 * Self.crossGeometry().indices.count)
    }
    /// Labels in the one labels mesh, once it has faced a camera.
    var drawnLabels: Int { (labelMesh?.parts.first?.indexCount ?? 0) / 6 }
    /// Where the selected target's highlight stands, in the guide's frame, when one is drawn.
    var highlighted: SIMD3<Float>? { highlight.isEnabled ? highlight.position : nil }

    // MARK: geometry

    private func rebuildCrosses() {
        let shown = order.filter { !hidden.contains($0) && $0 != selected }.map { points[$0]! }
        let cross = Self.crossGeometry()
        if shown.isEmpty {
            crosses.model = nil
        } else if let mesh = try? MeshResource.generate(from: [Self.descriptor(cross, at: shown, lift: 0.008, scale: 1.12, material: 0),
                                                                Self.descriptor(cross, at: shown, lift: 0.012, material: 1)]) {
            crosses.model = ModelComponent(mesh: mesh, materials: [UnlitMaterial(color: .black), UnlitMaterial(color: .systemCyan)])
        }
        if let id = selected, let at = points[id], !hidden.contains(id) {
            highlight.position = at; highlight.isEnabled = true
        } else {
            highlight.isEnabled = false
        }
    }

    private struct Geometry { var positions: [SIMD3<Float>]; var indices: [UInt32] }

    /// A cross and a broken ring, flat on the ground: the centre is easy to aim at without
    /// covering the soil.
    private static func crossGeometry() -> Geometry {
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
        for k in 0..<32 where k % 8 < 6 {
            let a = Float(k) * 2 * .pi / 32, b = Float(k+1) * 2 * .pi / 32
            let i = UInt32(positions.count)
            positions += [SIMD3(cos(a)*0.15,0,sin(a)*0.15), SIMD3(cos(b)*0.15,0,sin(b)*0.15),
                          SIMD3(cos(b)*0.14,0,sin(b)*0.14), SIMD3(cos(a)*0.14,0,sin(a)*0.14)]
            indices += [i,i+2,i+1,i,i+3,i+2]
        }
        return Geometry(positions: positions, indices: indices)
    }

    /// One copy of the cross at each point, as one mesh part.
    private static func descriptor(_ g: Geometry, at points: [SIMD3<Float>], lift: Float,
                                   scale: Float = 1, material: UInt32 = 0) -> MeshDescriptor {
        var positions: [SIMD3<Float>] = []; positions.reserveCapacity(points.count * g.positions.count)
        var indices: [UInt32] = []; indices.reserveCapacity(points.count * g.indices.count)
        for p in points {
            let base = UInt32(positions.count)
            positions += g.positions.map { p + SIMD3($0.x * scale, lift, $0.z * scale) }
            indices += g.indices.map { $0 + base }
        }
        var mesh = MeshDescriptor(name: "planting-centres")
        mesh.positions = MeshBuffers.Positions(positions)
        mesh.normals = MeshBuffers.Normals(Array(repeating: SIMD3<Float>(0, 1, 0), count: positions.count))
        mesh.primitives = .triangles(indices)
        mesh.materials = .allFaces(material)
        return mesh
    }

    // MARK: labels

    struct LabelVertex { var position: SIMD3<Float>; var uv: SIMD2<Float> }

    private static func makeLabelMesh(capacity: Int) -> LowLevelMesh? {
        guard capacity > 0 else { return nil }
        var d = LowLevelMesh.Descriptor()
        d.vertexAttributes = [
            .init(semantic: .position, format: .float3, offset: MemoryLayout<LabelVertex>.offset(of: \.position)!),
            .init(semantic: .uv0, format: .float2, offset: MemoryLayout<LabelVertex>.offset(of: \.uv)!)]
        d.vertexLayouts = [.init(bufferIndex: 0, bufferStride: MemoryLayout<LabelVertex>.stride)]
        d.vertexCapacity = capacity * 4
        d.indexCapacity = capacity * 6
        d.indexType = .uint32
        guard let mesh = try? LowLevelMesh(descriptor: d) else { return nil }
        mesh.withUnsafeMutableIndices { raw in
            let idx = raw.bindMemory(to: UInt32.self)
            for q in 0..<capacity {
                let b = UInt32(q * 4)
                for (k, i) in [b, b+1, b+2, b, b+2, b+3].enumerated() { idx[q * 6 + k] = i }
            }
        }
        return mesh
    }

    /// Every plant's ID, white on black, in one picture.
    private static func atlas(_ ids: [String]) -> TextureResource? {
        guard !ids.isEmpty else { return nil }
        let rows = (ids.count + columns - 1) / columns
        let size = CGSize(width: cell.width * CGFloat(columns), height: cell.height * CGFloat(rows))
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.black.setFill(); context.fill(CGRect(origin: .zero, size: size))
            let style = NSMutableParagraphStyle(); style.alignment = .center
            let font = UIFont.systemFont(ofSize: cell.height * 0.62, weight: .bold)
            let attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: UIColor.white, .paragraphStyle: style]
            for (i, id) in ids.enumerated() {
                let origin = CGPoint(x: CGFloat(i % columns) * cell.width, y: CGFloat(i / columns) * cell.height)
                let box = CGRect(x: origin.x, y: origin.y + (cell.height - font.lineHeight) / 2, width: cell.width, height: font.lineHeight)
                (id as NSString).draw(in: box, withAttributes: attributes)
            }
        }
        guard let cg = image.cgImage else { return nil }
        return try? TextureResource(image: cg, options: .init(semantic: .color, mipmapsMode: .allocateAndGenerateAll))
    }

    /// The atlas cell of the `index`th plant as texture coordinates (v runs up the picture),
    /// inset half a texel so neighbours never bleed in.
    private func cellUV(_ index: Int) -> (u0: Float, u1: Float, top: Float, bottom: Float) {
        let rows = (order.count + Self.columns - 1) / Self.columns
        let cw = Float(Self.cell.width), ch = Float(Self.cell.height)
        let w = cw * Float(Self.columns), h = ch * Float(rows)
        let x0 = Float(index % Self.columns) * cw, y0 = Float(index / Self.columns) * ch
        return ((x0 + 0.5) / w, (x0 + cw - 0.5) / w, 1 - (y0 + 0.5) / h, 1 - (y0 + ch - 0.5) / h)
    }

    private static func near(_ a: simd_float4x4, _ b: simd_float4x4) -> Bool {
        simd_distance(a.columns.3, b.columns.3) < 0.005 && simd_dot(a.columns.2, b.columns.2) > 0.99995
            && simd_dot(a.columns.0, b.columns.0) > 0.99995
    }
}
