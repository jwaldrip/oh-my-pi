package sh.ompd.app

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.LargeTest
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import java.io.ByteArrayOutputStream
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Emulator smoke with Metro serving JS (adb reverse tcp:8081).
 *
 * React Native maps `testID` to content-description on Android. Match
 * resource-id and content-desc, plus visible pairing copy.
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
      val deadline = System.currentTimeMillis() + timeoutMs
      var hit: String? = null

      while (System.currentTimeMillis() < deadline && hit == null) {
        hit = firstMatch(device)
        if (hit == null) {
          device.waitForIdle(500)
          Thread.sleep(500)
        }
      }

      if (hit == null) {
        val baos = ByteArrayOutputStream()
        device.dumpWindowHierarchy(baos)
        val snippet = baos.toString("UTF-8").lineSequence().take(100).joinToString("\n")
        throw AssertionError(
          "expected RN surface pair-endpoint/console after launch; hierarchy head:\n$snippet"
        )
      }
      assertNotNull(hit)
    }
  }

  private fun firstMatch(device: UiDevice): String? {
    val ids = listOf("pair-endpoint", "pair", "pair-form", "pair-submit", "console", "boot")
    for (id in ids) {
      if (device.findObject(By.res(id)) != null) return "res:$id"
      if (device.findObject(By.desc(id)) != null) return "desc:$id"
    }
    // Visible copy from PairScreen
    if (device.findObject(By.text("Take the position")) != null) return "text:heading"
    if (device.findObject(By.text("Daemon endpoint")) != null) return "text:endpoint-label"
    if (device.findObject(By.text(Pattern.compile("(?i)connect"))) != null) return "text:connect"
    // Wait helper keeps CPU calm when nothing matches yet
    device.wait(Until.hasObject(By.pkg("sh.ompd.app")), 250)
    return null
  }
}
