package com.dsharnessmobile.shell

import org.junit.Assert.*
import org.junit.Test

class EngineEndpointTest {
  @Test fun persistedEndpointRejectsMalformedPrivilegedAndFractionalPorts() {
    assertEquals(4145, EngineEndpoint.savedPort("""{"schema":1,"port":4145}"""))
    for (text in listOf("{}", "not-json", """{"schema":2,"port":4145}""",
      """{"schema":1,"port":0}""", """{"schema":1,"port":80}""",
      """{"schema":1,"port":65536}""", """{"schema":1,"port":4145.5}""")) {
      assertNull(text, EngineEndpoint.savedPort(text))
    }
  }

  @Test fun reportedEndpointRequiresExactLoopbackOrigin() {
    assertEquals(55231, EngineEndpoint.reportedPort("http://127.0.0.1:55231/?token=example"))
    for (url in listOf("http://127.0.0.1.evil:55231/", "http://user@127.0.0.1:55231/",
      "https://127.0.0.1:55231/", "http://0.0.0.0:55231/", "http://localhost:55231/",
      "http://127.0.0.1:0/", "http://127.0.0.1:55231/other", "http://127.0.0.1:55231/#fragment")) {
      assertNull(url, EngineEndpoint.reportedPort(url))
    }
  }

  @Test fun bindingFailsClosedAndOnlyCurrentGenerationCanPublish() {
    try {
      EngineEndpoint.beginBinding()
      EngineEndpoint.markGeneration(100)
      assertEquals(0, EngineEndpoint.port)
      assertFalse(EngineEndpoint.confirmed)
      assertFalse(EngineEndpoint.publishReportedPort(55231, 99))
      assertFalse(EngineEndpoint.publishReportedPort(0, 100))
      assertEquals(0, EngineEndpoint.port)
      assertTrue(EngineEndpoint.publishReportedPort(55231, 100))
      assertEquals("127.0.0.1:55231", EngineEndpoint.authority)
      assertEquals("http://127.0.0.1:55231", EngineProbe.ENGINE_URL)
      assertTrue(EngineProbe.isEngineOrigin("http://127.0.0.1:55231/api/test"))
      assertFalse(EngineProbe.isEngineOrigin("http://127.0.0.1:3080/api/test"))
      assertFalse(EngineProbe.isEngineOrigin("http://127.0.0.1:4145/api/test"))
    } finally {
      EngineEndpoint.markGeneration(101)
      EngineEndpoint.publishReportedPort(4145, 101)
    }
  }

  @Test fun aSavedOrPublishedEndpointIsAddressableOnlyForTheCurrentGeneration() {
    try {
      EngineEndpoint.invalidate()
      assertEquals(0, EngineEndpoint.port)
      assertFalse(EngineEndpoint.confirmed)
      EngineEndpoint.markGeneration(200)
      assertEquals("generation alone is not a published endpoint", 0, EngineEndpoint.port)
      assertTrue(EngineEndpoint.publishReportedPort(55232, 200))
      assertEquals(55232, EngineEndpoint.port)
      EngineEndpoint.invalidate()
      assertEquals("a stopped child must not leave stale requests pointing at its port", 0, EngineEndpoint.port)
      assertFalse(EngineEndpoint.confirmed)
    } finally {
      EngineEndpoint.markGeneration(201)
      EngineEndpoint.publishReportedPort(4145, 201)
    }
  }
}
