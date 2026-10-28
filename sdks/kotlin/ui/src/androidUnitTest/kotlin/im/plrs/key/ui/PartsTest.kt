// @pkey-feature ui.kit ui.paywall ui.settings
// UI-KITS.md 4.1, the styled parts: LicenseChoice (origin and term in plain words, the seats, a full
// license without a radio), Paywall (never invents checkout), ReleaseNotes (plain text), the
// EntitlementGate (only the entitlement decides), CloudSyncStatus and About (diagnostics redacted).

package im.plrs.key.ui

import android.app.Application
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-mdpi")
class PartsTest {
    @get:Rule
    val rule = createComposeRule()

    private val copy = sampleCopy
    private val radios = SemanticsMatcher.expectValue(SemanticsProperties.Role, Role.RadioButton)

    private fun show(content: @Composable () -> Unit) {
        rule.setContent { StockHost(false) { PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false) { content() } } }
        rule.waitForIdle()
    }

    // ── LicenseChoice ────────────────────────────────────────────────────────────────────────

    @Test
    fun licenseRowsSayWhereEachLicenseCameFromAndHowLongItLasts() {
        val case = MatrixCases.case("licenseChoice-many")
        show { PolarisLicenseChoice(case.screen, case.rows.choices!!) }
        // A purchase or a key reads "Added with a key"; a store license "From <store>", with its term.
        val rows = case.rows.choices!!.choices
        rule.onAllNodes(hasText("Added with a key · Lifetime")).assertCountEquals(rows.count { it.originKey() == "signin.choice.origin.keyAdded" && it.expiresAt == null })
        rule.onNodeWithText("From Google Play · Until ${kitDate(1_798_761_600, "en")}").assertIsDisplayed()
        rule.onNodeWithText("Free · Lifetime").assertIsDisplayed()
        // The developer's own grants name the developer (here the product, the only name the sample has).
        rule.onAllNodes(hasText("From Diceroll · Until ${kitDate(1_798_761_600, "en")}")).assertCountEquals(rows.count { it.origin == "developer" })
        // The tier as a pill and the seats as words.
        rule.onNodeWithText("Edu").assertIsDisplayed()
        rule.onAllNodes(hasText("1 of 3 devices")).assertCountEquals(case.rows.choices!!.choices.count { it.seats?.used == 1 && it.seats?.limit == 3 })
        rule.onNodeWithText("Fennick Studio Edu").assertIsDisplayed()
    }

    @Test
    fun aFullLicenseIsARowWithoutARadio() {
        val case = MatrixCases.case("licenseChoice-many")
        show { PolarisLicenseChoice(case.screen, case.rows.choices!!) }
        val rows = case.rows.choices!!.choices
        // One row is full: every other row has a radio, and it has none.
        assertEquals(1, rows.count { it.isFull })
        rule.onAllNodes(radios).assertCountEquals(rows.size - 1)
        rule.onNodeWithText("All devices in use").assertIsDisplayed()
    }

    @Test
    fun theChosenRowIsCheckedAndContinueHandsBackItsId() {
        val case = MatrixCases.case("licenseChoice-many")
        val chosen = mutableListOf<String>()
        show { PolarisLicenseChoice(case.screen, case.rows.choices!!, onContinue = { chosen += it }) }
        val rows = case.rows.choices!!.choices
        // The preselected license is chosen to start with.
        val start = case.rows.choices!!.preselected ?: rows.first { !it.isFull }.id
        rule.onNodeWithText("Use this license").performScrollTo().performClick()
        assertEquals(listOf(start), chosen)
        // Choosing another row moves the check and the answer.
        rule.onAllNodes(radios)[2].performClick()
        rule.onAllNodes(radios)[2].assertIsSelected()
        rule.onNodeWithText("Use this license").performScrollTo().performClick()
        assertEquals(rows.filterNot { it.isFull }[2].id, chosen.last())
    }

    @Test
    fun theMatrixRendererDrawsTheRowsWhenGivenThem() {
        val case = MatrixCases.case("licenseChoice-mixed")
        show { PolarisKitScreen(case.screen, rows = case.rows) }
        rule.onNodeWithText("Sign-in · Lifetime").assertIsDisplayed()
    }

    // ── Paywall ──────────────────────────────────────────────────────────────────────────────

    @Test
    fun theOffersStateNamesTheTierItsFeaturesAndTheWayToGetIt() {
        val (screen, rows) = samplePaywall()
        var upgrades = 0
        var redeems = 0
        show { PolarisPaywall(screen, rows.features, onUpgrade = { upgrades++ }, onRedeem = { redeems++ }) }
        // The product in the title is the inputs' own.
        rule.onNodeWithText(KitCopy.bundled.format(screen.copy.first { it.key == "paywall.title" }, "en")).assertIsDisplayed()
        rule.onNodeWithText("Pro includes").assertIsDisplayed()
        for (feature in sampleFeatures) rule.onNodeWithText(feature).assertIsDisplayed()
        rule.onNodeWithText("Upgrade to Pro").performClick()
        rule.onNodeWithText("Redeem a code").performClick()
        assertEquals(1, upgrades)
        assertEquals(1, redeems)
    }

    @Test
    fun withoutAPurchaseCapabilityThePortalIsTheWayAndTheKitDrawsNoPrice() {
        val base = MatrixCases.case("paywall-offers").inputs!!
        val inputs = base.with("capabilities", kotlinx.serialization.json.JsonObject(mapOf("purchase" to kotlinx.serialization.json.JsonPrimitive(false))))
        val screen = KitStates.resolve(KitComponent.paywall, inputs)
        var portal = 0
        show { PolarisPaywall(screen, emptyList(), onPortal = { portal++ }) }
        rule.onNodeWithText("Buy in your browser").performClick()
        assertEquals(1, portal)
        // No per-month price, no saving: the kit computes none.
        rule.onAllNodes(hasText("$", substring = true)).assertCountEquals(0)
    }

    @Test
    fun purchasingKeepsItsLabelAndShowsBusyAndPurchasedSaysDone() {
        val (purchasing, rows) = samplePaywall(pending = "purchase")
        show { PolarisPaywall(purchasing, rows.features) }
        rule.onNodeWithText("Completing purchase…").assertIsDisplayed()
        rule.onNodeWithText("Upgrade to Pro").assertDoesNotExist()
    }

    @Test
    fun purchasedConfirmsAndOffersDone() {
        val (screen, rows) = samplePaywall(purchased = true)
        var done = 0
        show { PolarisPaywall(screen, rows.features, onDone = { done++ }) }
        rule.onNodeWithText("Pro is unlocked").assertIsDisplayed()
        rule.onNodeWithText("Done").performClick()
        assertEquals(1, done)
    }

    // ── ReleaseNotes ─────────────────────────────────────────────────────────────────────────

    @Test
    fun releaseNotesListEachVersionWithItsDate() {
        val case = MatrixCases.case("releaseNotes-list")
        show { PolarisReleaseNotes(case.screen, case.rows.releaseNotes) }
        rule.onNodeWithText("Version 2.5.0").assertIsDisplayed()
        rule.onNodeWithText("Version 2.4.1").assertIsDisplayed()
        // The date is the reader's, never the ISO text (DL8).
        rule.onNodeWithText("Released ${kitDay("2026-09-30", "en")}").assertIsDisplayed()
        rule.onNodeWithText("Faster sync. Fixes a crash on launch.").assertIsDisplayed()
    }

    @Test
    fun remoteMarkupInANoteIsShownAsTextAndNeverRuns() {
        val case = MatrixCases.case("releaseNotes-list")
        val hostile = "<b>bold</b> <a href=\"https://evil.example\">tap</a> <script>alert(1)</script>"
        show { PolarisReleaseNotes(case.screen, listOf(KitReleaseNote("2.6.0", "2026-10-01", hostile))) }
        rule.onNodeWithText(hostile).assertIsDisplayed()
        // The only things to press are none: a note is not a link.
        rule.onAllNodes(androidx.compose.ui.test.hasClickAction()).assertCountEquals(0)
    }

    @Test
    fun emptyAndErrorStatesSaySoAndErrorOffersTryAgain() {
        val empty = MatrixCases.case("releaseNotes-empty")
        show { PolarisReleaseNotes(empty.screen, emptyList()) }
        rule.onNodeWithText("No release notes yet.").assertIsDisplayed()
    }

    @Test
    fun releaseNotesErrorTriesAgain() {
        val error = MatrixCases.case("releaseNotes-error")
        var retries = 0
        show { PolarisReleaseNotes(error.screen, emptyList(), onRetry = { retries++ }) }
        rule.onNodeWithText("Release notes couldn't be loaded.").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        assertEquals(1, retries)
    }

    // ── EntitlementGate ──────────────────────────────────────────────────────────────────────

    @Test
    fun onlyTheEntitlementDecides() {
        var unlocks = 0
        show {
            androidx.compose.foundation.layout.Column {
                PolarisEntitlementGate(entitled = true) { androidx.compose.material3.Text("ENTITLED CONTENT") }
                PolarisEntitlementGate(entitled = false, tier = "Pro", onUnlock = { unlocks++ }) { androidx.compose.material3.Text("LOCKED CONTENT") }
            }
        }
        rule.onNodeWithText("ENTITLED CONTENT").assertIsDisplayed()
        rule.onNodeWithText("LOCKED CONTENT").assertDoesNotExist()
        rule.onNodeWithText("This feature needs Pro.").assertIsDisplayed()
        rule.onNodeWithText("Unlock").performClick()
        assertEquals(1, unlocks)
    }

    @Test
    fun aLockedGateTakesAHostSlotInPlaceOfTheCard() {
        show { PolarisEntitlementGate(entitled = false, locked = { androidx.compose.material3.Text("Upgrade slot") }) { androidx.compose.material3.Text("hidden") } }
        rule.onNodeWithText("Upgrade slot").assertIsDisplayed()
        rule.onNodeWithText("hidden").assertDoesNotExist()
    }

    @Test
    fun whileTheEntitlementLoadsNeitherTheContentNorTheLockShows() {
        show { PolarisEntitlementGate(entitled = null, tier = "Pro") { androidx.compose.material3.Text("CONTENT") } }
        rule.onNodeWithText("CONTENT").assertDoesNotExist()
        rule.onNodeWithText("This feature needs Pro.").assertDoesNotExist()
        rule.onNodeWithText(copy.loading).assertExists()
    }

    @Test
    fun theMatrixEntitlementStatesDrawTheLockedCardOrNothing() {
        val locked = MatrixCases.case("entitlementGate-not-entitled")
        show { PolarisKitScreen(locked.screen, rows = locked.rows) }
        rule.onNodeWithText("Unlock").assertIsDisplayed()
    }

    // ── CloudSyncStatus ──────────────────────────────────────────────────────────────────────

    @Test
    fun cloudSyncStatesAreWordsAndOpenTheirDetails() {
        var opened = 0
        show {
            PolarisCloudSyncStatus(PolarisCloudSync.Synced, syncedAtMillis = NOW * 1000 - 300_000, nowMillis = NOW * 1000, onOpen = { opened++ })
        }
        rule.onNodeWithText("Synced ${copy.ago(300)}").performClick()
        assertEquals(1, opened)
    }

    @Test
    fun cloudSyncOffersTheRightWayOnForAFailureAndForSignedOut() {
        var retried = 0
        var signedIn = 0
        show {
            androidx.compose.foundation.layout.Column {
                PolarisCloudSyncStatus(PolarisCloudSync.Error, onRetry = { retried++ })
                PolarisCloudSyncStatus(PolarisCloudSync.SignedOut, onSignIn = { signedIn++ })
                PolarisCloudSyncStatus(PolarisCloudSync.Offline)
                PolarisCloudSyncStatus(PolarisCloudSync.Syncing)
                PolarisCloudSyncStatus(PolarisCloudSync.Conflict)
            }
        }
        rule.onNodeWithText("Couldn't sync. Try again later.").assertIsDisplayed()
        rule.onNodeWithText("Try again").performClick()
        rule.onNodeWithText("Sign in to sync").performClick()
        assertEquals(1, retried)
        assertEquals(1, signedIn)
        rule.onNodeWithText("Offline · changes sync when you reconnect").assertIsDisplayed()
        rule.onNodeWithText("Syncing…").assertIsDisplayed()
        rule.onNodeWithText("Some changes conflict.").assertIsDisplayed()
        // It never claims a backup.
        rule.onAllNodes(hasText("backup", substring = true, ignoreCase = true)).assertCountEquals(0)
    }

    // ── About ────────────────────────────────────────────────────────────────────────────────

    @Test
    fun aboutShowsTheProductVersionAndBuild() {
        show { PolarisAbout(PolarisAboutInfo(version = "2.4.1", build = "build 241"), onPrivacy = {}, onSupport = {}, onLicenses = {}) }
        rule.onNodeWithText("About Diceroll").assertIsDisplayed()
        rule.onNodeWithText("Version 2.4.1 · build 241").assertIsDisplayed()
        rule.onNodeWithText("Open-source licenses").assertIsDisplayed()
        rule.onNodeWithText("Privacy").assertIsDisplayed()
    }

    @Test
    fun copyDiagnosticsRedactsKeysTokensAndEmailBeforeItLeavesTheDevice() {
        val copied = mutableListOf<String>()
        show {
            PolarisAbout(
                PolarisAboutInfo(
                    version = "2.4.1",
                    diagnostics = "Diceroll 2.4.1\nlicense pkey_djdl_ABCDEFGHIJKLMNOPQRSTUV\ntoken pkeyt_0123456789abcdef\nada@fennick.studio\nAuthorization: Bearer abc.def.ghi",
                ),
                onCopied = { copied += it },
            )
        }
        rule.onNodeWithText("Copy diagnostics").performClick()
        rule.waitForIdle()
        val text = copied.single()
        assertFalse(text, text.contains("pkey_djdl"))
        assertFalse(text, text.contains("pkeyt_"))
        assertFalse(text, text.contains("fennick"))
        assertFalse(text, text.contains("abc.def.ghi"))
        assertTrue(text, text.startsWith("Diceroll 2.4.1"))
        // What went on the clipboard is the redacted text, and the person is told.
        val clipboard = ApplicationProvider.getApplicationContext<Application>().getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals(text, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        rule.onNodeWithText("Diagnostics copied").assertIsDisplayed()
    }

    @Test
    fun aboutDrawsTheAttributionOnlyWhenTheThemeAsksForIt() {
        rule.setContent {
            StockHost(false) {
                PolarisTheme(branding = PolarisBranding.PolarisKey, copy = copy, darkTheme = false, showPoweredBy = true) {
                    PolarisAbout(PolarisAboutInfo(version = "2.4.1"))
                }
            }
        }
        rule.waitForIdle()
        rule.onAllNodes(androidx.compose.ui.test.hasContentDescription(copy.poweredBy)).assertCountEquals(1)
    }
}
