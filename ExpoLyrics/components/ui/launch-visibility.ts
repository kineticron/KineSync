import { createContext } from 'react';

// Replayed onboarding is visible immediately; first launch waits for the veil.
export const LaunchVisibilityContext = createContext(true);
