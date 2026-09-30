import Foundation
import SceneKit

@main struct ScanLifecycleCheck {
    static func main() throws {
        let metaURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let metadata = try JSONSerialization.jsonObject(with: Data(contentsOf: metaURL)) as! [String: Any]
        let info = metadata["scan"] as! [String: Any]
        let capture = try OriginalScan.load(metaURL.deletingLastPathComponent().appendingPathComponent(info["file"] as! String))
        let before = capture.rootNode.boundingBox
        let count = capture.rootNode.childNodes.count
        for _ in 0..<5 {
            let picker = OriginalScan.pickerScene(capture)
            let camera = SCNNode(); camera.camera = SCNCamera()
            camera.position = SCNVector3(1000, 1000, 1000)
            picker.rootNode.addChildNode(camera)
            let pin = SCNNode(geometry: SCNSphere(radius: 1000))
            pin.name = "pick-pin"
            picker.rootNode.addChildNode(pin)
            precondition(capture.rootNode.childNodes.count == count, "picker polluted the cached capture")
            let after = capture.rootNode.boundingBox
            precondition(before.min.x == after.min.x && before.max.x == after.max.x, "returning picker would fit to stale badges")
        }
        print("PASS: five picker lifetimes leave the original scan and its bounds untouched")
    }
}
