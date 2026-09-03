import React from "react";
import ReactDOM from "react-dom/client";
import App from "./web/App";

// loaded by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
// Keep the inline splash visible while Vite/Electron loads the bundle, then
// remove it after React owns the page. This prevents a blank/black first paint.
document.getElementById("boot-splash")?.remove();
