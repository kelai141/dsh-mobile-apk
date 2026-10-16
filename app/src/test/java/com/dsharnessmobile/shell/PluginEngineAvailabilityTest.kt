package com.dsharnessmobile.shell

import org.junit.Assert.assertEquals
import org.junit.Test

class PluginEngineAvailabilityTest {
  @Test fun stoppedEngineIsOrdinaryOfflineStateEvenWhileOldPortCloses() {
    assertEquals(PluginEngineAvailability.OFFLINE,
      pluginEngineAvailability(true, true, true, GuidePhase.Starting, false))
  }
  @Test fun unopenedEngineDoesNotTryToReadPluginInventory() {
    assertEquals(PluginEngineAvailability.OFFLINE,
      pluginEngineAvailability(false, false, false, GuidePhase.Idle, false))
  }
  @Test fun explicitStartAndExtractionWaitForRealRuntime() {
    assertEquals(PluginEngineAvailability.STARTING,
      pluginEngineAvailability(false, false, false, GuidePhase.Idle, true))
    assertEquals(PluginEngineAvailability.STARTING,
      pluginEngineAvailability(false, false, false, GuidePhase.Extracting, false))
  }
  @Test fun failedStartupOffersRecoveryInsteadOfAnEndlessSpinner() {
    assertEquals(PluginEngineAvailability.FAILED,
      pluginEngineAvailability(false, false, false, GuidePhase.Error, true))
  }
  @Test fun authenticatedOrAuthRequiredLiveEngineCanQueryTheInventory() {
    assertEquals(PluginEngineAvailability.ONLINE,
      pluginEngineAvailability(false, true, true, GuidePhase.Starting, false))
  }
}
