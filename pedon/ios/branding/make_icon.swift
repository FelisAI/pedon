// Original PEDON vector artwork: a sprout over a measured volume of soil.
// No fonts, stock artwork or user-site assets. Render with macOS's Core Graphics:
// swift ios/branding/make_icon.swift /path/to/AppIcon.png
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

guard CommandLine.arguments.count == 2 else { fatalError("Pass the output PNG path") }
let rgb = CGColorSpaceCreateDeviceRGB()
let context = CGContext(data: nil, width: 1024, height: 1024, bitsPerComponent: 8,
                        bytesPerRow: 1024 * 4, space: rgb,
                        bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
context.setAllowsAntialiasing(true)
func color(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGColor {
    CGColor(colorSpace: rgb, components: [r / 255, g / 255, b / 255, 1])!
}
let background = color(19, 39, 31), soil = color(43, 69, 51)
let cream = color(234, 239, 205), amber = color(226, 168, 86)
context.setFillColor(background)
context.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))

func line(_ points: [CGPoint], color: CGColor, width: CGFloat, closed: Bool = false) {
    context.beginPath(); context.move(to: points[0])
    points.dropFirst().forEach { context.addLine(to: $0) }
    if closed { context.closePath() }
    context.setStrokeColor(color); context.setLineWidth(width)
    context.setLineJoin(.round); context.setLineCap(.round); context.strokePath()
}
let top = [CGPoint(x: 240, y: 420), CGPoint(x: 512, y: 566),
           CGPoint(x: 784, y: 420), CGPoint(x: 512, y: 274)]
context.beginPath(); context.move(to: top[0]); top.dropFirst().forEach { context.addLine(to: $0) }
context.closePath(); context.setFillColor(soil); context.fillPath()
line(top, color: amber, width: 22, closed: true)
line([CGPoint(x: 240, y: 354), CGPoint(x: 512, y: 208), CGPoint(x: 784, y: 354)], color: amber, width: 22)

// The stem lands at the center of the soil plane, as the planting guide's targets do.
let stem = CGMutablePath()
stem.move(to: CGPoint(x: 512, y: 418))
stem.addCurve(to: CGPoint(x: 531, y: 710), control1: CGPoint(x: 493, y: 525), control2: CGPoint(x: 500, y: 628))
context.addPath(stem); context.setStrokeColor(cream); context.setLineWidth(34)
context.setLineCap(.round); context.strokePath()

let right = CGMutablePath()
right.move(to: CGPoint(x: 516, y: 608))
right.addCurve(to: CGPoint(x: 763, y: 795), control1: CGPoint(x: 504, y: 739), control2: CGPoint(x: 647, y: 804))
right.addCurve(to: CGPoint(x: 516, y: 608), control1: CGPoint(x: 779, y: 672), control2: CGPoint(x: 674, y: 573))
right.closeSubpath(); context.addPath(right); context.setFillColor(cream); context.fillPath()
let left = CGMutablePath()
left.move(to: CGPoint(x: 506, y: 675))
left.addCurve(to: CGPoint(x: 287, y: 811), control1: CGPoint(x: 391, y: 650), control2: CGPoint(x: 295, y: 708))
left.addCurve(to: CGPoint(x: 506, y: 675), control1: CGPoint(x: 406, y: 836), control2: CGPoint(x: 505, y: 790))
left.closeSubpath(); context.addPath(left); context.fillPath()

let output = URL(fileURLWithPath: CommandLine.arguments[1])
try FileManager.default.createDirectory(at: output.deletingLastPathComponent(), withIntermediateDirectories: true)
let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil)!
CGImageDestinationAddImage(destination, context.makeImage()!, nil)
guard CGImageDestinationFinalize(destination) else { fatalError("Could not write icon") }
