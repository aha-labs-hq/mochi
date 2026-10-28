import CryptoKit
import Darwin
// On-demand privileged transport. The package's lifecycle.sh remains the only
// component commit/rollback authority. No caller-supplied path or command runs.
import Foundation
import SQLite3

enum UpdateError: String, Error {
  case invalid, untrusted, busy, cancelled, unavailable, preparationFailed, shutdownFailed,
    healthFailed, recoveryRequired
}
let fm = FileManager.default
let root = UpdateConfiguration.root
let requestPath = root + "/request.json"
let phasePath = root + "/status.json"
let application = UpdateConfiguration.application
let holdPath = UpdateConfiguration.hold
let accountLock = NSLock()

func require(_ value: @autoclosure () throws -> Bool, _ error: UpdateError = .invalid) throws {
  if try !value() { throw error }
}
func json(_ path: String) throws -> [String: Any] {
  try require(fileSize(path) <= 65536)
  guard
    let value = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path)))
      as? [String: Any]
  else { throw UpdateError.invalid }
  return value
}
func fileSize(_ path: String) -> Int64 {
  (try? fm.attributesOfItem(atPath: path)[.size] as? NSNumber)?.int64Value ?? -1
}
func writeJSON(_ value: [String: Any], _ path: String, mode: mode_t = 0o600) throws {
  let bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
  let temp = path + ".new"
  let fd = open(temp, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, mode)
  try require(fd >= 0)
  defer { close(fd) }
  try bytes.withUnsafeBytes { b in try require(write(fd, b.baseAddress, b.count) == b.count) }
  try require(fchmod(fd, mode) == 0 && mochi_sync_fd(fd) == 0 && rename(temp, path) == 0)
  try require(mochi_sync_directory((path as NSString).deletingLastPathComponent) == 0)
}
func transactionPending() -> Bool {
  ["", ".finalized", ".restored"].contains {
    fm.fileExists(atPath: UpdateConfiguration.transactionRoot + $0)
  }
}
func phase(_ name: String, error: String? = nil) throws {
  var value: [String: Any] = ["version": 1, "phase": name]
  if let r = try? json(requestPath) {
    value["targetVersion"] = r[name == "restored" ? "previousVersion" : "version"]
    value["candidateSha256"] = r["candidateSha256"]
    // A repair's outcome belongs to the App's preparation that started it, not
    // to its update view; the mode lets the App tell the two apart.
    if let mode = r["mode"] as? String, mode == "uninstall" || mode == "repair" {
      value["mode"] = mode
    }
  }
  if let error { value["error"] = error }
  try writeJSON(value, phasePath)
}
func run(
  _ executable: String, _ args: [String], timeout: TimeInterval = 120, allowed: Set<Int32> = [0]
) throws -> String {
  let child = Process()
  let output = Pipe()
  child.executableURL = URL(fileURLWithPath: executable)
  child.arguments = args
  child.environment = [
    "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": "/var/root", "LANG": "en_US.UTF-8",
  ]
  child.currentDirectoryURL = URL(fileURLWithPath: "/var/empty")
  child.standardOutput = output
  child.standardError = FileHandle.nullDevice
  let data = NSMutableData()
  let finished = DispatchSemaphore(value: 0)
  try child.run()
  DispatchQueue.global().async {
    while let bytes = try? output.fileHandleForReading.read(upToCount: 16384), !bytes.isEmpty {
      if data.length < 1_048_576 { data.append(bytes) }
    }
    finished.signal()
  }
  let deadline = Date().addingTimeInterval(timeout)
  while child.isRunning && Date() < deadline { usleep(100_000) }
  if child.isRunning {
    // Foundation gives each Process its own process group on macOS. Cancel
    // the entire group: killing only launchctl/bash leaves a pending dscl
    // privacy request able to mutate the account after recovery reopened App.
    let group = -child.processIdentifier
    kill(group, SIGTERM)
    let grace = Date().addingTimeInterval(5)
    while kill(group, 0) == 0 && Date() < grace { usleep(100_000) }
    if kill(group, 0) == 0 { kill(group, SIGKILL) }
    child.waitUntilExit()
    _ = finished.wait(timeout: .now() + 2)
    throw UpdateError.unavailable
  }
  child.waitUntilExit()
  try require(finished.wait(timeout: .now() + 2) == .success, .unavailable)
  try require(allowed.contains(child.terminationStatus), .preparationFailed)
  return String(data: data as Data, encoding: .utf8) ?? ""
}
func digest(_ path: String) throws -> String {
  let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try require(fd >= 0)
  defer { close(fd) }
  var info = stat()
  try require(fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG, .untrusted)
  var hash = SHA256()
  var buffer = [UInt8](repeating: 0, count: 65536)
  while true {
    let n = read(fd, &buffer, buffer.count)
    try require(n >= 0)
    if n == 0 { break }
    hash.update(data: Data(buffer[0..<n]))
  }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}
func privateDirectory(_ path: String) throws {
  var s = stat()
  if lstat(path, &s) != 0 {
    try require(errno == ENOENT && mkdir(path, 0o700) == 0)
    try require(mochi_sync_directory((path as NSString).deletingLastPathComponent) == 0)
    return
  }
  try require(s.st_mode & S_IFMT == S_IFDIR && s.st_uid == 0 && s.st_mode & 0o077 == 0, .untrusted)
}
func account(_ uid: uid_t, requireInstallation: Bool = true) throws -> (String, String) {
  accountLock.lock()
  defer { accountLock.unlock() }
  // uid comes from the signed App's audit token, or its root-authorized setup.
  // A console switch cannot retarget an accepted lifecycle operation.
  try require(uid >= 501 && uid < UInt32.max, .untrusted)
  guard let user = getpwuid(uid) else { throw UpdateError.untrusted }
  let name = String(cString: user.pointee.pw_name)
  let home = String(cString: user.pointee.pw_dir)
  try require(
    home == "/Users" + "/" + name
      && name.range(of: UpdateConfiguration.bridgeUserPattern, options: .regularExpression) != nil,
    .untrusted)
  if requireInstallation {
    let rule = try String(contentsOfFile: UpdateConfiguration.sudoers, encoding: .utf8)
    try require(
      rule.split(separator: "\n").contains(where: { $0.hasPrefix(name + " ALL=") }), .untrusted)
  }
  return (name, home)
}
// Root copies only regular files actually owned by the authenticated peer.
// fstat proves the opened inode after every user-controlled ancestor lookup.
func copyUserFile(_ from: String, _ to: String, uid: uid_t, maximum: Int64) throws {
  let input = open(from, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
  try require(input >= 0, .untrusted)
  defer { close(input) }
  var s = stat()
  try require(
    fstat(input, &s) == 0 && s.st_mode & S_IFMT == S_IFREG && s.st_uid == uid && s.st_size > 0
      && s.st_size <= maximum, .untrusted)
  let output = open(to, O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0o600)
  try require(output >= 0)
  defer { close(output) }
  var buffer = [UInt8](repeating: 0, count: 65536)
  var total: Int64 = 0
  while true {
    let n = read(input, &buffer, buffer.count)
    try require(n >= 0)
    if n == 0 { break }
    total += Int64(n)
    try require(total <= maximum && write(output, &buffer, n) == n)
  }
  try require(total == s.st_size && mochi_sync_fd(output) == 0)
  try require(mochi_sync_directory((to as NSString).deletingLastPathComponent) == 0)
}
struct VerifiedUpdateFeed {
  let release: [String: Any]
  let issuedAt: String
  let payload: Data
}
func verifiedFeed(_ path: String, candidate: String) throws -> VerifiedUpdateFeed {
  let envelope = try json(path)
  try require(Set(envelope.keys) == ["payload", "signature"])
  guard let p = envelope["payload"] as? String, let payload = Data(base64Encoded: p),
    payload.count <= 24576,
    let s = envelope["signature"] as? String, let signature = Data(base64Encoded: s),
    let key = Data(base64Encoded: UpdateConfiguration.publicKey)
  else { throw UpdateError.invalid }
  try require(
    try Curve25519.Signing.PublicKey(rawRepresentation: key).isValidSignature(
      signature, for: payload), .untrusted)
  guard let feed = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
    feed["schemaVersion"] as? Int == 1, feed["withdrawn"] as? Bool == false,
    let issuedAt = feed["issuedAt"] as? String,
    let release = feed["release"] as? [String: Any], let version = release["version"] as? String,
    let artifact = release["artifact"] as? [String: Any], let hash = artifact["sha256"] as? String,
    let size = artifact["size"] as? Int64
  else { throw UpdateError.invalid }
  let timestamp = ISO8601DateFormatter()
  timestamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  try require(
    issuedAt.range(
      of: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$",
      options: .regularExpression) != nil && timestamp.date(from: issuedAt) != nil)
  try require(
    release["product"] as? String == "app.mochi.companion"
      && release["architecture"] as? String == "arm64"
      && release["candidateSha256"] as? String == candidate && release["schemaVersion"] as? Int == 1
      && version.count <= 64
      && version.range(
        of: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$", options: .regularExpression)
        != nil
      && hash.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil && size > 0
      && size <= 4_294_967_296)
  guard let minimum = release["minimumUpdateVersion"] as? String,
    let minimumOS = release["minimumMacOS"] as? String,
    let installed = NSDictionary(contentsOfFile: application + "/Contents/Info.plist")?[
      "CFBundleShortVersionString"] as? String
  else { throw UpdateError.invalid }
  try require(
    minimum.range(of: "^[0-9]+\\.[0-9]+\\.[0-9]+$", options: .regularExpression) != nil
      && minimum.count <= 64
      && installed.compare(minimum, options: .numeric) != .orderedAscending, .invalid)
  let os = ProcessInfo.processInfo.operatingSystemVersion
  let osText = "\(os.majorVersion).\(os.minorVersion).\(os.patchVersion)"
  try require(
    minimumOS.range(of: "^[0-9]+\\.[0-9]+(?:\\.[0-9]+)?$", options: .regularExpression) != nil
      && minimumOS.count <= 32
      && osText.compare(minimumOS, options: .numeric) != .orderedAscending, .invalid)
  try require(
    fileSize(root + "/Mochi.dmg") == size && (try digest(root + "/Mochi.dmg")) == hash, .untrusted)
  return VerifiedUpdateFeed(release: release, issuedAt: issuedAt, payload: payload)
}
func verifyApp(_ path: String, version: String) throws {
  _ = try run(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "-R=" + UpdateConfiguration.requirement, path])
  let info = NSDictionary(contentsOfFile: path + "/Contents/Info.plist")
  try require(
    info?["CFBundleIdentifier"] as? String == "app.mochi.companion"
      && info?["CFBundleShortVersionString"] as? String == version, .untrusted)
  _ = try run("/usr/sbin/spctl", ["--assess", "--type", "execute", path])
  let package = path + "/Contents/Resources/Mochi-Setup.pkg"
  let signature = try run("/usr/sbin/pkgutil", ["--check-signature", package])
  try require(
    signature.contains("Status: signed by a developer certificate issued by Apple for distribution")
      && signature.components(separatedBy: "\n").contains(where: {
        $0.trimmingCharacters(in: .whitespaces).hasPrefix("1. Developer ID Installer: ")
          && $0.hasSuffix(" (" + UpdateConfiguration.team + ")")
      }), .untrusted)
  _ = try run("/usr/sbin/spctl", ["--assess", "--type", "install", package])
}
func socketRequest(_ path: String, _ value: [String: Any], uid: uid_t) throws -> [String: Any] {
  let fd = socket(AF_UNIX, SOCK_STREAM, 0)
  try require(fd >= 0)
  defer { close(fd) }
  var addr = sockaddr_un()
  addr.sun_family = sa_family_t(AF_UNIX)
  let bytes = Array(path.utf8CString)
  try require(bytes.count <= MemoryLayout.size(ofValue: addr.sun_path))
  withUnsafeMutableBytes(of: &addr.sun_path) {
    $0.copyBytes(from: bytes.map { UInt8(bitPattern: $0) })
  }
  var timeout = timeval(tv_sec: 60, tv_usec: 0)
  setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
  let connected = withUnsafePointer(to: &addr) {
    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
      connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
    }
  }
  try require(connected == 0, .unavailable)
  // Authenticate the connected Bridge before sending any lifecycle command.
  // A successful stop may exit immediately after its reply; a PID lookup
  // afterwards would mistake that completed handoff for a failed identity.
  var peerPID: pid_t = 0
  var peerUID: uid_t = 0
  try require(
    mochi_update_peer(
      fd, UpdateConfiguration.bridgeRequirement, UpdateConfiguration.bridge, &peerPID, &peerUID)
      == 1 && peerUID == uid, .untrusted)
  let bytesOut = try JSONSerialization.data(withJSONObject: value) + Data([10])
  try bytesOut.withUnsafeBytes { try require(write(fd, $0.baseAddress, $0.count) == $0.count) }
  let bytesIn = try readLine(fd)
  guard let response = try JSONSerialization.jsonObject(with: bytesIn) as? [String: Any] else {
    throw UpdateError.invalid
  }
  if response["ok"] as? Bool == true {
    try require(response["pid"] as? Int32 == peerPID, .untrusted)
  }
  return response
}
func readLine(_ fd: Int32) throws -> Data {
  var bytes = Data()
  var buffer = [UInt8](repeating: 0, count: 4096)
  while bytes.count < 65536 {
    let count = read(fd, &buffer, buffer.count)
    try require(count > 0, .unavailable)
    bytes.append(contentsOf: buffer[0..<count])
    if let end = bytes.firstIndex(of: 10) { return bytes.prefix(upTo: end) }
  }
  throw UpdateError.invalid
}
func bridge(_ home: String, uid: uid_t, _ extra: [String: Any]) throws -> [String: Any] {
  var request: [String: Any] = ["lifecycle": "update", "version": 1]
  extra.forEach { request[$0.key] = $0.value }
  // Installed and development deployments share this user's control endpoint.
  // A development process must never be stopped to install a public update.
  let result = try socketRequest(
    home + "/Library/Application Support/Mochi/control.sock", request, uid: uid)
  try require(result["version"] as? Int == 1 && result["lifecycle"] as? String == "update")
  return result
}
func runningProductProcesses(_ uid: uid_t) -> [pid_t] {
  var pids = [pid_t](repeating: 0, count: Int(proc_listallpids(nil, 0)) + 64)
  let n = pids.withUnsafeMutableBytes { proc_listallpids($0.baseAddress, Int32($0.count)) }
  let runtimeUID = getpwnam("_mochi")?.pointee.pw_uid
  return pids.prefix(max(0, Int(n))).filter { pid in
    var info = proc_bsdinfo()
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, Int32(MemoryLayout<proc_bsdinfo>.size)) > 0
    else { return false }
    if let runtimeUID, info.pbi_uid == runtimeUID { return true }
    guard info.pbi_uid == uid else { return false }
    var path = [CChar](repeating: 0, count: Int(MOCHI_PATH_MAX))
    guard proc_pidpath(pid, &path, UInt32(path.count)) > 0 else { return false }
    let name = String(cString: path)
    return name == UpdateConfiguration.bridge || name == UpdateConfiguration.lark
  }
}
func heldLocks(_ home: String) throws -> [Int32] {
  let data = home + "/Library/Application Support/Mochi"
  var paths = [
    data + "/bot.lock", UpdateConfiguration.runtimeHome + "/.pi/mochi/account/runtime.lock",
  ]
  if let bots = try? fm.contentsOfDirectory(atPath: data + "/Bots") {
    for id in bots where UUID(uuidString: id) != nil {
      paths += [
        data + "/Bots/" + id + "/State/bot.lock",
        UpdateConfiguration.runtimeHome + "/.pi/mochi/bots/" + id + "/runtime.lock",
      ]
    }
  }
  var locks: [Int32] = []
  do {
    for path in paths where fm.fileExists(atPath: path) {
      let fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK)
      try require(fd >= 0, .shutdownFailed)
      var info = stat()
      guard fstat(fd, &info) == 0 && info.st_mode & S_IFMT == S_IFREG else {
        close(fd)
        throw UpdateError.shutdownFailed
      }
      if flock(fd, LOCK_EX | LOCK_NB) != 0 {
        close(fd)
        throw UpdateError.shutdownFailed
      }
      locks.append(fd)
    }
    return locks
  } catch {
    locks.forEach { close($0) }
    throw error
  }
}
// Hash persistent history, policy and explicit user choices. The receipt holds
// only this aggregate digest; no contents, resource IDs or credentials escape.
func continuity(_ home: String) throws -> String {
  let data = home + "/Library/Application Support/Mochi"
  var files = [data + "/fleet.json"]
  for parent in [data + "/Bots", UpdateConfiguration.runtimeHome + "/.pi/mochi/bots"] {
    if let entries = fm.enumerator(atPath: parent) {
      for case let name as String in entries {
        if name.hasSuffix(".jsonl") || name.hasSuffix("/bot.toml") || name.hasSuffix("/AGENTS.md") {
          files.append(parent + "/" + name)
        }
      }
    }
  }
  var hash = SHA256()
  for path in files.sorted() where fm.fileExists(atPath: path) {
    hash.update(data: Data((path + "\n" + (try digest(path)) + "\n").utf8))
  }
  // Binding and candidate identity are semantic; SQLite/WAL page layout may
  // legitimately change when the same database is opened by the new process.
  if let bots = try? fm.contentsOfDirectory(atPath: data + "/Bots") {
    for id in bots.sorted() where UUID(uuidString: id) != nil {
      let path = data + "/Bots/" + id + "/State/bot.sqlite"
      if !fm.fileExists(atPath: path) { continue }
      var db: OpaquePointer?
      try require(sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, .healthFailed)
      defer { sqlite3_close(db) }
      for query in [
        "SELECT session_id, capability_abi, turn_count FROM runtime_session_binding ORDER BY singleton",
        "SELECT * FROM runtime_initial_setup ORDER BY singleton",
        "SELECT * FROM runtime_session_history ORDER BY session_id",
        "SELECT * FROM runtime_session_migration ORDER BY singleton",
        "SELECT * FROM connector_resource_selections ORDER BY connection_id, resource_id",
        "SELECT * FROM disabled_feishu_groups ORDER BY app_id, chat_id",
        "SELECT * FROM schedules ORDER BY id",
      ] {
        hash.update(data: try JSONSerialization.data(withJSONObject: [id, query]))
        var statement: OpaquePointer?
        try require(sqlite3_prepare_v2(db, query, -1, &statement, nil) == SQLITE_OK, .healthFailed)
        defer { sqlite3_finalize(statement) }
        var step = sqlite3_step(statement)
        while step == SQLITE_ROW {
          // JSON framing preserves null/type/column boundaries, including newlines.
          let columns: [[String]] = (0..<sqlite3_column_count(statement)).map { col in
            [
              String(sqlite3_column_type(statement, col)),
              sqlite3_column_text(statement, col).map { String(cString: $0) } ?? "",
            ]
          }
          hash.update(data: try JSONSerialization.data(withJSONObject: columns))
          step = sqlite3_step(statement)
        }
        try require(step == SQLITE_DONE, .healthFailed)
      }
    }
  }
  return hash.finalize().map { String(format: "%02x", $0) }.joined()
}

func freshFeed(candidate: String) throws {
  let body = try run(
    "/usr/bin/curl",
    [
      "--fail", "--silent", "--proto", "=https", "--max-time", "15", "--max-filesize", "32768",
      "--header", "Cache-Control: no-cache", UpdateConfiguration.feedURL,
    ], timeout: 20)
  try require(body.utf8.count <= 32768, .untrusted)
  let path = root + "/fresh-feed.json"
  try Data(body.utf8).write(to: URL(fileURLWithPath: path), options: .atomic)
  let fresh = try verifiedFeed(path, candidate: candidate)
  let staged = try verifiedFeed(root + "/feed.json", candidate: candidate)
  try require(
    fresh.issuedAt > staged.issuedAt
      || (fresh.issuedAt == staged.issuedAt && fresh.payload == staged.payload), .untrusted)
}
func handoff(repair: Bool = false, uninstall: Bool = false) throws {
  var r = try json(requestPath)
  guard let uid = r["uid"] as? UInt32, let version = r["version"] as? String,
    let sha = r["sha256"] as? String, let pid = r["pid"] as? Int32
  else { throw UpdateError.invalid }
  let (_, home) = try account(uid, requireInstallation: !uninstall)
  try phase("waiting")
  var lease: String?
  let job = "gui/\(uid)/app.mochi.bridge"
  // launchctl returns 113 only for an absent job. A loaded but unreachable
  // Bridge must still fail closed, never become an offline installation.
  let loaded = !(try run("/bin/launchctl", ["print", job], allowed: [0, 113])).isEmpty
  var stopped = false
  defer {
    if let lease, !stopped { _ = try? bridge(home, uid: uid, ["command": "release", "lease": lease]) }
  }
  if loaded {
    let deadline = Date().addingTimeInterval(repair ? 2 : 7200)
    while Date() < deadline {
      if fm.fileExists(atPath: root + "/cancel") { throw UpdateError.cancelled }
      let response = try bridge(
        home, uid: uid, ["command": "acquire", "targetVersion": version, "sha256": sha])
      if response["ok"] as? Bool == true {
        lease = response["lease"] as? String
        break
      }
      try require(response["reason"] as? String == "busy", .unavailable)
      sleep(1)
    }
    try require(lease != nil, .busy)
    if !uninstall {
      let health = try bridge(home, uid: uid, ["command": "health"])
      try require(
        health["ok"] as? Bool == true && health["initialized"] as? Bool == true, .healthFailed)
      r["previousFailures"] = health["failures"] ?? []
      r["previousVersion"] = health["productVersion"]
    }
  } else {
    try require(runningProductProcesses(uid).isEmpty, .shutdownFailed)
    guard let installed = NSDictionary(contentsOfFile: application + "/Contents/Info.plist")?[
      "CFBundleShortVersionString"] as? String
    else { throw UpdateError.untrusted }
    try verifyApp(application, version: installed)
    r["previousVersion"] = installed
    r["previousFailures"] = [String]()
  }
  if !repair && !uninstall {
    guard let candidate = r["candidateSha256"] as? String else { throw UpdateError.invalid }
    try freshFeed(candidate: candidate)
  }
  try writeJSON(r, requestPath)
  if !repair { try waitForApp(pid) }
  _ = try account(uid, requireInstallation: !uninstall)
  if let lease {
    let stop = try bridge(home, uid: uid, ["command": "stop", "lease": lease])
    try require(stop["ok"] as? Bool == true, .shutdownFailed)
    stopped = true
    _ = try run("/bin/launchctl", ["bootout", job], allowed: [0, 3, 113])
  } else {
    try require(
      try run("/bin/launchctl", ["print", job], allowed: [113]).isEmpty, .shutdownFailed)
  }
  let stopDeadline = Date().addingTimeInterval(20)
  while !runningProductProcesses(uid).isEmpty && Date() < stopDeadline { usleep(100_000) }
  try require(runningProductProcesses(uid).isEmpty, .shutdownFailed)
  let locks = try heldLocks(home)
  defer { locks.forEach { close($0) } }
  if uninstall {
    // A second App launch must not restart intake between shutdown and removal.
    try writeJSON(["version": version], holdPath, mode: 0o644)
    return
  }
  r["continuity"] = try continuity(home)
  try writeJSON(r, requestPath)
  try writeJSON(["version": version], holdPath, mode: 0o644)
  try phase("installing")
}
func health(restoring: Bool = false) throws {
  let r = try json(requestPath)
  guard let uid = r["uid"] as? UInt32 else { throw UpdateError.invalid }
  let (_, home) = try account(uid)
  try phase(restoring ? "restoring" : "verifying")
  let deadline = Date().addingTimeInterval(120)
  while Date() < deadline {
    if let current = try? bridge(home, uid: uid, ["command": "health"]), current["ok"] as? Bool == true,
      current["initialized"] as? Bool == true,
      current["productVersion"] as? String == r[restoring ? "previousVersion" : "version"]
        as? String
    {
      let old = Set(r["previousFailures"] as? [String] ?? [])
      let new = Set(current["failures"] as? [String] ?? [])
      try require(
        new.isSubset(of: old) && (try continuity(home)) == r["continuity"] as? String, .healthFailed
      )
      return
    }
    usleep(250_000)
  }
  throw UpdateError.healthFailed
}

func stopProcesses() throws {
  let r = try json(requestPath)
  guard let uid = r["uid"] as? UInt32 else { throw UpdateError.invalid }
  _ = try account(uid)
  _ = try run("/bin/launchctl", ["bootout", "gui/\(uid)/app.mochi.bridge"], allowed: [0, 3, 113])
  let deadline = Date().addingTimeInterval(30)
  while !runningProductProcesses(uid).isEmpty && Date() < deadline { usleep(100_000) }
  try require(runningProductProcesses(uid).isEmpty, .shutdownFailed)
}
func releaseHold(restored: Bool) throws {
  if restored { try health(restoring: true) }
  try phase(restored ? "restored" : "committed")
  if fm.fileExists(atPath: holdPath) {
    try fm.removeItem(atPath: holdPath)
    try require(mochi_sync_directory((holdPath as NSString).deletingLastPathComponent) == 0)
  }
}
// Same-version repair uses the existing package and the same idle/health
// handshake. It does not need a second signing or component lifecycle.
func prepareRepair(uid: uid_t) throws {
  let fd = open(
    UpdateConfiguration.workRoot + "/update.lock", O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
  try require(fd >= 0)
  defer { close(fd) }
  try require(flock(fd, LOCK_EX | LOCK_NB) == 0, .busy)
  try privateDirectory(root)
  try require(
    !fm.fileExists(atPath: holdPath) && !transactionPending(),
    .recoveryRequired)
  _ = try account(uid)
  let version = UpdateConfiguration.productVersion
  try verifyApp(application, version: version)
  if fm.fileExists(atPath: root + "/cancel") { try fm.removeItem(atPath: root + "/cancel") }
  try writeJSON(
    [
      "version": version, "mode": "repair",
      "sha256": try digest(application + "/Contents/Resources/Mochi-Setup.pkg"),
      "uid": uid, "pid": 0,
    ], requestPath)
  do {
    try handoff(repair: true)
  } catch {
    try phase(
      "failed",
      error: fm.fileExists(atPath: holdPath)
        ? "recoveryRequired" : (error as? UpdateError)?.rawValue ?? "unavailable")
    throw error
  }
}

// A killed preparation can leave the read-only image mounted. Only detach our
// exact private mountpoint, never the containing data volume or another image.
func detachStagedVolume() throws {
  let mount = root + "/Mount"
  guard fm.fileExists(atPath: mount) else { return }
  var info = statfs()
  try require(statfs(mount, &info) == 0, .preparationFailed)
  let mountedOn = withUnsafePointer(to: &info.f_mntonname) {
    $0.withMemoryRebound(to: CChar.self, capacity: Int(MNAMELEN)) { String(cString: $0) }
  }
  if mountedOn == mount {
    _ = try run("/usr/bin/hdiutil", ["detach", "-quiet", mount], timeout: 30)
  }
}

func cleanStaging(locking: Bool = false, preservingCancel: Bool = false) throws {
  let fd =
    locking
    ? open(UpdateConfiguration.workRoot + "/update.lock", O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
    : -1
  defer { if fd >= 0 { close(fd) } }
  if locking { try require(fd >= 0 && flock(fd, LOCK_EX | LOCK_NB) == 0, .busy) }
  try require(
    !fm.fileExists(atPath: holdPath) && !transactionPending(),
    .recoveryRequired)
  try detachStagedVolume()
  for name in [
    "request.json", "Mochi.app", "Mochi.dmg", "feed.json", "fresh-feed.json", "runner", "cancel", "Uninstall",
  ] {
    if preservingCancel && name == "cancel" { continue }
    let path = root + "/" + name
    if fm.fileExists(atPath: path) { try fm.removeItem(atPath: path) }
  }
}

func serviceState(active: Bool) throws -> [String: Any] {
  var state = (try? json(phasePath)) ?? ["version": 1, "phase": "idle"]
  let pending =
    fm.fileExists(atPath: holdPath) || transactionPending()
  if !active && pending {
    state["phase"] = "failed"
    state["error"] = "recoveryRequired"
  } else if state["phase"] as? String == "committed" {
    state["phase"] = active ? "verifying" : "completed"
  } else if !active
    && ["preparing", "waiting", "closing", "installing", "verifying", "restoring"].contains(
      state["phase"] as? String ?? "")
  {
    state["phase"] = "failed"
    state["error"] = "preparationFailed"
  }
  return state
}
func waitForApp(_ pid: pid_t) throws {
  try phase("closing")
  let deadline = Date().addingTimeInterval(30)
  while kill(pid, 0) == 0 && Date() < deadline {
    if fm.fileExists(atPath: root + "/cancel") { throw UpdateError.cancelled }
    usleep(100_000)
  }
  try require(kill(pid, 0) != 0, .shutdownFailed)
}

func install(uid: uid_t, pid: pid_t, candidate: String) throws {
  let (_, home) = try account(uid)
  let lock = open(
    UpdateConfiguration.workRoot + "/update.lock", O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
  try require(lock >= 0, .untrusted)
  defer { close(lock) }
  try require(flock(lock, LOCK_EX | LOCK_NB) == 0, .busy)
  try privateDirectory(root)
  let unfinished =
    transactionPending() || fm.fileExists(atPath: holdPath)
  if unfinished {
    var old = try json(requestPath)
    try require(
      old["candidateSha256"] as? String == candidate && old["uid"] as? UInt32 == uid,
      .recoveryRequired)
    old["pid"] = pid
    try writeJSON(old, requestPath)
    try waitForApp(pid)
  } else {
    try detachStagedVolume()
    for name in ["Mochi.app", "request.json"]
    where fm.fileExists(atPath: root + "/" + name) { try fm.removeItem(atPath: root + "/" + name) }
    let cache = home + UpdateConfiguration.cacheSuffix
    try copyUserFile(cache + "/feed.json", root + "/feed.json", uid: uid, maximum: 32768)
    try copyUserFile(cache + "/Mochi.dmg", root + "/Mochi.dmg", uid: uid, maximum: 4_294_967_296)
    let release = try verifiedFeed(root + "/feed.json", candidate: candidate).release
    let version = release["version"] as! String
    let artifact = release["artifact"] as! [String: Any]
    let installed =
      NSDictionary(contentsOfFile: application + "/Contents/Info.plist")?[
        "CFBundleShortVersionString"] as? String ?? ""
    try require(version.compare(installed, options: .numeric) == .orderedDescending, .invalid)
    let mount = root + "/Mount"
    try fm.createDirectory(atPath: mount, withIntermediateDirectories: true)
    _ = try run(
      "/usr/bin/hdiutil",
      [
        "attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount,
        root + "/Mochi.dmg",
      ])
    defer { _ = try? run("/usr/bin/hdiutil", ["detach", "-quiet", mount]) }
    try verifyApp(mount + "/Mochi.app", version: version)
    _ = try run("/usr/bin/ditto", [mount + "/Mochi.app", root + "/Mochi.app"])
    try verifyApp(root + "/Mochi.app", version: version)
    try require(mochi_sync_tree(root + "/Mochi.app") == 0)
    try require(mochi_sync_directory(root) == 0)
    try writeJSON(
      [
        "version": version, "candidateSha256": candidate, "sha256": artifact["sha256"]!, "uid": uid,
        "pid": pid,
      ], requestPath)
  }
  do {
    _ = try run(
      "/usr/sbin/installer",
      ["-pkg", root + "/Mochi.app/Contents/Resources/Mochi-Setup.pkg", "-target", "/"],
      timeout: 7800)
    try phase("completed")
    try cleanStaging()
  } catch {
    // The package is the only rollback owner. Never manufacture a successful
    // restore from installer exit status or mere presence of the old App.
    let state = (try? json(phasePath)["phase"] as? String) ?? ""
    if fm.fileExists(atPath: holdPath) || transactionPending()
    {
      try phase("failed", error: "recoveryRequired")
    } else if state != "restored" && state != "committed" && state != "completed" {
      try phase(
        "failed",
        error: fm.fileExists(atPath: holdPath)
          || transactionPending()
          ? "recoveryRequired" : "preparationFailed")
    }
    if kill(pid, 0) != 0 { try? reopen(uid) }
    if !fm.fileExists(atPath: holdPath)
      && !transactionPending()
    {
      try? cleanStaging()
    }
    throw error
  }
  try reopen(uid)
}
func reopen(_ uid: uid_t, requireInstallation: Bool = true) throws {
  let (name, home) = try account(uid, requireInstallation: requireInstallation)
  // asuser switches the bootstrap namespace, not the process environment.
  // LaunchServices inherits open's HOME: retaining root's home prevents the
  // standard user's App from opening its own private state and structured log.
  _ = try run(
    "/bin/launchctl",
    [
      "asuser", String(uid), "/usr/bin/sudo", "-n", "-H", "-u", name, "--",
      "/usr/bin/env", "-i", "HOME=\(home)", "USER=\(name)", "LOGNAME=\(name)",
      "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "LANG=en_US.UTF-8", "/usr/bin/open", application,
    ])
}

// Uninstall uses the same authenticated transport, admission and lifetime lock.
// The current signed package supplies the sole ownership/cleanup implementation.
// Keep the App until every other target is removed, so a failure can reopen it.
func uninstall(uid: uid_t, pid: pid_t, policy: String) throws {
  try require(["keepData", "deleteAll"].contains(policy))
  let previous = try? json(requestPath)
  let resuming = previous?["mode"] as? String == "uninstall"
    && previous?["uid"] as? UInt32 == uid && previous?["policy"] as? String == policy
  _ = try account(uid, requireInstallation: !resuming)
  let lock = open(UpdateConfiguration.workRoot + "/update.lock", O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
  try require(lock >= 0, .untrusted)
  defer { close(lock) }
  try require(flock(lock, LOCK_EX | LOCK_NB) == 0, .busy)
  try require(!transactionPending() && (resuming || !fm.fileExists(atPath: holdPath)), .recoveryRequired)
  try privateDirectory(root)
  let version = UpdateConfiguration.productVersion
  try verifyApp(application, version: version)
  let package = root + "/Mochi.app/Contents/Resources/Mochi-Setup.pkg"
  if resuming {
    try verifyApp(root + "/Mochi.app", version: version)
    try require(try digest(package) == previous?["sha256"] as? String, .untrusted)
    try require(try digest(application + "/Contents/Resources/Mochi-Setup.pkg") == digest(package), .untrusted)
  } else {
    try cleanStaging(preservingCancel: true)
    _ = try run("/usr/bin/ditto", [application, root + "/Mochi.app"])
    try verifyApp(root + "/Mochi.app", version: version)
    _ = try run("/usr/sbin/pkgutil", ["--expand-full", package, root + "/Uninstall"])
  }
  try writeJSON([
    "mode": "uninstall", "policy": policy, "version": version,
    "sha256": try digest(package), "uid": uid, "pid": pid,
  ], requestPath)
  do {
    try handoff(uninstall: true)
    try phase("installing")
    // Privacy consent belongs to the authenticated recipient's GUI audit
    // session. A LaunchDaemon has no user tccd to display account-removal
    // consent. asuser changes that session, not root credentials; only the
    // already verified, root-staged package script is executed.
    _ = try run("/bin/launchctl", ["asuser", String(uid), "/bin/bash",
      root + "/Uninstall/Mochi-component.pkg/Scripts/uninstall", policy, String(uid)], timeout: 600)
  } catch {
    if fm.fileExists(atPath: holdPath) {
      try? fm.removeItem(atPath: holdPath)
      _ = mochi_sync_directory((holdPath as NSString).deletingLastPathComponent)
    }
    try? phase("failed", error: (error as? UpdateError)?.rawValue ?? "unavailable")
    // Partial removal may already have removed the sudoers file. The recipient
    // was authenticated above; reopening never executes privileged user code.
    if kill(pid, 0) != 0 { try? reopen(uid, requireInstallation: false) }
    throw error
  }
  // This is deliberately last: bootout terminates this service, after cleanup
  // has verified its exact remaining-ownership list and removed its journal.
  _ = try run("/bin/launchctl", ["bootout", "system/app.mochi.update"])
}

let installAdmission = DispatchSemaphore(value: 1)
func serve() throws {
  try privateDirectory(UpdateConfiguration.workRoot)
  let listener = mochi_update_listener()
  try require(listener >= 0, .unavailable)
  var listenerPoll = pollfd(fd: listener, events: Int16(POLLIN), revents: 0)
  let clients = DispatchSemaphore(value: 16)
  while true {
    if poll(&listenerPoll, 1, 60_000) == 0 {
      // Release the old executable after an update, without killing an install.
      if installAdmission.wait(timeout: .now()) == .success {
        installAdmission.signal()
        return
      }
      continue
    }
    let fd = accept(listener, nil, nil)
    if fd < 0 { continue }
    if clients.wait(timeout: .now()) != .success {
      close(fd)
      continue
    }
    DispatchQueue.global().async {
      defer {
        close(fd)
        clients.signal()
      }
      var timeout = timeval(tv_sec: 10, tv_usec: 0)
      setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
      var uid: uid_t = 0
      var pid: pid_t = 0
      var result: [String: Any]
      do {
        try require(
          mochi_update_peer(
            fd, UpdateConfiguration.requirement, application + "/Contents/MacOS/Mochi", &pid, &uid)
            == 1, .untrusted)
        guard let request = try JSONSerialization.jsonObject(with: readLine(fd)) as? [String: Any],
          request["version"] as? Int == 1, let command = request["command"] as? String
        else { throw UpdateError.invalid }
        // A partially removed installation may have lost its sudoers rule. Its
        // authenticated recipient may still read the failure, never mutate it.
        let prior = try? json(requestPath)
        let uninstallRecovery = (command == "status" || (command == "uninstall" &&
          request["policy"] as? String == prior?["policy"] as? String)) && prior?["mode"] as? String == "uninstall"
          && prior?["uid"] as? UInt32 == uid
        _ = try account(uid, requireInstallation: !uninstallRecovery)
        try require(
          Set(request.keys)
            == (command == "install"
              ? ["version", "command", "candidateSha256"]
              : command == "uninstall" ? ["version", "command", "policy"] : ["version", "command"]))
        switch command {
        case "status":
          let inactive = installAdmission.wait(timeout: .now()) == .success
          if inactive { installAdmission.signal() }
          result = try serviceState(active: !inactive)
        case "cancel":
          let current = try json(phasePath)["phase"] as? String
          try require(["preparing", "waiting", "closing"].contains(current ?? ""), .busy)
          try writeJSON([:], root + "/cancel")
          result = ["version": 1, "phase": "cancelling"]
        case "install", "uninstall":
          let removing = command == "uninstall"
          let candidate = request["candidateSha256"] as? String ?? ""
          let policy = request["policy"] as? String ?? ""
          try require(removing ? ["keepData", "deleteAll"].contains(policy)
            : candidate.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil)
          // The lifetime lock in install admits exactly one installer; the
          // connection returns promptly so the App can show/cancel waiting.
          try require(installAdmission.wait(timeout: .now()) == .success, .busy)
          // Publish the new admission before acknowledging it. An old request
          // must not supply this attempt's target or candidate identity.
          do {
            try privateDirectory(root)
            if fm.fileExists(atPath: root + "/cancel") {
              try fm.removeItem(atPath: root + "/cancel")
            }
            var initial: [String: Any] = ["version": 1, "phase": "preparing"]
            if removing { initial["mode"] = "uninstall" }
            else { initial["candidateSha256"] = candidate }
            try writeJSON(initial, phasePath)
          } catch {
            installAdmission.signal()
            throw error
          }
          let requesterUID = uid
          let requesterPID = pid
          DispatchQueue.global().async {
            defer { installAdmission.signal() }
            do {
              if removing { try uninstall(uid: requesterUID, pid: requesterPID, policy: policy) }
              else { try install(uid: requesterUID, pid: requesterPID, candidate: candidate) }
            } catch {
              let state = (try? json(phasePath)["phase"] as? String) ?? ""
              if !["restored", "committed", "completed", "failed"].contains(state) {
                if removing {
                  try? writeJSON(["version": 1, "phase": "failed", "mode": "uninstall",
                    "error": (error as? UpdateError)?.rawValue ?? "unavailable"], phasePath)
                } else { try? phase("failed", error: (error as? UpdateError)?.rawValue ?? "unavailable") }
              }
              if !removing && !fm.fileExists(atPath: holdPath)
                && !transactionPending()
              {
                try? cleanStaging(locking: true)
              }
            }
          }
          result = ["version": 1, "phase": "preparing"]
          if removing { result["mode"] = "uninstall" }
        default: throw UpdateError.invalid
        }
      } catch {
        result = [
          "version": 1, "phase": "failed",
          "error": (error as? UpdateError)?.rawValue ?? "unavailable",
        ]
      }
      if let data = try? JSONSerialization.data(withJSONObject: result) {
        let line = data + Data([10])
        line.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
      }
    }
  }
}
