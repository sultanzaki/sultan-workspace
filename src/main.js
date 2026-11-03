// Standalone seeded demo is dev-only; normal startup authenticates first.
if (import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO === 'true') {
  import('./demo.js');
} else {
  import('./foundation/app.js');
}
