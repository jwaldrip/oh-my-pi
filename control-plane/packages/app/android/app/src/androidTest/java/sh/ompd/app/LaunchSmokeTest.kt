package sh.ompd.app

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.regex.Pattern

/**
 * Emulator smoke with Metro serving JS (adb reverse tcp:8081).
 *
 * React Native maps `testID` to content-description on Android (not always
 * resource-id). Match both, and fall back to visible pairing copy.
 */
@RunWith(AndroidJUnit4::class)
@LargeTest
class LaunchSmokeTest {
  @Test
  fun useAppContext() {
    val appContext = InstrumentationRegistry.getInstrumentation().targetContext
    assertEquals("sh.ompd.app", appContext.packageName)
  }

  @Test
  fun mainActivityRendersPairingOrConsole() {
    val device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    ActivityScenario.launch(MainActivity::class.java).use {
      val timeoutMs = 90_000L
      val idPattern = Pattern.compile("^(pair-endpoint|console|pair-submit)$")

      fun found(): Boolean {
        if (device.findObject(By.res(idPattern)) != null) return true
        if (device.findObject(By.desc(idPattern)) != null) return true
        // Visible copy from the pairing screen
        if (device.findObject(By.text(Pattern.compile("(?i).*pair.*|.*endpoint.*|.*connect.*"))) != null) return true
        return false
      }

      val ok = device.wait(Until.predicate { found() }, timeoutMs)
      if (!ok) {
        // Dump a short hierarchy so the next failure is diagnosable in CI logs.
        val xml = device.dumpWindowHierarchy()
        val snippet = xml.lineSequence().take(80).joinToString("\n")
        throw AssertionError(
          "expected RN surface pair-endpoint/console after launch; hierarchy head:\n$snippet"
        )
      }
      assertTrue(true)
    }
  }
}
