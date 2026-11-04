// @pkey-feature ui.kit.holders
//
// The holders' wiring (UK-43.6), headless: the Done step's key held in memory until Start using, where
// Add goes (the account step in the app, the manage QR on a TV, the product page with Identity off), when
// `#key=` rides the page, what Cancel returns to, and the floating license's row in Settings.

import Foundation
import PolarisKeyCore
import PolarisKeyUICore
import XCTest

private struct Idle: AddToAccountDriver {
    func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle { throw CancellationError() }
    func complete(grant: String) async throws -> Bool { true }
    func attach(confirm: Bool) async throws -> AddToAccountAttach { .ok }
}

private let activateLink = "https://polaris.locker/activate?product=tidewater"
private let sampleKey = "pkey_tidewater_AAAABBBBCCCCDDDDEEEEFFFFGGGG"

private func facts(
    portal: String? = activateLink, identity: Bool = true, tv: Bool = false, api: String = "https://key.plrs.im",
    email: String? = nil
) -> HolderFacts {
    let platform =
        tv ? KitPlatform(os: .tvos, formFactor: .tv) : KitPlatform(os: .macos, formFactor: .mac)
    var base = KitInputs(
        bundle: KitBundle(slug: "tidewater"), platform: platform,
        services: identity ? [.license, .identity, .sync] : [.license])
    base.licenseHolder = KitLicenseHolder(email: email ?? "", addIn: HolderFacts.addIn(for: platform))
    base.activateDone = KitActivateDone(
        tier: "Pro", deviceKind: HolderFacts.deviceKind(for: platform), position: 1, limit: 3)
    return HolderFacts(
        base: base, portal: portal, account: portal, apiOrigin: api, identity: identity,
        addIn: HolderFacts.addIn(for: platform), holderEmail: email, floating: email == nil,
        deviceKind: HolderFacts.deviceKind(for: platform))
}

final class HolderFactsTests: XCTestCase {
    func testAddInIsTheAppOnIphoneIpadAndMacAndThePortalOnATv() {
        for form: KitFormFactor in [.iphone, .ipad, .mac] {
            XCTAssertEqual(HolderFacts.addIn(for: KitPlatform(os: .ios, formFactor: form)), .app)
        }
        XCTAssertEqual(HolderFacts.addIn(for: KitPlatform(os: .tvos, formFactor: .tv)), .portal)
    }

    func testTheDeviceKindIsTheNounTheDoneLineUses() {
        XCTAssertEqual(HolderFacts.deviceKind(for: KitPlatform(os: .ios, formFactor: .iphone)), "iPhone")
        XCTAssertEqual(HolderFacts.deviceKind(for: KitPlatform(os: .ios, formFactor: .ipad)), "iPad")
        XCTAssertEqual(HolderFacts.deviceKind(for: KitPlatform(os: .macos, formFactor: .mac)), "Mac")
    }

    func testTheKeyRidesTheActivateLinkOnTheCustomerSiteOrTheApiOrigin() {
        XCTAssertEqual(
            facts().portalTarget(key: sampleKey), activateLink + "#key=" + ManageLink.formEncode(sampleKey))
        XCTAssertEqual(
            facts(portal: "https://key.example/activate?product=tidewater", api: "https://key.example")
                .portalTarget(key: sampleKey),
            "https://key.example/activate?product=tidewater#key=" + ManageLink.formEncode(sampleKey))
    }

    func testTheKeyNeverRidesAnotherOriginOrATvOrAMissingKey() {
        let other = "https://shop.example/activate?product=tidewater"
        XCTAssertEqual(facts(portal: other).portalTarget(key: sampleKey), other)
        XCTAssertEqual(facts(tv: true).portalTarget(key: sampleKey), activateLink)
        XCTAssertEqual(facts().portalTarget(key: nil), activateLink)
        XCTAssertEqual(facts().portalTarget(key: ""), activateLink)
        XCTAssertNil(facts(portal: nil).portalTarget(key: sampleKey))
    }

    func testTheKeyIsRedactedWhereverItIsPrinted() {
        let done = PolarisKeyDone(key: sampleKey)
        XCTAssertFalse("\(done)".contains(sampleKey))
        XCTAssertFalse(String(reflecting: done).contains(sampleKey))
    }
}

@MainActor
final class HolderFlowModelTests: XCTestCase {
    private func flow(
        _ f: HolderFacts = facts(), key: String? = sampleKey, onFinish: @escaping @MainActor () -> Void = {}
    ) -> HolderFlowModel {
        HolderFlowModel(facts: f, driver: Idle(), key: key, onFinish: onFinish)
    }

    func testAKeyStartsAtDoneAndSettingsAtTheAccountStep() {
        XCTAssertEqual(flow().stage, .done)
        XCTAssertEqual(flow(key: nil).stage, .add)
    }

    func testSettingsOnATvOrWithIdentityOffStartsAtTheManageQr() {
        XCTAssertEqual(flow(facts(tv: true), key: nil).stage, .qr)
        XCTAssertEqual(flow(facts(identity: false), key: nil).stage, .qr)
    }

    func testAddGoesToTheAccountStepInTheApp() {
        let f = flow()
        f.openAdd()
        XCTAssertEqual(f.stage, .add)
    }

    func testAddOnATvGoesToTheQrWithNoKeyInIt() {
        let f = flow(facts(tv: true))
        XCTAssertEqual(f.doneLink, activateLink)
        f.openAdd()
        XCTAssertEqual(f.stage, .qr)
        XCTAssertEqual(f.qrLink, activateLink)
    }

    func testDoneOpensThePortalWithTheKeyOnlyWhereItIsSafe() {
        XCTAssertEqual(flow().doneLink, activateLink + "#key=" + ManageLink.formEncode(sampleKey))
        XCTAssertEqual(flow().qrLink, activateLink)
    }

    func testCancelReturnsToDoneWithFocusOnAddAndTheFieldsKept() {
        let f = flow()
        XCTAssertNil(f.doneInputs.activateDone?.returned)
        f.openAdd()
        f.add.setField(.name, "Ada")
        f.add.setField(.email, "ada@example.com")
        f.cancelAdd()
        XCTAssertEqual(f.stage, .done)
        XCTAssertEqual(f.doneInputs.activateDone?.returned, true)
        XCTAssertEqual(f.add.name, "Ada")
        XCTAssertEqual(f.add.email, "ada@example.com")
        XCTAssertFalse(f.finished)
    }

    func testCancelFromSettingsLeavesTheFlow() {
        var finished = 0
        let f = flow(key: nil) { finished += 1 }
        f.cancelAdd()
        XCTAssertTrue(f.finished)
        XCTAssertEqual(finished, 1)
    }

    func testStartUsingEndsTheFlowOnceAndForgetsTheKey() {
        var finished = 0
        let f = flow { finished += 1 }
        XCTAssertNotNil(f.doneLink?.range(of: "#key="))
        f.finish()
        f.finish()
        XCTAssertEqual(finished, 1)
        XCTAssertNil(f.doneLink?.range(of: "#key="), "the key is gone once Start using ran")
    }

    func testAddedFromSettingsClosesWithDone() throws {
        let f = flow(key: nil)
        XCTAssertEqual(f.add.inputs.addToAccount?.fromSettings, true)
        XCTAssertNil(flow().add.inputs.addToAccount?.fromSettings)
    }

    func testTheDoneStepDrawsWithIdentityOffAsThePortalLine() {
        let screen = KitStates.activateDone(flow(facts(identity: false)).doneInputs)
        XCTAssertTrue(screen.shows("signin.key.addInLocker"))
        XCTAssertTrue(screen.shows("a11y.externalLink"))
    }

    func testTheDoneStepOnATvAddsThroughThePortalToo() {
        let screen = KitStates.activateDone(flow(facts(tv: true)).doneInputs)
        XCTAssertTrue(screen.shows("signin.key.addInLocker"))
    }

    func testTheDoneStepInTheAppOffersAddYourNameAndEmail() {
        let screen = KitStates.activateDone(flow().doneInputs)
        XCTAssertTrue(screen.shows("activate.recommend.action"))
        XCTAssertFalse(screen.shows("signin.key.addInLocker"))
    }
}

@MainActor
final class FloatingSettingsTests: XCTestCase {
    private func account(holder: KitLicenseHolder?, identity: Bool = true) -> KitScreen<AccountState> {
        var i = KitInputs(
            bundle: KitBundle(slug: "tidewater"), platform: KitPlatform(os: .macos, formFactor: .mac),
            services: identity ? [.license, .identity] : [.license])
        i.account = KitAccount(signedIn: false)
        i.licenseHolder = holder
        return KitStates.accountAndLicense(i)
    }

    func testAFloatingLicenseSaysSoOffersAddAndRemovesFromThisDevice() {
        let screen = account(holder: KitLicenseHolder(email: "", addIn: .app))
        XCTAssertTrue(screen.shows("account.notInAccount"))
        XCTAssertTrue(screen.shows("activate.recommend.action"))
        XCTAssertTrue(screen.shows("account.removeKey"))
        XCTAssertFalse(screen.shows("common.signOut"))
        XCTAssertEqual(KitCopy.bundled.format("account.removeKey", locale: "en"), "Remove license from this device")
    }

    func testWithIdentityOffTheRowOpensThePageAndSaysSo() {
        let screen = account(holder: KitLicenseHolder(email: "", addIn: .app), identity: false)
        XCTAssertTrue(screen.shows("signin.key.addInLocker"))
        XCTAssertTrue(screen.shows("a11y.externalLink"))
    }

    func testAnUnknownHolderKeepsSignOut() {
        let screen = account(holder: nil)
        XCTAssertFalse(screen.shows("account.notInAccount"))
        XCTAssertTrue(screen.shows("common.signOut"))
    }

    func testThePreviewSettingsModelOffersNoAdd() {
        let model = PolarisKeySettingsModel(preview: KitInputs())
        XCTAssertFalse(model.canAdd)
        XCTAssertNil(model.holders)
    }
}

private final class SignedHandle: AddToAccountHandle, @unchecked Sendable {
    let userCode: String? = "WDJB-MJHT"
    let email: String?
    init(email: String?) { self.email = email }
    func wait() async throws -> AddToAccountWait { .signedIn(email: email) }
    func reopen() async -> Bool { true }
    func cancel() {}
}

private final class HintDriver: AddToAccountDriver, @unchecked Sendable {
    let signed: String?
    private(set) var hints: [AddToAccountHints] = []
    init(signed: String?) { self.signed = signed }
    func signIn(_ hints: AddToAccountHints) async throws -> any AddToAccountHandle {
        self.hints.append(hints)
        return SignedHandle(email: signed)
    }
    func complete(grant: String) async throws -> Bool { true }
    func attach(confirm: Bool) async throws -> AddToAccountAttach { .ok }
}

@MainActor
final class HolderAccountSignInTests: XCTestCase {
    private func model(_ driver: HintDriver, holder: String? = "maya@example.com") -> AddToAccountModel {
        var base = KitInputs(
            bundle: KitBundle(slug: "tidewater"), platform: KitPlatform(os: .macos, formFactor: .mac),
            services: [.license, .identity])
        base.licenseHolder = KitLicenseHolder(email: holder ?? "", addIn: .app)
        return AddToAccountModel(driver: driver, base: base, deviceKind: "Mac")
    }

    func testTheSignInAsksForTheLicensesAccountAndNamesItOnTheWait() async {
        let driver = HintDriver(signed: "maya@example.com")
        let m = model(driver)
        let ok = await m.signInToAccount()
        XCTAssertTrue(ok)
        XCTAssertEqual(driver.hints.first?.loginHint, "maya@example.com")
        XCTAssertEqual(driver.hints.first?.purpose, "signin")
    }

    func testTheWaitNamesTheAccountItAskedFor() async {
        let driver = HintDriver(signed: nil)
        let m = model(driver)
        _ = await m.signInToAccount()
        XCTAssertEqual(m.host.hint, "maya@example.com")
        XCTAssertEqual(KitFormat.maskEmail(m.host.hint), "m•••@example.com")
    }

    func testAnotherAccountLandsOnOtherAccountAndTheLicenseIsAddedNowhere() async {
        let m = model(HintDriver(signed: "someone@else.com"))
        let ok = await m.signInToAccount()
        XCTAssertFalse(ok)
        XCTAssertEqual(m.step, .otherAccount)
        XCTAssertEqual(m.inputs.addToAccount?.typedEmail, "m•••@example.com")
        XCTAssertEqual(m.inputs.addToAccount?.signedEmail, "s•••@else.com")
    }

    func testASignInThatNamesNoAccountIsNeverClaimedToMatch() async {
        // A redirect sign-in carries no email: it finishes as before, it is not a mismatch.
        let m = model(HintDriver(signed: nil))
        let ok = await m.signInToAccount()
        XCTAssertTrue(ok)
        XCTAssertNotEqual(m.step, .otherAccount)
    }

    func testTheTypedEmailIsOnlyAHintWhenTheLicenseNamesNone() async {
        let driver = HintDriver(signed: "other@else.com")
        let m = model(driver, holder: nil)
        m.setField(.email, "me@example.com")
        let ok = await m.signInToAccount()
        XCTAssertTrue(ok, "nothing to check the account against")
        XCTAssertEqual(driver.hints.first?.loginHint, "me@example.com")
    }

    func testDoneSignInAsOnAnotherAccountLandsOnOtherAccount() async {
        var f = facts(email: "maya@example.com")
        f.holderEmail = "maya@example.com"
        let flow = HolderFlowModel(facts: f, driver: HintDriver(signed: "x@y.com"), key: "pkey_k")
        await flow.signInAs()
        XCTAssertEqual(flow.stage, .add)
        XCTAssertEqual(flow.add.step, .otherAccount)
        XCTAssertFalse(flow.finished)
    }

    func testDoneSignInAsOnTheSameAccountEndsTheFlow() async {
        var f = facts(email: "maya@example.com")
        f.holderEmail = "maya@example.com"
        let flow = HolderFlowModel(facts: f, driver: HintDriver(signed: "MAYA@example.com"), key: "pkey_k")
        await flow.signInAs()
        XCTAssertTrue(flow.finished)
    }
}

@MainActor
final class HolderFieldErrorTests: XCTestCase {
    private func invalid() async -> AddToAccountModel {
        let m = AddToAccountModel(driver: Idle(), base: KitInputs(), deviceKind: "Mac")
        m.setField(.name, "Ada Lovelace")
        m.setField(.email, "ada")
        await m.submit()
        return m
    }

    func testAWriteOfTheValueAlreadyThereKeepsTheError() async {
        // A macOS field writes its binding when it takes focus: that is not typing.
        let m = await invalid()
        XCTAssertEqual(m.step, .invalid)
        m.setField(.email, "ada")
        m.setField(.name, "Ada Lovelace")
        XCTAssertEqual(m.step, .invalid)
        XCTAssertEqual(m.field, .email)
    }

    func testTypingInTheOtherFieldKeepsTheError() async {
        let m = await invalid()
        m.setField(.name, "Ada L")
        XCTAssertEqual(m.step, .invalid)
        XCTAssertEqual(m.field, .email)
    }

    func testTypingInTheWrongFieldClearsItsError() async {
        let m = await invalid()
        m.setField(.email, "ada@")
        XCTAssertEqual(m.step, .form)
        XCTAssertNil(m.field)
    }

    func testBothWrongClearOneAtATime() async {
        let m = AddToAccountModel(driver: Idle(), base: KitInputs(), deviceKind: "Mac")
        await m.submit()
        XCTAssertEqual(m.field, .both)
        m.setField(.name, "Ada")
        XCTAssertEqual(m.step, .invalid)
        XCTAssertEqual(m.field, .email)
        m.setField(.email, "ada@example.com")
        XCTAssertEqual(m.step, .form)
    }
}

@MainActor
final class HolderLineTests: XCTestCase {
    func testASegmentWhoseValueIsUnknownIsDroppedNeverDrawnWithItsBrace() {
        XCTAssertEqual(
            KitFormat.deviceLine("Pro · {term} · this Mac is device 1 of 3."), "Pro · this Mac is device 1 of 3.")
        XCTAssertEqual(KitFormat.deviceLine("Pro · {term} · this Mac is device 2 of {limit}."), "Pro")
        XCTAssertNil(KitFormat.deviceLine("{tier} · {term} · this Mac is device {n} of {limit}."))
    }

    func testTheTvDoneStepOffersNoExternalLinkHint() {
        let screen = KitStates.activateDone(
            HolderFlowModel(facts: facts(tv: true), driver: Idle(), key: "k").doneInputs)
        XCTAssertTrue(screen.shows("signin.key.addInLocker"))
        XCTAssertFalse(screen.shows("a11y.externalLink"))
    }
}
