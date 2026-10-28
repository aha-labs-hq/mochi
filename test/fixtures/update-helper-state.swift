import CryptoKit
import Foundation
import SQLite3

let signingKey = Curve25519.Signing.PrivateKey()

// Compiles the production core with isolated paths. The production CLI and its
// root/peer guards have no test mode and are not part of this fixture binary.
enum UpdateConfiguration {
  static let root = CommandLine.arguments[1]
  static let workRoot = root
  static let transactionRoot = root + "/Transaction"
  static let application = root + "/Application"
  static let hold = root + "/hold"
  static let sudoers = root + "/sudoers"
  static let bridgeUserPattern = "^$"
  static let cacheSuffix = "/cache"
  static let publicKey = signingKey.publicKey.rawRepresentation.base64EncodedString()
  static let requirement = "never"
  static let bridgeRequirement = "identifier \"app.mochi.update-state-fixture\""
  static let team = "test"
  static let feedURL = "https://example.invalid/update"
  static let bridge: String = {
    let path = realpath(CommandLine.arguments[0], nil)!
    defer { free(path) }
    return String(cString: path)
  }()
  static let lark = root + "/lark"
  static let productVersion = "0.3.0"
  static let runtimeHome = root + "/runtime"
}
// The actual connected process answers stop and exits immediately. Identity is
// proven before the command, and the response PID must match that audit token.
let peerSocket = root + "/peer.sock"
if CommandLine.arguments.last == "socket-peer" {
  let listener = socket(AF_UNIX, SOCK_STREAM, 0)
  var address = sockaddr_un()
  address.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(peerSocket.utf8CString)
  precondition(bytes.count <= MemoryLayout.size(ofValue: address.sun_path))
  withUnsafeMutableBytes(of: &address.sun_path) {
    $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) })
  }
  let bound = withUnsafePointer(to: &address) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  precondition(bound == 0 && listen(listener, 1) == 0)
  let peer = accept(listener, nil, nil)
  let request = try JSONSerialization.jsonObject(with: readLine(peer)) as! [String: Any]
  let reply =
    try JSONSerialization.data(withJSONObject: [
      "ok": true, "pid": getpid() + (request["forged"] as? Bool == true ? 1 : 0),
    ]) + Data([10])
  reply.withUnsafeBytes { _ = write(peer, $0.baseAddress, $0.count) }
  close(peer)
  close(listener)
  exit(0)
}
// A timed-out shell must not leave its child capable of acting after recovery.
// In particular, a pending directory-service privacy prompt can outlive bash.
let descendantPath = root + "/timed-out-descendant"
do {
  _ = try run("/bin/bash", ["-c", "trap '' TERM; /bin/sleep 60 & echo $! > \"$1\"; wait",
    "timeout-fixture", descendantPath], timeout: 0.2)
  fatalError("Timed-out command unexpectedly succeeded")
} catch UpdateError.unavailable {} catch { throw error }
let descendant = pid_t(try String(contentsOfFile: descendantPath).trimmingCharacters(in: .whitespacesAndNewlines))!
let descendantDeadline = Date().addingTimeInterval(2)
while kill(descendant, 0) == 0 && Date() < descendantDeadline { usleep(10_000) }
precondition(kill(descendant, 0) != 0 && errno == ESRCH)
for forged in [false, true] {
  if fm.fileExists(atPath: peerSocket) { try fm.removeItem(atPath: peerSocket) }
  let peer = Process()
  peer.executableURL = URL(fileURLWithPath: UpdateConfiguration.bridge)
  peer.arguments = [root, "socket-peer"]
  try peer.run()
  let deadline = Date().addingTimeInterval(5)
  while !fm.fileExists(atPath: peerSocket) && Date() < deadline { usleep(10_000) }
  do {
    let response = try socketRequest(
      peerSocket, ["command": "stop", "forged": forged], uid: geteuid())
    precondition(!forged && response["pid"] as? Int32 == peer.processIdentifier)
  } catch {
    precondition(forged && error as? UpdateError == .untrusted, "Unexpected peer refusal: \(error)")
  }
  peer.waitUntilExit()
  precondition(peer.terminationStatus == 0)
}
try fm.removeItem(atPath: peerSocket)
print("native Bridge shutdown peer passed")
func check(_ actual: Any?, _ expected: String) {
  precondition(actual as? String == expected, "Unexpected recovery projection")
}
try writeJSON(
  [
    "version": "0.4.0", "previousVersion": "0.3.0",
    "candidateSha256": String(repeating: "a", count: 64),
  ], requestPath)
try phase("committed")
try writeJSON([:], holdPath)
check(try serviceState(active: false)["error"], "recoveryRequired")
check(try serviceState(active: true)["phase"], "verifying")
do {
  try cleanStaging()
  preconditionFailure("Must preserve unfinished files")
} catch { precondition(error as? UpdateError == .recoveryRequired) }
precondition(fm.fileExists(atPath: requestPath))
try fm.removeItem(atPath: holdPath)
try fm.createDirectory(
  atPath: UpdateConfiguration.transactionRoot, withIntermediateDirectories: false)
try Data().write(to: URL(fileURLWithPath: UpdateConfiguration.transactionRoot + "/finalized"))
check(try serviceState(active: false)["error"], "recoveryRequired")
try fm.removeItem(atPath: UpdateConfiguration.transactionRoot)
for suffix in [".finalized", ".restored"] {
  let retired = UpdateConfiguration.transactionRoot + suffix
  try fm.createDirectory(atPath: retired, withIntermediateDirectories: false)
  check(try serviceState(active: false)["error"], "recoveryRequired")
  do {
    try cleanStaging()
    preconditionFailure("Must preserve a retired journal awaiting cleanup")
  } catch { precondition(error as? UpdateError == .recoveryRequired) }
  try fm.removeItem(atPath: retired)
}
check(try serviceState(active: false)["phase"], "completed")
try phase("restored")
check(try serviceState(active: false)["targetVersion"], "0.3.0")
try phase("installing")
check(try serviceState(active: false)["error"], "preparationFailed")
precondition((try? serviceState(active: false))?["mode"] == nil)
// A repair's status names its mode, so the App never presents it as an update.
try writeJSON(["version": "0.3.0", "mode": "repair"], requestPath)
try phase("failed", error: "healthFailed")
check(try serviceState(active: false)["mode"], "repair")
check(try serviceState(active: false)["error"], "healthFailed")
try cleanStaging()
precondition(!fm.fileExists(atPath: requestPath))
precondition(fm.fileExists(atPath: phasePath))
print("native recovery state passed")

// The parent creates the actual schema-9 fixture through StateStore. Opening
// SQLite or checkpointing its WAL is harmless; changing saved choices is not.
let home = root + "/home"
let dbPath =
  home
  + "/Library/Application Support/Mochi/Bots/11111111-1111-4111-8111-111111111111/State/bot.sqlite"
var fixtureDB: OpaquePointer?
precondition(sqlite3_open(dbPath, &fixtureDB) == SQLITE_OK)
defer { sqlite3_close(fixtureDB) }
func execute(_ sql: String) {
  precondition(sqlite3_exec(fixtureDB, sql, nil, nil, nil) == SQLITE_OK)
}
func checkDigest(_ actual: String, _ expected: String, equal: Bool) {
  precondition((actual == expected) == equal)
}
let before = try continuity(home)
execute("PRAGMA wal_checkpoint(TRUNCATE)")
checkDigest(try continuity(home), before, equal: true)
for mutation in [
  "INSERT INTO disabled_feishu_groups VALUES ('app', 'group', 1)",
  "INSERT INTO connector_resource_selections VALUES ('connection', 'resource', 'repository', 'name', 'address', 'selection', 1)",
  "INSERT INTO schedules VALUES ('schedule', '{}', 0, NULL, 1, 1, 1)",
  "INSERT INTO runtime_initial_setup VALUES (1, 'session', 1)",
] {
  execute("BEGIN IMMEDIATE")
  execute(mutation)
  execute("COMMIT")
  checkDigest(try continuity(home), before, equal: false)
  execute(
    "DELETE FROM disabled_feishu_groups; DELETE FROM connector_resource_selections; DELETE FROM schedules; DELETE FROM runtime_initial_setup"
  )
  checkDigest(try continuity(home), before, equal: true)
}
let history = UpdateConfiguration.runtimeHome + "/.pi/mochi/bots/fixture/session.jsonl"
try fm.createDirectory(
  atPath: (history as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
try Data("{\"id\":\"same-session\",\"cwd\":\"original\"}\n".utf8).write(
  to: URL(fileURLWithPath: history))
let saved = try continuity(home)
try Data("{\"id\":\"same-session\",\"cwd\":\"different\"}\n".utf8).write(
  to: URL(fileURLWithPath: history))
checkDigest(try continuity(home), saved, equal: false)
print("native continuity passed")

// CryptoKit verifies signed feed bytes again at the privileged boundary.
try fm.createDirectory(atPath: application + "/Contents", withIntermediateDirectories: true)
(NSDictionary(dictionary: ["CFBundleShortVersionString": "0.3.0"])).write(
  toFile: application + "/Contents/Info.plist", atomically: true)
try Data("fixture-disk-image".utf8).write(to: URL(fileURLWithPath: root + "/Mochi.dmg"))
let candidate = String(repeating: "a", count: 64)
var release: [String: Any] = [
  "schemaVersion": 1, "product": "app.mochi.companion", "architecture": "arm64", "version": "0.4.0",
  "minimumUpdateVersion": "0.3.0", "minimumMacOS": "14.0", "candidateSha256": candidate,
  "artifact": ["sha256": try digest(root + "/Mochi.dmg"), "size": fileSize(root + "/Mochi.dmg")],
]
func signFixture(withdrawn: Bool = false) throws {
  let payload = try JSONSerialization.data(withJSONObject: [
    "schemaVersion": 1, "issuedAt": "2026-10-17T00:00:00.000Z", "withdrawn": withdrawn,
    "release": release,
  ])
  try writeJSON(
    [
      "payload": payload.base64EncodedString(),
      "signature": try signingKey.signature(for: payload).base64EncodedString(),
    ], root + "/feed.json")
}
func rejectsFeed() {
  do {
    _ = try verifiedFeed(root + "/feed.json", candidate: candidate)
    preconditionFailure("Untrusted candidate was accepted")
  } catch {}
}
try signFixture()
check(try verifiedFeed(root + "/feed.json", candidate: candidate).release["version"], "0.4.0")
try signFixture(withdrawn: true)
rejectsFeed()
release["product"] = "app.ahalabs.another"
try signFixture()
rejectsFeed()
release["product"] = "app.mochi.companion"
release["minimumUpdateVersion"] = "0.3.1"
try signFixture()
rejectsFeed()
release["minimumUpdateVersion"] = "0.3.0"
try signFixture()
try Data("tampered-image".utf8).write(to: URL(fileURLWithPath: root + "/Mochi.dmg"))
rejectsFeed()
print("native candidate verification passed")
