// Run this against a real exported yard.json and its scan. The viewer's measured
// bounds are the reference, not a second native loader making the same mistake.
import Foundation
import SceneKit
@main struct ScanFrameCheck {
    static func main() throws {
        let metaURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: metaURL)) as! [String: Any]
        let scan = metadata["scan"] as! [String: Any]
        let scene = try OriginalScan.load(metaURL.deletingLastPathComponent().appendingPathComponent(scan["file"] as! String))
        var lo = SIMD3<Float>(repeating: .infinity), hi = SIMD3<Float>(repeating: -.infinity)
        scene.rootNode.enumerateChildNodes { node, _ in
            guard node.geometry != nil else { return }
            let (a,b) = node.boundingBox
            for x in [a.x,b.x] { for y in [a.y,b.y] { for z in [a.z,b.z] {
                let p = node.convertPosition(SCNVector3(x,y,z), to: nil)
                let v = SIMD3<Float>(Float(p.x), Float(p.y), Float(p.z))
                lo = simd_min(lo,v); hi = simd_max(hi,v)
            } } }
        }
        let bounds = scan["bounds"] as! [String: [Double]]
        for (key, actual) in [("min",lo),("max",hi)] {
            let expected = bounds[key]!
            for i in 0..<3 { precondition(abs(Double(actual[i])-expected[i]) < 0.002, "Native \(key) axis \(i) differs: \(actual[i]) vs \(expected[i])") }
        }
        print("PASS: original scan's native frame matches the viewer within 2 mm", lo, hi)
    }
}
