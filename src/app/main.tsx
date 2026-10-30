import React from "react";
import { createRoot } from "react-dom/client";
import { MantineProvider, localStorageColorSchemeManager } from "@mantine/core";
import { Notifications } from "@mantine/notifications";
import { App } from "./App";
import "@mantine/core/styles.css";
import "@mantine/notifications/styles.css";
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
    <Notifications position="bottom-center" limit={3} />
    <App />
  </MantineProvider>,
);
