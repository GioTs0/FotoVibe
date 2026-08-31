// This file is injected only by the explicit local development mode.
(() => {
  let connected = false;
  let disconnected = false;
  const events = new EventSource('/__dev/reload');

  events.onopen = () => {
    if (connected && disconnected) location.reload();
    connected = true;
    disconnected = false;
  };

  events.onerror = () => {
    if (connected) disconnected = true;
  };
})();
