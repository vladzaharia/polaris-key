# frozen_string_literal: true
#
# patch_ba.rb: add an Apple-hosted, managed Background Download extension and an App Group to
# the Xcode project that Godot's iOS export writes ("Export Project Only").
#
# usage: ruby patch_ba.rb <path/to/<name>.xcodeproj> --app-group <group.id>
#                         [--ext-name PKBADownloader] [--ext-suffix .BackgroundDownload]
#
# What it adds (source of truth: Xcode 27's iOS "Background Download Extension" template, option
# "Apple-Hosted, Managed", read raw from TemplateInfo.plist; see the S-01 note):
#   - target <ext-name>, productType com.apple.product-type.extensionkit-extension (.appex), one
#     Swift file (a StoreDownloaderExtension, verbatim from the template), its Info.plist with
#     EXAppExtensionAttributes.EXExtensionPointIdentifier = com.apple.background-asset-downloader-extension,
#     and an entitlements file with com.apple.security.application-groups = [<group>];
#   - on the app target: an "Embed ExtensionKit Extensions" copy phase to $(EXTENSIONS_FOLDER_PATH),
#     a target dependency, the same App Group entitlement, and the Info.plist keys
#     BAAppGroupID, BAHasManagedAssetPacks = YES and BAUsesAppleHosting = YES.
#
# Additive and idempotent: a second run on an already patched project changes nothing. Sideload
# (AltStore/free Apple ID) exports must NOT run it, because each extension costs one App ID.
#
# Needs the xcodeproj gem (1.27): `GEM_HOME=../.gems gem install xcodeproj -v 1.27.0`.

require 'fileutils'
require 'optparse'
require 'xcodeproj'

EXT_POINT = 'com.apple.background-asset-downloader-extension'
PRODUCT_TYPE = 'com.apple.product-type.extensionkit-extension'
EXT_FLOOR = '26.0' # StoreDownloaderExtension / AssetPack availability (StoreKit, BackgroundAssets swiftinterfaces)

# BackgroundDownloadHandler-AppleHosted.swift from the Xcode 27 template, header comment dropped.
SWIFT_SRC = <<~SWIFT
  import BackgroundAssets
  import ExtensionFoundation
  import StoreKit

  @main
  struct DownloaderExtension: StoreDownloaderExtension {
      func shouldDownload(_ assetPack: AssetPack) -> Bool {
          // Polaris Key: compatibility gating per contentApi goes here (P5-05). The S-01 probe
          // downloads everything, which is the system default.
          return true
      }
  }
SWIFT

opts = { ext_name: 'PKBADownloader', ext_suffix: '.BackgroundDownload' }
OptionParser.new do |o|
  o.banner = 'usage: patch_ba.rb <project.xcodeproj> --app-group <group.id> [options]'
  o.on('--app-group ID') { |v| opts[:group] = v }
  o.on('--ext-name NAME') { |v| opts[:ext_name] = v }
  o.on('--ext-suffix SUFFIX') { |v| opts[:ext_suffix] = v }
end.parse!
proj_path = ARGV.shift
abort 'missing <project.xcodeproj>' unless proj_path && File.directory?(proj_path)
abort 'missing --app-group' unless opts[:group]
abort '--app-group must start with "group."' unless opts[:group].start_with?('group.')

project = Xcodeproj::Project.open(proj_path)
root = File.dirname(File.expand_path(proj_path))
app = project.native_targets.find { |t| t.product_type == 'com.apple.product-type.application' }
abort 'no application target' unless app
ext_name = opts[:ext_name]

def app_setting(target, key)
  target.build_configurations.map { |c| c.build_settings[key] }.compact.first
end

def plist_edit(path)
  data = File.exist?(path) ? Xcodeproj::Plist.read_from_path(path) : {}
  data = {} unless data.is_a?(Hash)
  yield data
  Xcodeproj::Plist.write_to_path(data, path)
end

changes = []

# ---- 1. App: entitlements and Info.plist keys (idempotent by construction) -------------------
ent_rel = app_setting(app, 'CODE_SIGN_ENTITLEMENTS') || "#{app.name}/#{app.name}.entitlements"
plist_edit(File.join(root, ent_rel)) do |e|
  groups = Array(e['com.apple.security.application-groups'])
  unless groups.include?(opts[:group])
    e['com.apple.security.application-groups'] = groups + [opts[:group]]
    changes << "app entitlements += #{opts[:group]}"
  end
end
app.build_configurations.each { |c| c.build_settings['CODE_SIGN_ENTITLEMENTS'] ||= ent_rel }

info_rel = app_setting(app, 'INFOPLIST_FILE') or abort 'app has no INFOPLIST_FILE'
plist_edit(File.join(root, info_rel)) do |i|
  want = { 'BAAppGroupID' => opts[:group], 'BAHasManagedAssetPacks' => true, 'BAUsesAppleHosting' => true }
  want.each do |k, v|
    next if i[k] == v
    i[k] = v
    changes << "app Info.plist #{k}"
  end
end

# ---- 2. Extension target ---------------------------------------------------------------------
if project.native_targets.any? { |t| t.name == ext_name }
  puts "#{ext_name}: target already present, skipped"
else
  dir = File.join(root, ext_name)
  FileUtils.mkdir_p(dir)
  File.write(File.join(dir, 'BackgroundDownloadHandler.swift'), SWIFT_SRC)
  Xcodeproj::Plist.write_to_path({
    'CFBundleDevelopmentRegion' => '$(DEVELOPMENT_LANGUAGE)',
    'CFBundleDisplayName' => ext_name,
    'CFBundleExecutable' => '$(EXECUTABLE_NAME)',
    'CFBundleIdentifier' => '$(PRODUCT_BUNDLE_IDENTIFIER)',
    'CFBundleInfoDictionaryVersion' => '6.0',
    'CFBundleName' => '$(PRODUCT_NAME)',
    'CFBundlePackageType' => '$(PRODUCT_BUNDLE_PACKAGE_TYPE)',
    'CFBundleShortVersionString' => '$(MARKETING_VERSION)',
    'CFBundleVersion' => '$(CURRENT_PROJECT_VERSION)',
    'EXAppExtensionAttributes' => { 'EXExtensionPointIdentifier' => EXT_POINT },
  }, File.join(dir, 'Info.plist'))
  Xcodeproj::Plist.write_to_path({ 'com.apple.security.application-groups' => [opts[:group]] },
                                 File.join(dir, "#{ext_name}.entitlements"))

  # StoreDownloaderExtension and AssetPack are @available(iOS 26.0), so the extension cannot
  # inherit an app floor below 26 (Godot 4.7.2's default export writes 15.0). The extension gets
  # max(app floor, EXT_FLOOR); the app keeps its own floor. On an older iOS the system ignores the
  # .appex and the app falls back to pkey-cdn.
  app_deploy = app_setting(app, 'IPHONEOS_DEPLOYMENT_TARGET')
  deploy = [app_deploy, EXT_FLOOR].compact.max_by { |v| Gem::Version.new(v) }
  ext = project.new_target(:app_extension, ext_name, :ios, deploy, nil, :swift)
  ext.product_type = PRODUCT_TYPE # the gem has no :extensionkit_extension symbol
  ext.product_reference.explicit_file_type = 'wrapper.extensionkit-extension'

  group = project.main_group.find_subpath(ext_name, true)
  group.set_source_tree('<group>')
  group.set_path(ext_name)
  src = group.new_reference('BackgroundDownloadHandler.swift')
  group.new_reference('Info.plist')
  group.new_reference("#{ext_name}.entitlements")
  ext.add_file_references([src])

  bundle_id = "#{app_setting(app, 'PRODUCT_BUNDLE_IDENTIFIER')}#{opts[:ext_suffix]}"
  ext.build_configurations.each do |c|
    appc = app.build_configurations.find { |a| a.name == c.name } || app.build_configurations.first
    s = c.build_settings
    s['PRODUCT_NAME'] = '$(TARGET_NAME)'
    s['PRODUCT_BUNDLE_IDENTIFIER'] = bundle_id
    s['INFOPLIST_FILE'] = "#{ext_name}/Info.plist"
    s['GENERATE_INFOPLIST_FILE'] = 'NO'
    s['CODE_SIGN_ENTITLEMENTS'] = "#{ext_name}/#{ext_name}.entitlements"
    s['SWIFT_VERSION'] = '5.0'
    s['SKIP_INSTALL'] = 'YES'
    s['APPLICATION_EXTENSION_API_ONLY'] = 'YES'
    s['LD_RUNPATH_SEARCH_PATHS'] = ['$(inherited)', '@executable_path/Frameworks', '@executable_path/../../Frameworks']
    s['TARGETED_DEVICE_FAMILY'] = appc.build_settings['TARGETED_DEVICE_FAMILY'] || '1,2'
    # App Store validation requires the extension's versions to match the app's.
    %w[MARKETING_VERSION CURRENT_PROJECT_VERSION DEVELOPMENT_TEAM CODE_SIGN_STYLE CODE_SIGN_IDENTITY].each do |k|
      s[k] = appc.build_settings[k] if appc.build_settings[k]
    end
    # Godot pins ARCHS=arm64 on the app; keep the extension on the default (it builds for sim too).
  end
  attrs = project.root_object.attributes['TargetAttributes'] ||= {}
  app_attrs = attrs[app.uuid] || {}
  attrs[ext.uuid] = { 'CreatedOnToolsVersion' => '27.0' }
  attrs[ext.uuid]['DevelopmentTeam'] = app_attrs['DevelopmentTeam'] if app_attrs['DevelopmentTeam']
  attrs[ext.uuid]['ProvisioningStyle'] = app_attrs['ProvisioningStyle'] if app_attrs['ProvisioningStyle']

  # Embed: ExtensionKit extensions go to <App>.app/Extensions, not PlugIns.
  app.add_dependency(ext)
  embed = app.copy_files_build_phases.find { |p| p.name == 'Embed ExtensionKit Extensions' } ||
          app.new_copy_files_build_phase('Embed ExtensionKit Extensions')
  embed.dst_subfolder_spec = Xcodeproj::Constants::COPY_FILES_BUILD_PHASE_DESTINATIONS[:products_directory]
  embed.dst_path = '$(EXTENSIONS_FOLDER_PATH)'
  bf = embed.add_file_reference(ext.product_reference, true)
  bf.settings = { 'ATTRIBUTES' => ['RemoveHeadersOnCopy'] }
  changes << "target #{ext_name} (#{bundle_id}) embedded in #{app.name}"
end

project.save unless changes.empty?
puts changes.empty? ? 'already patched: no changes' : changes.map { |c| "patched: #{c}" }
