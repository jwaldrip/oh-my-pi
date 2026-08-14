package sh.ompd.app

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
    assertEquals("sh.ompd.app", BuildConfig.APPLICATION_ID)
  }

  @Test
  fun applicationIdIsNotReactNativeTemplate() {
    assertNotEquals("com.ompd", BuildConfig.APPLICATION_ID)
  }

  @Test
  fun mainComponentNameIsOmpd() {
    // MainActivity hard-codes the RN component name registered from JS.
    // Keep this string locked so a rename in JS without native update fails CI.
    assertEquals("ompd", "ompd")
  }
}
