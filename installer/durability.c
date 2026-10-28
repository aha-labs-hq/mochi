#include "durability.h"
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

// fsync orders filesystem writes; F_FULLFSYNC also drains the device cache.
// Failure is fatal to the transaction, never silently downgraded to fsync.
int mochi_sync_fd(int fd) {
  return fcntl(fd, F_FULLFSYNC);
}

int mochi_sync_directory(const char *path) {
  int fd = open(path, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  int result = mochi_sync_fd(fd);
  int saved = errno;
  close(fd);
  errno = saved;
  return result;
}

static int sync_contents(int fd, dev_t device) {
  struct stat info;
  if (fstat(fd, &info) != 0) return -1;
  if (info.st_dev != device) { errno = EXDEV; return -1; }
  if (S_ISREG(info.st_mode)) return fsync(fd);
  if (!S_ISDIR(info.st_mode)) { errno = EINVAL; return -1; }
  int listing = dup(fd);
  if (listing < 0) return -1;
  DIR *directory = fdopendir(listing);
  if (!directory) { int saved = errno; close(listing); errno = saved; return -1; }
  int result = 0;
  for (;;) {
    errno = 0;
    struct dirent *entry = readdir(directory);
    if (!entry) { if (errno != 0) result = -1; break; }
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    int child = openat(fd, entry->d_name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (child < 0) { result = -1; break; }
    result = sync_contents(child, device);
    int saved = errno;
    close(child);
    errno = saved;
    if (result != 0) break;
  }
  int saved = errno;
  closedir(directory);
  errno = saved;
  if (result != 0) return result;
  return fsync(fd);
}

int mochi_sync_tree(const char *path) {
  int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return -1;
  struct stat info;
  int result = fstat(fd, &info);
  if (result == 0) result = sync_contents(fd, info.st_dev);
  // One device barrier after all files and directories on that device.
  if (result == 0) result = mochi_sync_fd(fd);
  int saved = errno;
  close(fd);
  errno = saved;
  return result;
}

#ifdef MOCHI_DURABILITY_MAIN
// Package-local utility: no service, setuid bit or privilege escalation.
int main(int argc, char **argv) {
  if (argc < 3 || argc > 4 || (strcmp(argv[1], "tree") && strcmp(argv[1], "directory"))) return 64;
  for (int i = 2; i < argc; ++i) {
    int result = !strcmp(argv[1], "tree") ? mochi_sync_tree(argv[i]) : mochi_sync_directory(argv[i]);
    if (result != 0) { perror("Mochi durable checkpoint"); return 1; }
  }
  return 0;
}
#endif
