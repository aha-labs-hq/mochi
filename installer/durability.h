#ifndef MOCHI_DURABILITY_H
#define MOCHI_DURABILITY_H
int mochi_sync_fd(int fd);
int mochi_sync_directory(const char *path);
int mochi_sync_tree(const char *path);
#endif
