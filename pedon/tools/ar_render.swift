// SEE THE AR FILE THE WAY THE PHONE WILL, WITHOUT A PHONE.
//
// The native PEDON app draws with RealityKit, which also runs on a Mac. Render an
// exported USDZ offscreen to check its geometry and materials without a phone.
// For interactive UI checks use the app's Simulator preview (ios/README.md).
//
// Coordinates are RealityKit's: metres, Y up, and the AR file's origin is its "start here"
// landmark on the ground. So an eye at (x, 1.6, z) is a person standing there.
//
//   swiftc -O -parse-as-library tools/ar_render.swift -o /tmp/ar_render
//   /tmp/ar_render data/ar/yard.usdz /tmp/look.png  -1.5 1.6 3.5   5.3 -0.8 0.5   60
//                  file              out            eye x y z      look-at x y z  fov
import Foundation
import RealityKit
import Metal
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let a = CommandLine.arguments
let url = URL(fileURLWithPath: a[1]), out = URL(fileURLWithPath: a[2])
let f = a[3...].compactMap { Float($0) }
let eye = SIMD3<Float>(f[0], f[1], f[2]), at = SIMD3<Float>(f[3], f[4], f[5])
let fov = f.count > 6 ? f[6] : 60
let W = 1100, H = 800

@MainActor func run() async throws {
  let entity = try await Entity(contentsOf: url)
  let b = entity.visualBounds(relativeTo: nil)
  print("RK bounds min \(b.min) max \(b.max) extents \(b.extents)")
  let renderer = try RealityRenderer()
  let anchor = Entity()
  anchor.addChild(entity)
  let sun = DirectionalLight()
  sun.light.intensity = 3000
  sun.look(at: .zero, from: [3, 8, 5], relativeTo: nil)
  anchor.addChild(sun)
  let cam = PerspectiveCamera()
  cam.camera.fieldOfViewInDegrees = fov
  cam.camera.near = 0.05; cam.camera.far = 500
  cam.look(at: at, from: eye, relativeTo: nil)
  anchor.addChild(cam)
  renderer.entities.append(anchor)
  renderer.activeCamera = cam
  // a plain mid-grey sky, so what is drawn and what is not is never a matter of luck
  renderer.cameraSettings.colorBackground = .color(CGColor(gray: 0.42, alpha: 1))
  let device = MTLCreateSystemDefaultDevice()!
  let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm_srgb, width: W, height: H, mipmapped: false)
  d.usage = [.renderTarget, .shaderRead]; d.storageMode = .shared
  let tex = device.makeTexture(descriptor: d)!
  for _ in 0..<3 {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      do {
        try renderer.updateAndRender(deltaTime: 1.0 / 30,
          cameraOutput: .init(.singleProjection(colorTexture: tex)),
          onComplete: { _ in c.resume() })
      } catch { c.resume(throwing: error) }
    }
  }
  var bytes = [UInt8](repeating: 0, count: W * H * 4)
  tex.getBytes(&bytes, bytesPerRow: W * 4, from: MTLRegionMake2D(0, 0, W, H), mipmapLevel: 0)
  let cs = CGColorSpace(name: CGColorSpace.sRGB)!
  let ctx = CGContext(data: &bytes, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs,
                      bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
  let img = ctx.makeImage()!
  let dst = CGImageDestinationCreateWithURL(out as CFURL, UTType.png.identifier as CFString, 1, nil)!
  CGImageDestinationAddImage(dst, img, nil)
  CGImageDestinationFinalize(dst)
  print("wrote \(out.path)")
}

@main struct Main {
  static func main() async {
    do { try await run() } catch { print("ERROR \(error)") }
  }
}
