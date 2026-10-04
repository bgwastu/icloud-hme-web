import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, localStorageColorSchemeManager } from "@mantine/core";
import { App } from "./App";
import "@mantine/core/styles.css";
import { theme } from "./theme";
import "./styles.css";
const colorSchemeManager = localStorageColorSchemeManager({
  key: "icloud-hme-color-scheme",
});
createRoot(document.getElementById("root")!).render(
  <MantineProvider
    theme={theme}
    defaultColorScheme="auto"
    colorSchemeManager={colorSchemeManager}
  >
    <App />
  </MantineProvider>,
);
