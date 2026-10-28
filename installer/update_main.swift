import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)
do {
  if CommandLine.arguments == [CommandLine.arguments[0], "--version"] {
    print("mochi-update 1")
  } else {
    try require(geteuid() == 0, .untrusted)
    let args = Array(CommandLine.arguments.dropFirst())
    if args.first == "--repair" {
      try require(args.count == 2)
      guard let uid = UInt32(args[1]) else { throw UpdateError.invalid }
      try prepareRepair(uid: uid)
      exit(0)
    }
    try require(args.count <= 1)
    switch CommandLine.arguments.dropFirst().first {
    case nil: try serve()
    case "--handoff": try handoff()
    case "--health": try health()
    case "--stop": try stopProcesses()
    case "--restored": try releaseHold(restored: true)
    case "--committed": try releaseHold(restored: false)
    case "--clean": try cleanStaging(locking: true)
    default: throw UpdateError.invalid
    }
  }
} catch {
  fputs("Mochi update: \((error as? UpdateError)?.rawValue ?? "unavailable")\n", stderr)
  exit(1)
}
