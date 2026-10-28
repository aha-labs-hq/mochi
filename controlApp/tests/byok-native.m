#import <AppKit/AppKit.h>
#include <string.h>
extern void mochi_prompt_byok(char *, unsigned long, char *, unsigned long,
  char *, unsigned long, char *, unsigned long, void (*)(int));
extern void mochi_finish_byok_attempt(const char *, int, int);
// A locked desktop has no key window. Supply only that lookup so the actual
// AppKit sheet and production callbacks can be exercised without UI access.
@interface ByokTestApplication : NSApplication
@property(nonatomic, strong) NSWindow *testWindow;
@end
@implementation ByokTestApplication
- (NSWindow *)keyWindow { return self.testWindow; }
@end
static char base[8193], model[469], label[481], key[4097];
static int callbackStatus = -9, submissions = 0;
static void completed(int value) { callbackStatus = value; if (value == 1) submissions++; }
static void check(BOOL condition, const char *message) {
  if (!condition) { fprintf(stderr, "%s\n", message); exit(1); }
}
static void waitFor(BOOL (^condition)(void)) {
  NSDate *deadline = [NSDate dateWithTimeIntervalSinceNow:3];
  while (!condition() && deadline.timeIntervalSinceNow > 0)
    [NSRunLoop.currentRunLoop runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.01]];
  check(condition(), "Native BYOK callback timed out");
}
static NSView *find(NSView *view, NSString *name) {
  if ([view isKindOfClass:NSTextField.class] && ((NSTextField *)view).editable && [view.accessibilityLabel isEqualToString:name]) return view;
  for (NSView *child in view.subviews) { NSView *match = find(child, name); if (match) return match; }
  return nil;
}
static NSButton *button(NSView *view, NSString *name) {
  if ([view isKindOfClass:NSButton.class] && [((NSButton *)view).title isEqualToString:name]) return (NSButton *)view;
  for (NSView *child in view.subviews) { NSButton *match = button(child, name); if (match) return match; }
  return nil;
}
static void snapshot(NSWindow *sheet, NSString *path) {
  if (!path) return;
  [sheet.contentView layoutSubtreeIfNeeded];
  NSBitmapImageRep *bitmap = [sheet.contentView bitmapImageRepForCachingDisplayInRect:sheet.contentView.bounds];
  [sheet.contentView cacheDisplayInRect:sheet.contentView.bounds toBitmapImageRep:bitmap];
  [[bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}] writeToFile:path atomically:YES];
}
static void begin(NSWindow *window) {
  callbackStatus = -9;
  [window makeKeyWindow];
  mochi_prompt_byok(base, sizeof(base), model, sizeof(model), label, sizeof(label), key, sizeof(key), completed);
  waitFor(^BOOL { return window.attachedSheet != nil || callbackStatus == -1; });
  check(callbackStatus != -1, "Native BYOK sheet could not open");
}
static void seed(char *destination, unsigned long capacity, const char *value) {
  strncpy(destination, value, capacity - 1);
  destination[capacity - 1] = 0;
}
int main(int argc, const char *argv[]) {
  @autoreleasepool {
    [ByokTestApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    [NSApp finishLaunching];
    NSWindow *window = [[NSWindow alloc] initWithContentRect:NSMakeRect(0, 0, 1040, 716)
      styleMask:NSWindowStyleMaskTitled backing:NSBackingStoreBuffered defer:NO];
    window.releasedWhenClosed = NO;
    ((ByokTestApplication *)NSApp).testWindow = window;
    begin(window);
    NSWindow *sheet = window.attachedSheet;
    NSSecureTextField *secret = (NSSecureTextField *)find(sheet.contentView, @"API Key");
    check([secret isKindOfClass:NSSecureTextField.class], "API key must be a native secure field");
    NSTextField *endpoint = (NSTextField *)find(sheet.contentView, @"API 地址");
    NSTextField *modelField = (NSTextField *)find(sheet.contentView, @"模型名称");
    NSTextField *labelField = (NSTextField *)find(sheet.contentView, @"连接名称");
    check(!endpoint.hidden && !modelField.hidden && !labelField.hidden, "Model API fields must be visible");
    check([modelField.placeholderString isEqualToString:@"gpt-6-sol"], "Model placeholder must use the current default model");
    NSButton *accept = button(sheet.contentView, @"验证并连接");
    check(accept && !accept.enabled, "Empty key must not submit");
    endpoint.stringValue = @"https://example.com/v1";
    modelField.stringValue = @"gpt-5";
    labelField.stringValue = @"Example";
    secret.stringValue = @"fixture-key-not-live";
    [NSNotificationCenter.defaultCenter postNotificationName:NSControlTextDidChangeNotification object:secret];
    snapshot(sheet, argc > 1 ? [NSString stringWithUTF8String:argv[1]] : nil);
    [accept performClick:nil];
    waitFor(^BOOL { return callbackStatus == 1; });
    check(window.attachedSheet == sheet && !accept.enabled, "Validation must retain sheet and prevent duplicate submission");
    check(strcmp(key, "fixture-key-not-live") == 0 && strcmp(model, "gpt-5") == 0, "Native submit must supply the input once");
    [accept performClick:nil];
    check(submissions == 1, "Pending click submitted twice");
    mochi_finish_byok_attempt("请填写以 https:// 开头的 API 地址。", 0, 0);
    waitFor(^BOOL { return accept.enabled; });
    check(window.attachedSheet == sheet && !endpoint.hidden, "Correction must retain model API fields in the same sheet");
    check([secret.stringValue isEqualToString:@"fixture-key-not-live"], "Failed validation erased the draft");
    check(sheet.firstResponder == endpoint.currentEditor, "Correction should focus its field");
    NSRect keyRect = secret.frame, endpointRect = endpoint.frame;
    check(keyRect.origin.x == endpointRect.origin.x && keyRect.size.width == endpointRect.size.width,
      "Native field alignment differs");
    check(NSMaxY(keyRect) < NSMinY(endpointRect), "Native fields overlap");
    snapshot(sheet, argc > 2 ? [NSString stringWithUTF8String:argv[2]] : nil);
    NSButton *cancel = button(sheet.contentView, @"取消");
    [cancel performClick:nil];
    waitFor(^BOOL { return callbackStatus == 0; });
    check(secret.stringValue.length == 0 && key[0] == 0, "Cancel must erase the native key and callback buffer");
    begin(window);
    sheet = window.attachedSheet;
    secret = (NSSecureTextField *)find(sheet.contentView, @"API Key");
    check(secret.stringValue.length == 0, "A new dialog must not inherit a canceled key");
    endpoint = (NSTextField *)find(sheet.contentView, @"API 地址");
    modelField = (NSTextField *)find(sheet.contentView, @"模型名称");
    labelField = (NSTextField *)find(sheet.contentView, @"连接名称");
    endpoint.stringValue = @"https://example.com/v1";
    modelField.stringValue = @"gpt-5";
    labelField.stringValue = @"Example";
    secret.stringValue = @"second-fixture";
    [NSNotificationCenter.defaultCenter postNotificationName:NSControlTextDidChangeNotification object:secret];
    [button(sheet.contentView, @"验证并连接") performClick:nil];
    waitFor(^BOOL { return callbackStatus == 1; });
    mochi_finish_byok_attempt("", -1, 1);
    waitFor(^BOOL { return callbackStatus == 2; });
    check(secret.stringValue.length == 0 && key[0] == 0, "Success must erase the native draft");
    seed(base, sizeof(base), "https://api.example.com/v1");
    seed(model, sizeof(model), "gpt-5");
    seed(label, sizeof(label), "Example service");
    begin(window);
    sheet = window.attachedSheet;
    check([((NSTextField *)find(sheet.contentView, @"API 地址")).stringValue isEqualToString:@"https://api.example.com/v1"], "Edit must prefill the API address");
    check([((NSTextField *)find(sheet.contentView, @"模型名称")).stringValue isEqualToString:@"gpt-5"], "Edit must prefill the model");
    check([((NSTextField *)find(sheet.contentView, @"连接名称")).stringValue isEqualToString:@"Example service"], "Edit must prefill the connection name");
    check(((NSSecureTextField *)find(sheet.contentView, @"API Key")).stringValue.length == 0, "Edit must leave the key blank");
    [button(sheet.contentView, @"取消") performClick:nil];
    waitFor(^BOOL { return callbackStatus == 0; });
    [window close];
    puts("native BYOK correction, progress, cancellation and success passed");
  }
}
