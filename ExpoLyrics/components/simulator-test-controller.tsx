// Dev/test-only controller that automatically boots the test scenario
// Completely excluded from production builds
// Renders no visual overlay so simulator screenshots capture clean lyrics matching baseline

import { useEffect } from 'react';
import { simulatorHarness } from '@/lib/simulator-test-harness';

export function SimulatorTestController() {
  useEffect(() => {
    if (!simulatorHarness.isSupported()) return;

    simulatorHarness.initialize();

    const timeout = setTimeout(() => {
      void simulatorHarness.runAutomatedScenario();
    }, 1000);

    return () => {
      clearTimeout(timeout);
      simulatorHarness.cleanup();
    };
  }, []);

  return null;
}
