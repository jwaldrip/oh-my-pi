//
//  PairingUITests.swift
//  ompdUITests
//
//  Proves, on a real tethered iPhone, that a fresh install pairs against a
//  live daemon over the LAN and reaches the console. The empty-endpoint
//  assertion is the point of the whole exercise: the field used to arrive
//  prefilled with a loopback URL, which can never resolve from a phone, and
//  it looked like a working default right up until someone tried it on a
//  device. Nothing else in this suite would have caught that regression.
//
//  The endpoint and token come from the test runner's own process environment
//  as OMPD_TEST_ENDPOINT and OMPD_TEST_TOKEN. The test passes those same
//  values through XCUIApplication.launchEnvironment before entering them. No
//  live credential belongs in version control.
//

import XCTest

final class PairingUITests: XCTestCase {

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testFreshInstallPairsAndReachesConsole() throws {
        let environment = ProcessInfo.processInfo.environment
        guard let endpoint = environment["OMPD_TEST_ENDPOINT"], !endpoint.isEmpty else {
            XCTFail("OMPD_TEST_ENDPOINT is not set in the test runner environment")
            return
        }
        guard let token = environment["OMPD_TEST_TOKEN"], !token.isEmpty else {
            XCTFail("OMPD_TEST_TOKEN is not set in the test runner environment")
            return
        }
        guard let agentID = environment["OMPD_TEST_AGENT_ID"], !agentID.isEmpty else {
            XCTFail("OMPD_TEST_AGENT_ID is not set in the test runner environment")
            return
        }
        guard let nonce = environment["OMPD_TEST_NONCE"], !nonce.isEmpty else {
            XCTFail("OMPD_TEST_NONCE is not set in the test runner environment")
            return
        }
        let app = XCUIApplication()
        let localNetworkPrompt = addUIInterruptionMonitor(withDescription: "Local Network permission") { alert in
            guard alert.label.localizedCaseInsensitiveContains("local networks") else {
                return false
            }
            alert.buttons["Allow"].tap()
            return true
        }
        defer {
            removeUIInterruptionMonitor(localNetworkPrompt)
        }

        // The app itself never reads these; they are threaded through only so
        // the whole chain from environment to keystrokes is traceable, and so
        // nothing in this file is ever a literal endpoint or token.
        app.launchEnvironment["OMPD_TEST_ENDPOINT"] = endpoint
        app.launchEnvironment["OMPD_TEST_TOKEN"] = token
        app.launch()

        let endpointField = app.textFields["pair-endpoint"]
        XCTAssertTrue(endpointField.waitForExistence(timeout: 15), "pairing screen did not appear on launch")

        // This is the defect the whole change fixes: the endpoint field used
        // to arrive prefilled with a loopback URL that can never work from a
        // phone. A fresh launch (the app was uninstalled before this run, so
        // there is no saved pairing) must show it empty.
        let initialValue = (endpointField.value as? String) ?? ""
        XCTAssertTrue(initialValue.isEmpty, "endpoint field must be empty on a fresh launch, was '\(initialValue)'")

        endpointField.tap()
        endpointField.typeText(endpoint)

        let endpointKind = app.staticTexts["pair-endpoint-kind"]
        XCTAssertTrue(endpointKind.waitForExistence(timeout: 5), "endpoint-kind label did not appear after typing")
        XCTAssertEqual(endpointKind.label, "Direct socket")

        let tokenField = app.secureTextFields["pair-token"]
        XCTAssertTrue(tokenField.exists, "token field not found")
        tokenField.tap()
        tokenField.typeText(token)

        let submit = app.buttons["pair-submit"]
        XCTAssertTrue(submit.waitForExistence(timeout: 5), "submit button not found")
        XCTAssertTrue(submit.isEnabled, "connect button did not become enabled once endpoint and token are present")

        // The keyboard obscures the lower form on a phone. Its return action
        // is an operator's normal way to leave this single-line field, and
        // makes the Connect control genuinely tappable rather than merely
        // present in the accessibility hierarchy.
        let keyboard = app.keyboards.firstMatch
        if keyboard.exists {
            let returnKey = keyboard.buttons["Return"]
            let doneKey = keyboard.buttons["Done"]
            if returnKey.exists {
                returnKey.tap()
            } else if doneKey.exists {
                doneKey.tap()
            } else {
                XCTFail("token keyboard has neither Return nor Done")
                return
            }
        }
        XCTAssertTrue(submit.isHittable, "connect button remained obscured by the keyboard")
        submit.tap()
        let console = app.otherElements["console"]
        XCTAssertTrue(console.waitForExistence(timeout: 20), "console did not appear after pairing")
        let fleet = app.otherElements["fleet"]
        XCTAssertTrue(fleet.waitForExistence(timeout: 5), "session fleet did not appear after pairing")
        XCTAssertTrue(app.staticTexts["fleet-count"].exists, "session fleet count did not appear after pairing")

        let agent = app.descendants(matching: .any)["session-open-\(agentID)"]
        XCTAssertTrue(agent.waitForExistence(timeout: 20), "requested daemon agent was not present in the session fleet")
        agent.tap()

        let session = app.otherElements["session"]
        XCTAssertTrue(session.waitForExistence(timeout: 10), "selected agent session did not open")

        let prompt = "Do not use tools. Do not make a todo list. Reply with exactly this token and nothing else: \(nonce)"
        let composer = app.textViews["composer-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 10), "agent composer did not appear")

        let userRows = app.otherElements.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "entry-user-")
        )
        let userCountBeforePrompt = userRows.count
        let assistantRows = app.otherElements.matching(
            NSPredicate(format: "identifier BEGINSWITH %@", "entry-assistant-")
        )
        let assistantCountBeforePrompt = assistantRows.count

        composer.tap()
        composer.typeText(prompt)
        XCTAssertTrue(((composer.value as? String) ?? "").contains(nonce), "composer input did not contain the nonce")
        let send = app.buttons["composer-send"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "agent send control did not appear")
        XCTAssertTrue(send.isEnabled, "agent send control did not become enabled for the prompt")
        if send.isHittable {
            send.tap()
        } else {
            let returnKey = app.keyboards.firstMatch.buttons["Return"]
            XCTAssertTrue(returnKey.waitForExistence(timeout: 5), "composer controls are obscured and keyboard has no Return key")
            returnKey.tap()
        }

        // Optimistic user entries carry accessibilityLabel = prompt text and
        // testID entry-user-*. Either surface is enough; both must exist once
        // Send lands so a dropped onPress cannot hide behind a descendant scan.
        let promptByLabel = app.otherElements
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-user-", nonce))
            .firstMatch
        let promptByAny = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-user-", nonce))
            .firstMatch
        let promptSubmitted = promptByLabel.waitForExistence(timeout: 15)
            || promptByAny.waitForExistence(timeout: 5)
        guard promptSubmitted else {
            // Surface what is actually on screen so the next failure is a diagnosis.
            let userIds = userRows.allElementsBoundByIndex.map { $0.identifier }
            XCTFail("prompt not submitted; user rows=\(userIds); composer=\(composer.value ?? "nil")")
            return
        }

        let assistantByLabel = app.otherElements
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-assistant-", nonce))
            .firstMatch
        let assistantByAny = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "entry-assistant-", nonce))
            .firstMatch
        XCTAssertTrue(
            assistantByLabel.waitForExistence(timeout: 90) || assistantByAny.waitForExistence(timeout: 5),
            "no new assistant response contained the unique nonce"
        )
    }
}
