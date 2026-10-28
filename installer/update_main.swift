import Darwin
import Foundation

signal(SIGPIPE, SIG_IGN)
do {
  if CommandLine.arguments == [CommandLine.arguments[0], "--version"] {
    print("mochi-update 1")
  } else {
    try require(geteuid() == 0, .untrusted)
    try require(CommandLine.arguments.count <= 2)
    switch CommandLine.arguments.dropFirst().first {
    case nil: try serve()
    case "--handoff": try handoff()
    case "--repair": try prepareRepair()
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
