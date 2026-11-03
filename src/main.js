// The original local-only prototype is explicitly opt-in and development-only.
if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO === 'true') {
  import('./demo.js');
} else {
  import('./foundation/app.js');
}
