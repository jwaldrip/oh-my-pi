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

/**
 * Emulator smoke with Metro serving JS:
 * - process id is the store package
 * - MainActivity launches
 * - React Native renders either the pairing screen (`pair-endpoint`) or the
 *   paired console (`console`) accessibility/testID surface
 *
 * Asserting only that an Activity object exists would green-pass a redbox.
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
      // RN bridge + first paint under CI can be slow; keep this a smoke, not a flake.
      val timeoutMs = 60_000L
      val pair = device.wait(Until.findObject(By.res("pair-endpoint")), timeoutMs)
        ?: device.wait(Until.findObject(By.desc("pair-endpoint")), timeoutMs)
      val console = device.wait(Until.findObject(By.res("console")), 5_000L)
        ?: device.wait(Until.findObject(By.desc("console")), 5_000L)
      assertTrue(
        "expected RN surface pair-endpoint or console after launch (metro must be up)",
        pair != null || console != null,
      )
    }
  }
}
