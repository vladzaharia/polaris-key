// @pkey-feature ui.i18n
// DL8 (UI-KITS.md): copy is verbatim from the catalogs. PolarisCopy keeps its own English fields (the
// host's override hook and the string resources), so this table pins each one that has a catalog
// line to that line's English text, with the named placeholders turned into positional ones in the
// order the field lists them. A catalog edit that the kit does not follow fails here.

package im.plrs.key.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PolarisCopyCatalogTest {
    /** The English catalog line [key] with `{name}` placeholders replaced by `%n$s` in [args] order. */
    private fun line(key: String, vararg args: String): String {
        var text = KitCopy.bundled.message(key, "en") ?: error("the catalog has no $key")
        args.forEachIndexed { i, name -> text = text.replace("{$name}", "%${i + 1}\$s") }
        assertTrue("$key keeps a placeholder the table did not name: $text", !Regex("""\{[A-Za-z]+\}""").containsMatchIn(text))
        return text
    }

    private val fields = PolarisCopy().asMap()

    private fun check(field: String, key: String, vararg args: String) = assertEquals("PolarisCopy.$field vs catalog $key", line(key, *args), fields.getValue(field))

    @Test
    fun commonLinesAreTheCatalogs() {
        check("loading", "common.loading")
        check("retry", "common.tryAgain")
        check("cancel", "common.cancel")
        check("close", "common.close")
        check("consentLater", "common.notNow")
        check("reconnect", "common.reconnect")
        check("updateDismiss", "common.dismiss")
        check("updateLater", "update.later")
    }

    @Test
    fun bootLinesAreTheCatalogs() {
        check("bootStarting", "boot.starting")
        check("bootSyncing", "boot.syncing")
        check("bootDeciding", "boot.deciding")
        check("bootFetching", "boot.fetching")
        check("bootReady", "boot.ready")
        check("bootOfflineTitle", "boot.offline.title")
        check("bootOfflineBody", "boot.offline.body")
        check("bootOfflinePlayableBody", "boot.offline.playable")
        check("playOffline", "boot.continueOffline")
        check("bootDeclinedTitle", "boot.declined.title")
        check("bootDeclinedBody", "boot.declined.body", "product")
        check("bootRolledBack", "boot.rolledBack")
        check("bootErrorBody", "boot.error.body")
        check("consentTitle", "boot.consent.title")
        check("consentBody", "boot.consent.body", "product", "size")
        check("consentBodyMetered", "boot.consent.bodyMetered", "product", "size")
        check("consentDownload", "boot.consent.download")
    }

    @Test
    fun gateAndActivationLinesAreTheCatalogs() {
        check("gateLoading", "gate.checking")
        check("versionTooOldTitle", "core.gate.version-too-old.title")
        check("versionTooOldBody", "core.gate.version-too-old.message")
        check("versionTooNewTitle", "core.gate.version-too-new.title")
        check("versionTooNewBody", "core.gate.version-too-new.message")
        check("channelNotEntitledTitle", "core.gate.channel-not-entitled.title")
        check("channelNotEntitledBody", "core.gate.channel-not-entitled.message")
        check("useAnotherLicense", "status.useAnotherLicense")
        check("activationTitle", "welcome.title", "product")
        check("signIn", "welcome.signIn")
        check("keyLabel", "part.keyField.label")
        check("keyPlaceholder", "part.keyField.placeholder")
        check("activate", "activate.submit")
        check("activating", "activate.busy")
        check("activationKeyEmpty", "part.keyField.empty")
        check("seatCaption", "part.seatMeter.caption", "used", "limit")
        check("deviceLimitNoManage", "deviceLimit.noManage", "product")
        check("freeDevice", "deviceLimit.title")
        check("openInBrowser", "deviceLimit.openBrowser")
        check("deviceLimitBrowser", "deviceLimit.browser", "product")
        check("useKey", "welcome.useKey")
        check("byDeveloper", "common.byDeveloper", "developer")
        check("back", "common.back")
        check("freeDeviceScan", "deviceLimit.scan")
    }

    @Test
    fun signInLinesAreTheCatalogs() {
        check("signInTitle", "signin.handoff.codeTitle")
        check("signInStarting", "signInHandoff.starting")
        check("signInInstructions", "signInHandoff.scanTv")
        check("signInCodeBody", "signin.handoff.codeBody", "url")
        check("signInCopyLink", "signin.handoff.copyLink")
        check("signInLinkCopied", "signInHandoff.linkCopied")
        check("signInNoBrowser", "signin.handoff.noBrowser")
        check("signInUseKey", "signin.choice.keyInstead")
        check("signInOpenBrowser", "signin.handoff.openBrowser")
        check("signInExpiresIn", "signin.handoff.expires", "time")
        check("signInDone", "signInHandoff.ok")
        check("signInNewCode", "signInHandoff.newCode")
    }

    @Test
    fun settingsAndStatusLinesAreTheCatalogs() {
        check("settingsTitle", "settings.title")
        check("settingsEmpty", "settings.empty")
        check("settingsLoadFailed", "settings.loadFailed")
        check("settingsOn", "settings.on")
        check("settingsOff", "settings.off")
        check("settingsSourceLocal", "settings.source.local")
        check("settingsSourceEnv", "settings.source.env")
        check("settingsSourceDefault", "settings.source.default")
        check("entitlementLicensed", "part.status.ok")
        check("entitlementGrace", "part.status.grace")
        check("graceTitle", "part.status.grace")
        check("entitlementExpired", "part.status.expired")
        check("entitlementRevoked", "part.status.revoked")
        check("entitlementInactive", "part.status.inactive")
        check("entitlementBlocked", "part.status.blocked")
        check("entitlementNotApplicable", "part.status.notApplicable")
    }

    @Test
    fun devicesAndUpdateLinesAreTheCatalogs() {
        check("devicesTitle", "devices.title")
        check("devicesSubtitle", "devices.lede")
        check("devicesEmpty", "devices.empty")
        check("devicesError", "devices.loadFailed")
        check("devicesRenameFailed", "devices.renameFailed", "device")
        check("devicesRemoveFailed", "devices.removeFailed", "device")
        check("deviceUnnamed", "devices.unnamed")
        check("deviceRename", "devices.rename")
        check("deviceRenameLabel", "devices.renameLabel")
        check("deviceSave", "common.save")
        check("deviceDeauthorize", "devices.remove")
        check("deviceRemoveConfirm", "devices.removeConfirm", "device", "product")
        check("deviceRenameDescription", "a11y.renameDevice", "device")
        check("deviceDeauthorizeDescription", "a11y.removeDevice", "device")
        check("updatePromptTitle", "update.title", "product", "version")
        check("updateMandatoryTitle", "update.mandatoryTitle", "product")
        check("updateMandatoryBody", "update.mandatoryBody")
        check("updateNow", "update.install")
        check("updateRestartNow", "update.restartNow")
        check("updateRestartWhenReady", "update.restartWhenReady")
        check("updateDownloading", "update.downloading", "size", "total")
        check("updateReadyTitle", "update.readyTitle", "product", "version")
        check("updateReadyBody", "update.readyBody", "product")
        check("updateCritical", "update.critical")
    }

    @Test
    fun aSentenceNeverStartsWithAnUnnamedProductInLowerCase() {
        val named = PolarisCopy(productName = "Diceroll")
        val nameless = PolarisCopy()
        assertEquals("Diceroll needs 12 MB of new content.", named.consentMessage(12_000_000, metered = false))
        assertEquals("This app needs 12 MB of new content.", nameless.consentMessage(12_000_000, metered = false))
        assertEquals(
            "This app needs this content to start. Download it when you're ready.",
            nameless.blockedMessage(im.plrs.key.core.BootEmit.BlockedReason.contentDeclined).body,
        )
    }
}
