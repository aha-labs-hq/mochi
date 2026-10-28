#import <AppKit/AppKit.h>

// UI only. The host supplies current facts and executes closed menu intents.
// Electrobun 2.0.1's Tray serializer drops key equivalents and has no header view.
// Own one native status item instead of patching the SDK or adding a WebView.
@interface MochiMenuBar : NSObject
@property NSStatusItem *item;
@property NSTextField *status;
@property NSTextField *environment;
@property NSImageView *indicator;
@property NSMenuItem *service;
@property NSMenuItem *serviceDivider;
@property NSMutableDictionary<NSString *, NSImage *> *icons;
@property NSString *iconName;
@property void (*action)(const char *);
@end

static MochiMenuBar *mochiMenuBar;

static NSTextField *mochi_menu_label(NSString *text, CGFloat size, NSFontWeight weight) {
  NSTextField *label = [NSTextField labelWithString:text];
  label.font = [NSFont systemFontOfSize:size weight:weight];
  label.textColor = NSColor.labelColor;
  label.lineBreakMode = NSLineBreakByTruncatingTail;
  label.maximumNumberOfLines = 1;
  return label;
}

// Mochi's upright pillow silhouette: the ears grow out of the body instead
// of a separate oversized head. State lives in the character, never a badge.
static NSImage *mochi_menu_symbol(NSString *state) {
  BOOL asleep = [state isEqualToString:@"sleeping"];
  BOOL looking = [state isEqualToString:@"replying"];
  BOOL thinking = [state isEqualToString:@"organizing"];
  BOOL full = [state isEqualToString:@"full"];
  BOOL preparing = [state isEqualToString:@"connecting"];
  BOOL attention = [state isEqualToString:@"attention"];
  NSImage *image = [NSImage imageWithSize:NSMakeSize(20, 18) flipped:NO drawingHandler:^BOOL(NSRect rect) {
    CGContextRef context = NSGraphicsContext.currentContext.CGContext;
    CGContextSaveGState(context);
    if (asleep) {
      CGContextTranslateCTM(context, -1.1, 1.8);
      CGContextScaleCTM(context, 1.11, .73);
    } else if (preparing) {
      CGContextTranslateCTM(context, 0, -2.5);
      CGContextClipToRect(context, CGRectMake(0, 4, 20, 18));
    } else if (thinking) {
      CGContextTranslateCTM(context, 10, 8);
      CGContextRotateCTM(context, -.12);
      CGContextTranslateCTM(context, -10, -8);
    }
    NSBezierPath *body = [NSBezierPath bezierPath];
    [body moveToPoint:NSMakePoint(3.2, 4)];
    [body curveToPoint:NSMakePoint(3.5, 11.5) controlPoint1:NSMakePoint(3.1, 6) controlPoint2:NSMakePoint(3.5, 9.3)];
    [body curveToPoint:NSMakePoint(3.5, 15.8) controlPoint1:NSMakePoint(3.5, 13) controlPoint2:NSMakePoint(3, 15.2)];
    [body curveToPoint:NSMakePoint(4.8, 16.1) controlPoint1:NSMakePoint(3.8, 16.4) controlPoint2:NSMakePoint(4.2, 16.5)];
    [body lineToPoint:NSMakePoint(7.9, 13.7)];
    [body curveToPoint:NSMakePoint(12.1, 13.7) controlPoint1:NSMakePoint(9.3, 14) controlPoint2:NSMakePoint(10.7, 14)];
    [body lineToPoint:NSMakePoint(15.1, attention ? 16.8 : 16.2)];
    [body curveToPoint:NSMakePoint(16.4, 15.8) controlPoint1:NSMakePoint(15.7, 16.7) controlPoint2:NSMakePoint(16.4, 16.6)];
    [body curveToPoint:NSMakePoint(16.5, 11.5) controlPoint1:NSMakePoint(16.6, 14.5) controlPoint2:NSMakePoint(16.2, 13.1)];
    [body curveToPoint:NSMakePoint(16.9, 4) controlPoint1:NSMakePoint(16.5, 9.5) controlPoint2:NSMakePoint(17, 6.2)];
    [body curveToPoint:NSMakePoint(14.5, 1.8) controlPoint1:NSMakePoint(16.8, 2.3) controlPoint2:NSMakePoint(16, 1.7)];
    [body curveToPoint:NSMakePoint(5.5, 1.8) controlPoint1:NSMakePoint(11.5, 1.5) controlPoint2:NSMakePoint(8.5, 1.5)];
    [body curveToPoint:NSMakePoint(3.2, 4) controlPoint1:NSMakePoint(3.9, 1.7) controlPoint2:NSMakePoint(3.1, 2.6)];
    [body closePath];
    [NSColor.blackColor setFill];
    [body fill];
    CGContextSetBlendMode(context, kCGBlendModeClear);
    CGFloat gaze = looking ? .8 : thinking ? -.45 : 0;
    for (NSNumber *center in @[@7.1, @12.9]) {
      CGFloat x = center.doubleValue;
      if (asleep || full) {
        NSBezierPath *eye = [NSBezierPath bezierPath];
        [eye moveToPoint:NSMakePoint(x - 1.15, 9.2)];
        [eye curveToPoint:NSMakePoint(x + 1.15, 9.2) controlPoint1:NSMakePoint(x - .45, full ? 9 : 8.1) controlPoint2:NSMakePoint(x + .45, full ? 9 : 8.1)];
        eye.lineWidth = .85;
        eye.lineCapStyle = NSLineCapStyleRound;
        [eye stroke];
      } else {
        CGFloat height = thinking ? 1.7 : 3.25;
        [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x - 1.6, 9.3 - height / 2, 3.2, height)] fill];
        if (!thinking) {
          CGContextSetBlendMode(context, kCGBlendModeNormal);
          CGFloat pupil = attention ? 1.15 : 1.65;
          [[NSBezierPath bezierPathWithOvalInRect:NSMakeRect(x + gaze - pupil / 2, 9.7 - pupil / 2, pupil, pupil)] fill];
          CGContextSetBlendMode(context, kCGBlendModeClear);
        }
      }
    }
    NSBezierPath *nose = [NSBezierPath bezierPath];
    [nose moveToPoint:NSMakePoint(9.5 + gaze, 7.2)];
    [nose lineToPoint:NSMakePoint(10.5 + gaze, 7.2)];
    [nose curveToPoint:NSMakePoint(10 + gaze, 6.5) controlPoint1:NSMakePoint(10.7 + gaze, 7.1) controlPoint2:NSMakePoint(10.3 + gaze, 6.7)];
    [nose curveToPoint:NSMakePoint(9.5 + gaze, 7.2) controlPoint1:NSMakePoint(9.7 + gaze, 6.7) controlPoint2:NSMakePoint(9.3 + gaze, 7.1)];
    [nose fill];
    CGContextRestoreGState(context);
    return YES;
  }];
  image.template = YES;
  image.accessibilityDescription = @"Mochi";
  return image;
}

@implementation MochiMenuBar
- (NSMenuItem *)command:(NSString *)title action:(NSString *)action key:(NSString *)key symbol:(NSString *)symbol {
  NSMenuItem *item = [[NSMenuItem alloc] initWithTitle:title action:@selector(select:) keyEquivalent:key];
  item.target = self;
  item.representedObject = action;
  if (key.length) item.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  if (symbol) {
    item.image = [NSImage imageWithSystemSymbolName:symbol accessibilityDescription:nil];
    item.image.size = NSMakeSize(16, 16);
  }
  return item;
}
- (void)select:(NSMenuItem *)sender {
  self.action([sender.representedObject UTF8String]);
}
- (instancetype)initWithIcon:(NSImage *)icon action:(void (*)(const char *))action {
  self = [super init];
  if (!self) return nil;
  self.action = action;
  self.item = [[NSStatusBar systemStatusBar] statusItemWithLength:NSSquareStatusItemLength];
  self.item.autosaveName = @"MochiMenuBar";
  self.icons = [NSMutableDictionary dictionary];
  self.item.button.accessibilityLabel = @"Mochi";
  NSMenu *menu = [[NSMenu alloc] initWithTitle:@"Mochi"];
  menu.autoenablesItems = NO;
  menu.minimumWidth = 264;

  NSView *header = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, 264, 62)];
  NSImageView *avatar = [[NSImageView alloc] initWithFrame:NSMakeRect(14, 14, 34, 34)];
  avatar.image = icon;
  avatar.imageScaling = NSImageScaleProportionallyUpOrDown;
  avatar.accessibilityElement = NO;
  [header addSubview:avatar];
  NSTextField *name = mochi_menu_label(@"Mochi", 14, NSFontWeightSemibold);
  NSFontDescriptor *rounded = [name.font.fontDescriptor fontDescriptorWithDesign:NSFontDescriptorSystemDesignRounded];
  name.font = [NSFont fontWithDescriptor:rounded size:14];
  name.frame = NSMakeRect(59, 33, 60, 19);
  [header addSubview:name];
  self.environment = mochi_menu_label(@"开发版", 10, NSFontWeightRegular);
  self.environment.textColor = NSColor.secondaryLabelColor;
  self.environment.frame = NSMakeRect(116, 35, 54, 14);
  [header addSubview:self.environment];
  self.indicator = [[NSImageView alloc] initWithFrame:NSMakeRect(60, 17, 6, 6)];
  self.indicator.image = [NSImage imageWithSystemSymbolName:@"circle.fill" accessibilityDescription:nil];
  self.indicator.accessibilityElement = NO;
  [header addSubview:self.indicator];
  self.status = mochi_menu_label(@"", 12, NSFontWeightRegular);
  self.status.textColor = NSColor.secondaryLabelColor;
  self.status.frame = NSMakeRect(71, 11, 179, 18);
  [header addSubview:self.status];
  NSMenuItem *heading = [[NSMenuItem alloc] initWithTitle:@"Mochi" action:nil keyEquivalent:@""];
  heading.view = header;
  [menu addItem:heading];
  [menu addItem:NSMenuItem.separatorItem];
  [menu addItem:[self command:@"显示 Mochi" action:@"show" key:@"0" symbol:@"macwindow"]];
  [menu addItem:[self command:@"设置…" action:@"settings" key:@"," symbol:@"gearshape"]];
  self.serviceDivider = NSMenuItem.separatorItem;
  [menu addItem:self.serviceDivider];
  self.service = [self command:@"" action:@"" key:@"" symbol:@"moon"];
  self.service.enabled = NO;
  self.service.hidden = YES;
  [menu addItem:self.service];
  [menu addItem:NSMenuItem.separatorItem];
  [menu addItem:[self command:@"退出 Mochi" action:@"quit" key:@"q" symbol:nil]];
  self.item.menu = menu;
  return self;
}
- (void)update:(NSDictionary *)state {
  NSString *iconName = state[@"icon"];
  if (![iconName isEqualToString:self.iconName]) {
    if (!self.icons[iconName]) self.icons[iconName] = mochi_menu_symbol(iconName);
    self.item.button.image = self.icons[iconName];
    self.iconName = iconName;
  }
  self.status.stringValue = state[@"status"];
  self.status.toolTip = state[@"detail"];
  self.environment.hidden = ![state[@"development"] boolValue];
  NSDictionary *colors = @{@"quiet": NSColor.tertiaryLabelColor, @"good": NSColor.systemGreenColor,
    @"pending": NSColor.systemOrangeColor, @"attention": NSColor.systemOrangeColor};
  self.indicator.contentTintColor = colors[state[@"tone"]];
  self.item.button.toolTip = [NSString stringWithFormat:@"Mochi · %@\n%@", state[@"status"], state[@"detail"]];
  self.item.button.accessibilityValue = state[@"status"];
  self.service.title = state[@"serviceTitle"];
  self.service.representedObject = state[@"serviceOperation"];
  self.service.enabled = [state[@"serviceEnabled"] boolValue];
  self.service.hidden = ![state[@"serviceVisible"] boolValue];
  self.serviceDivider.hidden = self.service.hidden;
  BOOL starting = [state[@"serviceOperation"] isEqualToString:@"start"];
  self.service.image = [NSImage imageWithSystemSymbolName:starting ? @"play" : @"moon" accessibilityDescription:nil];
  self.service.image.size = NSMakeSize(16, 16);
  self.service.toolTip = starting ? @"继续接收群消息，保留原有工作记忆。" : @"停止接收群消息；正在处理的工作会中止，工作记录保留。";
}
@end

__attribute__((visibility("default"))) void mochi_create_menu_bar(
    const char *iconPath, const char *json, void (*action)(const char *), void (*completion)(int)) {
  NSString *path = [NSString stringWithUTF8String:iconPath];
  NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  dispatch_async(dispatch_get_main_queue(), ^{
    NSImage *icon = [[NSImage alloc] initWithContentsOfFile:path];
    if (mochiMenuBar || !icon || !action) { completion(-1); return; }
    mochiMenuBar = [[MochiMenuBar alloc] initWithIcon:icon action:action];
    [mochiMenuBar update:state];
    completion(mochiMenuBar.item.button ? 0 : -1);
  });
}

__attribute__((visibility("default"))) void mochi_update_menu_bar(const char *json) {
  // Copy before crossing queues. This is an internal host ABI, not a renderer RPC.
  NSData *data = [[NSString stringWithUTF8String:json] dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data options:0 error:NULL];
  dispatch_async(dispatch_get_main_queue(), ^{ [mochiMenuBar update:state]; });
}
