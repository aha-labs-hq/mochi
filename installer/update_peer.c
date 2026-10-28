#include "update_peer.h"
#include <Security/Security.h>
#include <string.h>

/* The kernel audit token binds the dynamic code proof to this connection;
 * a PID lookup alone is not sufficient because PIDs can be recycled. */
int mochi_update_peer(int fd, const char *requirement, const char *executable, pid_t *pid, uid_t *uid) {
    audit_token_t token;
    socklen_t length = sizeof(token);
    if (getsockopt(fd, SOL_LOCAL, LOCAL_PEERTOKEN, &token, &length) || length != sizeof(token)) return 0;
    CFDataRef data = CFDataCreate(NULL, (const UInt8 *)&token, sizeof(token));
    const void *keys[] = {kSecGuestAttributeAudit};
    const void *values[] = {data};
    CFDictionaryRef attrs = CFDictionaryCreate(NULL, keys, values, 1, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    SecCodeRef code = NULL;
    SecRequirementRef req = NULL;
    CFStringRef text = CFStringCreateWithCString(NULL, requirement, kCFStringEncodingUTF8);
    int valid = SecCodeCopyGuestWithAttributes(NULL, attrs, kSecCSDefaultFlags, &code) == errSecSuccess
      && SecRequirementCreateWithString(text, kSecCSDefaultFlags, &req) == errSecSuccess
      && SecCodeCheckValidity(code, kSecCSStrictValidate, req) == errSecSuccess;
    CFDictionaryRef info = NULL;
    char actual[PROC_PIDPATHINFO_MAXSIZE] = {0};
    if (valid) {
      valid = SecCodeCopySigningInformation(code, kSecCSDefaultFlags, &info) == errSecSuccess;
      CFURLRef url = valid ? CFDictionaryGetValue(info, kSecCodeInfoMainExecutable) : NULL;
      valid = url && CFURLGetFileSystemRepresentation(url, true, (UInt8 *)actual, sizeof(actual)) && !strcmp(actual, executable);
    }
    if (valid) { *pid = audit_token_to_pid(token); *uid = audit_token_to_euid(token); }
    if (info) CFRelease(info);
    if (req) CFRelease(req);
    if (code) CFRelease(code);
    CFRelease(text); CFRelease(attrs); CFRelease(data);
    return valid;
}

#include <stdlib.h>
int mochi_update_listener(void) {
    int *sockets = NULL; size_t count = 0;
    if (launch_activate_socket("Listener", &sockets, &count) || count != 1) { free(sockets); return -1; }
    int fd = sockets[0]; free(sockets); return fd;
}
