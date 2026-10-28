#include <launch.h>
#include <libproc.h>
#include <sys/un.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <bsm/libbsm.h>
int mochi_update_peer(int fd, const char *requirement, const char *executable, pid_t *pid, uid_t *uid);

int mochi_update_listener(void);
enum { MOCHI_PATH_MAX = 4096 };
#include "durability.h"
