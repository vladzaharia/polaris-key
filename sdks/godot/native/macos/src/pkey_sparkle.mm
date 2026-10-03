// PKeySparkleNative: Sparkle 2 driven from a Godot macOS export (P5-07; notes/S-11 §4.1, §8).
//
// The GDScript facade is addons/polaris_key/native/pkey_sparkle.gd (PKeySparkle); this file is the
// native class it instantiates. Two modes:
//   "standard"  SPUStandardUpdaterController, Sparkle's own UI: what a game ships;
//   "headless"  SPUUpdater with an auto-accepting SPUUserDriver: unattended end-to-end tests only.
//
// Rules (SparkleAnchor.swift, notes/S-11):
//   - start() refuses off the main thread (Sparkle and AppKit need it; Godot's main thread is
//     AppKit's), without Sparkle.framework loaded ("dependency": it is WEAK-linked, so the
//     extension still loads when the framework is missing), and without SUPublicEDKey in the
//     bundle's Info.plist ("missing_public_key": Sparkle would accept unsigned updates);
//   - the bridge never verifies an update itself; SUPublicEDKey in the signed bundle is the anchor;
//   - the feed URL (from discovery) and the allowed channels go through SPUUpdaterDelegate, the
//     bearer through SPUUpdater.httpHeaders (Foundation drops it on a cross-origin redirect);
//   - every delegate and user-driver callback becomes `native_event(event, detail)` through
//     call_deferred (Sparkle calls back on the main thread; deferring keeps one pattern with the
//     Windows plugins, whose callbacks arrive on other threads).

#import <Cocoa/Cocoa.h>
#import <Sparkle/Sparkle.h>

#include <gdextension_interface.h>
#include <godot_cpp/classes/ref_counted.hpp>
#include <godot_cpp/core/class_db.hpp>
#include <godot_cpp/core/defs.hpp>
#include <godot_cpp/core/object.hpp>
#include <godot_cpp/godot.hpp>
#include <godot_cpp/variant/array.hpp>
#include <godot_cpp/variant/dictionary.hpp>
#include <godot_cpp/variant/packed_string_array.hpp>

#include <cstring>

// ── Conversions ─────────────────────────────────────────────────────────────────────────────

static godot::Variant pks_variant(id obj) {
  if (!obj || obj == [NSNull null]) return godot::Variant();
  if ([obj isKindOfClass:[NSString class]]) return godot::String::utf8([obj UTF8String]);
  if ([obj isKindOfClass:[NSNumber class]]) {
    const char *t = [obj objCType];
    if (strcmp(t, @encode(BOOL)) == 0 || strcmp(t, "c") == 0 || strcmp(t, "B") == 0) return (bool)[obj boolValue];
    if (strcmp(t, "d") == 0 || strcmp(t, "f") == 0) return [obj doubleValue];
    return (int64_t)[obj longLongValue];
  }
  if ([obj isKindOfClass:[NSDictionary class]]) {
    godot::Dictionary d;
    for (id k in obj) d[pks_variant(k)] = pks_variant(obj[k]);
    return d;
  }
  if ([obj isKindOfClass:[NSArray class]]) {
    godot::Array a;
    for (id v in obj) a.push_back(pks_variant(v));
    return a;
  }
  return godot::String::utf8([[obj description] UTF8String]);
}

static NSString *pks_ns(const godot::String &s) { return [NSString stringWithUTF8String:s.utf8().get_data()]; }

static NSDictionary *pks_item(SUAppcastItem *item) {
  if (!item) return @{};
  return @{
    @"version" : item.versionString ?: @"",
    @"short_version" : item.displayVersionString ?: @"",
    @"url" : item.fileURL.absoluteString ?: @"",
    @"length" : @(item.contentLength),
    @"critical" : @(item.criticalUpdate),
    @"delta" : @(item.deltaUpdate),
    @"channel" : item.channel ?: @"",
  };
}

static NSDictionary *pks_error(NSError *e) {
  if (!e) return @{};
  NSMutableDictionary *d = [@{
    @"domain" : e.domain ?: @"",
    @"code" : @(e.code),
    @"message" : e.localizedDescription ?: @"",
  } mutableCopy];
  NSError *u = e.userInfo[NSUnderlyingErrorKey];
  if (u) d[@"underlying"] = pks_error(u);
  if (e.localizedFailureReason) d[@"reason"] = e.localizedFailureReason;
  return d;
}

// Emit `native_event(event, detail)` on the Godot object `owner`, deferred to the main loop.
static void pks_emit(uint64_t owner, NSString *event, NSDictionary *detail) {
  godot::Object *o = godot::ObjectDB::get_instance(godot::ObjectID(owner));
  if (!o) return;
  godot::Variant d = detail ? pks_variant(detail) : godot::Variant(godot::Dictionary());
  o->call_deferred("emit_signal", "native_event", godot::String::utf8(event.UTF8String), d);
}

// ── Updater delegate: feed URL, channels, lifecycle events ──────────────────────────────────

@interface PKSDelegate : NSObject <SPUUpdaterDelegate>
@property(nonatomic, copy) NSString *feedURL;
@property(nonatomic, copy) NSSet<NSString *> *channels;
@property(nonatomic, assign) uint64_t owner;
@end

@implementation PKSDelegate
- (NSString *)feedURLStringForUpdater:(SPUUpdater *)updater {
  return self.feedURL;  // nil: SUFeedURL from Info.plist
}
- (NSSet<NSString *> *)allowedChannelsForUpdater:(SPUUpdater *)updater {
  return self.channels ?: [NSSet set];
}
- (void)updater:(SPUUpdater *)u didFinishLoadingAppcast:(SUAppcast *)appcast {
  pks_emit(self.owner, @"appcast_loaded", @{@"items" : @(appcast.items.count)});
}
- (void)updater:(SPUUpdater *)u didFindValidUpdate:(SUAppcastItem *)item {
  pks_emit(self.owner, @"update_found", pks_item(item));
}
- (void)updaterDidNotFindUpdate:(SPUUpdater *)u error:(NSError *)error {
  pks_emit(self.owner, @"no_update", pks_error(error));
}
- (void)updater:(SPUUpdater *)u willDownloadUpdate:(SUAppcastItem *)item withRequest:(NSMutableURLRequest *)request {
  pks_emit(self.owner, @"will_download", pks_item(item));
}
- (void)updater:(SPUUpdater *)u didDownloadUpdate:(SUAppcastItem *)item {
  pks_emit(self.owner, @"downloaded", pks_item(item));
}
- (void)updater:(SPUUpdater *)u failedToDownloadUpdate:(SUAppcastItem *)item error:(NSError *)error {
  pks_emit(self.owner, @"download_failed", @{@"item" : pks_item(item), @"error" : pks_error(error)});
}
- (void)updater:(SPUUpdater *)u willExtractUpdate:(SUAppcastItem *)item {
  pks_emit(self.owner, @"will_extract", pks_item(item));
}
- (void)updater:(SPUUpdater *)u didExtractUpdate:(SUAppcastItem *)item {
  pks_emit(self.owner, @"extracted", pks_item(item));
}
- (void)updater:(SPUUpdater *)u willInstallUpdate:(SUAppcastItem *)item {
  pks_emit(self.owner, @"will_install", pks_item(item));
}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)u {
  pks_emit(self.owner, @"will_relaunch", nil);
}
- (BOOL)updater:(SPUUpdater *)u willInstallUpdateOnQuit:(SUAppcastItem *)item immediateInstallationBlock:(void (^)(void))block {
  pks_emit(self.owner, @"will_install_on_quit", pks_item(item));
  return NO;  // install when the game quits normally
}
- (void)updater:(SPUUpdater *)u didAbortWithError:(NSError *)error {
  pks_emit(self.owner, @"aborted", pks_error(error));
}
- (void)updater:(SPUUpdater *)u didFinishUpdateCycleForUpdateCheck:(SPUUpdateCheck)check error:(NSError *)error {
  pks_emit(self.owner, @"cycle_finished", @{@"check" : @(check), @"error" : pks_error(error)});
}
@end

// ── Headless user driver: accepts every prompt (tests only) ─────────────────────────────────

@interface PKSAutoDriver : NSObject <SPUUserDriver>
@property(nonatomic, assign) uint64_t owner;
@end

@implementation PKSAutoDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request reply:(void (^)(SUUpdatePermissionResponse *))reply {
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  pks_emit(self.owner, @"driver_checking", nil);
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)item state:(SPUUserUpdateState *)state reply:(void (^)(SPUUserUpdateChoice))reply {
  pks_emit(self.owner, @"driver_update_found", @{@"item" : pks_item(item), @"stage" : @(state.stage)});
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))ack {
  pks_emit(self.owner, @"driver_not_found", pks_error(error));
  ack();
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))ack {
  pks_emit(self.owner, @"driver_error", pks_error(error));
  ack();
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  pks_emit(self.owner, @"driver_download_started", nil);
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)len {
  pks_emit(self.owner, @"driver_download_length", @{@"bytes" : @(len)});
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
}
- (void)showDownloadDidStartExtractingUpdate {
  pks_emit(self.owner, @"driver_extracting", nil);
}
- (void)showExtractionReceivedProgress:(double)progress {
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  pks_emit(self.owner, @"driver_ready_to_install", nil);
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)terminated retryTerminatingApplication:(void (^)(void))retry {
  pks_emit(self.owner, @"driver_installing", @{@"app_terminated" : @(terminated)});
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))ack {
  pks_emit(self.owner, @"driver_installed", @{@"relaunched" : @(relaunched)});
  ack();
}
- (void)showUpdateInFocus {
}
- (void)dismissUpdateInstallation {
}
@end

// ── The Godot class ─────────────────────────────────────────────────────────────────────────

class PKeySparkleNative : public godot::RefCounted {
  GDCLASS(PKeySparkleNative, godot::RefCounted)

  SPUStandardUpdaterController *controller_ = nil;
  SPUUpdater *updater_ = nil;
  PKSDelegate *delegate_ = nil;
  PKSAutoDriver *driver_ = nil;

  static godot::Dictionary fail(const char *code, NSString *msg = nil) {
    godot::Dictionary d;
    d["ok"] = false;
    d["error"] = code;
    if (msg) d["message"] = godot::String::utf8(msg.UTF8String);
    return d;
  }

  static NSDictionary *headers_of(const godot::Dictionary &headers) {
    NSMutableDictionary *h = [NSMutableDictionary dictionary];
    godot::Array keys = headers.keys();
    for (int64_t i = 0; i < keys.size(); i++) h[pks_ns(keys[i])] = pks_ns(headers[keys[i]]);
    return h;
  }

 protected:
  static void _bind_methods() {
    using godot::ClassDB;
    using godot::D_METHOD;
    ClassDB::bind_method(D_METHOD("bundle_info"), &PKeySparkleNative::bundle_info);
    ClassDB::bind_method(D_METHOD("start", "mode", "feed_url", "headers", "channels"), &PKeySparkleNative::start);
    ClassDB::bind_method(D_METHOD("check_for_updates"), &PKeySparkleNative::check_for_updates);
    ClassDB::bind_method(D_METHOD("check_in_background"), &PKeySparkleNative::check_in_background);
    ClassDB::bind_method(D_METHOD("set_feed_url", "url"), &PKeySparkleNative::set_feed_url);
    ClassDB::bind_method(D_METHOD("set_http_headers", "headers"), &PKeySparkleNative::set_http_headers);
    ClassDB::bind_method(D_METHOD("set_automatically_checks", "on"), &PKeySparkleNative::set_automatically_checks);
    ClassDB::bind_method(D_METHOD("set_automatically_downloads", "on"), &PKeySparkleNative::set_automatically_downloads);
    ClassDB::bind_method(D_METHOD("get_state"), &PKeySparkleNative::get_state);
    ADD_SIGNAL(godot::MethodInfo("native_event", godot::PropertyInfo(godot::Variant::STRING, "event"),
                                 godot::PropertyInfo(godot::Variant::DICTIONARY, "detail")));
  }

 public:
  // The running bundle as Sparkle sees it. The key itself is public; it is reported so a test can
  // tell a fixture bundle without one from a real one.
  godot::Dictionary bundle_info() {
    NSBundle *b = NSBundle.mainBundle;
    id pub = [b objectForInfoDictionaryKey:@"SUPublicEDKey"];
    godot::Dictionary d;
    d["path"] = godot::String::utf8(b.bundlePath.UTF8String);
    d["version"] = pks_variant([b objectForInfoDictionaryKey:@"CFBundleVersion"]);
    d["short_version"] = pks_variant([b objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);
    d["has_public_key"] = [pub isKindOfClass:[NSString class]] &&
                          [pub stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet].length > 0;
    d["feed_url"] = pks_variant([b objectForInfoDictionaryKey:@"SUFeedURL"]);
    d["sparkle_loaded"] = NSClassFromString(@"SPUUpdater") != nil;
    Class spu = NSClassFromString(@"SPUUpdater");
    d["sparkle_version"] = spu ? pks_variant([[NSBundle bundleForClass:spu] objectForInfoDictionaryKey:@"CFBundleShortVersionString"]) : godot::Variant();
    d["main_thread"] = (bool)[NSThread isMainThread];
    return d;
  }

  godot::Dictionary start(const godot::String &mode, const godot::String &feed_url, const godot::Dictionary &headers,
                          const godot::PackedStringArray &channels) {
    if (![NSThread isMainThread]) return fail("not_main_thread");
    if (NSClassFromString(@"SPUUpdater") == nil) return fail("dependency", @"Sparkle.framework is not loaded");
    if (!bool(bundle_info()["has_public_key"])) return fail("missing_public_key");
    if (updater_) return fail("already_started");

    delegate_ = [PKSDelegate new];
    delegate_.owner = get_instance_id();
    delegate_.feedURL = feed_url.is_empty() ? nil : pks_ns(feed_url);
    NSMutableSet *chs = [NSMutableSet set];
    for (int64_t i = 0; i < channels.size(); i++) [chs addObject:pks_ns(channels[i])];
    delegate_.channels = chs;

    NSDictionary *h = headers_of(headers);
    NSError *err = nil;
    SPUUpdater *u = nil;
    if (mode == godot::String("headless")) {
      driver_ = [PKSAutoDriver new];
      driver_.owner = get_instance_id();
      u = [[SPUUpdater alloc] initWithHostBundle:NSBundle.mainBundle applicationBundle:NSBundle.mainBundle userDriver:driver_ delegate:delegate_];
    } else if (mode == godot::String("standard")) {
      controller_ = [[SPUStandardUpdaterController alloc] initWithStartingUpdater:NO updaterDelegate:delegate_ userDriverDelegate:nil];
      u = controller_.updater;
    } else {
      return fail("bad_mode", pks_ns(mode));
    }
    u.httpHeaders = h.count ? h : nil;
    // The updater's own start, so a misconfiguration comes back as an error (the controller's
    // startUpdater would only log it and show an alert later).
    if (![u startUpdater:&err]) {
      controller_ = nil;
      driver_ = nil;
      godot::Dictionary d = fail("start_failed", err.localizedDescription);
      d["detail"] = pks_variant(pks_error(err));
      return d;
    }
    updater_ = u;
    godot::Dictionary ok;
    ok["ok"] = true;
    ok["can_check"] = (bool)updater_.canCheckForUpdates;
    return ok;
  }

  void check_for_updates() {
    if (controller_)
      [controller_ checkForUpdates:nil];
    else if (updater_)
      [updater_ checkForUpdates];
  }

  void check_in_background() {
    if (updater_) [updater_ checkForUpdatesInBackground];
  }

  void set_feed_url(const godot::String &url) {
    if (delegate_) delegate_.feedURL = url.is_empty() ? nil : pks_ns(url);
  }

  void set_http_headers(const godot::Dictionary &headers) {
    if (!updater_) return;
    NSDictionary *h = headers_of(headers);
    updater_.httpHeaders = h.count ? h : nil;
  }

  void set_automatically_checks(bool on) {
    if (updater_) updater_.automaticallyChecksForUpdates = on;
  }

  void set_automatically_downloads(bool on) {
    if (updater_) updater_.automaticallyDownloadsUpdates = on;
  }

  godot::Dictionary get_state() {
    godot::Dictionary d;
    d["started"] = updater_ != nil;
    if (updater_) {
      d["can_check"] = (bool)updater_.canCheckForUpdates;
      d["session"] = (bool)updater_.sessionInProgress;
      d["feed_url"] = pks_variant(updater_.feedURL.absoluteString);
      d["auto_checks"] = (bool)updater_.automaticallyChecksForUpdates;
      d["auto_downloads"] = (bool)updater_.automaticallyDownloadsUpdates;
    }
    return d;
  }
};

static void pks_initialize(godot::ModuleInitializationLevel level) {
  if (level != godot::MODULE_INITIALIZATION_LEVEL_SCENE) return;
  GDREGISTER_CLASS(PKeySparkleNative);
}

static void pks_uninitialize(godot::ModuleInitializationLevel level) {}

extern "C" GDExtensionBool GDE_EXPORT pkey_sparkle_init(GDExtensionInterfaceGetProcAddress p_get_proc_address,
                                                         GDExtensionClassLibraryPtr p_library,
                                                         GDExtensionInitialization *r_initialization) {
  godot::GDExtensionBinding::InitObject init_obj(p_get_proc_address, p_library, r_initialization);
  init_obj.register_initializer(pks_initialize);
  init_obj.register_terminator(pks_uninitialize);
  init_obj.set_minimum_library_initialization_level(godot::MODULE_INITIALIZATION_LEVEL_SCENE);
  return init_obj.init();
}
