#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <string.h>
#include <objc/runtime.h>

// Electrobun 2.0.1 mirrors inactive views by moving their NSView offscreen.
// A hidden root WKWebView can then finish loading without ever painting (seen
// on macOS 14 after fitting Settings to the display). Mochi's full-window web
// views have no overlapping browser views to route around: keep them in place.
// Preserve the SDK's own inspector/mirroring policy for embedded views.
static IMP mochi_original_suppress_mirror;
static IMP mochi_webview_full_size;
static BOOL mochi_suppress_root_mirror(id view, SEL selector) {
  return ((BOOL (*)(id, SEL))mochi_webview_full_size)(view, @selector(fullSize)) ||
    ((BOOL (*)(id, SEL))mochi_original_suppress_mirror)(view, selector);
}

__attribute__((visibility("default"))) int mochi_prepare_webviews(void) {
  static dispatch_once_t once;
  static int prepared;
  dispatch_once(&once, ^{
    Class view = NSClassFromString(@"WKWebViewImpl");
    Method suppression = class_getInstanceMethod(view, @selector(shouldSuppressMirrorMode));
    Method fullSize = class_getInstanceMethod(view, @selector(fullSize));
    if (!suppression || !fullSize) return;
    char suppressionType[8], fullSizeType[8];
    method_getReturnType(suppression, suppressionType, sizeof(suppressionType));
    method_getReturnType(fullSize, fullSizeType, sizeof(fullSizeType));
    if (strcmp(suppressionType, @encode(BOOL)) || strcmp(fullSizeType, @encode(BOOL))) return;
    mochi_webview_full_size = method_getImplementation(fullSize);
    mochi_original_suppress_mirror = method_setImplementation(suppression,
      (IMP)mochi_suppress_root_mirror);
    prepared = 1;
  });
  return prepared;
}

// Run the host-generated setup script in Mochi, so macOS identifies Mochi as
// the requester. No script or package choice crosses the renderer boundary.
// AppleScript work is serialized off the UI thread; the package still owns
// every privileged installation step. Only a numeric outcome leaves Cocoa.
__attribute__((visibility("default"))) void mochi_authorize_setup(const char *source,
    void (*completion)(int)) {
  NSString *text = [NSString stringWithUTF8String:source];
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ queue = dispatch_queue_create("app.mochi.setup-authorization", DISPATCH_QUEUE_SERIAL); });
  dispatch_async(queue, ^{
    @autoreleasepool {
      @try {
        NSDictionary *error = nil;
        NSAppleScript *script = [[NSAppleScript alloc] initWithSource:text];
        NSAppleEventDescriptor *result = [script executeAndReturnError:&error];
        NSNumber *number = error[NSAppleScriptErrorNumber];
        completion(result ? 0 : (number ? number.intValue : -1));
      } @catch (NSException *exception) {
        completion(-1);
      }
    }
  });
}

// Read the OS-owned authorization for our existing LaunchAgent. Registration
// and process lifecycle remain with DesktopService and the installer.
__attribute__((visibility("default"))) int mochi_background_status(const char *path) {
  @autoreleasepool {
    NSURL *url = [NSURL fileURLWithPath:[NSString stringWithUTF8String:path]];
    return (int)[SMAppService statusForLegacyURL:url];
  }
}

__attribute__((visibility("default"))) void mochi_open_login_items(void) {
  dispatch_async(dispatch_get_main_queue(), ^{
    [SMAppService openSystemSettingsLoginItems];
  });
}

// A tiny retained target lets a C-facing prompt own a Cocoa control action
// without moving credentials or UI state through the renderer.
@interface MochiActionTarget : NSObject
@property(nonatomic, copy) void (^handler)(NSButton *sender);
@end

@implementation MochiActionTarget
- (void)invoke:(NSButton *)sender { if (self.handler) self.handler(sender); }
@end

// The full-desktop performance temporarily auto-hides system chrome. This is
// an active-application presentation, never a write to the user's Dock settings.
// Restore on windowed handoff or close; changing apps remains unrestricted.
static __weak NSWindow *mochi_desktop_window;
static NSApplicationPresentationOptions mochi_saved_presentation;
static id mochi_desktop_close_observer;

static void mochi_end_desktop_presentation(void) {
  if (!mochi_desktop_close_observer) return;
  NSApp.presentationOptions = mochi_saved_presentation;
  [[NSNotificationCenter defaultCenter] removeObserver:mochi_desktop_close_observer];
  mochi_desktop_close_observer = nil;
  mochi_desktop_window = nil;
}

static void mochi_desktop_presentation(NSWindow *window, int surface) {
  if (surface == -1) return; // Preserve presentation while the paint-gated handoff runs.
  if (surface != 0 && surface != 3) { mochi_end_desktop_presentation(); return; }
  if (mochi_desktop_window == window) return;
  mochi_end_desktop_presentation();
  mochi_desktop_window = window;
  mochi_saved_presentation = NSApp.presentationOptions;
  NSApp.presentationOptions = NSApplicationPresentationAutoHideDock |
    NSApplicationPresentationAutoHideMenuBar;
  mochi_desktop_close_observer = [[NSNotificationCenter defaultCenter]
    addObserverForName:NSWindowWillCloseNotification object:window queue:nil
    usingBlock:^(NSNotification *notification) { mochi_end_desktop_presentation(); }];
}

// The daily landing is a translucent renderer layer over real desktop blur.
// Keep this view out of the full-desktop acting stage and transparent setup.
// It belongs to this window; Settings retains its separate material contract.
static void mochi_companion_material(NSWindow *window, BOOL visible) {
  NSView *content = window.contentView;
  NSVisualEffectView *material = nil;
  for (NSView *view in content.subviews)
    if ([view.identifier isEqualToString:@"mochi-companion-material"])
      material = (NSVisualEffectView *)view;
  if (!material && visible) {
    material = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
    material.identifier = @"mochi-companion-material";
    // UnderWindowBackground keeps the desktop present through a genuine blur;
    // the renderer adds the quiet ivory veil and the local felt landing.
    material.material = NSVisualEffectMaterialUnderWindowBackground;
    material.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    material.state = NSVisualEffectStateActive;
    material.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    // Keep the blur fully composed. Lowering the view's alpha leaks unfiltered
    // desktop detail through it; the renderer owns the thin felt tint instead.
    material.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:material positioned:NSWindowBelow relativeTo:nil];
  }
  material.hidden = !visible;
}

// Electrobun owns the window; this boundary supplies missing AppKit behavior only.
__attribute__((visibility("default"))) void mochi_configure_window(void *pointer) {
  NSWindow *window = (__bridge NSWindow *)pointer;
  dispatch_async(dispatch_get_main_queue(), ^{
    window.minSize = NSMakeSize(360, 509);
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
  });
}

// One system material behind Electrobun's transparent content view. React paints
// the reading panel opaque and exposes this material only through window chrome.
// AppKit owns desktop sampling, active/inactive appearance and material lifetime.
__attribute__((visibility("default"))) void mochi_configure_settings_window(void *pointer) {
  NSWindow *window = (__bridge NSWindow *)pointer;
  dispatch_async(dispatch_get_main_queue(), ^{
    window.minSize = NSMakeSize(640, 540);
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    window.appearance = [NSAppearance appearanceNamed:NSAppearanceNameAqua];
    window.hasShadow = YES;
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    NSView *content = window.contentView;
    NSVisualEffectView *backdrop = [[NSVisualEffectView alloc] initWithFrame:content.bounds];
    backdrop.material = NSVisualEffectMaterialSidebar;
    backdrop.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    backdrop.state = NSVisualEffectStateFollowsWindowActiveState;
    backdrop.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
    [content addSubview:backdrop positioned:NSWindowBelow relativeTo:nil];
    NSRect available = (window.screen ?: NSScreen.mainScreen).visibleFrame;
    NSRect frame = window.frame;
    frame.size.width = MIN(frame.size.width, available.size.width - 32);
    frame.size.height = MIN(frame.size.height, available.size.height - 32);
    frame.origin = NSMakePoint(NSMidX(available) - frame.size.width / 2,
      NSMidY(available) - frame.size.height / 2);
    [window setFrame:frame display:NO];
  });
}

// This preference records only an explicitly dismissed introduction. Connections
// and setup completion remain Bridge facts, never inferred from this flag.
__attribute__((visibility("default"))) int mochi_has_met(void) {
  return [[NSUserDefaults standardUserDefaults] boolForKey:@"MochiHasMetCompanion"];
}
__attribute__((visibility("default"))) void mochi_remember_meeting(void) {
  [[NSUserDefaults standardUserDefaults] setBool:YES forKey:@"MochiHasMetCompanion"];
}

__attribute__((visibility("default"))) int mochi_has_finished_setup(void) {
  return [[NSUserDefaults standardUserDefaults] boolForKey:@"MochiHasFinishedSetup"];
}
__attribute__((visibility("default"))) void mochi_remember_finished_setup(void) {
  [[NSUserDefaults standardUserDefaults] setBool:YES forKey:@"MochiHasFinishedSetup"];
}

// AppKit chooses the destination; the renderer never supplies desktop geometry.
// One NSWindow covers the union of source and destination during the handoff.
static NSRect mochi_target_frame(NSWindow *window, int surface) {
  NSScreen *screen = window.screen ?: NSScreen.mainScreen;
  if (!screen || surface < 0 || surface > 3) return NSZeroRect;
  NSRect available = screen.visibleFrame;
  if (surface == 0 || surface == 3) return screen.frame;
  NSSize size = surface == 1 ? NSMakeSize(960, 680) : NSMakeSize(400, 560);
  size.width = MIN(size.width, available.size.width - 32);
  size.height = MIN(size.height, available.size.height - 32);
  NSRect target = NSMakeRect(NSMidX(available) - size.width / 2,
    NSMidY(available) - size.height / 2, size.width, size.height);
  return target;
}

__attribute__((visibility("default"))) void mochi_plan_window(void *pointer, int surface,
    void (*completion)(int, double, double, double, double, double, double, double, double, int)) {
  NSWindow *window = (__bridge NSWindow *)pointer;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!window || surface < 0 || surface > 3) { completion(-1,0,0,0,0,0,0,0,0,0); return; }
    // Restore chrome before measuring the normal window's usable screen area.
    if (surface == 1 || surface == 2) mochi_end_desktop_presentation();
    NSRect target = mochi_target_frame(window, surface);
    if (NSIsEmptyRect(target)) { completion(-1,0,0,0,0,0,0,0,0,0); return; }
    NSRect source = window.frame;
    BOOL visible = !NSApp.hidden && window.visible && !window.miniaturized &&
      (window.occlusionState & NSWindowOcclusionStateVisible) != 0;
    completion(0, source.origin.x, source.origin.y, source.size.width, source.size.height,
      target.origin.x, target.origin.y, target.size.width, target.size.height, visible);
  });
}

__attribute__((visibility("default"))) void mochi_place_window(void *pointer,
    double x, double y, double width, double height, int surface, void (*completion)(int)) {
  NSWindow *window = (__bridge NSWindow *)pointer;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (!window || surface < -1 || surface > 3 || !isfinite(x) || !isfinite(y) ||
        !isfinite(width) || !isfinite(height) || width <= 0 || height <= 0) {
      completion(-1); return;
    }
    BOOL borderless = surface == -1 || surface == 0 || surface == 3;
    // Setup puts its visible close control and drag region on the paper.
    // Keep the titled native window underneath: performClose/Cmd-W relies
    // on that AppKit capability even when its traffic lights are hidden.
    BOOL hideNativeControls = borderless || surface == 1;
    window.minSize = surface == -1 ? NSMakeSize(1, 1)
      : surface == 3 ? NSMakeSize(320, 320)
      : surface == 2 ? NSMakeSize(360, 509)
      : NSMakeSize(MIN(740, width), MIN(560, height));
    window.opaque = NO;
    window.backgroundColor = NSColor.clearColor;
    // The felt surface owns its shadow. AppKit's shadow of a transparent,
    // changing silhouette leaves a second contour around the material.
    window.hasShadow = NO;
    window.styleMask = borderless ? NSWindowStyleMaskBorderless
      : NSWindowStyleMaskTitled | NSWindowStyleMaskClosable |
        NSWindowStyleMaskMiniaturizable | NSWindowStyleMaskResizable |
        NSWindowStyleMaskFullSizeContentView;
    window.titleVisibility = NSWindowTitleHidden;
    window.titlebarAppearsTransparent = YES;
    for (NSNumber *button in @[@(NSWindowCloseButton), @(NSWindowMiniaturizeButton), @(NSWindowZoomButton)])
      [window standardWindowButton:button.integerValue].hidden = hideNativeControls;
    [window setFrame:NSMakeRect(x, y, width, height) display:YES];
    mochi_companion_material(window, surface == 2);
    mochi_desktop_presentation(window, surface);
    completion(0);
  });
}
// A single product-owned uninstall decision; data deletion is never the default.
__attribute__((visibility("default"))) void mochi_choose_uninstall(void (*completion)(int)) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *parent = NSApp.mainWindow;
    if (!parent) { completion(-1); return; }
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = @"卸载 Mochi？";
    alert.informativeText = @"Mochi 会等已接工作和回复发送完成，再移除应用与后台组件。默认保留这台 Mac 上的伙伴、连接和记忆，重新安装后可以继续使用。飞书、GitHub 和模型服务上的授权需在对应服务中撤销。";
    NSButton *cancel = [alert addButtonWithTitle:@"取消"];
    NSButton *accept = [alert addButtonWithTitle:@"卸载并保留数据"];
    accept.keyEquivalent = @"";
    alert.window.defaultButtonCell = cancel.cell;
    MochiActionTarget *target = [[MochiActionTarget alloc] init];
    NSButton *remove = [NSButton checkboxWithTitle:@"同时永久删除此 Mac 上所有 Mochi 数据" target:target action:@selector(invoke:)];
    remove.frame = NSMakeRect(0, 0, 380, 28);
    remove.accessibilityHelp = @"包括所有伙伴、账号连接、设置、工作记忆和日志，删除后无法恢复。";
    alert.accessoryView = remove;
    target.handler = ^(NSButton *sender) {
      BOOL deleting = sender.state == NSControlStateValueOn;
      accept.title = deleting ? @"卸载并删除全部数据" : @"卸载并保留数据";
      accept.hasDestructiveAction = deleting;
      alert.informativeText = deleting
        ? @"这会永久删除此 Mac 上所有伙伴、账号连接、设置、工作记忆和日志，无法恢复。Mochi 会等已接工作和回复发送完成，再卸载。飞书、GitHub 和模型服务上的授权需在对应服务中撤销。"
        : @"Mochi 会等已接工作和回复发送完成，再移除应用与后台组件。默认保留这台 Mac 上的伙伴、连接和记忆，重新安装后可以继续使用。飞书、GitHub 和模型服务上的授权需在对应服务中撤销。";
    };
    id escape = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event) {
      if (event.window == alert.window && event.keyCode == 53) {
        [parent endSheet:alert.window returnCode:NSAlertFirstButtonReturn]; return nil;
      }
      return event;
    }];
    [alert beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) {
      [NSEvent removeMonitor:escape];
      target.handler = nil;
      completion(response == NSAlertSecondButtonReturn ? (remove.state == NSControlStateValueOn ? 2 : 1) : 0);
    }];
  });
}

// Electrobun 2.0.1's macOS alert ignores detail/defaultId/cancelId. Own this
// small NSAlert boundary explicitly instead of depending on ignored options.
__attribute__((visibility("default"))) void mochi_confirm(
    const char *title, const char *message, const char *acceptTitle,
    void (*completion)(int)) {
  NSString *heading = [NSString stringWithUTF8String:title];
  NSString *detail = [NSString stringWithUTF8String:message];
  NSString *acceptLabel = [NSString stringWithUTF8String:acceptTitle];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *parent = NSApp.mainWindow;
    if (!parent) { completion(-1); return; }
    NSAlert *alert = [[NSAlert alloc] init];
    alert.messageText = heading;
    alert.informativeText = detail;
    NSButton *cancel = [alert addButtonWithTitle:@"取消"];
    NSButton *accept = [alert addButtonWithTitle:acceptLabel];
    accept.keyEquivalent = @"";
    alert.window.defaultButtonCell = cancel.cell;
    // A button has one key equivalent. Keep Return on the safe default and
    // scope Escape to this modal window, regardless of the button's language.
    id escape = [NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown
        handler:^NSEvent *(NSEvent *event) {
      if (event.window == alert.window && event.keyCode == 53) {
        [parent endSheet:alert.window returnCode:NSAlertFirstButtonReturn];
        return nil;
      }
      return event;
    }];
    // A sheet does not block Bun's event loop or the framework's event pump.
    [alert beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) {
      [NSEvent removeMonitor:escape];
      completion(response == NSAlertSecondButtonReturn);
    }];
  });
}

// One native sheet owns a connection attempt and its corrections. The host
// validates fields and performs the request; native code only displays feedback.
static void (^mochi_byok_attempt_result)(NSString *, int, int);

static NSString *mochi_byok_initial_string(const char *value, unsigned long capacity) {
  if (!value || capacity < 1) return @"";
  size_t length = strnlen(value, capacity);
  if (length >= capacity) return @"";
  NSString *result = [[NSString alloc] initWithBytes:value length:length encoding:NSUTF8StringEncoding];
  return result ?: @"";
}

__attribute__((visibility("default"))) void mochi_finish_byok_attempt(
    const char *message, int field, int outcome) {
  NSString *copy = message ? [NSString stringWithUTF8String:message] : @"";
  dispatch_async(dispatch_get_main_queue(), ^{
    if (mochi_byok_attempt_result) mochi_byok_attempt_result(copy, field, outcome);
  });
}

__attribute__((visibility("default"))) void mochi_prompt_byok(
    char *base_url, unsigned long base_capacity,
    char *model, unsigned long model_capacity,
    char *label, unsigned long label_capacity,
    char *api_key, unsigned long api_key_capacity,
    void (*completion)(int)) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *parent = NSApp.keyWindow ?: NSApp.mainWindow;
    if (!parent || parent.attachedSheet || mochi_byok_attempt_result ||
        !base_url || !model || !label || !api_key || base_capacity < 2 ||
        model_capacity < 2 || label_capacity < 2 || api_key_capacity < 2) {
      completion(-1); return;
    }
    NSAlert *alert = [[NSAlert alloc] init];
    BOOL editing = base_url[0] || model[0] || label[0];
    alert.messageText = editing ? @"编辑模型 API 连接" : @"添加模型 API 连接";
    alert.informativeText = @"填写服务商提供的 API 地址、模型名称和连接名称。保存前会发送一次验证请求。";
    NSView *accessory = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 420, 210)];
    NSArray<NSString *> *names = @[@"API 地址", @"模型名称", @"连接名称", @"API Key"];
    NSArray<NSString *> *defaults = @[
      mochi_byok_initial_string(base_url, base_capacity),
      mochi_byok_initial_string(model, model_capacity),
      mochi_byok_initial_string(label, label_capacity),
      @"",
    ];
    NSArray<NSString *> *placeholders = @[@"https://api.openai.com/v1", @"gpt-6-sol", @"OpenAI", @"粘贴 API Key"];
    NSMutableArray<NSTextField *> *inputs = [NSMutableArray new];
    NSMutableArray<NSTextField *> *captions = [NSMutableArray new];
    for (NSUInteger index = 0; index < names.count; index++) {
      NSTextField *input = index == 3 ? [[NSSecureTextField alloc] initWithFrame:NSZeroRect]
        : [[NSTextField alloc] initWithFrame:NSZeroRect];
      input.placeholderString = placeholders[index];
      input.accessibilityLabel = names[index];
      input.stringValue = defaults[index];
      input.font = [NSFont systemFontOfSize:13];
      input.bezelStyle = NSTextFieldRoundedBezel;
      NSTextField *caption = [NSTextField labelWithString:names[index]];
      caption.font = [NSFont systemFontOfSize:12];
      [inputs addObject:input]; [captions addObject:caption];
      [accessory addSubview:caption]; [accessory addSubview:input];
    }
    NSTextField *feedback = [NSTextField wrappingLabelWithString:@""];
    feedback.font = [NSFont systemFontOfSize:12];
    feedback.textColor = NSColor.systemRedColor;
    feedback.hidden = YES;
    [accessory addSubview:feedback];
    alert.accessoryView = accessory;
    NSButton *cancel = [alert addButtonWithTitle:@"取消"];
    NSButton *accept = [alert addButtonWithTitle:@"验证并连接"];
    cancel.keyEquivalent = @"\033"; accept.keyEquivalent = @"\r";
    alert.window.defaultButtonCell = accept.cell;
    __block BOOL pending = NO;
    __block BOOL attempted = NO;
    void (^layout)(void) = ^{
      CGFloat errorHeight = feedback.hidden ? 0 : 64;
      CGFloat height = 210 + errorHeight;
      accessory.frame = NSMakeRect(0, 0, 420, height);
      for (NSUInteger index = 0; index < inputs.count; index++) {
        NSUInteger row = index;
        captions[index].frame = NSMakeRect(0, height - 16 - row * 52, 420, 16);
        inputs[index].frame = NSMakeRect(0, height - 46 - row * 52, 420, 28);
        captions[index].hidden = inputs[index].hidden = NO;
      }
      feedback.frame = NSMakeRect(0, 0, 420, 40);
      [alert layout];
    };
    void (^updateAccept)(void) = ^{
      accept.enabled = !pending && [inputs[0].stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length > 0
        && [inputs[1].stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length > 0
        && [inputs[2].stringValue stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length > 0
        && inputs[3].stringValue.length > 0;
      accept.title = pending ? @"正在验证…" : attempted ? @"重试连接" : @"验证并连接";
    };
    MochiActionTarget *submitTarget = [MochiActionTarget new];
    submitTarget.handler = ^(NSButton *sender) {
      if (pending) return;
      char *destinations[] = {base_url, model, label, api_key};
      unsigned long capacities[] = {base_capacity, model_capacity, label_capacity, api_key_capacity};
      for (NSUInteger index = 0; index < inputs.count; index++) {
        const char *value = inputs[index].stringValue.UTF8String;
        size_t length = strlen(value);
        if (length != [inputs[index].stringValue lengthOfBytesUsingEncoding:NSUTF8StringEncoding]) {
          mochi_byok_attempt_result(@"请检查这项内容，去掉不可见的控制字符。", (int)index, 0); return;
        }
        if (length + 1 > capacities[index]) {
          mochi_byok_attempt_result(@"这项内容太长，请检查粘贴的内容。", (int)index, 0); return;
        }
        memcpy(destinations[index], value, length + 1);
      }
      pending = YES; attempted = YES;
      feedback.hidden = NO; feedback.textColor = NSColor.secondaryLabelColor;
      feedback.stringValue = @"正在验证连接，请稍候。完成后会自动继续。";
      for (NSTextField *input in inputs) input.enabled = NO;
      cancel.enabled = NO;
      updateAccept(); layout();
      completion(1);
    };
    accept.target = submitTarget; accept.action = @selector(invoke:);
    id observer = [[NSNotificationCenter defaultCenter]
      addObserverForName:NSControlTextDidChangeNotification object:nil queue:nil
      usingBlock:^(NSNotification *notification) { if ([inputs containsObject:notification.object]) updateAccept(); }];
    mochi_byok_attempt_result = ^(NSString *message, int field, int outcome) {
      if (outcome != 0) {
        [parent endSheet:alert.window returnCode:outcome > 0 ? NSAlertSecondButtonReturn : NSAlertThirdButtonReturn];
        return;
      }
      pending = NO;
      feedback.hidden = NO; feedback.textColor = NSColor.systemRedColor;
      feedback.stringValue = message;
      for (NSTextField *input in inputs) input.enabled = YES;
      cancel.enabled = YES;
      layout(); updateAccept();
      if (field >= 0 && field < 4) {
        [alert.window makeFirstResponder:inputs[field]];
        [inputs[field] selectText:nil];
      }
      NSAccessibilityPostNotification(feedback, NSAccessibilityValueChangedNotification);
    };
    layout(); updateAccept();
    [alert beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) {
      [[NSNotificationCenter defaultCenter] removeObserver:observer];
      // Break all native UI ownership and erase the field on every exit path.
      submitTarget.handler = nil;
      mochi_byok_attempt_result = nil;
      inputs[3].stringValue = @"";
      memset(base_url, 0, base_capacity);
      memset(model, 0, model_capacity);
      memset(label, 0, label_capacity);
      memset(api_key, 0, api_key_capacity);
      completion(response == NSAlertSecondButtonReturn ? 2 : response == NSAlertThirdButtonReturn ? -1 : 0);
    }];
    dispatch_async(dispatch_get_main_queue(), ^{ [alert.window makeFirstResponder:inputs[3]]; });
  });
}

// Keep the save panel attached to the requesting App instead of an unowned osascript process.
__attribute__((visibility("default"))) void mochi_save_diagnostics(
    char *destination, unsigned long capacity, void (*completion)(int)) {
  dispatch_async(dispatch_get_main_queue(), ^{
    NSWindow *parent = NSApp.keyWindow ?: NSApp.mainWindow;
    if (!parent || parent.attachedSheet || !destination || capacity < 1) { completion(-1); return; }
    NSSavePanel *panel = [NSSavePanel savePanel];
    panel.title = @"保存 Mochi 诊断";
    panel.message = @"诊断文件不包含聊天正文、账号凭据或项目目录。";
    panel.nameFieldStringValue = @"Mochi-Diagnostics.json";
    panel.canCreateDirectories = YES;
    [NSApp activateIgnoringOtherApps:YES];
    [panel beginSheetModalForWindow:parent completionHandler:^(NSModalResponse response) {
      if (response != NSModalResponseOK) { completion(0); return; }
      completion([panel.URL getFileSystemRepresentation:destination maxLength:capacity] ? 1 : -1);
    }];
  });
}
