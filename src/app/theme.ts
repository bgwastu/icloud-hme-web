import {
  ActionIcon,
  Badge,
  Button,
  Menu,
  MenuRadioItem,
  Modal,
  NativeSelect,
  Notification,
  SegmentedControl,
  Stepper,
  Switch,
  Textarea,
  TextInput,
  Title,
  createTheme,
} from "@mantine/core";
import classes from "./theme.module.css";

export const theme = createTheme({
  primaryColor: "blue",
  primaryShade: 6,
  colors: {
    dark: [
      "#e9edf3",
      "#c2cbd7",
      "#a4afbd",
      "#8391a3",
      "#526074",
      "#303946",
      "#222b36",
      "#181e26",
      "#101419",
      "#0b0f14",
    ],
    blue: [
      "#edf5ff",
      "#dceaff",
      "#b8d5ff",
      "#8cbbff",
      "#609fff",
      "#3885f5",
      "#1769e0",
      "#1258c2",
      "#124a9e",
      "#143f80",
    ],
  },
  fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: "inherit", fontWeight: "650" },
  defaultRadius: "md",
  respectReducedMotion: true,
  components: {
    Button: Button.extend({ defaultProps: { size: "md" } }),
    ActionIcon: ActionIcon.extend({
      defaultProps: { size: 44, variant: "subtle", color: "gray" },
    }),
    Badge: Badge.extend({
      defaultProps: { size: "sm", variant: "light", tt: "none" },
    }),
    TextInput: TextInput.extend({
      defaultProps: { size: "md" },
      classNames: { input: classes.input },
    }),
    Textarea: Textarea.extend({
      defaultProps: { size: "md" },
      classNames: { input: classes.input },
    }),
    NativeSelect: NativeSelect.extend({
      defaultProps: { size: "md" },
      classNames: { input: classes.input },
    }),
    Stepper: Stepper.extend({ defaultProps: { size: "xs" } }),
    Menu: Menu.extend({
      defaultProps: { position: "bottom-end", width: 180 },
    }),
    MenuRadioItem: MenuRadioItem.extend({
      defaultProps: {
        checkIcon: false,
        classNames: {
          item: classes.themeChoice,
          itemLabel: classes.themeChoiceLabel,
          itemIndicator: classes.themeChoiceIndicator,
        },
      },
    }),
    Title: Title.extend({
      classNames: (_, props) => ({
        root: props.order === 1 ? classes.pageTitle : undefined,
      }),
    }),
    SegmentedControl: SegmentedControl.extend({
      defaultProps: { size: "sm" },
      classNames: {
        root: classes.segmentedRoot,
        label: classes.segmentedLabel,
      },
    }),
    Switch: Switch.extend({
      defaultProps: { size: "md" },
      classNames: { body: classes.switchBody, label: classes.switchLabel },
    }),
    Modal: Modal.extend({
      defaultProps: {
        size: "md",
        centered: true,
        transitionProps: { transition: "fade", duration: 120 },
        overlayProps: { backgroundOpacity: 0.35 },
      },
      classNames: {
        content: classes.modalContent,
        body: classes.modalBody,
        header: classes.modalHeader,
        title: classes.modalTitle,
      },
    }),
    Notification: Notification.extend({
      defaultProps: { color: "blue", withCloseButton: false },
      classNames: { root: classes.notice },
    }),
  },
});
