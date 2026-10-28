#import <AppKit/AppKit.h>

extern void mochi_configure_settings_window(void *pointer);
extern void mochi_configure_window(void *pointer);
extern int mochi_prepare_webviews(void);
extern void mochi_plan_window(void *pointer, int surface,
  void (*completion)(int, double, double, double, double, double, double, double, double, int));
extern void mochi_place_window(void *pointer, double x, double y, double width,
  double height, int surface, void (*completion)(int));
static void check(BOOL condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}

// The pinned SDK boundary, without loading a second AppKit host in this test.
@interface WKWebViewImpl : NSObject
@property BOOL fullSize;
@property BOOL inspectorAttached;
- (BOOL)shouldSuppressMirrorMode;
@end
@implementation WKWebViewImpl
- (BOOL)shouldSuppressMirrorMode { return self.inspectorAttached; }
@end

static void checkRootViewPolicy(void) {
  WKWebViewImpl *root = [WKWebViewImpl new];
  root.fullSize = YES;
  WKWebViewImpl *embedded = [WKWebViewImpl new];
  check(!root.shouldSuppressMirrorMode, "fixture must reproduce the SDK's root mirroring");
  check(mochi_prepare_webviews() == 1, "pinned native webview contract unavailable");
  check(root.shouldSuppressMirrorMode, "root renderer can still be moved offscreen");
  check(!embedded.shouldSuppressMirrorMode, "embedded view lost its SDK policy");
  embedded.inspectorAttached = YES;
  check(embedded.shouldSuppressMirrorMode, "SDK inspector policy was not preserved");
  check(mochi_prepare_webviews() == 1 && root.shouldSuppressMirrorMode,
    "preparing a second host must not replace the original implementation again");
}

static int placement = -2;
static void placed(int value) { placement = value; }
static void place(NSWindow *window, int surface) {
  placement = -2;
  mochi_place_window((__bridge void *)window, 50, 50, 520, 700, surface, placed);
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
  while (placement == -2 && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  check(placement == 0, "native placement did not finish");
}

static void finishConfiguration(NSWindow *window) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:2];
  while (window.opaque && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  check(!window.opaque, "native configuration did not finish");
}

static NSWindow *makeWindow(void) {
  NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1040, 716)
    styleMask:NSWindowStyleMaskTitled | NSWindowStyleMaskResizable |
      NSWindowStyleMaskFullSizeContentView
    backing:NSBackingStoreBuffered defer:NO];
  window.releasedWhenClosed = NO;
  return window;
}

static int plannedStatus = -2, plannedVisible = -1;
static void planned(int status, double x, double y, double width, double height,
  double tx, double ty, double tw, double th, int visible) {
  plannedStatus = status;
  plannedVisible = visible;
  check(width > 0 && height > 0 && tw > 0 && th > 0, "native plan has invalid geometry");
}

int main(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    checkRootViewPolicy();
    NSWindow *window = makeWindow();
    mochi_plan_window((__bridge void *)window, 1, planned);
    NSDate *planDeadline = [NSDate dateWithTimeIntervalSinceNow:2];
    while (plannedStatus == -2 && planDeadline.timeIntervalSinceNow > 0)
      [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
    check(plannedStatus == 0 && plannedVisible == 0,
      "a window that was never ordered in must not require animation paint");
    check(!window.visible, "planning must not bring a hidden window forward");
    NSView *content = window.contentView;
    NSView *webview = [[NSView alloc] initWithFrame:content.bounds];
    [content addSubview:webview];
    mochi_configure_settings_window((__bridge void *)window);
    finishConfiguration(window);
    check(window.contentView == content, "Electrobun content view was replaced");
    check(content.subviews.count == 2 && content.subviews.lastObject == webview,
      "material must stay behind the existing renderer");
    NSVisualEffectView *material = (NSVisualEffectView *)content.subviews.firstObject;
    check([material isKindOfClass:NSVisualEffectView.class], "native material is missing");
    check(material.material == NSVisualEffectMaterialSidebar &&
      material.blendingMode == NSVisualEffectBlendingModeBehindWindow &&
      material.state == NSVisualEffectStateFollowsWindowActiveState,
      "material must sample the desktop and follow window activity");
    check(window.backgroundColor.alphaComponent == 0 && window.hasShadow,
      "opaque window background would conceal the material");
    check(NSEqualSizes(window.minSize, NSMakeSize(640, 540)), "minimum window size changed");
    [window setContentSize:NSMakeSize(880, 580)];
    check(NSEqualRects(material.frame, content.bounds), "material did not follow window resize");
    [window close];

    NSWindow *companion = makeWindow();
    mochi_configure_window((__bridge void *)companion);
    finishConfiguration(companion);
    check(companion.contentView.subviews.count == 0, "Settings material leaked into the character window");
    NSView *companionContent = companion.contentView;
    NSView *renderer = [[NSView alloc] initWithFrame:companionContent.bounds];
    [companionContent addSubview:renderer];
    place(companion, 2);
    NSVisualEffectView *felt = (NSVisualEffectView *)companionContent.subviews.firstObject;
    check([felt isKindOfClass:NSVisualEffectView.class] && !felt.hidden &&
      companionContent.subviews.lastObject == renderer, "daily material must be behind renderer");
    check(felt.blendingMode == NSVisualEffectBlendingModeBehindWindow &&
      felt.material == NSVisualEffectMaterialUnderWindowBackground && felt.state == NSVisualEffectStateActive,
      "daily landing must use native desktop blur");
    check(felt.alphaValue == 1 && felt.appearance != nil,
      "blur must remain complete and keep the product's light appearance");
    [companion setContentSize:NSMakeSize(400, 620)];
    check(NSEqualRects(felt.frame, companionContent.bounds), "felt did not follow resize");
    for (NSNumber *surface in @[@(-1), @(0), @(1), @(3)]) {
      place(companion, surface.intValue);
      check(felt.hidden, "blur must not fill the desktop during performance, setup or handoff");
      check(![companion standardWindowButton:NSWindowCloseButton] ||
        [companion standardWindowButton:NSWindowCloseButton].hidden,
        "transparent paper stages must not leave detached titlebar controls");
    }
    place(companion, 2);
    check((companion.styleMask & NSWindowStyleMaskTitled) != 0 &&
      ![companion standardWindowButton:NSWindowCloseButton].hidden,
      "daily companion must restore its native window controls");
    check(!felt.hidden && companionContent.subviews.count == 2 &&
      companionContent.subviews.firstObject == felt,
      "daily material must be reused without replacing the renderer");
    [companion close];
    NSWindow *setup = makeWindow();
    place(setup, 1);
    __block BOOL closed = NO;
    id observer = [NSNotificationCenter.defaultCenter addObserverForName:NSWindowWillCloseNotification
      object:setup queue:nil usingBlock:^(NSNotification *notification) { closed = YES; }];
    [setup performClose:nil];
    check(closed, "setup must retain native Close Window / Cmd-W behavior");
    [NSNotificationCenter.defaultCenter removeObserver:observer];
    puts("settings material contract passed");
  }
}
