import React from "react";
import ReactDOM from "react-dom/client";
import App from "./web/App";

// loaded by index.html
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
