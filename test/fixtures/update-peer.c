#include <sys/socket.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "update_peer.h"

int main(int argc, char **argv) {
    if (argc != 5) return 2;
    int listener = socket(AF_UNIX, SOCK_STREAM, 0);
    struct sockaddr_un address = { .sun_family = AF_UNIX };
    if (strlen(argv[1]) >= sizeof(address.sun_path)) return 3;
    strcpy(address.sun_path, argv[1]);
    if (bind(listener, (struct sockaddr *)&address, sizeof(address)) || listen(listener, 1)) return 4;
    pid_t child = fork();
    if (child == 0) {
        close(listener);
        int client = socket(AF_UNIX, SOCK_STREAM, 0);
        if (connect(client, (struct sockaddr *)&address, sizeof(address))) _exit(5);
        pid_t peer_pid = 0; uid_t peer_uid = 0;
        int proof = mochi_update_peer(client, argv[2], argv[3], &peer_pid, &peer_uid);
        int ok = proof == atoi(argv[4]) && (!proof || (peer_pid == getppid() && peer_uid == geteuid()));
        char result; read(client, &result, 1); close(client); _exit(ok ? 0 : 6);
    }
    int peer = accept(listener, NULL, NULL);
    pid_t pid = 0; uid_t uid = 0;
    int valid = mochi_update_peer(peer, argv[2], argv[3], &pid, &uid);
    int expected = atoi(argv[4]);
    int ok = valid == expected && (!valid || (pid == child && uid == geteuid()));
    write(peer, "x", 1); close(peer); close(listener);
    int child_status = 0; waitpid(child, &child_status, 0); unlink(argv[1]);
    ok = ok && WIFEXITED(child_status) && WEXITSTATUS(child_status) == 0;
    printf("peer proof: %s\n", ok ? "passed" : "failed");
    return ok ? 0 : 1;
}
