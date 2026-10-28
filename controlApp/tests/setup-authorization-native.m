#import <Foundation/Foundation.h>
#include <stdatomic.h>
extern void mochi_authorize_setup(const char *, void (*)(int));
static atomic_int count = 0;
static int outcomes[3];
static void completed(int value) {
  int index = atomic_load(&count);
  if (index >= 3) abort();
  outcomes[index] = value;
  atomic_store(&count, index + 1);
}
int main(void) {
  @autoreleasepool {
    // Exercise the production queue and error conversion without a password,
    // an authorization request, a shell command, or an installed product.
    mochi_authorize_setup("delay 0.2\nreturn 1", completed);
    mochi_authorize_setup("error number -128", completed);
    mochi_authorize_setup("error number 65", completed);
    NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:5];
    __block int ticks = 0;
    NSTimer *timer = [NSTimer scheduledTimerWithTimeInterval:0.01 repeats:YES block:^(NSTimer *_) {
      ticks++;
    }];
    while (atomic_load(&count) < 3 && deadline.timeIntervalSinceNow > 0) {
      [NSRunLoop.currentRunLoop runMode:NSDefaultRunLoopMode beforeDate:deadline];
    }
    [timer invalidate];
    if (atomic_load(&count) != 3 || outcomes[0] != 0 || outcomes[1] != -128 || outcomes[2] != 65 || ticks < 2) {
      fprintf(stderr, "Setup queue did not preserve ordered structured outcomes and main-thread progress\n");
      return 1;
    }
    return 0;
  }
}
