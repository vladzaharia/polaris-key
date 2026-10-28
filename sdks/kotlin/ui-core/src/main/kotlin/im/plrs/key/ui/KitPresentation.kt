// @pkey-feature ui.theme
// The Compose-free presentation core (UI-KITS §1.3 layer c, §5.2). It resolves the shared
// ui-matrix.json states into catalog-keyed lines and actions, and the product identity and theme
// (§1.2, §3.1, §3.4), so Compose hosts and headless integrations use one model.
package im.plrs.key.ui

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import java.net.URI
import java.net.URISyntaxException
import java.text.BreakIterator
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import kotlin.math.roundToInt

/** The UI-KITS components whose states the presentation core resolves. */
public enum class KitComponent(public val id: String) {
    gate("PolarisKeyGate"),
    boot("Boot"),
    welcome("Welcome"),
    signIn("SignIn"),
    signInHandoff("SignInHandoff"),
    nearbyApproval("NearbyApproval"),
    activate("Activate"),
    offlineActivation("OfflineActivation"),
    deviceLimit("DeviceLimit"),
    licenseChoice("LicenseChoice"),
    devices("Devices"),
    updatePrompt("UpdatePrompt"),
    updateProgress("UpdateProgress"),
    releaseNotes("ReleaseNotes"),
    statusScreen("StatusScreen"),
    graceBanner("GraceBanner"),
    accountAndLicense("AccountAndLicense"),
    settings("Settings"),
    paywall("Paywall"),
    entitlementGate("EntitlementGate"),
    toast("Toast"),
    cloudSyncStatus("CloudSyncStatus"),
    unlockSync("UnlockSync"),
    recoveryCode("RecoveryCode"),
    ringChange("RingChange"),
    ;

    public companion object {
        /** The component whose corpus identifier is [id], or null when it is not a kit component. */
        public fun fromId(id: String): KitComponent? = entries.firstOrNull { it.id == id }
    }
}

/** A control action in the matrix's closed vocabulary. */
public enum class KitAction(public val id: String) {
    openCard("open-card"),
    openBrowser("open-browser"),
    replaceInBrowser("replace-in-browser"),
    openManageUrl("open-manage-url"),
    startSignIn("start-sign-in"),
    copyLink("copy-link"),
    retry("retry"),
    cancel("cancel"),
    unlock("unlock"),
    startOver("start-over"),
    confirmStartOver("confirm-start-over"),
    acceptRingChange("accept-ring-change"),
    useRecoveryCode("use-recovery-code"),
    copyCode("copy-code"),
    ;

    public companion object {
        private val byCopyKey: Map<String, KitAction> = mapOf(
            "signin.desktop.continue" to openCard,
            "signin.email.continue" to openCard,
            "signin.handoff.again" to openBrowser,
            "signin.handoff.openBrowser" to openBrowser,
            "deviceLimit.openBrowser" to openManageUrl,
            "devices.manage" to openManageUrl,
            "signin.key.addInLocker" to openManageUrl,
            "signin.deviceLimit.replace" to openManageUrl,
            "signin.key.ownedSignIn" to startSignIn,
            "signin.key.signIn" to startSignIn,
            "signin.handoff.copyLink" to copyLink,
            "a11y.copyAddress" to copyLink,
            "common.tryAgain" to retry,
            "common.reconnect" to retry,
            "signin.again" to retry,
            "signInHandoff.newCode" to retry,
            "common.cancel" to cancel,
            "unlockSync.unlock" to unlock,
            "cloudSync.unlock" to unlock,
            "unlockSync.startOver" to startOver,
            "unlockSync.startOverConfirm" to confirmStartOver,
            "ringChange.accept" to acceptRingChange,
            "ringChange.useCode" to useRecoveryCode,
            "recoveryCode.copy" to copyCode,
        )

        /** The action taken by a control with [copyKey], when the catalog assigns one. */
        public fun forCopyKey(copyKey: String): KitAction? = byCopyKey[copyKey]

        /** Controls outside the vocabulary's three opening actions that also leave the app. */
        private val alsoLeaving: Set<String> = setOf(
            "status.renew", "status.update", "update.appStore", "update.googlePlay", "update.steam",
            "update.openStore", "paywall.portal", "signin.none.get", "common.manage", "about.licenses",
            "deviceLimit.title",
        )

        /** Whether the control with [copyKey] leaves the app, so it carries the new-window glyph (UI-KITS.md 1.5 rule 11). */
        public fun leavesApp(copyKey: String): Boolean = when (forCopyKey(copyKey)) {
            openCard, openBrowser, openManageUrl -> true
            else -> copyKey in alsoLeaving
        }
    }
}

/** An argument supplied by a state to one catalog line. */
public sealed interface CopyArgument {
    /** A text argument such as a product name or URL. */
    public data class Text(public val value: String) : CopyArgument

    /** A counted argument used by a plural catalog line. */
    public data class Number(public val value: Int) : CopyArgument

    /** A nested catalog line, formatted in the same locale as its parent. */
    public data class Line(public val value: CopyLine) : CopyArgument
}

/** One visible catalog string, retained as a key and arguments until the host formats it. */
public data class CopyLine(public val key: String, public val args: Map<String, CopyArgument> = emptyMap())

/** A resolved kit screen. `hidden` means the component renders no UI for these inputs. */
public data class KitScreen(
    public val component: KitComponent,
    public val state: String,
    public val copy: List<CopyLine>,
    public val actions: List<KitAction>,
) {
    /** The catalog keys in stable comparison order. */
    public val copyKeys: List<String>
        get() = copy.map(CopyLine::key).sorted()

    /** Whether service configuration makes this component invisible. */
    public val isHidden: Boolean
        get() = state == "hidden"

    /** Whether this screen includes [key]. */
    public fun shows(key: String): Boolean = copy.any { it.key == key }
}

/**
 * Values supplied to the presentation core.
 *
 * The shape is deliberately the JSON shape in `conformance/corpus/v2/ui-matrix.json`: discovery,
 * SDKs and non-Compose hosts already exchange these wire-free presentation values. Absent members
 * take the corpus defaults; a null presentation intentionally remains absent.
 */
public class KitInputs private constructor(internal val raw: JsonObject) {
    public companion object {
        /** Creates immutable inputs from the documented presentation-value object. */
        public fun fromJson(input: JsonObject): KitInputs = KitInputs(input)

        /** Creates immutable inputs from a member map. */
        public fun of(input: Map<String, JsonElement>): KitInputs = KitInputs(JsonObject(input))
    }

    /** Whether the inputs carry the member [name], even as an explicit null. */
    public fun has(name: String): Boolean = raw.containsKey(name)

    /** These inputs with the member [name] set to [value]. */
    public fun with(name: String, value: JsonElement): KitInputs = KitInputs(JsonObject(raw + (name to value)))
}

/** The source selected for a product accent. */
public enum class AccentSource(public val id: String) {
    integrator("integrator"),
    product("product"),
    icon("icon"),
    core("core"),
    ink("ink"),
    host("host"),
}

/** The icon representation a kit draws. */
public enum class IconKind(public val id: String) {
    image("image"),
    monogram("monogram"),
    none("none"),
}

/** The kit's base visual look. */
public enum class KitPreset(public val id: String) {
    polarisKey("polaris-key"),
    native("native"),
}

/** The requested color scheme. */
public enum class KitColorScheme(public val id: String) {
    system("system"),
    dark("dark"),
    light("light"),
}

/** The kit whose identity/theme is being resolved. */
public enum class KitKind(public val id: String) {
    elements("elements"),
    react("react"),
    swiftui("swiftui"),
    compose("compose"),
    godot("godot"),
    qt("qt"),
    terminal("terminal"),
}

/** The product identity a screen uses. */
public data class ResolvedIdentity(
    public val name: String,
    public val shortName: String?,
    public val developer: String?,
    public val icon: IconKind,
    public val accentSource: AccentSource,
    public val accentLight: String?,
    public val accentDark: String?,
    public val deviceCodeUrl: String?,
) {
    /** The supplied short name when set, otherwise the full product name. */
    public val inlineName: String
        get() = shortName ?: name

    /** The first visible product-name character (a whole grapheme, localized upper case) for a monogram tile. */
    public val monogram: String
        get() {
            val trimmed = name.trim()
            if (trimmed.isEmpty()) return "?"
            val graphemes = BreakIterator.getCharacterInstance()
            graphemes.setText(trimmed)
            return trimmed.substring(0, graphemes.next()).uppercase(Locale.getDefault())
        }
}

/** The resolved visual theme for one kit. */
public data class ResolvedTheme(public val identity: ResolvedIdentity, public val colorScheme: KitColorScheme, public val preset: KitPreset) {
    public val name: String
        get() = identity.name
    public val accentSource: AccentSource
        get() = identity.accentSource
    public val icon: IconKind
        get() = identity.icon
}

/** Resolves one product identity and theme through the UI-KITS ProductIdentity seam. */
public object KitIdentity {
    /** The Polaris violet selected only by the explicit `core` integrator accent. */
    public const val coreAccentLight: String = "#7a2fff"
    public const val coreAccentDark: String = "#9a5cff"

    /** Resolves the product identity field by field without any discovery fetch or icon cache. */
    public fun resolve(inputs: KitInputs, preset: KitPreset = KitPreset.polarisKey, kit: KitKind = KitKind.compose): ResolvedIdentity {
        val integrator = inputs.obj("integrator")
        val presentation = inputs.obj("presentation")
        val bundle = inputs.obj("bundle")
        val name = nonEmpty(integrator.string("name"))
            ?: nonEmpty(presentation.string("name"))
            ?: nonEmpty(bundle.string("name"))
            ?: bundle.string("slug")
            ?: "product"
        val developer = nonEmpty(integrator.string("developer"))
            ?: nonEmpty(presentation.string("developerName"))
        val hasIcon = integrator.boolean("icon") == true || presentation.boolean("icon") == true ||
            bundle.boolean("icon") == true
        val icon = if (kit == KitKind.terminal) {
            IconKind.none
        } else if (hasIcon) {
            IconKind.image
        } else {
            IconKind.monogram
        }
        val integratorAccent = nonEmpty(integrator.string("accent"))
        val presentationAccent = nonEmpty(presentation.string("accent"))
        val source: AccentSource
        val light: String?
        val dark: String?
        when {
            integratorAccent == "core" -> {
                source = AccentSource.core
                light = coreAccentLight
                dark = coreAccentDark
            }

            integratorAccent != null -> {
                source = AccentSource.integrator
                light = integratorAccent
                dark = nonEmpty(integrator.string("accentDark")) ?: integratorAccent
            }

            preset == KitPreset.native -> {
                source = AccentSource.host
                light = null
                dark = null
            }

            presentationAccent != null -> {
                source = AccentSource.product
                light = presentationAccent
                dark = nonEmpty(presentation.string("accentDark")) ?: presentationAccent
            }

            hasIcon -> {
                source = AccentSource.icon
                light = null
                dark = null
            }

            else -> {
                source = AccentSource.ink
                light = null
                dark = null
            }
        }
        return ResolvedIdentity(
            name = name,
            shortName = nonEmpty(integrator.string("shortName")),
            developer = developer,
            icon = icon,
            accentSource = source,
            accentLight = light,
            accentDark = dark,
            deviceCodeUrl = nonEmpty(integrator.string("deviceCodeUrl")),
        )
    }

    /** Resolves identity plus a kit's default color scheme. */
    public fun theme(inputs: KitInputs, kit: KitKind, preset: KitPreset = KitPreset.polarisKey, colorScheme: KitColorScheme? = null): ResolvedTheme {
        val scheme = colorScheme ?: if (kit == KitKind.godot || inputs.isTv) {
            KitColorScheme.dark
        } else {
            KitColorScheme.system
        }
        return ResolvedTheme(resolve(inputs, preset, kit), scheme, preset)
    }

    internal fun nonEmpty(value: String?): String? = value?.takeIf { it.isNotBlank() }
}

/** The shared state resolver; each component is pure and Compose-free. */
public object KitStates {
    /** The `uiMatrixVersion` of conformance/corpus/v2/ui-matrix.json these state machines implement. */
    public const val uiMatrixVersion: Int = im.plrs.key.core.UI_MATRIX_VERSION

    /**
     * Resolves [component] from [inputs] into state, catalog lines, and allowed actions. [today] is
     * the date the grace banner counts its deadline from; a test passes a fixed one.
     */
    public fun resolve(component: KitComponent, inputs: KitInputs, today: LocalDate = LocalDate.now()): KitScreen = when (component) {
        KitComponent.gate -> gateScreen(inputs)
        KitComponent.boot -> bootScreen(inputs)
        KitComponent.welcome -> welcomeScreen(inputs)
        KitComponent.signIn -> signInScreen(inputs)
        KitComponent.signInHandoff -> signInHandoffScreen(inputs)
        KitComponent.nearbyApproval -> nearbyApprovalScreen(inputs)
        KitComponent.activate -> activateScreen(inputs)
        KitComponent.offlineActivation -> offlineActivationScreen(inputs)
        KitComponent.deviceLimit -> deviceLimitScreen(inputs)
        KitComponent.licenseChoice -> licenseChoiceScreen(inputs)
        KitComponent.devices -> devicesScreen(inputs)
        KitComponent.updatePrompt -> updatePromptScreen(inputs)
        KitComponent.updateProgress -> updateProgressScreen(inputs)
        KitComponent.releaseNotes -> releaseNotesScreen(inputs)
        KitComponent.statusScreen -> statusScreen(inputs)
        KitComponent.graceBanner -> graceBannerScreen(inputs, today)
        KitComponent.accountAndLicense -> accountAndLicenseScreen(inputs)
        KitComponent.settings -> settingsScreen(inputs)
        KitComponent.paywall -> paywallScreen(inputs)
        KitComponent.entitlementGate -> entitlementGateScreen(inputs)
        KitComponent.toast -> toastScreen(inputs)
        KitComponent.cloudSyncStatus -> cloudSyncStatusScreen(inputs)
        KitComponent.unlockSync -> unlockSyncScreen(inputs)
        KitComponent.recoveryCode -> recoveryCodeScreen(inputs)
        KitComponent.ringChange -> ringChangeScreen(inputs)
    }
}

internal const val KIT_LOADING_DELAY_MS: Int = 250

internal class KitContext(internal val inputs: KitInputs) {
    internal val identity: ResolvedIdentity = KitIdentity.resolve(inputs)
    internal val product: CopyArgument = CopyArgument.Text(identity.name)
    internal val productArgs: Map<String, CopyArgument> = mapOf("product" to product)
    internal val developerArgs: Map<String, CopyArgument> = mapOf(
        "developer" to CopyArgument.Text(identity.developer ?: identity.name),
    )
    internal val formFactor: CopyArgument = CopyArgument.Text(inputs.formFactor)

    internal fun line(key: String, args: Map<String, CopyArgument> = emptyMap()): CopyLine = CopyLine(key, args)

    internal fun delayed(lines: List<CopyLine>): List<CopyLine> {
        val elapsed = inputs.raw["elapsedMs"].double() ?: return lines
        return if (elapsed < KIT_LOADING_DELAY_MS) emptyList() else lines
    }

    internal fun codeLines(code: String?): List<CopyLine> = if (code != null && KitCopy.bundled.has("core.codes.$code.title")) {
        listOf(
            line("core.codes.$code.title", productArgs),
            line("core.codes.$code.message", productArgs),
        )
    } else {
        listOf(line("core.fallback.title"), line("core.fallback.message"))
    }

    internal fun progressArgs(): Map<String, CopyArgument> {
        val progress = inputs.obj("update").obj("progress") ?: return emptyMap()
        val bytes = progress.integer("bytes")
        val total = progress.integer("totalBytes")
        val seconds = progress.double("secondsLeft")
        return buildMap {
            if (bytes != null && total != null && total > 0) {
                put("size", CopyArgument.Text(KitFormat.bytes(bytes)))
                put("total", CopyArgument.Text(KitFormat.bytes(total)))
            }
            if (seconds != null) put("time", CopyArgument.Text(KitFormat.duration(seconds)))
        }
    }

    internal fun thisDevice(): CopyArgument = CopyArgument.Line(
        line("part.thisDevice", mapOf("formFactor" to formFactor)),
    )

    internal fun thisDeviceTitle(): CopyArgument = CopyArgument.Line(
        line("part.thisDeviceTitle", mapOf("formFactor" to formFactor)),
    )
}

internal fun screen(
    component: KitComponent,
    state: String,
    lines: List<CopyLine> = emptyList(),
    extraActions: List<KitAction> = emptyList(),
): KitScreen {
    if (state == "hidden") return KitScreen(component, state, emptyList(), emptyList())
    val actions = (lines.mapNotNull { KitAction.forCopyKey(it.key) } + extraActions)
        .distinct()
        .sortedBy(KitAction::id)
    return KitScreen(component, state, lines, actions)
}

internal fun hidden(component: KitComponent): KitScreen = screen(component, "hidden")

internal fun KitInputs.obj(name: String): JsonObject? = raw[name] as? JsonObject
internal fun JsonObject?.obj(name: String): JsonObject? = this?.get(name) as? JsonObject
internal fun KitInputs.array(name: String): JsonArray? = raw[name] as? JsonArray
internal fun JsonObject?.array(name: String): JsonArray? = this?.get(name) as? JsonArray
internal fun KitInputs.string(name: String): String? = raw[name].string()
internal fun JsonObject?.string(name: String): String? = this?.get(name).string()
internal fun JsonElement?.string(): String? = (this as? JsonPrimitive)?.contentOrNull
internal fun KitInputs.boolean(name: String): Boolean? = raw[name].boolean()
internal fun JsonObject?.boolean(name: String): Boolean? = this?.get(name).boolean()
internal fun JsonElement?.boolean(): Boolean? = (this as? JsonPrimitive)?.booleanOrNull
internal fun KitInputs.integer(name: String): Int? = raw[name].integer()
internal fun JsonObject?.integer(name: String): Int? = this?.get(name).integer()
internal fun JsonElement?.integer(): Int? = (this as? JsonPrimitive)?.intOrNull
internal fun JsonObject?.double(name: String): Double? = this?.get(name).double()
internal fun JsonElement?.double(): Double? = (this as? JsonPrimitive)?.doubleOrNull
internal fun JsonArray.objects(): List<JsonObject> = mapNotNull { it as? JsonObject }
internal fun JsonArray.strings(): List<String> = mapNotNull { it.string() }

internal val KitInputs.platform: JsonObject
    get() = obj("platform") ?: JsonObject(emptyMap())
internal val KitInputs.os: String
    get() = platform.string("os") ?: "macos"
internal val KitInputs.formFactor: String
    get() = platform.string("formFactor") ?: "mac"

/** A TV or other screen that cannot browse: the only place a sign-in QR appears (DL14). */
internal val KitInputs.isTv: Boolean
    get() = formFactor == "tv" || os == "tvos"

/** A desktop OS window (macOS, Windows, Linux), not a TV. */
internal val KitInputs.isDesktop: Boolean
    get() = formFactor != "tv" && (os == "macos" || os == "windows" || os == "linux")

/** A phone or tablet (Apple or Android). */
internal val KitInputs.isHandheld: Boolean
    get() = !isTv && (os == "ios" || os == "android" || os == "visionos")
internal fun KitInputs.capability(name: String): Boolean = obj("capabilities").boolean(name) ?: when (name) {
    "signIn", "keyEntry", "deviceCode" -> true
    else -> false
}
internal fun KitInputs.isOn(service: String): Boolean {
    val services = array("services") ?: return true
    return service in services.strings()
}

private val SERVICE_REQUIRES: Map<String, List<String>> = mapOf(
    "distribution" to listOf("release"),
    "update" to listOf("distribution"),
    "sync" to listOf("config", "identity"),
    "commerce" to listOf("license"),
    "connect" to listOf("identity"),
)

private val ALL_SERVICES: List<String> = listOf("license", "config", "release", "distribution", "update", "identity", "sync", "commerce", "connect")

/** `services` closed under `requires` (tools/services.json): a service whose requirement is off is off too. */
internal val KitInputs.closedServices: Set<String>
    get() {
        val on = (array("services")?.strings() ?: ALL_SERVICES).toMutableSet()
        do {
            val unmet = on.filter { service -> SERVICE_REQUIRES[service].orEmpty().any { it !in on } }
            on.removeAll(unmet.toSet())
        } while (unmet.isNotEmpty())
        return on
    }

/** Formatting used only for catalog arguments; hosts may apply native locale formatting at draw time. */
public object KitFormat {
    /** Formats bytes in the file-style unit vocabulary used by the catalog. */
    public fun bytes(value: Int): String {
        val units = arrayOf("B", "KB", "MB", "GB", "TB")
        var amount = value.toDouble().coerceAtLeast(0.0)
        var index = 0
        while (amount >= 1000.0 && index < units.lastIndex) {
            amount /= 1000.0
            index += 1
        }
        val display = if (amount >= 10.0 || amount == amount.roundToInt().toDouble()) {
            amount.roundToInt().toString()
        } else {
            String.format(Locale.US, "%.1f", amount)
        }
        return "$display ${units[index]}"
    }

    /** Formats a duration as `m:ss` or `h:mm:ss`. */
    public fun duration(value: Double): String {
        val seconds = value.coerceAtLeast(0.0).roundToInt()
        val hours = seconds / 3600
        val minutes = (seconds % 3600) / 60
        val remainder = seconds % 60
        return if (hours > 0) {
            String.format(Locale.US, "%d:%02d:%02d", hours, minutes, remainder)
        } else {
            String.format(Locale.US, "%d:%02d", minutes, remainder)
        }
    }

    /** Formats the local date [days] after [today] for a grace-period deadline. */
    public fun dayAfter(days: Int, today: LocalDate = LocalDate.now()): String =
        DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).format(today.plusDays(days.toLong()))

    /** Formats a normalized fraction as a rounded percentage. */
    public fun percent(value: Double): String = "${(value.coerceIn(0.0, 1.0) * 100).roundToInt()}%"

    /** Makes a platform identifier readable without reformatting unknown integrations. */
    public fun platformName(id: String): String = when (id.lowercase(Locale.US)) {
        "macos" -> "macOS"
        "ios" -> "iOS"
        "ipados" -> "iPadOS"
        "android" -> "Android"
        "windows" -> "Windows"
        "linux" -> "Linux"
        "web" -> "Web"
        "tvos" -> "tvOS"
        "visionos" -> "visionOS"
        "watchos" -> "watchOS"
        else -> id
    }
}

internal object KitLinks {
    private val loopbackHosts: Set<String> = setOf("127.0.0.1", "localhost", "::1", "[::1]")

    /** [value] when it is a usable https URL (or an http loopback redirect), else null. */
    internal fun valid(value: String?): String? {
        val uri = try {
            URI(value ?: return null)
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase(Locale.US) ?: return null
        val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
        return when {
            scheme == "https" -> value
            scheme == "http" && host in loopbackHosts -> value
            else -> null
        }
    }

    internal fun deviceCodePage(identity: ResolvedIdentity, isTv: Boolean): String =
        valid(identity.deviceCodeUrl) ?: if (isTv) im.plrs.key.core.TV_CODE_PAGE else im.plrs.key.core.DEVICE_CODE_PAGE

    internal fun display(url: String): String = url.removePrefix("https://").removePrefix("http://").removeSuffix("/")
}
