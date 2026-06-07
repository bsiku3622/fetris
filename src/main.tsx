import React from "react";
import ReactDOM from "react-dom/client";
import "@studio-baeks/funky-ui/styles.css";
import "./styles/app.css";
import { App } from "./app/App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
