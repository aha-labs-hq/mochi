import Foundation
import Vision
import CoreImage
import ImageIO

guard CommandLine.arguments.count == 3 else { fatalError("input image, output mask required") }
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let output = URL(fileURLWithPath: CommandLine.arguments[2])
let handler = VNImageRequestHandler(url: input)
let request = VNGenerateForegroundInstanceMaskRequest()
try handler.perform([request])
guard let result = request.results?.first, !result.allInstances.isEmpty else { fatalError("No foreground instance found") }
let buffer = try result.generateScaledMaskForImage(forInstances: result.allInstances, from: handler)
let context = CIContext()
let image = CIImage(cvPixelBuffer: buffer)
try context.writePNGRepresentation(of: image, to: output, format: .L8, colorSpace: CGColorSpaceCreateDeviceGray())
print("Foreground mask saved: \(output.lastPathComponent)")
