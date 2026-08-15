package ai.ompctl.app

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * Guards the store identity. A silent revert to the RN template package
 * (com.ompd / org.reactjs...) would ship an un-uploadable or colliding AAB.
 */
class PackageIdentityTest {
  @Test
  fun applicationIdIsStoreIdentity() {
    assertEquals("ai.ompctl.app", BuildConfig.APPLICATION_ID)
  }

  @Test
  fun applicationIdIsNotReactNativeTemplate() {
    assertNotEquals("com.ompd", BuildConfig.APPLICATION_ID)
  }
}
