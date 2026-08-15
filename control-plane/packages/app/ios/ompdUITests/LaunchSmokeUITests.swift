//
//  LaunchSmokeUITests.swift
//  ompdUITests
//
//  Simulator-safe smoke: the app launches and either the pairing screen or
//  the console is visible. No live daemon credentials required. This is the
//  CI gate for "the binary boots"; PairingUITests remains the device proof.
//

import XCTest

final class LaunchSmokeUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAppLaunchesToPairingOrConsole() throws {
        let app = XCUIApplication()
        app.launch()

        let pairEndpoint = app.textFields["pair-endpoint"]
        let console = app.otherElements["console"]
        // 60s/15s, not 30s/5s: a shared CI runner on an older Xcode (16.4 vs.
        // a modern local install) genuinely needs more wall time for an iPad
        // simulator's first boot, bundle fetch, and Hermes bytecode
        // compilation than a local Mac does. A generous margin here is
        // cheap; a flaky CI gate that intermittently fails a correct build
        // is not.
        let pairAppeared = pairEndpoint.waitForExistence(timeout: 60)
        let consoleAppeared = console.waitForExistence(timeout: 15)
        XCTAssertTrue(
            pairAppeared || consoleAppeared,
            "expected pairing screen (pair-endpoint) or console after launch"
        )

        if pairAppeared {
            // Fresh install / no saved pairing: endpoint must not ship with a
            // loopback default that can never work from a real device.
            let value = (pairEndpoint.value as? String) ?? ""
            let placeholderish = value == "Endpoint" || value.isEmpty
            XCTAssertTrue(
                placeholderish || !value.contains("127.0.0.1") && !value.contains("localhost"),
                "endpoint field must not default to loopback, was '\(value)'"
            )
            XCTAssertTrue(app.buttons["pair-submit"].exists, "pair-submit missing on pairing screen")
        }
    }
}
