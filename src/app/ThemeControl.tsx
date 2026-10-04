import { useEffect } from "react";
import {
  ActionIcon,
  Menu,
  useComputedColorScheme,
  useMantineColorScheme,
} from "@mantine/core";
import { IconDeviceDesktop, IconMoon, IconSun } from "@tabler/icons-react";

const choices = [
  { value: "light", label: "Light", Icon: IconSun },
  { value: "dark", label: "Dark", Icon: IconMoon },
  { value: "auto", label: "Auto", Icon: IconDeviceDesktop },
] as const;

export function ThemeControl() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  const resolved = useComputedColorScheme("light", {
    getInitialValueInEffect: false,
  });
  const selected = choices.find((choice) => choice.value === colorScheme)!;
  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", resolved === "dark" ? "#101419" : "#f7f8fa");
  }, [resolved]);
  return (
    <Menu position="bottom-end" width={150}>
      <Menu.Target>
        <ActionIcon
          variant="subtle"
          color="gray"
          aria-label={`Theme: ${selected.label}`}
          title={`Theme: ${selected.label}`}
        >
          <selected.Icon size={21} />
        </ActionIcon>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.RadioGroup
          value={colorScheme}
          onChange={(value) => {
            if (value === "light" || value === "dark" || value === "auto")
              setColorScheme(value);
          }}
        >
          {choices.map(({ value, label }) => (
            <Menu.RadioItem key={value} value={value} closeMenuOnClick>
              {label}
            </Menu.RadioItem>
          ))}
        </Menu.RadioGroup>
      </Menu.Dropdown>
    </Menu>
  );
}
